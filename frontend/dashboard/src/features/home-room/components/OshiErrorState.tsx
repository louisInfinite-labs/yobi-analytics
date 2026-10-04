import { describeApiFailure } from "../../../shared/api/apiClient"
import { useLocale } from "../../../shared/i18n/hooks/useLocale"
import { t } from "../../../shared/i18n/translations"

/** The normal error state of a Home data surface: the same wording the dashboard's ErrorState uses
 * (describeApiFailure tells the visitor's own network apart from the server answering with an error,
 * and the code makes it reportable), as a compact inline block for the shelf and the Oshi Status
 * recent rows. It is what an API/network/server failure renders -- never mock data, and never the
 * empty-state text, which is reserved for a valid empty result. */
export function OshiErrorState({ error }: { error: Error }) {
  const [locale] = useLocale()
  const { code, description } = describeApiFailure(error, locale)
  return (
    <div className="oshi-error-state" role="alert">
      <span>{description}</span>
      <span className="oshi-error-state__code">{t(locale, "errorState.code", { code })}</span>
    </div>
  )
}
