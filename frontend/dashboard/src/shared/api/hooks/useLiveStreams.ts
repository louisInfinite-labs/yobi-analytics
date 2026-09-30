import { useEffect } from "react"
import { useSharedState } from "../../state/sharedState"
import { acquireLiveStreamsPolling, liveStreamsStore, type LiveStreamsState } from "../liveStreamsStore"

/** The shared Yobi /live-streams read every consumer (Home, the Live
 * Schedule Dock, the Schedule/Timetable page) goes through -- never fetched
 * independently per consumer. See liveStreamsStore.ts for the actual
 * fetch/poll/ref-counting; this hook only subscribes to it and manages this
 * component's share of that ref count. */
export function useLiveStreams(): LiveStreamsState {
  const [state] = useSharedState(liveStreamsStore)

  useEffect(() => acquireLiveStreamsPolling(), [])

  return state
}
