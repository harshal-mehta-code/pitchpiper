import { useEffect, useRef } from 'react'

/**
 * Keep the screen alive while the app is open.
 *
 * A pitch pipe that has locked itself and needs a passcode halfway through a
 * run-through is worse than no pitch pipe. The lock is dropped when the tab
 * hides and re-acquired on return, which is what the spec requires anyway.
 */
export function useWakeLock(enabled: boolean) {
  const lockRef = useRef<WakeLockSentinel | null>(null)

  useEffect(() => {
    if (!enabled || !('wakeLock' in navigator)) return
    let cancelled = false

    const acquire = async () => {
      if (cancelled || document.visibilityState !== 'visible') return
      if (lockRef.current) return
      try {
        const lock = await navigator.wakeLock.request('screen')
        if (cancelled) {
          void lock.release()
          return
        }
        lockRef.current = lock
        lock.addEventListener('release', () => {
          lockRef.current = null
        })
      } catch {
        // Denied, low battery, or unsupported. Not worth surfacing.
      }
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible') void acquire()
    }

    void acquire()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisibility)
      void lockRef.current?.release()
      lockRef.current = null
    }
  }, [enabled])
}
