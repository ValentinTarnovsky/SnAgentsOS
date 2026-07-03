/**
 * Router-less phase switch. The client's state machine drives store.phase; each
 * value maps to one full-screen surface. Banners (reconnecting/desktopGone/
 * disabled) overlay the live MainScreen and are handled inside it, not here.
 */
import type { ReactNode } from 'react'
import { useRemoteStore } from './lib/store'
import { WelcomeScreen } from './components/WelcomeScreen'
import { PairScreen } from './components/PairScreen'
import { RevokedScreen } from './components/RevokedScreen'
import { MainScreen } from './components/MainScreen'
import { ConnectingScreen, ImpostorScreen, LockedScreen, RePairScreen } from './components/StatusScreens'

export function App(): ReactNode {
  const phase = useRemoteStore((s) => s.phase)
  switch (phase) {
    case 'live':
      return <MainScreen />
    case 'welcome':
      return <WelcomeScreen />
    case 'pairForm':
    case 'pairPending':
    case 'pairDenied':
      return <PairScreen />
    case 'revoked':
      return <RevokedScreen />
    case 'rePair':
      return <RePairScreen />
    case 'impostor':
      return <ImpostorScreen />
    case 'locked':
      return <LockedScreen />
    case 'idle':
    case 'connecting':
    default:
      return <ConnectingScreen />
  }
}
