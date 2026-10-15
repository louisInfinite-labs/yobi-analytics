import { useSyncExternalStore } from "react"

interface VideoSearchInputState {
  /** What the input shows. */
  draft: string
  /** The query the Video List actually searches ("" = no search, the normal Home). */
  submitted: string
  /** An IME composition is in progress (the same flag the search hook waits on before it asks the backend). */
  composing: boolean
}

let state: VideoSearchInputState = { draft: "", submitted: "", composing: false }
const listeners = new Set<() => void>()

function commit(next: VideoSearchInputState): void {
  if (next.draft === state.draft && next.submitted === state.submitted && next.composing === state.composing) return
  state = next
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const isBlank = (text: string) => text.trim() === ""

/** The ONE video-search state, shared by every input that drives the Video List's search, with the draft kept apart from the query:
 *
 * - Desktop / tablet (Home's always-visible box) is INPUT-DRIVEN: `setLive` makes the typed text the search query as it is typed.
 * - Phone (the header input) is SUBMIT-DRIVEN: `setDraft` only changes what the input shows, so typing runs no search; `submit`
 *   (the keyboard's Enter / Search) turns the draft into the query. Emptying the draft is the one exception: it ends the search at
 *   once, with no Enter, wherever focus is.
 *
 * Both feed the same search (RecentVideosSection's useVideoSearch: the selected-Oshi scope, multilingual matching, cancellation, cache),
 * and an empty query means "not searching" everywhere. Not persisted: a reload starts with no query. */
export function useVideoSearchInput() {
  const current = useSyncExternalStore(subscribe, () => state)
  return {
    draft: current.draft,
    submitted: current.submitted,
    isComposing: current.composing,
    setLive: (text: string) => commit({ ...state, draft: text, submitted: isBlank(text) ? "" : text }),
    setDraft: (text: string) => commit({ ...state, draft: text, submitted: isBlank(text) ? "" : state.submitted }),
    /** Promotes the draft to the query. False (and nothing changes) for an empty draft or mid-IME-composition. */
    submit: (): boolean => {
      const query = state.draft.trim()
      if (state.composing || query === "") return false
      commit({ ...state, submitted: query })
      return true
    },
    setComposing: (composing: boolean) => commit({ ...state, composing }),
    clear: () => commit({ draft: "", submitted: "", composing: false }),
  }
}

/** Clears the shared search from code that is not a hook (a page leaving, a test). */
export function clearVideoSearchInput(): void {
  commit({ draft: "", submitted: "", composing: false })
}
