import { useSyncExternalStore } from "react"

/** Whether the latest Settings notification write (a reminder or a per-creator new-video switch) was rejected by
 * the backend and therefore NOT applied. Module-scoped and deliberately not persisted: it only drives the inline
 * "couldn't save" alert, and a reload shows the last confirmed state instead. */
let failed = false
const listeners = new Set<() => void>()

function setFailed(next: boolean): void {
  if (failed === next) return
  failed = next
  listeners.forEach((listener) => listener())
}

export function reportNotificationSaveFailed(): void {
  setFailed(true)
}

export function clearNotificationSaveFailed(): void {
  setFailed(false)
}

/** Test-only (wired into src/test/setup.ts like the other non-persisted module singletons). */
export function resetNotificationSaveStatusForTests(): void {
  setFailed(false)
}

export function useNotificationSaveFailed(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => failed,
  )
}
