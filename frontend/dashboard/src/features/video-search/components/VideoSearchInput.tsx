import { Search, X } from "lucide-react"
import { forwardRef } from "react"
import { t, type Locale } from "../../../shared/i18n/translations"

interface VideoSearchInputProps {
  value: string
  onChange: (value: string) => void
  locale: Locale
  /** Extra class names for the outer label -- layout-only (width/flex), never a second visual skin;
   * the `.live-status-search` class itself (home.css) supplies every visual value. */
  className?: string
  /** What the clear (x) button does -- defaults to `onChange("")`. A caller that also wants clearing to
   * collapse the whole expanded SearchView back to its trigger (desktop's RecentVideosSection) passes
   * its own handler instead of adding a SECOND, redundant close affordance next to this one. */
  onClear?: () => void
  /** Native autofocus -- React applies this at the moment the input element itself is created, which is
   * what makes it work correctly even when the input is mounted through a portal (mobile Videos' own
   * Search input, portaled into MainNavbar's top-bar slot one render cycle after this component's own
   * mount): an imperative ref + empty-deps effect would fire before the portal's target DOM node even
   * exists yet in that case. */
  autoFocus?: boolean
  /** Fired on native compositionstart/compositionend (CJK IME input) -- the caller threads this into
   * useVideoSearch's own `isComposing` option so a backend request/cache lookup never runs against
   * unstable intermediate composition text (spec: IME composition). `onChange` keeps firing normally
   * throughout composition (suppressing it would break the browser's own IME rendering of a controlled
   * input) -- only the SEARCH-TRIGGERING side effect is paused, not the visible typing. */
  onCompositionStart?: () => void
  onCompositionEnd?: () => void
  /** Enter (or a mobile keyboard's search action) when not composing -- see useVideoSearch's own
   * `flush`, which this is meant to be wired to. Never fired for the Enter that merely confirms an IME
   * candidate (guarded by `event.nativeEvent.isComposing` below, not the isComposing PROP: the browser's
   * own composition flag at the moment of the keydown is what's authoritative for this one decision). */
  onSubmit?: () => void
}

/** Reuses the EXACT existing `.live-status-search` input skin (home.css) already shared by
 * ScheduleCreatorFilter's creator search and the notification Topic/Creator drawer's search -- same
 * markup shape (label > Search icon + input), same height/border/radius/colors. The one genuinely new
 * piece is the clear (×) button: no existing search input in this codebase has one, so its sizing
 * mirrors the smallest existing icon-button convention (lucide icon only, no border/background of its
 * own, colored from the same --oshi-text-3/--oshi-text-1 tokens the input's own icon and placeholder
 * already use) rather than introducing a new icon-button visual style. */
export const VideoSearchInput = forwardRef<HTMLInputElement, VideoSearchInputProps>(function VideoSearchInput(
  { value, onChange, locale, className, onClear, autoFocus, onCompositionStart, onCompositionEnd, onSubmit },
  ref,
) {
  return (
    <label className={`live-status-search video-search-input${className ? ` ${className}` : ""}`}>
      <Search size={14} aria-hidden="true" />
      <input
        ref={ref}
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onCompositionStart={onCompositionStart}
        onCompositionEnd={onCompositionEnd}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return
          onSubmit?.()
        }}
        placeholder={t(locale, "videoSearch.placeholder")}
        aria-label={t(locale, "videoSearch.placeholder")}
        autoFocus={autoFocus}
      />
      {(value || onClear) && (
        <button type="button" className="video-search-input__clear" onClick={() => (onClear ? onClear() : onChange(""))} aria-label={t(locale, "videoSearch.clear")}>
          <X size={13} aria-hidden="true" />
        </button>
      )}
    </label>
  )
})
