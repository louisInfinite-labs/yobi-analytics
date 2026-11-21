import { ApiError, describeApiFailure } from "../../shared/api/apiClient"
import { useLocale } from "../../shared/i18n/hooks/useLocale"
import type { Locale } from "../../shared/i18n/translations"
import { ErrorState } from "../../shared/ui/states/ErrorState"
import { LoadingState } from "../../shared/ui/states/LoadingState"
import { AboutContentView } from "./AboutContentView"
import { AboutSecondaryNavbar } from "./AboutSecondaryNavbar"
import { AboutContentFormatError } from "./api/aboutContentApi"
import { retryAboutContentLoad } from "./aboutContentStore"
import { useAboutContent } from "./useAboutContent"
import { useAboutSection } from "./useAboutSection"

/** The error text for a failed About content load: the same network / server / rate-limit wording every other API view uses
 * (describeApiFailure). Two failures get ErrorState's own generic message instead: a 404 from the content API (reported WITHOUT its
 * status: /about itself is a valid page, so a missing content resource must never read like "this page does not exist"), and a response
 * that arrived but could not be rendered (AboutContentFormatError -- the server answered, so it is not a connection problem). No failure
 * (e.g. the locale has no pages) also keeps the generic message. */
function describeAboutFailure(failure: Error | null, locale: Locale): { description?: string; code?: string } {
  if (!failure) return {}
  if (failure instanceof ApiError && failure.status === 404) return {}
  if (failure instanceof AboutContentFormatError) return {}
  return describeApiFailure(failure, locale)
}

/** About's own [MainNavbar] [AboutSecondaryNavbar] [Content] layout -- the
 * exact same shell SettingsPage.tsx uses (MainNavbar mounted one level up
 * in App.tsx; this renders the other two), reusing its settings-page /
 * settings-page__content CSS directly rather than an independent
 * About-specific layout. Content, page order, and titles are entirely
 * backend-driven (useAboutContent.ts) -- this component owns none of that
 * copy, only the shell and which destination is currently active (see
 * useAboutSection.ts). */
export function AboutPage() {
  const [locale] = useLocale()
  const { content, isLoading, failure } = useAboutContent()

  const localeContent = content ? (content.locales[locale] ?? content.locales.en ?? Object.values(content.locales)[0]) : undefined
  const pages = localeContent?.pages ?? []
  const defaultId = pages[0]?.id ?? ""
  const [activeSection, setActiveSection] = useAboutSection(
    pages.map((page) => page.id),
    defaultId,
  )
  const activePage = pages.find((page) => page.id === activeSection)
  const failureText = describeAboutFailure(failure, locale)

  return (
    <div className="settings-page">
      {/* The page's one <h1>: the shown page's own title once content is on screen (AboutContentView), otherwise -- loading or failed --
          the secondary nav's existing "About" title, so the route keeps its heading without a second visible title. */}
      <AboutSecondaryNavbar pages={pages} activeSection={activeSection} onSelect={setActiveSection} titleIsPageHeading={!activePage} />
      <div className="settings-page__content">
        {activePage ? (
          <AboutContentView page={activePage} />
        ) : isLoading ? (
          <LoadingState />
        ) : (
          <ErrorState message={failureText.description} code={failureText.code} onRetry={() => void retryAboutContentLoad()} />
        )}
      </div>
    </div>
  )
}
