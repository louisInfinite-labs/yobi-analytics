export type ScheduledStreamStatus = "live" | "upcoming" | "ended" | "premiere"

export interface ScheduledStream {
  id: string
  channelId: string
  videoId: string
  title: string
  description: string
  status: ScheduledStreamStatus
  /** Epoch ms -- the slot this stream renders in and an upcoming stream's starts-in text are both derived from this, not stored
   * separately. (A live stream's "started" text uses actualStartMs below.) */
  scheduledStartMs: number
  /** Epoch ms of the stream's ACTUAL start, when the backend reports one (a live stream). The popup's "started ..." text uses this, never
   * scheduledStartMs (which only places the stream on the grid) or any published time. */
  actualStartMs?: number
  /** The stream's own backend thumbnail (GET /live-streams `thumbnailUrl`), when it has one. */
  thumbnailUrl?: string
  topics: string[]
}

/** Spec: live badge shows for a currently-live stream, or an upcoming one
 * starting within the next 60 minutes -- not for anything further out or
 * already ended. */
export function shouldShowLiveBadge(status: ScheduledStreamStatus, scheduledStartMs: number, nowMs: number): boolean {
  if (status === "live") return true
  if (status !== "upcoming") return false
  const minutesUntilStart = (scheduledStartMs - nowMs) / 60_000
  return minutesUntilStart >= 0 && minutesUntilStart <= 60
}
