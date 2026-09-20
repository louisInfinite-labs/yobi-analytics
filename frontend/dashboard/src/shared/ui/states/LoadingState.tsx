/** Skeleton placeholder shown while analytics data is still loading. */
export function LoadingState({ rows = 3 }: { rows?: number }) {
  return (
    <div role="status" aria-live="polite" aria-label="Loading dashboard data" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ height: 18, width: `${90 - i * 12}%` }} />
      ))}
    </div>
  )
}
