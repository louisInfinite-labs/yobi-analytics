import { VideoSearchBox } from "../../features/home-room/components/VideoSearchBox"
import { useVideoSearchInput } from "../../features/video-search/hooks/useVideoSearchInput"
import { useLocale } from "../../shared/i18n/hooks/useLocale"
import { goToPage, useCurrentPage } from "./useCurrentPage"

/** The phone header's video search: the SAME Video List search input (VideoSearchBox) as Home's desktop box, feeding the SAME shared search
 * (useVideoSearchInput -> Home's useVideoSearch: the selected-Oshi scope, multilingual matching, cancellation, cache, error handling).
 *
 * SUBMIT-driven, unlike the desktop box: typing only edits a draft and sends nothing. The keyboard's Enter / Search key (the input asks
 * for it with enterKeyHint="search"; a one-field <form> turns that key into a submit, with preventDefault so the page never reloads)
 * submits the draft as the query, takes the viewer to Home's search results (from any other page it first goes to Home, the route last
 * shown this session), and blurs the input so the on-screen keyboard closes -- the text stays. There is deliberately no submit button.
 * An Enter that is part of an unfinished IME composition (a candidate being confirmed) submits nothing. Emptying the input ends the
 * search at once -- no Enter, blur or Escape -- and Home returns. */
export function MobileHeaderSearch() {
  const [locale] = useLocale()
  const [page] = useCurrentPage()
  const { draft, setDraft, submit, setComposing, isComposing } = useVideoSearchInput()

  return (
    <form
      className="main-topbar__search"
      role="search"
      action="#"
      onSubmit={(event) => {
        event.preventDefault() // never a page reload
        if (!submit()) return
        if (page !== "home") goToPage("home")
        window.scrollTo({ top: 0, left: 0, behavior: "instant" }) // the results start at the top, under the header
        event.currentTarget.querySelector("input")?.blur() // dismiss the virtual keyboard; the query stays
      }}
    >
      <VideoSearchBox
        value={draft}
        onChange={setDraft}
        locale={locale}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
        wrapperClassName="main-topbar__search-box"
        inputClassName="main-topbar__search-input"
        enterKeyHint="search"
        // Enter while a composition is open confirms the IME candidate, not the search (keyCode 229 covers browsers that fire the keydown
        // after compositionend).
        onKeyDown={(event) => {
          if (event.key === "Enter" && (isComposing || event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault()
        }}
      />
    </form>
  )
}
