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

/// @title Fund — núcleo del mecanismo RobinFund (SPEC v0.9 §4–§10; Fase 1.3a)
/// @notice Esta pasada implementa: estados, colas con forward pricing estricto, secuencia canónica
/// de batch, contabilidad NI de por vida con materialización perezosa y vesting, entry fee en curva,
/// perf fee con HWM ajustado, settlement con marca no discrecional + degradado, y claims pull.
/// DIFERIDO y documentado: trading vía adapters (Fase 1.4 — este Fund aún no opera activos, aunque
/// los valora si se le transfieren); liquidación keeper-asistida de retiros cash (1.4 — un retiro
/// cash solo ejecuta si el USDG del fondo lo cubre; el LP puede convertirlo a in-kind); mecánica
/// Frozen completa y true-up al alza del collar in-kind (1.3b).
/// FIX DE SPEC (v0.9.1, detectado aquí): el vesting reduce grossClaims pero la fórmula de funding
/// no lo sabía — con cobertura parcial `grossClaims ≥ funding` era insatisfacible con datos
/// honestos. Corregido: `funding = min(stake, neteado, grossClaims)` — el neteado sigue siendo el
/// techo (inmunidad Sybil intacta) y λ ≤ 1 por construcción.
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
    address public immutable MANAGER;
    address public immutable KEEPER; // publica grossClaims en settle (confianza v1, §15)
    address public immutable FEE_SPLITTER; // excluido de la contabilidad NI (§7.3)
    address public immutable PROTOCOL_TREASURY;
    Config public config;

    // ---------- Estado ----------

    State public state;
    bool public frozen; // cacheado; declarable permissionless si isBlocked(fund) (§10.3)

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
    error GrossClaimsTooLow();
    error BlackoutActive();
    error StillEligible();
    error SharesLocked();

    // ---------- Construcción ----------

    constructor(
        TokenRegistry registry_,
        IEligibilityGate gate_,
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
    function claim() external {
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

    function requestDeposit(uint256 amount6) external returns (uint256 orderId) {
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

    function cancelDeposit(uint256 orderId) external {
        DepositOrder storage o = depositQueue[orderId];
        if (o.lp != msg.sender || o.cancelled || orderId < depositHead) revert BadOrder();
        o.cancelled = true;
        _refundDeposit(orderId, o, "cancelada");
    }

    function requestWithdraw(uint256 shares_, bool inKind) external returns (uint256 orderId) {
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
    function cancelWithdraw(uint256 orderId) external {
        WithdrawOrder storage o = withdrawQueue[orderId];
        if (o.lp != msg.sender || o.cancelled || orderId < withdrawHead) revert BadOrder();
        if (block.timestamp >= o.requestTime + config.withdrawCooldown) revert CooldownActive();
        o.cancelled = true;
        lockedShares[msg.sender] -= o.shares;
        pendingOrders[msg.sender]--;
        emit OrderCancelled(orderId, false);
    }

    /// @notice Convierte un retiro cash pendiente a in-kind (válvula §5.6.5).
    function convertToInKind(uint256 orderId) external {
        WithdrawOrder storage o = withdrawQueue[orderId];
        if (o.lp != msg.sender || o.cancelled || orderId < withdrawHead) revert BadOrder();
        o.inKind = true;
    }

    // ---------- Ejecución de batches (§5.4) ----------

    /// @notice Ejecuta la secuencia canónica en una ventana válida: settlement si due →
    /// depósitos FIFO → retiros FIFO. Permissionless.
    function executeBatch(uint256 grossClaimsWad) external {
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

            // fee-fondo sube el NAV y ajusta el HWM ANTES del mint (§5.4.iv, C4)
            uint256 supply = share.totalSupply();
            if (supply > 0 && feeFondoWad > 0) {
                hwmWad += feeFondoWad * WAD / supply; // HWM += crédito por share (aporte, no performance)
            }
            navWad += feeFondoWad;

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
            uint256 dueWad = uint256(o.shares) * price / WAD;
            uint256 due6 = dueWad / USDG_TO_WAD;

            if (o.inKind) {
                _executeInKind(withdrawHead, o, price);
            } else {
                // 1.3a: paga solo si el USDG del fondo cubre (liquidación keeper-asistida en 1.4)
                if (USDG.balanceOf(address(this)) < due6) break;
                _settleNiOnBurn(o.lp, o.shares, due6 * USDG_TO_WAD);
                share.burn(o.lp, o.shares);
                lockedShares[o.lp] -= o.shares;
                pendingOrders[o.lp]--;
                USDG.safeTransfer(o.lp, due6);
                navWad -= due6 * USDG_TO_WAD;
                emit WithdrawExecuted(withdrawHead, o.lp, o.shares, due6, false);
            }
            withdrawHead++;
        }
    }

    function _executeInKind(uint256 orderId, WithdrawOrder storage o, uint256 priceIfValid) internal {
        uint256 supply = share.totalSupply();
        // proceeds para NI: collar (§6, simplificado 1.3a — sin true-up al alza posterior)
        uint256 refPrice = priceIfValid > lastValidSharePriceWad ? priceIfValid : lastValidSharePriceWad;
        _settleNiOnBurn(o.lp, o.shares, uint256(o.shares) * refPrice / WAD);

        // pro-rata físico de cada activo + USDG (try/catch: en Frozen salta tokens bloqueados, §10.3)
        for (uint256 i; i < assets.length; ++i) {
            uint256 bal = IERC20(assets[i]).balanceOf(address(this));
            uint256 slice = bal * o.shares / supply;
            if (slice > 0) {
                (bool ok,) = assets[i].call(abi.encodeCall(IERC20.transfer, (o.lp, slice)));
                ok; // residual de tokens intransferibles: TODO 1.3b (claim in-kind)
            }
        }
        uint256 usdgSlice = USDG.balanceOf(address(this)) * o.shares / supply;
        share.burn(o.lp, o.shares);
        lockedShares[o.lp] -= o.shares;
        pendingOrders[o.lp]--;
        if (usdgSlice > 0) USDG.safeTransfer(o.lp, usdgSlice);
        emit WithdrawExecuted(orderId, o.lp, o.shares, usdgSlice, true);
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
    function settle(uint256 grossClaimsWad) external {
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
        uint256 supplyLP = supply - share.balanceOf(FEE_SPLITTER);
        uint256 peWad = _sharePrice(s.navWad);

        // funding neteado (§6) + fix v0.9.1: min(stake, neteado, grossClaims)
        uint256 nettedWad = 0;
        if (niAggregateWad > 0) {
            uint256 lpValueWad = supplyLP * peWad / WAD;
            if (uint256(niAggregateWad) > lpValueWad && !frozen) {
                nettedWad = uint256(niAggregateWad) - lpValueWad; // first-loss suspendido en Frozen (§10.3)
            }
        }
        uint256 stakeWad = stakeEscrow.stakeAvailable() * USDG_TO_WAD;
        uint256 fundingWad = nettedWad < stakeWad ? nettedWad : stakeWad;
        if (fundingWad > grossClaimsWad) fundingWad = grossClaimsWad; // v0.9.1
        if (grossClaimsWad < fundingWad) revert GrossClaimsTooLow(); // λ ≤ 1 (redundante tras el min, belt)

        uint64 period = ++currentPeriod;
        uint256 lambdaWad = grossClaimsWad == 0 ? 0 : fundingWad * WAD / grossClaimsWad;
        if (fundingWad > 0) {
            uint256 funding6 = fundingWad / USDG_TO_WAD;
            stakeEscrow.slash(funding6);
            reserve.creditPeriod(period, funding6);
        }

        // perf fee (§7.2) — omitida en settlement degradado
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

        // transición de Winding pendiente (§4)
        if (state == State.PendingWinding) {
            state = State.Winding;
            _voidAllDeposits();
            emit StateChanged(State.Winding);
        }
        // reducción de stake pendiente: solo en settlement, tras slash, con cap-check (§6)
        if (stakeEscrow.withdrawExecutableAt() != 0 && block.timestamp >= stakeEscrow.withdrawExecutableAt()) {
            uint256 remainingWad = (stakeEscrow.stakeAvailable() - stakeEscrow.pendingWithdraw()) * USDG_TO_WAD;
            if (uint256(config.kFactor) * remainingWad >= s.navWad) {
                stakeEscrow.executeWithdraw();
            }
        }
        emit Settled(period, peWad, fundingWad, lambdaWad, degraded);
    }

    // ---------- Estados (§4, §10.2, §10.3) ----------

    function requestWinding() external {
        if (msg.sender != MANAGER) revert NotManager();
        if (state != State.Active) revert WrongState();
        state = State.PendingWinding;
        windingRequestedAt = uint48(block.timestamp);
        emit WindingRequested(windingRequestedAt);
    }

    /// @notice Cierre: todo liquidado a USDG (assets vacíos en 1.3a) + settlement final ejecutado.
    function close() external {
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
    function finalizeClosure(uint64[] calldata periodsToSweep) external {
        if (state != State.Closed || share.totalSupply() != 0) revert WrongState();
        for (uint256 i; i < periodsToSweep.length; ++i) {
            reserve.sweep(periodsToSweep[i], MANAGER);
        }
        stakeEscrow.releaseAll();
    }

    /// @notice Declarable por cualquiera si RHJ bloqueó el fondo (§10.3).
    function declareFrozen() external {
        if (!REGISTRY.accessRegistry().isBlocked(address(this))) revert WrongState();
        frozen = true;
        _voidAllDeposits();
        emit FrozenDeclared();
    }

    /// @notice Redención forzosa por compliance (§10.2): inelegible > 30 días ⇒ cualquiera la encola
    /// como retiro in-kind sin cooldown (burn normal: sin claim extra).
    function forceRedeem(address lp) external {
        uint48 since = GATE.ineligibleSince(lp);
        if (since == 0 || block.timestamp < since + COMPLIANCE_GRACE) revert StillEligible();
        _touch(lp);
        uint256 bal = share.balanceOf(lp) - lockedShares[lp];
        if (bal == 0) revert BadOrder();
        lockedShares[lp] += bal;
        pendingOrders[lp]++;
        uint256 orderId = withdrawQueue.length;
        withdrawQueue.push(
            WithdrawOrder({lp: lp, shares: uint128(bal), requestTime: uint48(block.timestamp) - config.withdrawCooldown, cancelled: false, inKind: false})
        );
        emit ForcedRedemption(lp, bal);
        emit WithdrawRequested(orderId, lp, bal, false);
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

    // ---------- Activos ----------

    /// @notice Registra un activo en la cartera (orden estricto ascendente, F13). Permissionless:
    /// solo puede añadir activos listados que el fondo realmente posee — lo usará el adapter (1.4)
    /// y permite valorar transferencias entrantes directas.
    function registerAsset(address token) external {
        if (!REGISTRY.isActive(token) || IERC20(token).balanceOf(address(this)) == 0) revert BadOrder();
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

    // ---------- Vistas ----------

    function accountOf(address lp) external view returns (Account memory) {
        return _accounts[lp];
    }

    function queueLengths() external view returns (uint256 deposits, uint256 withdrawals) {
        return (depositQueue.length - depositHead, withdrawQueue.length - withdrawHead);
    }
}
