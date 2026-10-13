import { ConfigProvider, Segmented } from "antd"
import { HOME_FILTER_SEGMENTED_TOKENS } from "../theme/homeFilterSegmentedTheme"

interface HomeFilterSegmentedProps<T extends string> {
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
  /** Extra root/label classes for a screen's own layout; the shared skin classes are always added after them. */
  rootClassName?: string
  labelClassName?: string
  "aria-label"?: string
}

/** Home's filter segmented control (the Live Status ALL / Favorites selector): antd Segmented with HOME_FILTER_SEGMENTED_TOKENS and the
 * .home-filter-segmented / .home-filter-segment-label skin (home.css). Every screen that shows this control renders it through here. */
export function HomeFilterSegmented<T extends string>({
  value,
  options,
  onChange,
  rootClassName,
  labelClassName,
  "aria-label": ariaLabel,
}: HomeFilterSegmentedProps<T>) {
  return (
    <ConfigProvider theme={{ components: { Segmented: HOME_FILTER_SEGMENTED_TOKENS } }}>
      <Segmented<T>
        classNames={{
          root: [rootClassName, "home-filter-segmented"].filter(Boolean).join(" "),
          label: [labelClassName, "home-filter-segment-label"].filter(Boolean).join(" "),
        }}
        value={value}
        onChange={onChange}
        options={options}
        aria-label={ariaLabel}
      />
    </ConfigProvider>
  )
}
