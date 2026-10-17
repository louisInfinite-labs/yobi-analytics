import { useEffect, useRef, useState, type RefObject } from "react"
import type { HomeAllFeed } from "../../home-room/hooks/useHomeAllFeed"
import type { RecentVideo } from "../../../shared/media/model/recentVideo"

/** Latest Activity starts at, and on mobile/tablet Home stays at, the FIRST 6 items of the shared ALL feed. */
export const LATEST_ACTIVITY_ROW_LIMIT = 6

/** How Latest Activity is shown:
 * - "preview": the first 6 rows only, nothing observed or requested (mobile/tablet Home: the page itself scrolls past them);
 * - "scroll": 6 rows to start, the rest revealed as the DESKTOP panel scrolls inside its own fixed box, paging the feed;
 * - "full": every loaded row (the dedicated full-screen view), paging the feed as it scrolls. */
export type LatestActivityMode = "preview" | "scroll" | "full"

/** Desktop only: how many more already-loaded rows appear each time the user scrolls to the last rendered one. */
const REVEAL_STEP = 6

/** Desktop only: the next 20-item page is requested once the row at index 13 of the loaded rows (the 14th, inside the 12th-14th window)
 * is scrolled into view, then 33, 53, ... -- the same prefetch points the Video List itself uses. */
const PREFETCH_AT_INDEX = 13
const FEED_PAGE_SIZE = 20

/** A prefetch point asks the feed ONCE per loaded count. The observer is re-attached whenever the feed state changes, and re-attaching to a
 * row that is still on screen reports it again -- without this a page still in flight would be followed by an early request for the next
 * one (the loader queues it). If the page has not landed after this long (it failed), the point may ask again. */
const PREFETCH_RETRY_MS = 4000

interface LatestActivityRows {
  /** The rows to render: 6 first; on desktop more as the panel scrolls, up to everything the shared feed has loaded. */
  rows: RecentVideo[]
  /** Attach to the element whose children are the rendered rows, in order (the observers watch two of them). */
  listRef: RefObject<HTMLDivElement | null>
}

/** Which Latest Activity rows to show (see LatestActivityMode) over the SAME shared ALL feed (useHomeAllFeed), and the infinite scroll that
 * goes with the two scrolling modes: "scroll" reveals six more loaded rows when the last rendered row scrolls into view, and both
 * "scroll" and "full" ask the feed for its next page (loadMore, already deduplicated and rate-limited there) when the prefetch row does.
 * "preview" never reveals, observes or requests anything. The 尚未觀看 counts never depend on what is rendered here. Skipped where
 * IntersectionObserver is unavailable. */
export function useLatestActivityRows(creatorId: string, feed: HomeAllFeed, mode: LatestActivityMode): LatestActivityRows {
  const loaded = feed.videos.length
  const { hasMore, loadMore } = feed
  // The revealed count is remembered per creator, so switching Oshi starts over at six instead of carrying the previous creator's depth.
  const [revealed, setRevealed] = useState({ creatorId, count: LATEST_ACTIVITY_ROW_LIMIT })
  const count = revealed.creatorId === creatorId ? revealed.count : LATEST_ACTIVITY_ROW_LIMIT
  const shown =
    mode === "full"
      ? loaded
      : mode === "scroll"
        ? Math.min(Math.max(count, LATEST_ACTIVITY_ROW_LIMIT), loaded)
        : Math.min(LATEST_ACTIVITY_ROW_LIMIT, loaded)
  const listRef = useRef<HTMLDivElement | null>(null)
  const lastPrefetch = useRef({ loaded: -1, at: 0 })

  const loadedPages = Math.max(0, Math.floor((loaded - 1 - PREFETCH_AT_INDEX) / FEED_PAGE_SIZE))
  const prefetchIndex = Math.min(PREFETCH_AT_INDEX + loadedPages * FEED_PAGE_SIZE, loaded - 1)
  const revealIndex = mode === "scroll" && shown < loaded ? shown - 1 : -1
  const prefetchActive = mode !== "preview" && hasMore && prefetchIndex >= 0 && prefetchIndex < shown

  useEffect(() => {
    const list = listRef.current
    if (mode === "preview" || !list || typeof IntersectionObserver === "undefined") return
    const revealRow = revealIndex >= 0 ? list.children.item(revealIndex) : null
    const prefetchRow = prefetchActive ? list.children.item(prefetchIndex) : null
    if (!revealRow && !prefetchRow) return
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        if (entry.target === revealRow) {
          setRevealed((previous) => {
            const base = previous.creatorId === creatorId ? previous.count : LATEST_ACTIVITY_ROW_LIMIT
            return { creatorId, count: Math.min(base + REVEAL_STEP, loaded) }
          })
        }
        if (entry.target === prefetchRow) {
          const now = Date.now()
          if (lastPrefetch.current.loaded === loaded && now - lastPrefetch.current.at < PREFETCH_RETRY_MS) continue
          lastPrefetch.current = { loaded, at: now }
          loadMore()
        }
      }
    })
    if (revealRow) observer.observe(revealRow)
    if (prefetchRow) observer.observe(prefetchRow)
    return () => observer.disconnect()
  }, [mode, creatorId, loaded, revealIndex, prefetchActive, prefetchIndex, loadMore])

  return { rows: feed.videos.slice(0, shown), listRef }
}
