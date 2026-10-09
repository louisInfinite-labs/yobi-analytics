import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { AboutPage } from "./AboutPage"
import * as aboutContentApi from "./api/aboutContentApi"
import type { AboutContent, AboutPage as AboutPageDto } from "./api/aboutContentApi"
import { resetAllSharedStateForTests } from "../../shared/state/sharedState"
import { MemberThemeProvider } from "../../shared/theme/MemberThemeProvider"
import { resetAboutContentFetchForTests } from "./aboutContentFetchState"

vi.mock("./api/aboutContentApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api/aboutContentApi")>()),
  fetchAboutContent: vi.fn(),
}))

function page(id: string, title: string, markdown: string): AboutPageDto {
  return { id, title, markdown: markdown || "placeholder body" }
}

function fixture(): AboutContent {
  return {
    schemaVersion: 1,
    contentVersion: "test-1",
    locales: {
      "zh-TW": {
        pages: [
          page("about", "關於 OshiYobi", "zh-TW about 內容"),
          page("dataSources", "資料來源", "Schedule 直播排程"),
          page("privacy", "隱私權", "隱私內容"),
          page("terms", "使用條款", "條款內容"),
          page("acknowledgements", "致謝", "致謝內容"),
        ],
      },
      en: {
        pages: [
          page(
            "about",
            "About OshiYobi",
            [
              "# H1 Heading",
              "## H2 Heading",
              "### H3 Heading",
              "plain **emphasis** text",
              "- bullet item",
              "1. ordered item",
            ].join("\n\n"),
          ),
          page("dataSources", "Data Sources", "en data sources body"),
          page(
            "privacy",
            "Privacy",
            ["See [Google Privacy Policy](https://policies.google.com/privacy) for details.", "**[Contact]**"].join("\n\n"),
          ),
          page("terms", "Terms of Use", "By using OshiYobi you agree to [YouTube Terms of Service](https://www.youtube.com/t/terms)."),
          page("acknowledgements", "Acknowledgements", "Thanks everyone."),
        ],
      },
      ja: {
        pages: [
          page("about", "OshiYobi について", "ja about 本文"),
          page("dataSources", "データソース", "データ内容"),
          page("privacy", "プライバシー", "プライバシー内容"),
          page("terms", "利用規約", "規約内容"),
          page("acknowledgements", "謝辞", "謝辞内容"),
        ],
      },
    },
  }
}

function renderAboutPage() {
  return render(
    <MemberThemeProvider>
      <AboutPage />
    </MemberThemeProvider>,
  )
}

function setLocale(locale: string) {
  localStorage.setItem("yobi.locale", locale)
  resetAllSharedStateForTests()
}

beforeEach(() => {
  window.history.pushState({}, "", "/about")
  setLocale("en")
  vi.mocked(aboutContentApi.fetchAboutContent).mockResolvedValue(fixture())
})

