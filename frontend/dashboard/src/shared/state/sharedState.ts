import { useCallback, useSyncExternalStore } from "react"

/** A module-scoped (singleton) store backed by localStorage. Every
 * component that calls the hook built on top of one of these shares ONE
 * reactive value instead of each mounting its own isolated `useState` that
 * only happened to read the same localStorage key at mount time — the
 * architectural gap this session's "SELECTED OSHI MUST SYNC IMMEDIATELY"
 * correction closes for useSelectedCreator/useFavoriteCreators/
 * useConfirmOshiSwitchPreference/useLocale. The in-memory `value` is the
 * actual source of truth every subscriber reads; localStorage is only ever
 * a write-through cache read once at module load, for next page load. */
export interface SharedState<T> {
  get: () => T
  set: (next: T) => void
  subscribe: (listener: () => void) => () => void
}

interface RegisteredStore {
  resetForTests: () => void
}

const registeredStores: RegisteredStore[] = []

export function createSharedState<T>(storageKey: string, read: () => T, serialize: (value: T) => string): SharedState<T> {
  let value = read()
  const listeners = new Set<() => void>()

  const store: SharedState<T> & RegisteredStore = {
    get: () => value,
    set(next) {
      if (next === value) return
      value = next
      try {
        window.localStorage.setItem(storageKey, serialize(next))
      } catch {
        // Best-effort persistence, matching every consumer's own
        // pre-existing reasoning — a failed write still updates every
        // mounted subscriber in this tab via the listeners below.
      }
      listeners.forEach((listener) => listener())
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    resetForTests() {
      value = read()
      listeners.forEach((listener) => listener())
    },
  }
  registeredStores.push(store)
  return store
}

/** Test-only: re-reads every shared store from localStorage, so each test
 * starts as if the page had just loaded instead of carrying over whatever
 * the previous test's components set in memory — a module-level singleton
 * (required for same-tab reactivity) would otherwise leak its in-memory
 * value across tests despite `localStorage.clear()`, since it isn't
 * re-created per test the way a component-local useState would be. Call
 * this AFTER clearing localStorage (see src/test/setup.ts). */
export function resetAllSharedStateForTests(): void {
  registeredStores.forEach((store) => store.resetForTests())
}

/** Subscribes the calling component to `store` and returns the same
 * `[value, setValue]` shape a plain useState-backed hook already returned,
 * so hooks built on this need no change to their own public API. */
export function useSharedState<T>(store: SharedState<T>): [T, (next: T) => void] {
  const value = useSyncExternalStore(store.subscribe, store.get)
  const setValue = useCallback((next: T) => store.set(next), [store])
  return [value, setValue]
}
