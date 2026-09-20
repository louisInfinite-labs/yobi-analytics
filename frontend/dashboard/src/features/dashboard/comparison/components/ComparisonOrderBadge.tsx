export interface ComparisonOrderBadgeProps {
  /** 1-based comparison order (MT-10: comparisonOrderOf's return value). */
  order: number
}

/** MT-10 "Ordered Creator Selection and Badges" -- the circular per-creator
 * comparison-order badge (DASHBOARD_LAYOUT_GUIDELINES.md Section 3.4:
 * "Display the selection order as a circular ordinal badge at the
 * top-right of each selected creator avatar").
 *
 * Renders the plain numeral inside a CSS circle rather than a Unicode
 * circled-number glyph (①②③...): the guidelines explicitly call for "a
 * rendered numeric badge for larger values rather than depending on the
 * availability of Unicode circled-number characters" (Section 3.4), and a
 * CSS circle works identically for any comparison size instead of being
 * bounded by which circled digits a font/Unicode version happens to
 * provide.
 *
 * Positioning-only: `.comparison-order-badge` expects an
 * ancestor with `position: relative` (an avatar wrapper) to anchor its
 * `position: absolute` placement at the top-right corner -- this component
 * does not render or know about any specific avatar (MT-11 owns wiring a
 * real avatar/Creator List UI; see creatorComparisonOrder.ts's header).
 *
 * Order is communicated only through the accessible label, never color
 * alone (DASHBOARD_LAYOUT_GUIDELINES.md Section 0.2, Section 3.4's own
 * "must have an accessible label such as 'Comparison order 1'; do not
 * communicate the order visually only"). */
export function ComparisonOrderBadge({ order }: ComparisonOrderBadgeProps) {
  return (
    <span className="comparison-order-badge" aria-label={`Comparison order ${order}`}>
      {order}
    </span>
  )
}