describe("AboutPage", () => {
  it("renders content fetched from the backend, not hardcoded article data", async () => {
    renderAboutPage()
    await waitFor(() => expect(aboutContentApi.fetchAboutContent).toHaveBeenCalled())
    expect(await screen.findByRole("heading", { level: 1, name: "About OshiYobi" })).toBeInTheDocument()
  })

  it("lists all five pages and defaults to the first one", async () => {
    renderAboutPage()
    const nav = await screen.findByRole("navigation", { name: "About navigation" })
    await waitFor(() => {
      const labels = Array.from(nav.querySelectorAll(".settings-secondary-navbar__link")).map((el) => el.textContent)
      expect(labels).toEqual(["About OshiYobi", "Data Sources", "Privacy", "Terms of Use", "Acknowledgements"])
    })
    expect(screen.getByRole("button", { name: "About OshiYobi" })).toHaveAttribute("aria-current", "page")
  })

  it("switches the content area and active item for every destination", async () => {
    const user = userEvent.setup()
    renderAboutPage()
    await screen.findByRole("heading", { level: 1, name: "About OshiYobi" })

    for (const label of ["Data Sources", "Privacy", "Terms of Use", "Acknowledgements", "About OshiYobi"]) {
      await user.click(screen.getByRole("button", { name: label }))
      expect(screen.getByRole("button", { name: label })).toHaveAttribute("aria-current", "page")
      expect(await screen.findByRole("heading", { level: 1, name: label })).toBeInTheDocument()
    }
  })

  it("renders zh-TW content", async () => {
    setLocale("zh-TW")
    renderAboutPage()
    expect(await screen.findByRole("heading", { level: 1, name: "關於 OshiYobi" })).toBeInTheDocument()
    expect(screen.getByText("zh-TW about 內容")).toBeInTheDocument()
  })

  it("renders en content", async () => {
    const user = userEvent.setup()
    renderAboutPage()
    await screen.findByRole("heading", { level: 1, name: "About OshiYobi" })
    await user.click(screen.getByRole("button", { name: "Data Sources" }))
    expect(await screen.findByText("en data sources body")).toBeInTheDocument()
  })

  it("renders ja content", async () => {
    setLocale("ja")
    renderAboutPage()
    expect(await screen.findByRole("heading", { level: 1, name: "OshiYobi について" })).toBeInTheDocument()
    expect(screen.getByText("ja about 本文")).toBeInTheDocument()
  })

  it("respects the backend's own page order, including a non-default order", async () => {
    const reordered = fixture()
    reordered.locales.en.pages = [...reordered.locales.en.pages].reverse()
    vi.mocked(aboutContentApi.fetchAboutContent).mockResolvedValue(reordered)

    renderAboutPage()
    const nav = await screen.findByRole("navigation", { name: "About navigation" })
    await waitFor(() => {
      const labels = Array.from(nav.querySelectorAll(".settings-secondary-navbar__link")).map((el) => el.textContent)
      expect(labels).toEqual(["Acknowledgements", "Terms of Use", "Privacy", "Data Sources", "About OshiYobi"])
    })
    // The first page in backend order is now the default landing page.
    expect(screen.getByRole("button", { name: "Acknowledgements" })).toHaveAttribute("aria-current", "page")
  })

  it("renders backend heading levels as real h1/h2/h3 elements", async () => {
    renderAboutPage()
    await screen.findByRole("heading", { level: 1, name: "About OshiYobi" })
    expect(screen.getByRole("heading", { level: 1, name: "H1 Heading" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { level: 2, name: "H2 Heading" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { level: 3, name: "H3 Heading" })).toBeInTheDocument()
  })

  it("renders an ordered list as a real <ol> and a bullet list as a <ul>", async () => {
    renderAboutPage()
    await screen.findByRole("heading", { level: 1, name: "About OshiYobi" })
    expect(screen.getByText("ordered item").closest("ol")).not.toBeNull()
    expect(screen.getByText("bullet item").closest("ul")).not.toBeNull()
  })

  it("changing a list's Markdown syntax in backend content changes presentation with no renderer code change", async () => {
    const asOrdered = fixture()
    asOrdered.locales.en.pages[0] = page("about", "About OshiYobi", "1. item")
    vi.mocked(aboutContentApi.fetchAboutContent).mockResolvedValue(asOrdered)
    const { unmount } = renderAboutPage()
    await screen.findByRole("heading", { level: 1, name: "About OshiYobi" })
    expect(screen.getByText("item").closest("ol")).not.toBeNull()
    unmount()

    const asBullet = fixture()
    asBullet.locales.en.pages[0] = page("about", "About OshiYobi", "- item")
    vi.mocked(aboutContentApi.fetchAboutContent).mockResolvedValue(asBullet)
    resetAllSharedStateForTests()
    resetAboutContentFetchForTests()
    renderAboutPage()
    await screen.findByRole("heading", { level: 1, name: "About OshiYobi" })
    expect(screen.getByText("item").closest("ul")).not.toBeNull()
  })

  it("renders backend emphasis as a real <strong> element", async () => {
    renderAboutPage()
    await screen.findByRole("heading", { level: 1, name: "About OshiYobi" })
    expect(screen.getByText("emphasis").tagName).toBe("STRONG")
  })

  it("a page with unsupported/unsafe Markdown constructs renders safely instead of crashing", async () => {
    const raw = fixture()
    raw.locales.en.pages[0] = page(
      "about",
      "About OshiYobi",
      ["[dangerous](javascript:alert(1))", "**unterminated bold and a stray ["].join("\n\n"),
    )
    vi.mocked(aboutContentApi.fetchAboutContent).mockResolvedValue(raw)

    renderAboutPage()
    expect(await screen.findByRole("heading", { level: 1, name: "About OshiYobi" })).toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "dangerous" })).not.toBeInTheDocument()
  })

  it("a malformed/rejected response does not crash the app -- shows an error state instead", async () => {
    vi.mocked(aboutContentApi.fetchAboutContent).mockRejectedValue(new Error("Received a malformed About content response"))
    renderAboutPage()
    expect(await screen.findByRole("alert")).toBeInTheDocument()
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument()
  })

  it("resolves the Google Privacy Policy link to the official Google domain", async () => {
    const user = userEvent.setup()
    renderAboutPage()
    await screen.findByRole("heading", { level: 1, name: "About OshiYobi" })
    await user.click(screen.getByRole("button", { name: "Privacy" }))
    expect(screen.getByRole("link", { name: "Google Privacy Policy" })).toHaveAttribute("href", "https://policies.google.com/privacy")
  })

  it("resolves the YouTube Terms of Service link to the official YouTube domain", async () => {
    const user = userEvent.setup()
    renderAboutPage()
    await screen.findByRole("heading", { level: 1, name: "About OshiYobi" })
    await user.click(screen.getByRole("button", { name: "Terms of Use" }))
    expect(screen.getByRole("link", { name: "YouTube Terms of Service" })).toHaveAttribute("href", "https://www.youtube.com/t/terms")
  })

  it("leaves the unresolved contact placeholder as literal text, never a link", async () => {
    const user = userEvent.setup()
    renderAboutPage()
    await screen.findByRole("heading", { level: 1, name: "About OshiYobi" })
    await user.click(screen.getByRole("button", { name: "Privacy" }))
    expect(screen.getByText("[Contact]")).toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "[Contact]" })).not.toBeInTheDocument()
  })

  it("uses the existing Settings secondary-nav/content shell classes -- no independent About layout", async () => {
    const { container } = renderAboutPage()
    await screen.findByRole("heading", { level: 1, name: "About OshiYobi" })
    expect(container.querySelector(".settings-page")).not.toBeNull()
    expect(container.querySelector(".settings-page__content")).not.toBeNull()
    expect(container.querySelector(".settings-secondary-navbar")).not.toBeNull()
  })

  it("never renders the obsolete first Data Sources draft", async () => {
    setLocale("zh-TW")
    renderAboutPage()
    await screen.findByRole("heading", { level: 1, name: "關於 OshiYobi" })
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "資料來源" }))
    expect(screen.getByText("Schedule 直播排程")).toBeInTheDocument()
    expect(screen.queryByText("協助整理 VTuber 直播資訊的外部資料服務", { exact: false })).not.toBeInTheDocument()
  })
})
