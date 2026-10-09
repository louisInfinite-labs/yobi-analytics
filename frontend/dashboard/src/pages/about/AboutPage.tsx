import { useLocale } from "../../shared/i18n/hooks/useLocale"
import { ErrorState } from "../../shared/ui/states/ErrorState"
import { LoadingState } from "../../shared/ui/states/LoadingState"
import { AboutContentView } from "./AboutContentView"
import { AboutSecondaryNavbar } from "./AboutSecondaryNavbar"
import { retryAboutContentLoad } from "./aboutContentStore"
import { useAboutContent } from "./useAboutContent"
import { useAboutSection } from "./useAboutSection"

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
  const { content, isLoading, error } = useAboutContent()

  const localeContent = content ? (content.locales[locale] ?? content.locales.en ?? Object.values(content.locales)[0]) : undefined
  const pages = localeContent?.pages ?? []
  const defaultId = pages[0]?.id ?? ""
  const [activeSection, setActiveSection] = useAboutSection(
    pages.map((page) => page.id),
    defaultId,
  )
  const activePage = pages.find((page) => page.id === activeSection)

  return (
    <div className="settings-page">
      <AboutSecondaryNavbar pages={pages} activeSection={activeSection} onSelect={setActiveSection} />
      <div className="settings-page__content">
        {activePage ? (
          <AboutContentView page={activePage} />
        ) : isLoading ? (
          <LoadingState />
        ) : (
          <ErrorState message={error ?? undefined} onRetry={() => void retryAboutContentLoad()} />
        )}
      </div>
    </div>
  )
}
