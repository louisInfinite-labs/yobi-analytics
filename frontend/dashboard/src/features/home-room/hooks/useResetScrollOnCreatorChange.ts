import { useLayoutEffect, useRef } from "react"

/** Puts the page at its very top, immediately (never an animated scroll). Below 1024px Home is one column that scrolls with the DOCUMENT
 * (home.css: `.oshi-home` is `height: auto; overflow: visible` there), so `window` is the scroll container -- there is no inner scroller to reset. */
function scrollPageToTop(): void {
  if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo({ top: 0, left: 0, behavior: "instant" })
}

/** Treats a change of the Home creator as a newly opened creator view: where Home scrolls with the page (phone and tablet, `enabled`), the page
 * jumps to the very top the moment the creator changes -- from Live Status, the dock, a creator link, or browser Back/Forward between creator
 * routes -- and the previous creator's scroll position is never carried over.
 *
 * It reacts ONLY to `creatorId` changing: a refresh of the same creator's data, a topic/filter/sort/search change and a resize never reset the
 * scroll, and the first render (a reload or a page switch, which App.tsx already starts at the top) is left to the browser. The reset runs in a
 * layout effect, before the new creator is painted, so the old position is never shown; because the browser may restore a history entry's own
 * scroll position just after a Back/Forward `popstate`, it is applied once more on the next frame (a no-op when already at the top). */
export function useResetScrollOnCreatorChange(creatorId: string, enabled: boolean): void {
  const shownCreator = useRef(creatorId)
  useLayoutEffect(() => {
    if (shownCreator.current === creatorId) return
    shownCreator.current = creatorId
    if (!enabled) return
    scrollPageToTop()
    const frame = window.requestAnimationFrame(scrollPageToTop)
    return () => window.cancelAnimationFrame(frame)
  }, [creatorId, enabled])
}
