export type ScheduledStreamStatus = "live" | "upcoming" | "ended"

export interface ScheduledStream {
  id: string
  channelId: string
  videoId: string
  title: string
  description: string
  status: ScheduledStreamStatus
  /** Epoch ms -- the slot this stream renders in and the modal's started/
   * starts-in text are both derived from this, not stored separately. */
  scheduledStartMs: number
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
