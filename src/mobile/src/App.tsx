/**
 * Router-less phase switch. The client's state machine drives store.phase; each
 * value maps to one full-screen surface. Banners (reconnecting/desktopGone/
 * disabled) overlay the live MainScreen and are handled inside it, not here.
 * The in-app QR scanner is a separate overlay on top of whatever phase is
 * showing, opened via store.scanOpen from the screens that ask for a scan.
 */
import type { ReactNode } from 'react'
import { useRemoteStore } from './lib/store'
import { WelcomeScreen } from './components/WelcomeScreen'
import { PairScreen } from './components/PairScreen'
import { RevokedScreen } from './components/RevokedScreen'
import { MainScreen } from './components/MainScreen'
import { ScanScreen } from './components/ScanScreen'
import { ConnectingScreen, ImpostorScreen, LockedScreen, RePairScreen } from './components/StatusScreens'

function screenFor(phase: ReturnType<typeof useRemoteStore.getState>['phase']): ReactNode {
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

export function App(): ReactNode {
  const phase = useRemoteStore((s) => s.phase)
  const scanOpen = useRemoteStore((s) => s.scanOpen)
  return (
    <>
      {screenFor(phase)}
      {scanOpen && <ScanScreen />}
    </>
  )
}
