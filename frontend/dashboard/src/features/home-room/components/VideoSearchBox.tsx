import { ConfigProvider, Input } from "antd"
import { Search } from "lucide-react"
import { t, type Locale } from "../../../shared/i18n/translations"

/** Desktop's always-visible video search box, a sibling of VideoSectionTagBar inside .oshi-videos__header
 * (never a collapsed icon the user must click to expand -- see home.css's own .oshi-videos__search for the
 * responsive width this depends on). A plain Input with the search icon as its `prefix` -- deliberately NOT
 * Input.Search: that component renders its own enterButton/search-submit affordance, and this box has no
 * submit step at all (every keystroke's onChange IS the search state; allowClear's X only clears the text,
 * it does not submit anything). Styled to match the existing dark .oshi-videos__sort control (home.css),
 * not antd's own light input skin. Its query drives the multilingual Video Search (features/video-search:
 * GET /creators/{creatorId}/videos/search, 250ms debounce, cancellation, session cache) -- see RecentVideosSection. */
export function VideoSearchBox({
  value,
  onChange,
  locale,
  onCompositionStart,
  onCompositionEnd,
  wrapperClassName = "oshi-videos__search",
  inputClassName = "oshi-videos__search-input",
  enterKeyHint,
  onKeyDown,
}: {
  value: string
  onChange: (value: string) => void
  locale: Locale
  onCompositionStart: () => void
  onCompositionEnd: () => void
  /** The wrapper's class: Home's desktop box sizing by default; the phone header passes its own (main-navbar.css). */
  wrapperClassName?: string
  /** The Input's class (its sizing/typography): Home's compact desktop look by default. */
  inputClassName?: string
  /** The phone keyboard's Enter key label ("search"); desktop leaves it unset. */
  enterKeyHint?: "search"
  onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void
}) {
  return (
    <div className={wrapperClassName}>
      {/* Same approach as VideoSectionTagBar's Segmented below: antd's own CSS-in-JS styles are
          injected at runtime and can outrank a plain stylesheet override regardless of selector
          specificity, so the dark colors/sizing/no-accent-focus are set through ConfigProvider's
          actual Input tokens (authoritative, not a cascade race) rather than CSS alone. */}
      <ConfigProvider
        theme={{
          components: {
            Input: {
              colorBgContainer: "rgba(0, 0, 0, 0.2)",
              colorBorder: "var(--oshi-border)",
              colorText: "var(--oshi-text-2)",
              colorTextPlaceholder: "var(--oshi-text-3)",
              colorIcon: "var(--oshi-text-3)",
              colorIconHover: "var(--oshi-text-2)",
              hoverBorderColor: "var(--oshi-border)",
              activeBorderColor: "var(--oshi-border)",
              activeShadow: "none",
              borderRadius: 4,
            },
          },
        }}
      >
        <Input
          size="small"
          allowClear
          prefix={<Search size={12} aria-hidden="true" />}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onCompositionStart={onCompositionStart}
          onCompositionEnd={onCompositionEnd}
          enterKeyHint={enterKeyHint}
          onKeyDown={onKeyDown}
          placeholder={t(locale, "videoSearch.placeholder")}
          aria-label={t(locale, "videoSearch.placeholder")}
          className={inputClassName}
        />
      </ConfigProvider>
    </div>
  )
}
