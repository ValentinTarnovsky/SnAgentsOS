import { useEffect, useState } from 'react'
import type { AppInfo } from '@shared/ipc-contract'

/** Fetches static app metadata (version, platform, portable flag) once. */
export function useAppInfo(): AppInfo | null {
  const [info, setInfo] = useState<AppInfo | null>(null)
  useEffect(() => {
    window.snApi.app
      .info()
      .then(setInfo)
      .catch(() => setInfo(null))
  }, [])
  return info
}
