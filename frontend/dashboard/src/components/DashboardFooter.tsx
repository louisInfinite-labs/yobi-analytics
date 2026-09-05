/** Reserved footer attribution slot; stays empty until Phase 9 populates it with required Holodex credit. */
export function DashboardFooter() {
  return (
    <footer className="dashboard-footer">
      <div className="dashboard-footer__attribution" data-testid="holodex-attribution-slot" aria-hidden="true" />
    </footer>
  )
}
