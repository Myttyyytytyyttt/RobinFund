/**
 * ABI mínimo del Fund que el keeper necesita. Fuente de verdad: los artefactos de Foundry en
 * `packages/contracts/out/Fund.sol/Fund.json`. Aquí solo las funciones/eventos que consumimos, para
 * no acoplar el keeper a la compilación. Si cambia la firma en el contrato, actualizar aquí.
 */
export const fundAbi = [
  // --- lectura de estado ---
  {
    type: "function",
    name: "accountOf",
    stateMutability: "view",
    inputs: [{ name: "lp", type: "address" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "niWad", type: "int256" },
          { name: "vestTime", type: "uint48" },
          { name: "settledThrough", type: "uint64" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "nav",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "navWad", type: "uint256" },
          { name: "valid", type: "bool" },
        ],
      },
    ],
  },
  { type: "function", name: "share", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "stakeEscrow", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "GATE", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  {
    type: "function",
    name: "queueLengths",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "deposits", type: "uint256" },
      { name: "withdrawals", type: "uint256" },
    ],
  },
  { type: "function", name: "withdrawHead", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "withdrawQueue",
    stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [
      { name: "lp", type: "address" },
      { name: "shares", type: "uint128" },
      { name: "requestTime", type: "uint48" },
      { name: "cancelled", type: "bool" },
      { name: "inKind", type: "bool" },
    ],
  },
  { type: "function", name: "niAggregateWad", stateMutability: "view", inputs: [], outputs: [{ type: "int256" }] },
  { type: "function", name: "FEE_SPLITTER", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "currentPeriod", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
  { type: "function", name: "settlementDue", stateMutability: "view", inputs: [], outputs: [{ type: "uint48" }] },
  { type: "function", name: "state", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "frozen", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "guardianPaused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  {
    type: "function",
    name: "config",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "perfFeeBps", type: "uint16" },
      { name: "feeMinBps", type: "uint16" },
      { name: "feeMaxBps", type: "uint16" },
      { name: "managerEntryShareBps", type: "uint16" },
      { name: "kFactor", type: "uint16" },
      { name: "period", type: "uint32" },
      { name: "withdrawCooldown", type: "uint32" },
    ],
  },
  // --- acciones del keeper ---
  {
    type: "function",
    name: "settle",
    stateMutability: "nonpayable",
    inputs: [{ name: "grossClaimsWad", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "executeBatch",
    stateMutability: "nonpayable",
    inputs: [{ name: "grossClaimsWad", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "executeInKindWithdrawals",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  { type: "function", name: "declareFrozen", stateMutability: "nonpayable", inputs: [], outputs: [] },
  // --- eventos (para descubrir el set de LPs y monitorear) ---
  {
    type: "event",
    name: "DepositExecuted",
    inputs: [
      { name: "orderId", type: "uint256", indexed: true },
      { name: "lp", type: "address", indexed: true },
      { name: "amount6", type: "uint256", indexed: false },
      { name: "sharesMinted", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Settled",
    inputs: [
      { name: "period", type: "uint64", indexed: true },
      { name: "peWad", type: "uint256", indexed: false },
      { name: "fundingWad", type: "uint256", indexed: false },
      { name: "lambdaWad", type: "uint256", indexed: false },
      { name: "degraded", type: "bool", indexed: false },
    ],
  },
] as const;

export const shareAbi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

export const stakeEscrowAbi = [
  { type: "function", name: "stakeAvailable", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "addStake", stateMutability: "nonpayable", inputs: [{ name: "amount", type: "uint256" }], outputs: [] },
] as const;

/** ACCESS registry de RHJ — para monitorear si un fondo fue bloqueado (§10.3). */
export const accessRegistryAbi = [
  { type: "function", name: "isBlocked", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
] as const;

/** FundRegistry — enumeración de los fondos que el runner atiende. */
export const fundRegistryAbi = [
  { type: "function", name: "fundCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "funds", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "address" }] },
] as const;
