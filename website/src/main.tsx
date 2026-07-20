import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { PrivyProvider } from '@privy-io/react-auth'
import './index.css'
import App from './App'
import { robinhoodChain } from './lib/chains'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PrivyProvider
      appId={import.meta.env.VITE_PRIVY_APP_ID}
      config={{
        // Solo wallets EVM externas; sin email/social ni embedded wallets
        loginMethods: ['wallet'],
        appearance: {
          theme: 'light',
          accentColor: '#111827',
          walletChainType: 'ethereum-only',
        },
        embeddedWallets: {
          ethereum: { createOnLogin: 'off' },
        },
        defaultChain: robinhoodChain,
        supportedChains: [robinhoodChain],
      }}
    >
      <App />
    </PrivyProvider>
  </StrictMode>,
)
