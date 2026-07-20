/** ABIs que el drill consume (subconjunto; fuente de verdad en packages/contracts). */
import { parseAbi } from "viem";

export const fundAbi = parseAbi([
  "function share() view returns (address)",
  "function stakeEscrow() view returns (address)",
  "function FEE_SPLITTER() view returns (address)",
  "function state() view returns (uint8)",
  "function frozen() view returns (bool)",
  "function currentPeriod() view returns (uint64)",
  "function settlementDue() view returns (uint48)",
  "function nav() view returns (uint256 navWad, bool valid)",
  "function niAggregateWad() view returns (int256)",
  "function aumCapWad() view returns (uint256)",
  "function accountOf(address) view returns (int256 niWad, uint48 vestTime, uint64 settledThrough)",
  "function queueLengths() view returns (uint256 deposits, uint256 withdrawals)",
  "function requestDeposit(uint256 amount6) returns (uint256)",
  "function requestWithdraw(uint256 shares_, bool inKind) returns (uint256)",
  "function cancelDeposit(uint256 orderId)",
  "function execute(uint256 adapterId, address tokenIn, address tokenOut, uint256 amountIn, bytes data)",
  "function executeBatch(uint256 grossClaimsWad)",
  "function requestWinding()",
  "function close()",
  "function finalizeClosure(uint64[] periodsToSweep)",
  "function claim()",
]);

export const shareAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
]);

export const stakeEscrowAbi = parseAbi([
  "function addStake(uint256 amount)",
  "function stakeAvailable() view returns (uint256)",
]);

export const erc20 = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);

export const gateRevokeAbi = parseAbi(["function revoke(address account)"]);
