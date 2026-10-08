import type { AboutPage } from "./api/aboutContentApi"
import { renderMarkdown } from "./markdown"

/** Renders one About destination's backend-supplied Markdown. All five
 * destinations share this one renderer/shell (see about.css) -- only
 * `page` differs between them. The page title is shown via the same
 * settings-page-header shell Settings uses; the body is rendered by the
 * safe Markdown renderer (markdown.tsx) -- never raw HTML, never
 * dangerouslySetInnerHTML. */
export function AboutContentView({ page }: { page: AboutPage }) {
  return (
    <div className="about-content">
      <header className="settings-page-header">
        <h1 className="settings-page-title">{page.title}</h1>
      </header>
      {renderMarkdown(page.markdown)}
    </div>
  )
}
