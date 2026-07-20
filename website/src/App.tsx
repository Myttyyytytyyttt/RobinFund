import NuvemFundHero from './fronts/NuvemFundHero'
import ProfileView from './components/ProfileView'

export default function App() {
  // Preview de diseño del perfil sin wallet: ?profile=demo
  const profileDemo = new URLSearchParams(window.location.search).get('profile') === 'demo'

  return (
    <>
      <NuvemFundHero audioDisabled={profileDemo} />

      {profileDemo && (
        <ProfileView
          profile={{ address: '0x1234abcd5678ef901234abcd5678ef901234abcd', username: 'mytyty', twitter: 'mytyty', createdAt: Date.now() }}
          onClose={() => { window.location.search = '' }}
          previewData
        />
      )}
    </>
  )
}
