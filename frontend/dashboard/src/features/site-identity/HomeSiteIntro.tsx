import type { MouseEvent } from "react"
import { goToPage, pageHref, type Page } from "../../app/navigation/useCurrentPage"
import { useLocale } from "../../shared/i18n/hooks/useLocale"
import { SITE_INTRO_COPY } from "./siteIntroCopy"
import "./styles/homeSiteIntro.css"

/** A plain primary-button click with no modifier: navigate in place. Anything else is the browser's own link behaviour. */
function isPlainPrimaryClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
}

/** A real link to one of the app's pages that navigates in place on a plain click (same behaviour as the main navigation). */
export function PageLink({ page, children }: { page: Exclude<Page, "home" | "dashboard">; children: string }) {
  return (
    <a
      className="home-site-intro__link"
      href={pageHref(page)}
      onClick={(event) => {
        if (!isPlainPrimaryClick(event)) return
        event.preventDefault()
        goToPage(page)
      }}
    >
      {children}
    </a>
  )
}

/** How to get around OshiYobi: a line on each feature and the links, closing Home's status column on phone/tablet (where Latest Activity is a
 * fixed 6-row preview and the page itself scrolls, so the end is always reachable). The site's name, description and live line are in
 * HomeSiteHeading at the top of the column. Static text and links only -- it needs no API data, so it is there from the first render and
 * through loading or failed requests, and it never states anything about current livestreams. */
export function HomeSiteIntro() {
  const [locale] = useLocale()
  const copy = SITE_INTRO_COPY[locale] ?? SITE_INTRO_COPY.en
  return (
    <section className="oshi-status__section home-site-intro" aria-labelledby="home-site-intro-heading">
      <h2 id="home-site-intro-heading" className="home-site-intro__title">
        {copy.heading}
      </h2>
      <ul className="home-site-intro__list">
        <li>{copy.liveStatus}</li>
        <li>
          <PageLink page="schedule">{copy.scheduleLink}</PageLink>
          {copy.scheduleText}
        </li>
        <li>{copy.videos}</li>
        <li>
          <PageLink page="settings">{copy.settingsLink}</PageLink>
          {copy.settingsText}
        </li>
      </ul>
      <p className="home-site-intro__more">
        <PageLink page="about">{copy.aboutLink}</PageLink>
      </p>
    </section>
  )
}
