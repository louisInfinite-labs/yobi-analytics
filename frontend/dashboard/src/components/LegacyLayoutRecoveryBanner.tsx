interface LegacyLayoutRecoveryBannerProps {
  savedGrid: { columns: number; rows: number }
  canConvert: boolean
  error: string | null
  onConvert: () => void
}

/** Shown while a saved layout from the former 4/5-column contract is
 * awaiting an explicit conversion. It deliberately offers no reset action. */
export function LegacyLayoutRecoveryBanner({ savedGrid, canConvert, error, onConvert }: LegacyLayoutRecoveryBannerProps) {
  return (
    <section className="card legacy-layout-banner" aria-labelledby="legacy-layout-banner-title" data-testid="legacy-layout-banner">
      <h2 id="legacy-layout-banner-title" className="legacy-layout-banner__title">
        Your saved layout uses an older grid size
      </h2>
      <p>
        The saved layout is {savedGrid.columns}×{savedGrid.rows}. It has been preserved and has not been changed. The Dashboard now supports layouts up
        to 3×3, so editing is unavailable until this layout is converted.
      </p>
      {canConvert ? (
        <>
          <p data-testid="legacy-layout-convert-note">
            Converting to 3×3 may change widget positions. Widget IDs and settings will be preserved, and your original layout is backed up first.
          </p>
          <button type="button" className="soft-button" onClick={onConvert}>
            Convert to 3x3
          </button>
        </>
      ) : (
        <p data-testid="legacy-layout-no-convert">
          This layout cannot be converted without removing or changing widgets, so it is kept exactly as saved and editing stays disabled.
        </p>
      )}
      {error && (
        <p className="legacy-layout-banner__error" role="alert" data-testid="legacy-layout-convert-error">
          {error}
        </p>
      )}
    </section>
  )
}
