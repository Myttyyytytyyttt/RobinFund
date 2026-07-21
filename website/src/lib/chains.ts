import { defineChain } from 'viem'

const configuredChainId = Number(import.meta.env.VITE_RH_CHAIN_ID || 4663)
const isLocalDevnet = configuredChainId === 31337

/** Robinhood Chain mainnet (L2 Arbitrum Orbit). RPC público — la key de Alchemy no va al frontend. */
export const robinhoodChain = defineChain({
  id: configuredChainId,
  name: isLocalDevnet ? 'NuvemFund Devnet' : 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: {
      http: [import.meta.env.VITE_RH_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com'],
    },
  },
  ...(isLocalDevnet
    ? {}
    : {
        blockExplorers: {
          default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' },
        },
      }),
})

export const isNuvemDevnet = isLocalDevnet
