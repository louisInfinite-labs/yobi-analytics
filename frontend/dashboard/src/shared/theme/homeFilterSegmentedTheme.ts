/** The antd Segmented tokens of Home's filter controls (the Live Status ALL / Favorites selector, itself Home's Video List filter bar look): the
 * track sits on --oshi-surface-1 with no border, 4px radius and 2px padding, chips are 2px-radius (see .home-filter-segmented in home.css), the
 * selected chip is the fixed neutral --oshi-surface-3 with full-strength text, unselected text is --oshi-text-3 with Home's hover wash. One
 * definition, used by every screen that shows that control, so none of them keeps a palette of its own. */
export const HOME_FILTER_SEGMENTED_TOKENS = {
  trackBg: "var(--oshi-surface-1)",
  trackPadding: 2,
  itemColor: "var(--oshi-text-3)",
  itemHoverColor: "var(--oshi-text-1)",
  itemHoverBg: "rgba(255, 255, 255, 0.05)",
  itemSelectedBg: "var(--oshi-surface-3)",
  itemSelectedColor: "var(--oshi-text-1)",
  borderRadius: 4,
  borderRadiusSM: 4,
}
