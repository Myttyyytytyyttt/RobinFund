// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "./interfaces/IERC20.sol";
import {IAggregatorV3} from "./interfaces/IAggregatorV3.sol";
import {IEligibilityGate} from "./interfaces/IEligibilityGate.sol";
import {TokenRegistry} from "./TokenRegistry.sol";
import {NAVLib} from "./libraries/NAVLib.sol";
import {SafeTransferLib} from "./libraries/SafeTransferLib.sol";
import {FundShare} from "./FundShare.sol";
import {QueueEscrow} from "./QueueEscrow.sol";
import {StakeEscrow} from "./StakeEscrow.sol";
import {CompensationReserve} from "./CompensationReserve.sol";
import {AdapterRegistry} from "./AdapterRegistry.sol";
import {ITradeAdapter} from "./interfaces/ITradeAdapter.sol";

/// @title Fund — núcleo del mecanismo RobinFund (SPEC v0.9 §4–§10; Fase 1.3a)
/// @notice Esta pasada implementa: estados, colas con forward pricing estricto, secuencia canónica
/// de batch, contabilidad NI de por vida con materialización perezosa y vesting, entry fee en curva,
/// perf fee con HWM ajustado, settlement con marca no discrecional + degradado, y claims pull.
/// DIFERIDO y documentado: trading vía adapters (Fase 1.4 — este Fund aún no opera activos, aunque
/// los valora si se le transfieren); liquidación keeper-asistida de retiros cash (1.4 — un retiro
/// cash solo ejecuta si el USDG del fondo lo cubre; el LP puede convertirlo a in-kind); mecánica
/// Frozen completa y true-up al alza del collar in-kind (1.3b).
/// FUNDING (§6, revisión 1.3a S3): `funding = min(stake, neteado)` — 100% on-chain y
/// KEEPER-INDEPENDIENTE. El vesting per-LP hace que grossClaims (vesteado) < neteado (no vesteado),
/// así que grossClaims NO puede gatear el funding (lo haría reducible por un keeper sub-declarante);
/// vive solo en el reparto vía `λ = min(1, funding/grossClaims)`. El residuo (funding − Σ claims)
/// queda en la reserva y se barre al manager en Closed (v0.9).
contract Fund {
    using SafeTransferLib for IERC20;

    // ---------- Tipos ----------

    enum State {
        Active,
        PendingWinding, // settlement ad-hoc pendiente de primera ventana válida (§4)
        Winding,
        Closed
    }

    struct Config {
        uint16 perfFeeBps; // ≤ 3000 (§7.2)
        uint16 feeMinBps; // ≤ feeMaxBps
        uint16 feeMaxBps; // ≤ 500 (§7.1)
        uint16 managerEntryShareBps; // sobre el total de la fee, ≤ 5000; protocolo fijo 2000; resto al fondo
        uint16 kFactor; // aumCap = k × stake, ≤ 25 (§6)
        uint32 period; // 7–90 días (§9)
        uint32 withdrawCooldown; // 1h–7d (§5.3)
    }

    struct SettlementRec {
        uint128 peWad; // sharePrice a la marca
        uint128 lambdaWad; // λ en WAD (≤ 1e18)
        uint48 markTime;
        bool degraded;
    }

    struct Account {
        int256 niWad; // capital neto invertido de por vida (§6); puede ser negativo
        uint48 vestTime; // media ponderada de timestamps de depósito (v0.7)
        uint64 settledThrough; // último período materializado
    }

    struct DepositOrder {
        address lp;
        uint96 amount6; // USDG 6 dec
        uint48 requestTime;
        bool cancelled;
    }

    struct WithdrawOrder {
        address lp;
        uint128 shares;
        uint48 requestTime;
        bool cancelled;
        bool inKind;
    }

    // ---------- Constantes de protocolo (§13) ----------

    uint256 internal constant WAD = 1e18;
    uint256 internal constant USDG_TO_WAD = 1e12;
    uint16 internal constant PROTOCOL_ENTRY_BPS = 2000; // 20% del total de la entry fee
    uint16 internal constant PROTOCOL_PERF_BPS = 1000; // 10% de la perf fee
    uint48 internal constant MIN_QUEUE_LATENCY = 10 minutes;
    uint48 internal constant DEPOSIT_BLACKOUT = 24 hours;
    uint48 internal constant MAX_SETTLEMENT_DELAY = 7 days;
    uint48 internal constant COMPLIANCE_GRACE = 30 days;
    uint256 internal constant MIN_DEPOSIT_6 = 50_000000; // 50 USDG
    uint256 internal constant MAX_ORDERS_PER_TX = 50;
    uint8 internal constant MAX_PENDING_PER_LP = 8;
    // Guardarraíl y presupuesto de slippage (§8, §13)
    uint256 internal constant MAX_SLIPPAGE_BPS = 100; // 1% por trade vs cruce Chainlink
    uint256 internal constant SLIPPAGE_BUDGET_DAY_BPS = 50; // 0.5% del AUM por ventana rodante de 24h
    uint256 internal constant SLIPPAGE_BUDGET_PERIOD_BPS = 5000; // 50% del stake por período
    uint256 internal constant MAX_TRADES_PER_DAY = 200;
    uint48 internal constant WASH_WINDOW = 1 hours;
    // Offset virtual anti-inflation (§14.9): assets y shares con el MISMO offset para que el
    // precio seed sea exactamente 1.0 (navWad y shares comparten espacio de 18 decimales).
    uint256 internal constant VIRT_SHARES = 1e6;
    uint256 internal constant VIRT_ASSETS = 1e6;

    // ---------- Wiring inmutable ----------

    TokenRegistry public immutable REGISTRY;
    IERC20 public immutable USDG;
    FundShare public share;
    QueueEscrow public queue;
    StakeEscrow public stakeEscrow;
    CompensationReserve public reserve;
    IEligibilityGate public immutable GATE;
    AdapterRegistry public immutable ADAPTERS;
    address public immutable MANAGER;
    address public immutable KEEPER; // publica grossClaims en settle (confianza v1, §15)
    address public immutable FEE_SPLITTER; // excluido de la contabilidad NI (§7.3)
    address public immutable PROTOCOL_TREASURY;
    Config public config;

    // ---------- Estado ----------

    State public state;
    bool public frozen; // cacheado; declarable permissionless si isBlocked(fund) (§10.3)
    uint256 private _lock = 1; // guard de reentrancy (S2)

    address[] public assets; // estrictamente ascendente (F13); vacío hasta Fase 1.4
    uint256 public hwmWad; // HWM ajustado por aportes (§7.2); 0 hasta el primer mint
    uint256 public lastValidSharePriceWad; // para el collar in-kind (§6)

    uint64 public currentPeriod; // settlements ejecutados
    uint48 public lastMarkTime; // due = lastMarkTime + period
    uint48 public windingRequestedAt; // due ad-hoc de Winding (§4)
    mapping(uint64 => SettlementRec) public settlements;

    mapping(address => Account) internal _accounts;
    int256 public niAggregateWad; // ≡ Σ NI_lp (cuentas ≠ FEE_SPLITTER)

    DepositOrder[] public depositQueue;
    uint256 public depositHead;
    WithdrawOrder[] public withdrawQueue;
    uint256 public withdrawHead;
    mapping(address => uint256) public lockedShares;
    mapping(address => uint8) public pendingOrders;
    uint256 public queuedDeposits6; // total USDG vivo en el QueueEscrow

    // Contabilidad de slippage (§8)
    uint48 public slippageDayStart; // inicio del bucket de 24h (fijo, no rodante — §8/T11)
    uint256 public slippageDayWad; // slippage adverso acumulado en el bucket
    uint256 public slippagePeriodWad; // acumulado en el período contable (reset en settlement)
    uint256 public tradesInDay;
    uint256 public budgetStakeWad; // snapshot del stake al último settlement (denominador no pumpeable, T4)
    mapping(bytes32 => uint48) public dirTradeTime; // keccak(tokenIn,tokenOut) → último trade en esa dirección

    // ---------- Eventos ----------

    event DepositRequested(uint256 indexed orderId, address indexed lp, uint256 amount6);
    event DepositExecuted(uint256 indexed orderId, address indexed lp, uint256 amount6, uint256 sharesMinted);
    event DepositRefunded(uint256 indexed orderId, address indexed lp, uint256 amount6, string reason);
    event WithdrawRequested(uint256 indexed orderId, address indexed lp, uint256 shares, bool inKind);
    event WithdrawExecuted(uint256 indexed orderId, address indexed lp, uint256 shares, uint256 paid6, bool inKind);
    event OrderCancelled(uint256 indexed orderId, bool isDeposit);
    event Settled(uint64 indexed period, uint256 peWad, uint256 fundingWad, uint256 lambdaWad, bool degraded);
    event PerfFeeCrystallized(uint64 indexed period, uint256 feeWad, uint256 sharesMinted);
    event ClaimMaterialized(address indexed lp, uint64 indexed period, uint256 claim6);
    event EntryFeeCharged(uint256 indexed orderId, uint256 fee6, uint256 toManager6, uint256 toProtocol6);
    event WindingRequested(uint48 due);
    event StateChanged(State newState);
    event FrozenDeclared();
    event ForcedRedemption(address indexed lp, uint256 shares);
    event ConvertedToInKind(uint256 indexed orderId);
    event AssetRegistered(address indexed token);
    event Traded(uint256 indexed adapterId, address tokenIn, address tokenOut, uint256 spent, uint256 received, uint256 adverseWad);

    // ---------- Errores ----------

    error NotManager();
    error NotKeeper();
    error WrongState();
    error FrozenFund();
    error NotEligible();
    error BelowMinimum();
    error TooManyPending();
    error NavInvalid();
    error NothingExecutable();
    error CooldownActive();
    error BadOrder();
    error BadConfig();
    error BlackoutActive();
    error StillEligible();
    error SharesLocked();
    error Reentrancy();
    error SlippageExceeded();
    error TradeLimit();
    error BudgetExceeded();

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    // ---------- Construcción ----------

    constructor(
        TokenRegistry registry_,
        IEligibilityGate gate_,
        AdapterRegistry adapters_,
        address manager_,
        address keeper_,
        address feeSplitter_,
        address treasury_,
        Config memory cfg,
        string memory name_,
        string memory symbol_
    ) {
        if (
            cfg.perfFeeBps > 3000 || cfg.feeMaxBps > 500 || cfg.feeMinBps > cfg.feeMaxBps
                || cfg.managerEntryShareBps > 5000 || cfg.kFactor == 0 || cfg.kFactor > 25 || cfg.period < 7 days
                || cfg.period > 90 days || cfg.withdrawCooldown < 1 hours || cfg.withdrawCooldown > 7 days
        ) revert BadConfig();
        REGISTRY = registry_;
        USDG = IERC20(registry_.USDG());
        GATE = gate_;
        ADAPTERS = adapters_;
        MANAGER = manager_;
        KEEPER = keeper_;
        FEE_SPLITTER = feeSplitter_;
        PROTOCOL_TREASURY = treasury_;
        config = cfg;

        share = new FundShare(name_, symbol_, address(this));
        queue = new QueueEscrow(address(this), USDG);
        reserve = new CompensationReserve(address(this), USDG);
        stakeEscrow = new StakeEscrow(address(this), USDG, manager_, address(reserve), 7 days);

        lastMarkTime = uint48(block.timestamp);
    }

    // ---------- Vistas de NAV ----------

    function nav() public view returns (NAVLib.Snapshot memory) {
        return NAVLib.compute(REGISTRY, address(this), assets);
    }

    /// @notice sharePrice WAD con offset virtual (§14.9). Si totalSupply es 0, precio seed 1.0.
    function _sharePrice(uint256 navWad) internal view returns (uint256) {
        return (navWad + VIRT_ASSETS) * WAD / (share.totalSupply() + VIRT_SHARES);
    }

    function aumCapWad() public view returns (uint256) {
        return uint256(config.kFactor) * stakeEscrow.stakeAvailable() * USDG_TO_WAD;
    }

    function settlementDue() public view returns (uint48) {
        if (state == State.PendingWinding) return windingRequestedAt;
        return lastMarkTime + uint48(config.period);
    }

    /// @notice Freeze de trading (§8) — lo consumirá el adapter layer en 1.4.
    function tradingFrozen() public view returns (bool) {
        return frozen || state != State.Active || block.timestamp >= settlementDue();
    }

    // ---------- Materialización perezosa (§6) ----------

    /// @notice Entrypoint de cobro: SIN dependencias de estado/NAV/atestación/pausas (G15, espejo D12).
    function claim() external nonReentrant {
        _touch(msg.sender);
    }

    function _touch(address lp) internal {
        if (lp == FEE_SPLITTER) return; // excluido de NI (§7.3)
        Account storage a = _accounts[lp];
        uint64 from = a.settledThrough;
        uint64 to = currentPeriod;
        if (from >= to) return;
        uint256 bal = share.balanceOf(lp);

        for (uint64 k = from + 1; k <= to; ++k) {
            SettlementRec storage rec = settlements[k];
            if (rec.lambdaWad != 0 && a.niWad > 0) {
                uint256 valueAtMark = bal * rec.peWad / WAD;
                if (uint256(a.niWad) > valueAtMark) {
                    uint256 lossWad = uint256(a.niWad) - valueAtMark;
                    // vesting de cobertura (v0.7): madura linealmente durante 1 período
                    uint256 age = rec.markTime > a.vestTime ? rec.markTime - a.vestTime : 0;
                    uint256 coverageWad = age >= config.period ? WAD : age * WAD / config.period;
                    uint256 claimWad = lossWad * coverageWad / WAD * rec.lambdaWad / WAD;
                    uint256 claim6 = claimWad / USDG_TO_WAD; // floor: contra el actor (§3.1)
                    if (claim6 > 0) {
                        a.niWad -= int256(claim6 * USDG_TO_WAD);
                        niAggregateWad -= int256(claim6 * USDG_TO_WAD);
                        reserve.pay(k, lp, claim6);
                        emit ClaimMaterialized(lp, k, claim6);
                    }
                }
            }
        }
        a.settledThrough = to;
    }

    // ---------- Colas (§5.3) ----------

    function requestDeposit(uint256 amount6) external nonReentrant returns (uint256 orderId) {
        if (state != State.Active) revert WrongState();
        if (frozen) revert FrozenFund();
        if (!GATE.isEligible(msg.sender)) revert NotEligible();
        if (amount6 < MIN_DEPOSIT_6) revert BelowMinimum();
        if (pendingOrders[msg.sender] >= MAX_PENDING_PER_LP) revert TooManyPending();

        USDG.safeTransferFrom(msg.sender, address(queue), amount6);
        queuedDeposits6 += amount6;
        pendingOrders[msg.sender]++;
        orderId = depositQueue.length;
        depositQueue.push(
            DepositOrder({lp: msg.sender, amount6: uint96(amount6), requestTime: uint48(block.timestamp), cancelled: false})
        );
        emit DepositRequested(orderId, msg.sender, amount6);
    }

    function cancelDeposit(uint256 orderId) external nonReentrant {
        DepositOrder storage o = depositQueue[orderId];
        if (o.lp != msg.sender || o.cancelled || orderId < depositHead) revert BadOrder();
        o.cancelled = true;
        _refundDeposit(orderId, o, "cancelada");
    }

    function requestWithdraw(uint256 shares_, bool inKind) external nonReentrant returns (uint256 orderId) {
        if (shares_ == 0) revert BelowMinimum();
        _touch(msg.sender);
        if (share.balanceOf(msg.sender) - lockedShares[msg.sender] < shares_) revert SharesLocked();
        if (pendingOrders[msg.sender] >= MAX_PENDING_PER_LP) revert TooManyPending();

        lockedShares[msg.sender] += shares_;
        pendingOrders[msg.sender]++;
        orderId = withdrawQueue.length;
        withdrawQueue.push(
            WithdrawOrder({
                lp: msg.sender,
                shares: uint128(shares_),
                requestTime: uint48(block.timestamp),
                cancelled: false,
                inKind: inKind
            })
        );
        emit WithdrawRequested(orderId, msg.sender, shares_, inKind);
    }

    /// @notice Cancelable solo hasta madurar el cooldown (C20).
    function cancelWithdraw(uint256 orderId) external nonReentrant {
        WithdrawOrder storage o = withdrawQueue[orderId];
        if (o.lp != msg.sender || o.cancelled || orderId < withdrawHead) revert BadOrder();
        if (block.timestamp >= o.requestTime + config.withdrawCooldown) revert CooldownActive();
        o.cancelled = true;
        lockedShares[msg.sender] -= o.shares;
        pendingOrders[msg.sender]--;
        emit OrderCancelled(orderId, false);
    }

    /// @notice Convierte un retiro cash pendiente a in-kind (válvula §5.6.5).
    function convertToInKind(uint256 orderId) external nonReentrant {
        WithdrawOrder storage o = withdrawQueue[orderId];
        if (o.lp != msg.sender || o.cancelled || orderId < withdrawHead) revert BadOrder();
        o.inKind = true;
        emit ConvertedToInKind(orderId);
    }

    // ---------- Ejecución de batches (§5.4) ----------

    /// @notice Ejecuta la secuencia canónica en una ventana válida: settlement si due →
    /// depósitos FIFO → retiros FIFO. Permissionless.
    function executeBatch(uint256 grossClaimsWad) external nonReentrant {
        // 1. settlement si está due (necesita grossClaims del keeper si lo llama el keeper;
        //    cualquier otro caller solo puede ejecutar batches si no hay settlement pendiente)
        if (block.timestamp >= settlementDue() && state != State.Closed) {
            _settle(grossClaimsWad);
        }
        NAVLib.Snapshot memory s = nav();
        if (!s.valid) revert NavInvalid();
        _executeDeposits(s);
        s = nav(); // los depósitos cambian el NAV (fee al fondo + USDG entrante)
        _executeWithdrawals(s);
    }

    /// @notice Procesa SOLO retiros in-kind, SIN requerir NAV válido (S4: válvula de escape §5.3/§10.3/
    /// D12 — funciona con feed muerto, pausa, depeg o Frozen; el in-kind es pro-rata raw, no necesita
    /// precio). Permissionless. Es la única salida garantizada cuando el fondo no tiene NAV válido.
    function executeInKindWithdrawals() external nonReentrant {
        uint48 cutoff = _freshnessCutoff();
        uint256 processed;
        // Sin NAV válido no hay precio de referencia fiable: el collar usa lastValidSharePrice.
        uint256 priceRef = lastValidSharePriceWad;
        bool overdue = block.timestamp >= settlementDue() && state != State.Closed;

        while (withdrawHead < withdrawQueue.length && processed < MAX_ORDERS_PER_TX) {
            WithdrawOrder storage o = withdrawQueue[withdrawHead];
            if (o.cancelled) {
                withdrawHead++;
                continue;
            }
            if (!o.inKind) break; // el cash espera al batch normal; el in-kind no lo bloquea aquí
            bool cooldownOver = block.timestamp >= o.requestTime + config.withdrawCooldown
                || state == State.Winding || state == State.Closed;
            // en Frozen/pausa el cooldown de un in-kind sigue aplicando salvo estados terminales;
            // la frescura del cutoff no aplica al in-kind (no usa precio de mercado)
            if (!cooldownOver) break;
            overdue; // el overdue no bloquea el in-kind (es la válvula)
            cutoff;
            processed++;
            _touch(o.lp);
            _executeInKind(withdrawHead, o, priceRef);
            withdrawHead++;
        }
    }

    function _freshnessCutoff() internal view returns (uint48 cutoff) {
        // Forward pricing estricto (C13): toda ronda usada debe ser posterior a la solicitud.
        // cutoff = min(updatedAt) de los feeds relevantes; una orden es ejecutable si
        // requestTime < cutoff y requestTime + MIN_QUEUE_LATENCY ≤ now.
        cutoff = type(uint48).max;
        for (uint256 i; i < assets.length; ++i) {
            TokenRegistry.Asset memory a = REGISTRY.getAsset(assets[i]);
            if (a.feed == address(0)) continue;
            try IAggregatorV3(a.feed).latestRoundData() returns (uint80, int256, uint256, uint256 upd, uint80) {
                if (upd < cutoff) cutoff = uint48(upd);
            } catch {
                return 0; // sin frescura demostrable: nada es ejecutable
            }
        }
        address uFeed = REGISTRY.usdgFeed();
        if (uFeed != address(0)) {
            try IAggregatorV3(uFeed).latestRoundData() returns (uint80, int256, uint256, uint256 upd, uint80) {
                if (upd < cutoff) cutoff = uint48(upd);
            } catch {
                return 0;
            }
        }
        if (cutoff == type(uint48).max) cutoff = uint48(block.timestamp); // fondo 100% USDG sin feed
    }

    function _executeDeposits(NAVLib.Snapshot memory s) internal {
        if (state != State.Active || frozen) return;
        uint48 due = settlementDue();
        if (block.timestamp + DEPOSIT_BLACKOUT >= due) return; // blackout pre-settlement (C1)

        uint48 cutoff = _freshnessCutoff();
        uint256 navWad = s.navWad;
        uint256 processed;
        uint256 capWad = aumCapWad();

        while (depositHead < depositQueue.length && processed < MAX_ORDERS_PER_TX) {
            DepositOrder storage o = depositQueue[depositHead];
            if (o.cancelled) {
                depositHead++;
                continue;
            }
            if (o.requestTime >= cutoff || block.timestamp < o.requestTime + MIN_QUEUE_LATENCY) break; // FIFO espera
            processed++;

            // atestación re-verificada al ejecutar (C21): skip + refund, no bloquea el batch
            if (!GATE.isEligible(o.lp)) {
                _refundDeposit(depositHead, o, "atestacion invalida");
                depositHead++;
                continue;
            }

            uint256 dWad = uint256(o.amount6) * USDG_TO_WAD;
            // cap con fill total-o-siguiente-batch (simplificación 1.3a del fill parcial C19)
            if (navWad + dWad > capWad) break;

            _touch(o.lp);

            // entry fee (§7.1): u con AUM corriente
            uint256 fee6 = _chargeEntryFee(depositHead, o.amount6, navWad, capWad);
            uint256 netWad = (uint256(o.amount6) - fee6) * USDG_TO_WAD;
            uint256 feeFondoWad = _entryFeeFondo6(fee6) * USDG_TO_WAD;

            // fee-fondo sube el NAV y ajusta el HWM ANTES del mint (§5.4.iv, C4) — pero SOLO con LPs
            // existentes a beneficiar. Con supply==0 no hay "LPs existentes": añadirlo al NAV pre-mint
            // dispararía el precio seed contra el propio primer depositante (bug detectado en 1.3a).
            // Con supply==0 el USDG del fee-fondo entra igual al fondo y respalda sus shares (justo:
            // es el único holder), pero no se cuenta en el precio de su mint.
            uint256 supply = share.totalSupply();
            if (supply > 0 && feeFondoWad > 0) {
                hwmWad += feeFondoWad * WAD / supply; // HWM += crédito por share (aporte, no performance)
                navWad += feeFondoWad;
            }

            uint256 price = _sharePrice(navWad);
            uint256 minted = netWad * WAD / price;
            navWad += netWad;

            // NI y vesting (§6): suma el cash neto real
            Account storage a = _accounts[o.lp];
            if (a.niWad <= 0) {
                a.vestTime = uint48(block.timestamp);
            } else {
                // media ponderada por NI
                uint256 old = uint256(a.niWad);
                a.vestTime = uint48((old * a.vestTime + netWad * block.timestamp) / (old + netWad));
            }
            a.niWad += int256(netWad);
            niAggregateWad += int256(netWad);

            // el USDG neto + fee-fondo pasan del escrow al fondo; las cuotas salen a manager/protocolo
            queue.release(address(this), uint256(o.amount6) - fee6 + _entryFeeFondo6(fee6));
            queuedDeposits6 -= o.amount6;
            pendingOrders[o.lp]--;
            share.mint(o.lp, minted);
            if (hwmWad == 0) hwmWad = price; // seed HWM (C27)
            emit DepositExecuted(depositHead, o.lp, o.amount6, minted);
            depositHead++;
        }
        if (s.valid) lastValidSharePriceWad = _sharePrice(navWad);
    }

    function _executeWithdrawals(NAVLib.Snapshot memory s) internal {
        uint48 cutoff = _freshnessCutoff();
        uint256 navWad = s.navWad;
        uint256 processed;
        // Orden canónico (§5.4): con settlement vencido y sin ejecutar, los retiros CASH esperan
        // (nadie escapa a la dilución de la perf fee ni cobra a precio pre-marca); el in-kind
        // sigue abierto como válvula (§5.3).
        bool overdue = block.timestamp >= settlementDue() && state != State.Closed;

        while (withdrawHead < withdrawQueue.length && processed < MAX_ORDERS_PER_TX) {
            WithdrawOrder storage o = withdrawQueue[withdrawHead];
            if (o.cancelled) {
                withdrawHead++;
                continue;
            }
            if (overdue && !o.inKind) break;
            bool cooldownOver = block.timestamp >= o.requestTime + config.withdrawCooldown
                || state == State.Winding || state == State.Closed; // cooldown anulado en Winding (§4)
            if (!cooldownOver || o.requestTime >= cutoff) break;
            processed++;

            _touch(o.lp);
            uint256 price = _sharePrice(navWad);
            uint256 due6 = uint256(o.shares) * price / WAD / USDG_TO_WAD;

            if (o.inKind) {
                uint256 removedWad = _executeInKind(withdrawHead, o, price);
                navWad -= removedWad; // S6: descontar el valor entregado para no sobre-preciar el siguiente
                withdrawHead++;
            } else {
                // 1.3a: paga solo si el USDG del fondo cubre (liquidación keeper-asistida en 1.4)
                if (USDG.balanceOf(address(this)) < due6) break;
                // CEI (S2): mutaciones de estado ANTES de la transferencia externa
                _settleNiOnBurn(o.lp, o.shares, due6 * USDG_TO_WAD);
                share.burn(o.lp, o.shares);
                lockedShares[o.lp] -= o.shares;
                pendingOrders[o.lp]--;
                navWad -= due6 * USDG_TO_WAD;
                uint256 shares = o.shares;
                address lp = o.lp;
                withdrawHead++;
                USDG.safeTransfer(lp, due6);
                emit WithdrawExecuted(withdrawHead - 1, lp, shares, due6, false);
            }
        }
    }

    /// @dev Ejecuta un retiro in-kind. Devuelve el valor WAD retirado del fondo (para descontar del
    /// NAV local, S6). No requiere NAV válido: solo balances raw pro-rata (§5.3, válvula de escape).
    function _executeInKind(uint256 orderId, WithdrawOrder storage o, uint256 priceIfValid)
        internal
        returns (uint256 removedWad)
    {
        uint256 supply = share.totalSupply();
        uint256 shares = o.shares;
        address lp = o.lp;
        // proceeds para NI: collar (§6, simplificado 1.3a — sin true-up al alza posterior)
        uint256 refPrice = priceIfValid > lastValidSharePriceWad ? priceIfValid : lastValidSharePriceWad;
        _settleNiOnBurn(lp, shares, shares * refPrice / WAD);

        // CEI (S2): quemar y limpiar estado ANTES de mover activos
        uint256 usdgSlice = USDG.balanceOf(address(this)) * shares / supply;
        share.burn(lp, shares);
        lockedShares[lp] -= shares;
        pendingOrders[lp]--;

        // pro-rata físico de cada activo (try/catch: en Frozen salta tokens bloqueados, §10.3)
        for (uint256 i; i < assets.length; ++i) {
            uint256 bal = IERC20(assets[i]).balanceOf(address(this));
            uint256 slice = bal * shares / supply;
            if (slice > 0) {
                removedWad += _valueSliceWad(REGISTRY.getAsset(assets[i]).feed, slice);
                (bool ok,) = assets[i].call(abi.encodeCall(IERC20.transfer, (lp, slice)));
                ok; // residual de tokens intransferibles: TODO 1.3b (claim in-kind)
            }
        }
        removedWad += usdgSlice * USDG_TO_WAD;
        if (usdgSlice > 0) USDG.safeTransfer(lp, usdgSlice);
        emit WithdrawExecuted(orderId, lp, shares, usdgSlice, true);
    }

    function _valueSliceWad(address feed, uint256 slice) internal view returns (uint256) {
        if (feed == address(0)) return 0;
        try IAggregatorV3(feed).latestRoundData() returns (uint80, int256 px, uint256, uint256, uint80) {
            return px > 0 ? slice * uint256(px) / 1e8 : 0;
        } catch {
            return 0;
        }
    }

    /// @dev Regla de burn del NI (§6): resta max(pro-rata NI, proceeds).
    function _settleNiOnBurn(address lp, uint256 sharesBurned, uint256 proceedsWad) internal {
        if (lp == FEE_SPLITTER) return; // excluido (§7.3)
        Account storage a = _accounts[lp];
        uint256 balBefore = share.balanceOf(lp);
        int256 proRata = a.niWad > 0 ? a.niWad * int256(sharesBurned) / int256(balBefore) : int256(0);
        int256 deduction = proRata > int256(proceedsWad) ? proRata : int256(proceedsWad);
        a.niWad -= deduction;
        niAggregateWad -= deduction;
    }

    // ---------- Entry fee (§7.1) ----------

    function _chargeEntryFee(uint256 orderId, uint256 amount6, uint256 navWad, uint256 capWad)
        internal
        returns (uint256 fee6)
    {
        Config memory c = config;
        if (c.feeMaxBps == 0) return 0;
        uint256 dWad = amount6 * USDG_TO_WAD;
        uint256 uWad = capWad == 0 ? WAD : (navWad + dWad / 2) * WAD / capWad;
        if (uWad > WAD) uWad = WAD;
        uint256 rateBps = c.feeMinBps + (uint256(c.feeMaxBps) - c.feeMinBps) * uWad / WAD;
        fee6 = (amount6 * rateBps + 9999) / 10000; // ceil (§3.1)

        uint256 toProtocol = fee6 * PROTOCOL_ENTRY_BPS / 10000;
        uint256 toManager = fee6 * config.managerEntryShareBps / 10000;
        // el resto (≥30%) se queda en el fondo — sale del escrow hacia el Fund con el neto
        if (toProtocol > 0) queue.release(PROTOCOL_TREASURY, toProtocol);
        if (toManager > 0) queue.release(MANAGER, toManager);
        emit EntryFeeCharged(orderId, fee6, toManager, toProtocol);
    }

    function _entryFeeFondo6(uint256 fee6) internal view returns (uint256) {
        return fee6 - fee6 * PROTOCOL_ENTRY_BPS / 10000 - fee6 * config.managerEntryShareBps / 10000;
    }

    function _refundDeposit(uint256 orderId, DepositOrder storage o, string memory reason) internal {
        queue.release(o.lp, o.amount6);
        queuedDeposits6 -= o.amount6;
        pendingOrders[o.lp]--;
        emit DepositRefunded(orderId, o.lp, o.amount6, reason);
    }

    // ---------- Settlement (§9, §6, §7.2) ----------

    /// @notice El keeper publica grossClaims (WAD). Ejecutable en la primera ventana válida ≥ due;
    /// degradado pasados MAX_SETTLEMENT_DELAY sin ventana válida (§9).
    function settle(uint256 grossClaimsWad) external nonReentrant {
        if (msg.sender != KEEPER) revert NotKeeper();
        if (block.timestamp < settlementDue()) revert NothingExecutable();
        _settle(grossClaimsWad);
    }

    function _settle(uint256 grossClaimsWad) internal {
        if (state == State.Closed) return;
        NAVLib.Snapshot memory s = nav();
        bool degraded;
        if (!s.valid) {
            if (block.timestamp < settlementDue() + MAX_SETTLEMENT_DELAY) {
                if (msg.sender == KEEPER) revert NavInvalid();
                return; // batch de otro caller: settlement simplemente no ocurre aún
            }
            degraded = true; // §9: marcas al último precio disponible, perf fee omitida
        }
        if (msg.sender != KEEPER) return; // solo el keeper aporta grossClaims

        uint256 supply = share.totalSupply();
        uint64 period = ++currentPeriod;

        // Sin shares no hay nada que marcar: registra un settlement trivial y transiciona (S1 — evita
        // la división por cero de la perf fee con supply==0 que bloqueaba el cierre).
        if (supply == 0) {
            settlements[period] = SettlementRec({
                peWad: uint128(lastValidSharePriceWad),
                lambdaWad: 0,
                markTime: uint48(block.timestamp),
                degraded: degraded
            });
            lastMarkTime = uint48(block.timestamp);
            _postSettle(s.navWad);
            emit Settled(period, lastValidSharePriceWad, 0, 0, degraded);
            return;
        }

        uint256 supplyLP = supply - share.balanceOf(FEE_SPLITTER);
        uint256 peWad = _sharePrice(s.navWad);

        // Funding neteado (§6): 100% on-chain y KEEPER-INDEPENDIENTE (S3 — el fix v0.9.1 que capaba
        // por grossClaims permitía a un keeper sub-declarar y reducir la salida del stake, reabriendo
        // §14.6/§14.20). La pérdida agregada NO vesteada es el techo exacto; el vesting per-LP vive
        // solo en el REPARTO vía λ, nunca en cuánto sale del stake.
        uint256 nettedWad = 0;
        if (niAggregateWad > 0) {
            uint256 lpValueWad = supplyLP * peWad / WAD;
            if (uint256(niAggregateWad) > lpValueWad && !frozen) {
                nettedWad = uint256(niAggregateWad) - lpValueWad; // first-loss suspendido en Frozen (§10.3)
            }
        }
        uint256 stakeWad = stakeEscrow.stakeAvailable() * USDG_TO_WAD;
        uint256 fundingWad = nettedWad < stakeWad ? nettedWad : stakeWad;

        // λ = min(1, funding/grossClaims). Con grossClaims vesteado < funding no-vesteado, λ=1 y se paga
        // el claim vesteado de cada LP; el residuo (funding − Σ claims) queda en la reserva y se barre
        // al manager en Closed (v0.9). grossClaims solo baja λ, jamás sube la salida del stake.
        uint256 lambdaWad;
        if (grossClaimsWad == 0) {
            lambdaWad = 0;
        } else {
            lambdaWad = fundingWad * WAD / grossClaimsWad;
            if (lambdaWad > WAD) lambdaWad = WAD;
        }
        if (fundingWad > 0) {
            uint256 funding6 = fundingWad / USDG_TO_WAD;
            stakeEscrow.slash(funding6);
            reserve.creditPeriod(period, funding6);
        }

        // perf fee (§7.2) — omitida en settlement degradado; supply>0 garantizado arriba
        uint256 pFinalWad = peWad;
        if (!degraded && hwmWad > 0 && peWad > hwmWad && config.perfFeeBps > 0) {
            uint256 gainWad = (peWad - hwmWad) * supply / WAD;
            uint256 feeWad = gainWad * config.perfFeeBps / 10000;
            uint256 sFee = feeWad * supply / (s.navWad - feeWad);
            share.mint(FEE_SPLITTER, sFee);
            pFinalWad = s.navWad * WAD / (supply + sFee);
            hwmWad = pFinalWad;
            emit PerfFeeCrystallized(period, feeWad, sFee);
        }

        settlements[period] =
            SettlementRec({peWad: uint128(peWad), lambdaWad: uint128(lambdaWad), markTime: uint48(block.timestamp), degraded: degraded});
        lastMarkTime = uint48(block.timestamp);
        lastValidSharePriceWad = degraded ? lastValidSharePriceWad : pFinalWad;
        _postSettle(s.navWad);
        emit Settled(period, peWad, fundingWad, lambdaWad, degraded);
    }

    /// @dev Transiciones post-settlement comunes (§4, §6).
    function _postSettle(uint256 navWad) internal {
        slippagePeriodWad = 0; // reset del presupuesto de slippage por período (§8)
        budgetStakeWad = stakeEscrow.stakeAvailable() * USDG_TO_WAD; // snapshot no pumpeable (T4)
        if (state == State.PendingWinding) {
            state = State.Winding;
            _voidAllDeposits();
            emit StateChanged(State.Winding);
        }
        // reducción de stake pendiente: solo en settlement, tras slash, con cap-check (§6)
        if (stakeEscrow.withdrawExecutableAt() != 0 && block.timestamp >= stakeEscrow.withdrawExecutableAt()) {
            uint256 remainingWad = (stakeEscrow.stakeAvailable() - stakeEscrow.pendingWithdraw()) * USDG_TO_WAD;
            if (uint256(config.kFactor) * remainingWad >= navWad) {
                stakeEscrow.executeWithdraw();
            }
        }
    }

    // ---------- Estados (§4, §10.2, §10.3) ----------

    function requestWinding() external nonReentrant {
        if (msg.sender != MANAGER) revert NotManager();
        if (state != State.Active) revert WrongState();
        state = State.PendingWinding;
        windingRequestedAt = uint48(block.timestamp);
        emit WindingRequested(windingRequestedAt);
    }

    /// @notice Cierre: todo liquidado a USDG (assets vacíos en 1.3a) + settlement final ejecutado.
    function close() external nonReentrant {
        if (msg.sender != MANAGER) revert NotManager();
        if (state != State.Winding) revert WrongState();
        for (uint256 i; i < assets.length; ++i) {
            if (IERC20(assets[i]).balanceOf(address(this)) > 0) revert WrongState();
        }
        state = State.Closed;
        stakeEscrow.startRelease();
        emit StateChanged(State.Closed);
    }

    /// @notice Con totalShares == 0 todo claim ha materializado: residuo → manager (v0.9) y stake.
    function finalizeClosure(uint64[] calldata periodsToSweep) external nonReentrant {
        if (state != State.Closed || share.totalSupply() != 0) revert WrongState();
        for (uint256 i; i < periodsToSweep.length; ++i) {
            reserve.sweep(periodsToSweep[i], MANAGER);
        }
        stakeEscrow.releaseAll();
    }

    /// @notice Declarable por cualquiera si RHJ bloqueó el fondo (§10.3).
    function declareFrozen() external nonReentrant {
        if (!REGISTRY.accessRegistry().isBlocked(address(this))) revert WrongState();
        frozen = true;
        _voidAllDeposits();
        emit FrozenDeclared();
    }

    /// @notice Redención forzosa por compliance (§10.2): inelegible > 30 días ⇒ cualquiera la encola
    /// como retiro in-kind sin cooldown (burn normal: sin claim extra).
    function forceRedeem(address lp) external nonReentrant {
        uint48 since = GATE.ineligibleSince(lp);
        if (since == 0 || block.timestamp < since + COMPLIANCE_GRACE) revert StillEligible();
        _touch(lp);
        uint256 bal = share.balanceOf(lp) - lockedShares[lp];
        if (bal == 0) revert BadOrder();
        lockedShares[lp] += bal;
        pendingOrders[lp]++; // balancea el decremento de la ejecución; sin tope (orden de compliance)
        // cooldown ya vencido (S15: resta saturada para no revertir en chains de timestamp bajo)
        uint48 reqTime = block.timestamp > config.withdrawCooldown ? uint48(block.timestamp) - config.withdrawCooldown : 0;
        uint256 orderId = withdrawQueue.length;
        withdrawQueue.push(
            WithdrawOrder({lp: lp, shares: uint128(bal), requestTime: reqTime, cancelled: false, inKind: true}) // in-kind: siempre ejecutable (S5)
        );
        emit ForcedRedemption(lp, bal);
        emit WithdrawRequested(orderId, lp, bal, true);
    }

    function _voidAllDeposits() internal {
        for (uint256 i = depositHead; i < depositQueue.length; ++i) {
            DepositOrder storage o = depositQueue[i];
            if (!o.cancelled) {
                o.cancelled = true;
                _refundDeposit(i, o, "anulada por estado");
            }
        }
        depositHead = depositQueue.length;
    }

    // ---------- Trading (§8) ----------

    /// @notice El manager opera vía un adapter whitelisteado. El Fund transfiere `amountIn` al adapter,
    /// éste devuelve `tokenOut`, y el Fund mide sus PROPIOS deltas y aplica el guardarraíl de slippage
    /// contra el cruce Chainlink + el presupuesto acumulado (día + período). La seguridad NO depende
    /// del adapter (que solo se whitelistea para no permitir calldata a contratos cualesquiera).
    function execute(uint256 adapterId, address tokenIn, address tokenOut, uint256 amountIn, bytes calldata data)
        external
        nonReentrant
    {
        if (msg.sender != MANAGER) revert NotManager();
        if (tradingFrozen()) revert FrozenFund();
        if (tokenIn == tokenOut || amountIn == 0) revert BadOrder();
        _requireTradableIn(tokenIn);
        _requireTradableOut(tokenOut);

        address adapter = ADAPTERS.get(adapterId);
        uint256 inBefore = IERC20(tokenIn).balanceOf(address(this));
        uint256 outBefore = IERC20(tokenOut).balanceOf(address(this));
        if (amountIn > inBefore) revert BadOrder();

        IERC20(tokenIn).safeTransfer(adapter, amountIn);
        ITradeAdapter(adapter).swap(tokenIn, tokenOut, amountIn, address(this), data);

        // Deltas reales medidos por el Fund (revisión: no confiar en el adapter)
        uint256 spent = inBefore - IERC20(tokenIn).balanceOf(address(this));
        uint256 received = IERC20(tokenOut).balanceOf(address(this)) - outBefore;
        if (spent > amountIn || spent == 0) revert BadOrder();
        // El adapter no debe retener nada de ninguno de los dos tokens (T5: sin residuos drenables)
        if (IERC20(tokenIn).balanceOf(adapter) != 0 || IERC20(tokenOut).balanceOf(adapter) != 0) revert BadOrder();

        uint256 spentValueWad = _valueWad(tokenIn, spent);
        uint256 recvValueWad = _valueWad(tokenOut, received);

        // Guardarraíl por trade: la pérdida vs el cruce oráculo ≤ maxSlippageBps del valor entregado.
        uint256 adverseWad = spentValueWad > recvValueWad ? spentValueWad - recvValueWad : 0;
        if (adverseWad * 10000 > spentValueWad * MAX_SLIPPAGE_BPS) revert SlippageExceeded();

        // registrar el activo comprado ANTES de acumular (T4: el denominador AUM incluye tokenOut)
        if (tokenOut != address(USDG) && IERC20(tokenOut).balanceOf(address(this)) > 0) {
            _ensureAssetRegistered(tokenOut);
        }
        _accrueSlippage(tokenIn, tokenOut, adverseWad);
        emit Traded(adapterId, tokenIn, tokenOut, spent, received, adverseWad);
    }

    /// @dev El lado COMPRADO (tokenOut) debe estar activo (listado y no suspendido). El lado VENDIDO
    /// (tokenIn) solo necesita estar listado — así el manager puede DES-arriesgarse de un token
    /// suspendido por drift de beacon (§8/C29: "prohibido comprar", no prohibido vender) (T7).
    function _requireTradableIn(address token) internal view {
        if (token == address(USDG)) return;
        if (!REGISTRY.getAsset(token).listed) revert BadOrder();
    }

    function _requireTradableOut(address token) internal view {
        if (token == address(USDG)) return;
        if (!REGISTRY.isActive(token)) revert BadOrder();
    }

    /// @dev Valor WAD de `amount` de `token` al precio oráculo, con la MISMA disciplina que NAVLib
    /// (T1/T2/T6): revierte si el feed está stale, fuera de banda, roto o `updatedAt` en el futuro.
    /// Un precio stale-pero-positivo cegaba el guardarraíl y los presupuestos → extracción ilimitada.
    function _valueWad(address token, uint256 amount) internal view returns (uint256) {
        if (token == address(USDG)) {
            uint256 balWad = amount * USDG_TO_WAD;
            address uFeed = REGISTRY.usdgFeed();
            if (uFeed == address(0)) return balWad; // solo modo degradado de deploy de prueba (§5.5)
            int256 px = _validPrice(uFeed, REGISTRY.usdgMaxStaleness(), REGISTRY.usdgMinAnswer(), REGISTRY.usdgMaxAnswer());
            return balWad * uint256(px) / 1e8;
        }
        TokenRegistry.Asset memory a = REGISTRY.getAsset(token);
        int256 px2 = _validPrice(a.feed, a.maxStaleness, a.minAnswer, a.maxAnswer);
        return amount * uint256(px2) / 1e8;
    }

    /// @dev Devuelve el precio si es válido (fresco, en banda, > 0); revierte si no.
    function _validPrice(address feed, uint48 maxStaleness, int256 minAnswer, int256 maxAnswer)
        internal
        view
        returns (int256)
    {
        if (feed == address(0)) revert SlippageExceeded();
        try IAggregatorV3(feed).latestRoundData() returns (uint80, int256 px, uint256, uint256 upd, uint80) {
            if (px <= 0 || px < minAnswer || px > maxAnswer) revert SlippageExceeded();
            if (upd > block.timestamp || block.timestamp - upd > maxStaleness) revert SlippageExceeded();
            return px;
        } catch {
            revert SlippageExceeded();
        }
    }

    /// @dev Acumula el slippage adverso contra los presupuestos diario y de período (§8). Una reversión
    /// del mismo par dentro de WASH_WINDOW computa doble — detectada por par (no solo el trade anterior),
    /// así que interleaving no la esquiva (T3/T8).
    function _accrueSlippage(address tokenIn, address tokenOut, uint256 adverseWad) internal {
        // bucket diario de ventana FIJA de 24h (no rodante; §8/T11)
        if (block.timestamp >= slippageDayStart + 1 days) {
            slippageDayStart = uint48(block.timestamp);
            slippageDayWad = 0;
            tradesInDay = 0;
        }
        if (++tradesInDay > MAX_TRADES_PER_DAY) revert TradeLimit();

        uint256 charge = adverseWad;
        // ¿hubo un trade en la dirección INVERSA de este par dentro de la ventana? → doble (T8)
        bytes32 reverseKey = keccak256(abi.encodePacked(tokenOut, tokenIn));
        if (dirTradeTime[reverseKey] != 0 && block.timestamp < dirTradeTime[reverseKey] + WASH_WINDOW) {
            charge = adverseWad * 2;
        }
        slippageDayWad += charge;
        slippagePeriodWad += charge;

        // Denominador AUM: vivo (donar para inflarlo no es rentable). Denominador stake: min(vivo,
        // snapshot al settlement) para que un top-up mid-período no suba el techo (T4).
        uint256 aumWad = nav().navWad;
        if (slippageDayWad * 10000 > aumWad * SLIPPAGE_BUDGET_DAY_BPS) revert BudgetExceeded();
        uint256 liveStakeWad = stakeEscrow.stakeAvailable() * USDG_TO_WAD;
        uint256 stakeWad = budgetStakeWad == 0 ? liveStakeWad : (liveStakeWad < budgetStakeWad ? liveStakeWad : budgetStakeWad);
        if (slippagePeriodWad * 10000 > stakeWad * SLIPPAGE_BUDGET_PERIOD_BPS) revert BudgetExceeded();

        dirTradeTime[keccak256(abi.encodePacked(tokenIn, tokenOut))] = uint48(block.timestamp);
    }

    function _ensureAssetRegistered(address token) internal {
        uint256 n = assets.length;
        for (uint256 i; i < n; ++i) {
            if (assets[i] == token) return;
        }
        if (n >= 32) revert BadOrder();
        // inserción ordenada (F13)
        if (n > 0 && token < assets[n - 1]) {
            for (uint256 i; i < n; ++i) {
                if (token < assets[i]) {
                    assets.push(assets[n - 1]);
                    for (uint256 j = n - 1; j > i; --j) {
                        assets[j] = assets[j - 1];
                    }
                    assets[i] = token;
                    emit AssetRegistered(token);
                    return;
                }
            }
        }
        assets.push(token);
        emit AssetRegistered(token);
    }

    // ---------- Activos ----------

    /// @notice Registra un activo en la cartera (orden estricto ascendente, F13). Restringido a
    /// manager/keeper (S8: permissionless permitía inflar `assets[]` con polvo de muchos tokens hasta
    /// hacer que los loops de NAV superaran el gas límite). Cap de longitud como backstop.
    function registerAsset(address token) external nonReentrant {
        if (msg.sender != MANAGER && msg.sender != KEEPER) revert NotManager();
        if (assets.length >= 32) revert BadOrder(); // cap de cartera (§10, backstop de gas)
        if (!REGISTRY.isActive(token) || IERC20(token).balanceOf(address(this)) == 0) revert BadOrder();
        emit AssetRegistered(token);
        uint256 n = assets.length;
        if (n > 0 && token <= assets[n - 1]) {
            // inserción ordenada
            for (uint256 i; i < n; ++i) {
                if (assets[i] == token) revert BadOrder();
                if (token < assets[i]) {
                    assets.push(assets[n - 1]);
                    for (uint256 j = n - 1; j > i; --j) {
                        assets[j] = assets[j - 1];
                    }
                    assets[i] = token;
                    return;
                }
            }
        }
        assets.push(token);
    }

    function assetCount() external view returns (uint256) {
        return assets.length;
    }

    /// @notice Elimina de la cartera un activo con balance cero (T9: evita que 32 slots se agoten
    /// con posiciones muertas y que los loops de NAV crezcan sin cota). Manager/keeper.
    function deregisterAsset(address token) external nonReentrant {
        if (msg.sender != MANAGER && msg.sender != KEEPER) revert NotManager();
        if (IERC20(token).balanceOf(address(this)) != 0) revert BadOrder();
        uint256 n = assets.length;
        for (uint256 i; i < n; ++i) {
            if (assets[i] == token) {
                for (uint256 j = i; j + 1 < n; ++j) {
                    assets[j] = assets[j + 1]; // preserva el orden ascendente (F13)
                }
                assets.pop();
                return;
            }
        }
        revert BadOrder();
    }

    // ---------- Vistas ----------

    function accountOf(address lp) external view returns (Account memory) {
        return _accounts[lp];
    }

    function queueLengths() external view returns (uint256 deposits, uint256 withdrawals) {
        return (depositQueue.length - depositHead, withdrawQueue.length - withdrawHead);
    }
}
