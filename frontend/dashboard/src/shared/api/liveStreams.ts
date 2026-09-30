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
}

interface LiveStreamsResponse {
  streams: LiveStreamDto[]
}

/** Call Yobi's own GET /live-streams and return its `streams` array. */
export async function fetchLiveStreams(): Promise<LiveStreamDto[]> {
  const response = await apiRequest<LiveStreamsResponse>("/live-streams")
  return response.streams
}
