import { apiRequest } from "./apiClient"

export type LiveStreamStatus = "live" | "upcoming"

/** Yobi backend's own GET /live-streams item shape (src/api/read_api.py's
 * get_live_streams) -- already Holodex-sourced, already filtered to eligible
 * Creator Master channels, already windowed to the 168-hour upcoming
 * lookahead server-side. The browser never talks to holodex.net and never
 * sees a Holodex API key -- this is the only shape it ever gets. */
export interface LiveStreamDto {
  videoId: string
  creatorId: string
  channelName: string
  title: string
  status: LiveStreamStatus
  scheduledStart: string | null
  actualStart: string | null
  thumbnailUrl: string
  /** The stream's canonical backend topic id (same machine id GET /topics uses), or null when none matched. */
  topic?: string | null
}

/** A stream the backend has CONFIRMED ended (GET /live-streams `recentlyEnded`: the 5-minute lifecycle verified it against YouTube, not merely saw it
 * drop out of the live list). `archive` is the separate, short-term archive lookup for the same video; the Schedule never reads it. */
export interface RecentlyEndedStreamDto {
  videoId: string
  creatorId?: string | null
  title?: string | null
  scheduledStart?: string | null
  actualStart?: string | null
  confirmedEndedAt: string
  archive?: { status: string; attempts?: number }
}

interface LiveStreamsResponse {
  streams: LiveStreamDto[]
  /** Absent when the backend cannot supply an end signal (an older deployment, or a store problem): "unknown", NOT "nothing has ended". */
  recentlyEnded?: RecentlyEndedStreamDto[]
}

/** The live/upcoming streams, plus -- when the backend supplied it -- the confirmed-ended list riding on the same array (so every caller that only
 * wants the streams, and every test double that returns a plain array, keeps working unchanged). */
export type LiveStreamsResult = LiveStreamDto[] & { recentlyEnded?: RecentlyEndedStreamDto[] }

/** Call Yobi's own GET /live-streams and return its `streams` array. */
export async function fetchLiveStreams(): Promise<LiveStreamsResult> {
  const response = await apiRequest<LiveStreamsResponse>("/live-streams")
  return Array.isArray(response.recentlyEnded) ? Object.assign(response.streams, { recentlyEnded: response.recentlyEnded }) : response.streams
}
