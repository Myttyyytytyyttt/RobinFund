import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { PrivyProvider } from '@privy-io/react-auth'
import './index.css'
import App from './App'
import AppErrorBoundary from './components/AppErrorBoundary'
import { robinhoodChain } from './lib/chains'

// Privy's App ID is a public browser identifier (it is included in every client
// bundle). Keeping the production ID as a fallback prevents a missing Vercel
// VITE_* variable from taking down the whole application. The App Secret must
// remain server-only and must never be added here or prefixed with VITE_.
const PRIVY_APP_ID =
  import.meta.env.VITE_PRIVY_APP_ID?.trim() || 'cmrsii6e3010e0cl3qs0ri7qx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary>
      <PrivyProvider
        appId={PRIVY_APP_ID}
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
    </AppErrorBoundary>
  </StrictMode>,
)
