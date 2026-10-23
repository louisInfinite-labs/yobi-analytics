import { useCallback, useEffect } from "react"
import { createSharedState, useSharedState } from "../../../shared/state/sharedState"
import { fetchSimultaneousLiveNotice, saveSimultaneousLiveNotice } from "../api/simultaneousLiveNoticeApi"
import { clearNotificationSaveFailed, reportNotificationSaveFailed } from "./notificationSaveStatus"

// The LAST CONFIRMED backend state: null until the first read answers. Held in memory only (the backend item is the source of truth), and shared so
// every Settings panel that shows the switch sees one value and the page reads it once, not once per topic card.
const simultaneousLiveNoticeStore = createSharedState<boolean | null>(
  "yobi.simultaneousLiveNotice",
  () => null,
  (value) => JSON.stringify(value),
  null,
)

let loading: Promise<void> | null = null

function loadOnce(): void {
  if (simultaneousLiveNoticeStore.get() !== null || loading !== null) return
  loading = fetchSimultaneousLiveNotice()
    .then((enabled) => simultaneousLiveNoticeStore.set(enabled))
    .catch(() => {
      // An unreadable state stays "not loaded": the switch stays disabled rather than showing a guess; the next mount reads again.
    })
    .finally(() => {
      loading = null
    })
}

/** 同時直播預告 (the notice that several followed creators start at the same time): the opt-in lives on the backend, so a change is backend-first --
 * the switch only moves once the write was accepted, and a rejected one raises the page's shared "couldn't save" alert instead. */
export function useSimultaneousLiveNotice() {
  const [enabled] = useSharedState(simultaneousLiveNoticeStore)
  useEffect(loadOnce, [])
  /** Opts in or out; resolves true when the backend accepted the change. */
  const setEnabled = useCallback(async (next: boolean): Promise<boolean> => {
    try {
      await saveSimultaneousLiveNotice(next)
    } catch {
      reportNotificationSaveFailed()
      return false
    }
    clearNotificationSaveFailed()
    simultaneousLiveNoticeStore.set(next)
    return true
  }, [])
  return { enabled: enabled === true, loaded: enabled !== null, setEnabled }
}
