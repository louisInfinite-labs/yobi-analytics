import { useSyncExternalStore } from "react"

/** ONE shared "now" for every countdown / start-time display (Home's Oshi Status and Live Status dock, the Schedule page and its
 * detail modal). It ticks exactly at wall-clock minute boundaries, so a countdown (which only changes once per minute) changes at the
 * same instant everywhere. Two independent 30-second timers with different start phases used to disagree for up to a minute -- the
 * same stream read "In 1h:30m" on Home and "In 1h:29m" on Schedule at the same moment. */

/** A hair after the boundary, so `new Date()` is unambiguously inside the new minute even with timer jitter. */
const BOUNDARY_SLACK_MS = 20
/** Without subscribers nothing refreshes the value, so a render that finds it older than this takes a fresh one. */
const STALE_AFTER_MS = 30_000

let current = new Date()
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setTimeout> | null = null

function scheduleNextBoundary(): void {
  const wait = 60_000 - (Date.now() % 60_000) + BOUNDARY_SLACK_MS
  timer = setTimeout(() => {
    current = new Date()
    listeners.forEach((listener) => listener())
    scheduleNextBoundary()
  }, wait)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (timer === null) {
    current = new Date()
    scheduleNextBoundary()
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }
}

function getSnapshot(): Date {
  // Stable between ticks; only refreshed here when nobody is subscribed (no timer running) and the value has gone stale.
  if (timer === null && Math.abs(Date.now() - current.getTime()) > STALE_AFTER_MS) current = new Date()
  return current
}

/** The current time, updated at every wall-clock minute boundary for every consumer at once. */
export function useMinuteClock(): Date {
  return useSyncExternalStore(subscribe, getSnapshot)
}
