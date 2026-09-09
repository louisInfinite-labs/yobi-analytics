/** Per-creator Oshi image position/scale, persisted the same way layoutStore
 * persists dashboard layouts: plain localStorage, never throws, corrupt/
 * missing data silently falls back to a sane default rather than crashing
 * Home. `x`/`y` are percentages of the Home scene (matching every other
 * layer's coordinate space); `scale` is a plain multiplier on the image's
 * natural size. */

export interface OshiTransform {
  x: number
  y: number
  scale: number
}

export const DEFAULT_OSHI_TRANSFORM: OshiTransform = { x: 30, y: 62, scale: 1 }

const MIN_SCALE = 0.4
const MAX_SCALE = 2.5

function storageKey(creatorId: string): string {
  return `yobi.home.oshiTransform.${creatorId}`
}

function isValidTransform(value: unknown): value is OshiTransform {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as OshiTransform).x === "number" &&
    typeof (value as OshiTransform).y === "number" &&
    typeof (value as OshiTransform).scale === "number"
  )
}

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

export function readOshiTransform(creatorId: string, storage?: Storage): OshiTransform {
  try {
    const raw = (storage ?? window.localStorage).getItem(storageKey(creatorId))
    if (!raw) return DEFAULT_OSHI_TRANSFORM
    const parsed: unknown = JSON.parse(raw)
    if (!isValidTransform(parsed)) return DEFAULT_OSHI_TRANSFORM
    return { ...parsed, scale: clampScale(parsed.scale) }
  } catch {
    return DEFAULT_OSHI_TRANSFORM
  }
}

export function writeOshiTransform(creatorId: string, transform: OshiTransform, storage?: Storage): boolean {
  try {
    ;(storage ?? window.localStorage).setItem(storageKey(creatorId), JSON.stringify(transform))
    return true
  } catch {
    return false
  }
}

export function resetOshiTransform(creatorId: string, storage?: Storage): void {
  try {
    ;(storage ?? window.localStorage).removeItem(storageKey(creatorId))
  } catch {
    // Best-effort, matching layoutStore.resetLayout's own reasoning.
  }
}
