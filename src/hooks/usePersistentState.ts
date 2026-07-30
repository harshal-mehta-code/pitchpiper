import { useCallback, useState } from 'react'

/**
 * State that survives a reload. Directors set their tuning and hall mode once
 * and should never think about it again.
 */
export function usePersistentState<T>(key: string, initial: T) {
  const storageKey = `pitchpiper:${key}`

  const [value, setValue] = useState<T>(() => {
    try {
      // Fall back to the pre-rename key so nobody's tuning and volume reset
      // out from under them when the app changed name.
      const raw =
        localStorage.getItem(storageKey) ?? localStorage.getItem(`pipedream:${key}`)
      return raw === null ? initial : (JSON.parse(raw) as T)
    } catch {
      return initial
    }
  })

  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const resolved =
          typeof next === 'function' ? (next as (p: T) => T)(prev) : next
        try {
          localStorage.setItem(storageKey, JSON.stringify(resolved))
        } catch {
          // Private mode, quota, whatever. The app still works in-session.
        }
        return resolved
      })
    },
    [storageKey],
  )

  return [value, set] as const
}
