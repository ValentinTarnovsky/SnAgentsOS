import { useEffect, useState } from 'react'

/**
 * Re-render once when `at` (epoch ms) arrives: a single timeout while
 * mounted, none while `at` is null or already past, and no polling
 * interval. A chip whose words change at a known moment (the next whole
 * minute of a silence, a limit's reset) reads Date.now() when it renders
 * and hands its next moment in here.
 */
export function useTickAt(at: number | null): void {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (at === null) return
    const wait = at - Date.now()
    if (wait <= 0) return
    // A few ms late, so the render that follows sits past the boundary.
    const id = setTimeout(() => setTick((n) => n + 1), wait + 25)
    return () => clearTimeout(id)
  }, [at])
}
