/** Phone Home: the header's Video List search is SUBMIT-driven (the keyboard's Enter / Search), a submitted query REPLACES Home's content with a
 * vertical results list (one video per row), and emptying the input restores the complete Home -- player, Oshi Status, then the SAME Topic's
 * video list, fetched again -- immediately, whatever the focus, and whatever the search request is doing (pending, loaded, empty or failed).
 * The real HomePage and header input run against a stubbed `fetch`; only the YouTube IFrame API is faked. */
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { HomePage } from "./HomePage"
import { MobileHeaderSearch } from "../../app/navigation/MobileHeaderSearch"
import { getCreators, toLegacyRosterId } from "../../entities/creator/data/creatorRegistry"
import { useSelectedCreator } from "../../features/oshi/hooks/useSelectedCreator"
import { loadYouTubeIframeApi } from "../../features/media-player/utils/youtubeIframeApi"
import { resetAllSharedStateForTests } from "../../shared/state/sharedState"
import { readStylesheet, ruleBody, mediaBlocks } from "../../test/readStylesheet"

Element.prototype.setPointerCapture ??= () => {}
Element.prototype.releasePointerCapture ??= () => {}
Element.prototype.hasPointerCapture ??= () => false

vi.mock("../../features/media-player/utils/youtubeIframeApi", () => ({ loadYouTubeIframeApi: vi.fn() }))

const [CREATOR_A] = getCreators()
const LEGACY_A = toLegacyRosterId(CREATOR_A)
const BASELINE_KEY = "yobi.newContent.trackingBaselineAt"

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
const row = (videoId: string, title: string) => ({ videoId, title, publishedAt: "2026-10-01T00:00:00Z", contentType: "upload", currentViewCount: 1 })

type SearchOutcome = { rows: ReturnType<typeof row>[] } | { fail: number } | { pending: true }
let searchOutcome: SearchOutcome
let pendingResolvers: Array<() => void>
let requests: string[]

function installApi() {
  requests = []
  pendingResolvers = []
  searchOutcome = { rows: [row("s1", "Search hit one"), row("s2", "Search hit two"), row("s3", "Search hit three")] }
  vi.stubEnv("VITE_API_BASE_URL", "https://api.test")
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
      requests.push(`${url.pathname}${url.search}`)
      if (url.pathname === "/live-streams") return json({ streams: [] })
      if (url.pathname === "/topics") return json({ topics: [{ id: "singing", labels: { en: "Singing" } }, { id: "chatting", labels: { en: "Chatting" } }] })
      const match = url.pathname.match(/^\/creators\/([^/]+)\/(videos\/recent|videos\/search|oshi-status)$/)
      if (!match) return json({ error: "not found" }, 404)
      if (match[2] === "oshi-status") {
        return json({ subscriberCount: 1, latestVideo: null, thisWeek: { newUploads: 0, newStreams: 0 }, growth: {}, recent: [], sinceLastVisit: null })
      }
      if (match[2] === "videos/search") {
        const outcome = searchOutcome
        if ("fail" in outcome) return json({ error: "boom" }, outcome.fail)
        if ("pending" in outcome) {
          await new Promise<void>((done) => pendingResolvers.push(done))
          return json({ videos: [row("late", "LATE STALE RESULT")] })
        }
        return json({ videos: outcome.rows })
      }
      if (url.searchParams.get("liveStatus") === "completed") return json({ videos: [], hasMore: false })
      const topic = url.searchParams.get("topic") ?? "all"
      return json({ videos: [row(`list_${topic}`, `LIST ${topic}`)], hasMore: false })
    }),
  )
}

function setViewport(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width })
  window.dispatchEvent(new Event("resize"))
}

const headerInput = () => document.querySelector<HTMLInputElement>(".main-topbar__search input")!
const searchRequests = () => requests.filter((request) => request.includes("/videos/search"))
const listRequests = (topic: string) => requests.filter((request) => request.includes("/videos/recent") && request.includes(`topic=${topic}`))
const resultRows = () => Array.from(document.querySelectorAll(".oshi-videos__results > li"))
const homeIsNormal = () => !!document.querySelector(".oshi-stream") && !!document.querySelector(".oshi-status") && !!document.querySelector(".oshi-videos__header") && !document.querySelector(".oshi-videos--results")
const searchViewIsOpen = () => !!document.querySelector(".oshi-videos--results") && !document.querySelector(".oshi-stream") && !document.querySelector(".oshi-status") && !document.querySelector(".oshi-videos__header")

function selectCreator(legacyId: string) {
  const { result } = renderHook(() => useSelectedCreator())
  act(() => result.current[1](legacyId))
}

async function renderPhoneHome() {
  setViewport(390)
  render(
    <>
      <MobileHeaderSearch />
      <HomePage />
    </>,
  )
  await screen.findByText("LIST all")
}

/** What the keyboard does on Enter in a one-field form: the form submits. */
const pressEnter = (user: ReturnType<typeof userEvent.setup>) => user.keyboard("{Enter}")

beforeEach(() => {
  installApi()
  vi.mocked(loadYouTubeIframeApi).mockReset()
  vi.mocked(loadYouTubeIframeApi).mockResolvedValue({ PlayerState: { PLAYING: 1 }, Player: class {} } as never)
  window.localStorage.setItem("yobi.locale", "en")
  window.localStorage.setItem(BASELINE_KEY, "2026-01-01T00:00:00.000Z")
  resetAllSharedStateForTests()
  selectCreator(LEGACY_A)
  vi.spyOn(window, "scrollTo").mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  setViewport(1024)
})

describe("typing does not search; the keyboard's Enter does", () => {
  it("the input asks the phone keyboard for a Search key, and there is no separate submit button", async () => {
    await renderPhoneHome()

    expect(headerInput().getAttribute("enterkeyhint")).toBe("search")
    expect(document.querySelector(".main-topbar__search")?.tagName).toBe("FORM")
    expect(document.querySelector(".main-topbar__search button[type=submit], .main-topbar__search .ant-input-search-button")).toBeNull()
  })

  it("typing sends NO search request, and Home stays exactly as it was", async () => {
    const user = userEvent.setup()
    await renderPhoneHome()

    await user.type(headerInput(), "VALO")
    await new Promise((done) => setTimeout(done, 450)) // longer than the search debounce

    expect(searchRequests()).toEqual([])
    expect(homeIsNormal()).toBe(true)
    expect(headerInput().value).toBe("VALO") // the draft is kept as typed
  })

  it("Enter submits the query: one search request, for what was typed", async () => {
    const user = userEvent.setup()
    await renderPhoneHome()

    await user.type(headerInput(), "VALO")
    await pressEnter(user)

    await waitFor(() => expect(searchRequests()).toHaveLength(1))
    expect(searchRequests()[0]).toContain("/videos/search?q=valo") // normalized, scoped to the selected creator
    expect(searchRequests()[0]).toContain(`/creators/${CREATOR_A.creatorId}/`)
  })

  it("submitting never reloads the page (the form's default is prevented)", async () => {
    await renderPhoneHome()
    fireEvent.change(headerInput(), { target: { value: "VALO" } })

    const notPrevented = fireEvent.submit(document.querySelector(".main-topbar__search")!)

    expect(notPrevented).toBe(false) // preventDefault was called
  })

  it("after submitting, the keyboard is dismissed (the input is blurred) but the query stays in the input", async () => {
    const user = userEvent.setup()
    await renderPhoneHome()
    await user.type(headerInput(), "VALO")
    expect(document.activeElement).toBe(headerInput())

    await pressEnter(user)

    expect(document.activeElement).not.toBe(headerInput())
    expect(headerInput().value).toBe("VALO")
  })

  it("an empty draft submits nothing", async () => {
    const user = userEvent.setup()
    await renderPhoneHome()
    headerInput().focus()

    await pressEnter(user)

    expect(searchRequests()).toEqual([])
    expect(homeIsNormal()).toBe(true)
  })
})

describe("IME composition does not submit", () => {
  it("Enter while a composition is open confirms the candidate: the keydown is cancelled and nothing is searched", async () => {
    await renderPhoneHome()
    fireEvent.compositionStart(headerInput())
    fireEvent.change(headerInput(), { target: { value: "ゔぁろ" } })

    const notPrevented = fireEvent.keyDown(headerInput(), { key: "Enter", keyCode: 229, isComposing: true })
    fireEvent.submit(document.querySelector(".main-topbar__search")!) // even a submit the browser fires anyway

    expect(notPrevented).toBe(false)
    await new Promise((done) => setTimeout(done, 450))
    expect(searchRequests()).toEqual([])
    expect(homeIsNormal()).toBe(true)
  })

  it("once the composition ends, Enter submits the final text", async () => {
    const user = userEvent.setup()
    await renderPhoneHome()
    fireEvent.compositionStart(headerInput())
    fireEvent.change(headerInput(), { target: { value: "誕生日" } })
    fireEvent.compositionEnd(headerInput())

    headerInput().focus()
    await pressEnter(user)

    await waitFor(() => expect(searchRequests()).toHaveLength(1))
  })
})

describe("a submitted search replaces Home with a vertical results list", () => {
  it("hides the player, Oshi Status and the horizontal video list and shows the results view instead", async () => {
    const user = userEvent.setup()
    await renderPhoneHome()
    expect(homeIsNormal()).toBe(true)

    await user.type(headerInput(), "VALO")
    await pressEnter(user)

    await waitFor(() => expect(searchViewIsOpen()).toBe(true))
    expect(document.querySelector(".oshi-videos__viewport")).toBeNull() // no horizontal carousel
    expect(await screen.findByText("Search hit one")).toBeInTheDocument()
  })

  it("lists ONE video per row: one <li> per result, each holding exactly one video card", async () => {
    const user = userEvent.setup()
    await renderPhoneHome()
    await user.type(headerInput(), "VALO")
    await pressEnter(user)

    await screen.findByText("Search hit one")
    expect(resultRows()).toHaveLength(3)
    for (const item of resultRows()) expect(item.querySelectorAll(".oshi-video-card")).toHaveLength(1)
    expect(Array.from(document.querySelectorAll(".oshi-video-card__title")).map((node) => node.textContent)).toEqual(["Search hit one", "Search hit two", "Search hit three"])
  })

  it("keeps the header and its input accessible, with the submitted text in it", async () => {
    const user = userEvent.setup()
    await renderPhoneHome()
    await user.type(headerInput(), "VALO")
    await pressEnter(user)
    await screen.findByText("Search hit one")

    expect(headerInput()).toBeInTheDocument()
    expect(headerInput().value).toBe("VALO")
  })

  it("the stylesheet stacks the rows vertically at phone width: a single-column flex list, full-width cards, no grid of videos", async () => {
    const css = await readStylesheet("src/pages/home/styles/home.css")
    const phone = mediaBlocks(css, "(max-width: 767px)")

    expect(ruleBody(phone, ".oshi-videos__results")).toMatch(/flex-direction:\s*column/)
    expect(ruleBody(phone, ".oshi-videos__results")).not.toMatch(/grid-template-columns/)
    expect(ruleBody(phone, ".oshi-videos__results .oshi-video-card")).toMatch(/width:\s*100%/)
    expect(ruleBody(phone, ".oshi-videos.oshi-videos--results")).toMatch(/height:\s*auto/) // the page itself scrolls vertically
  })

  it("selecting a result opens it in Home's player (the existing selection) and returns to the normal Home", async () => {
    const user = userEvent.setup()
    await renderPhoneHome()
    await user.type(headerInput(), "VALO")
    await pressEnter(user)

    await user.click(await screen.findByText("Search hit two"))

    await waitFor(() => expect(homeIsNormal()).toBe(true))
    expect(document.querySelector(".oshi-player-frame iframe")?.getAttribute("src")).toContain("/embed/s2")
    expect(headerInput().value).toBe("") // the search is over
  })
})

describe("no results, and a failed search, are different states", () => {
  it("zero results: the same 'no matching videos' state the desktop shows; Home stays hidden and the query stays in the input (nothing is cleared for the user)", async () => {
    searchOutcome = { rows: [] }
    const user = userEvent.setup()
    await renderPhoneHome()
    await user.type(headerInput(), "zzz")
    await pressEnter(user)

    expect(await screen.findByText("No matching videos")).toBeInTheDocument()
    expect(searchViewIsOpen()).toBe(true)
    expect(headerInput().value).toBe("zzz")
    await new Promise((done) => setTimeout(done, 100))
    expect(searchViewIsOpen()).toBe(true) // still there: it never restores Home by itself
  })

  it("a failed search shows the error state (never the empty-result text); Home stays hidden", async () => {
    searchOutcome = { fail: 500 }
    const user = userEvent.setup()
    await renderPhoneHome()
    await user.type(headerInput(), "VALO")
    await pressEnter(user)

    expect(await screen.findByRole("alert")).toBeInTheDocument()
    expect(screen.queryByText("No matching videos")).not.toBeInTheDocument()
    expect(searchViewIsOpen()).toBe(true)
    expect(headerInput().value).toBe("VALO")
  })

  it("while the request is loading, the results view is up (not Home) and shows a loading state, not 'no results'", async () => {
    searchOutcome = { pending: true }
    const user = userEvent.setup()
    await renderPhoneHome()
    await user.type(headerInput(), "VALO")
    await pressEnter(user)

    await waitFor(() => expect(searchViewIsOpen()).toBe(true))
    expect(document.querySelector(".oshi-videos--results [aria-busy=true]")).not.toBeNull()
    expect(screen.queryByText("No matching videos")).not.toBeInTheDocument()
  })
})

describe("editing a submitted query", () => {
  it("editing the text sends nothing; only Enter searches again, with the new text", async () => {
    const user = userEvent.setup()
    await renderPhoneHome()
    await user.type(headerInput(), "VALO")
    await pressEnter(user)
    await screen.findByText("Search hit one")
    expect(searchRequests()).toHaveLength(1)

    headerInput().focus()
    fireEvent.change(headerInput(), { target: { value: "apex" } }) // a different query, not an extension of the cached one
    await new Promise((done) => setTimeout(done, 450))
    expect(searchRequests()).toHaveLength(1) // typing alone searched nothing; the old results stay
    expect(screen.getByText("Search hit one")).toBeInTheDocument()

    await pressEnter(user)

    await waitFor(() => expect(searchRequests()).toHaveLength(2))
    expect(searchRequests()[1]).toContain("q=apex")
  })

  it("a submitted extension of the previous query is answered from the existing Search cache (no second request), and still replaces the results", async () => {
    const user = userEvent.setup()
    await renderPhoneHome()
    await user.type(headerInput(), "VALO")
    await pressEnter(user)
    await screen.findByText("Search hit one")

    headerInput().focus()
    fireEvent.change(headerInput(), { target: { value: "VALORANT" } })
    await pressEnter(user)

    expect(searchViewIsOpen()).toBe(true)
    await new Promise((done) => setTimeout(done, 450))
    expect(searchRequests()).toHaveLength(1) // the cache narrowed the complete earlier response locally
  })
})

describe("emptying the input restores the complete Home immediately", () => {
  async function submit(user: ReturnType<typeof userEvent.setup>, text = "VALO") {
    await user.type(headerInput(), text)
    await pressEnter(user)
  }

  it("restores the player, Oshi Status and the video list (in that order on screen)", async () => {
    const user = userEvent.setup()
    await renderPhoneHome()
    await submit(user)
    await screen.findByText("Search hit one")

    fireEvent.change(headerInput(), { target: { value: "" } })

    expect(homeIsNormal()).toBe(true)
    const canvas = document.querySelector(".oshi-home__canvas")!
    const sections = [".oshi-stream", ".oshi-status", ".oshi-videos"].map((selector) => canvas.querySelector(selector)!)
    expect(sections.every(Boolean)).toBe(true)
    // the visual order is the stylesheet's flex `order`: player 1, Oshi Status 2, video list 3
    const css = await readStylesheet("src/pages/home/styles/home.css")
    const orders = [".oshi-stream", ".oshi-status", ".oshi-videos"].map((selector) => Number(/order:\s*(\d+)/.exec(ruleBody(mediaBlocks(css, "(max-width: 1023px)"), selector))![1]))
    expect(orders).toEqual([1, 2, 3])
  })

  it("works while the input is still focused and the keyboard is open", async () => {
    const user = userEvent.setup()
    await renderPhoneHome()
    await submit(user)
    await screen.findByText("Search hit one")
    headerInput().focus()

    fireEvent.change(headerInput(), { target: { value: "" } })

    expect(homeIsNormal()).toBe(true)
    expect(document.activeElement).toBe(headerInput())
  })

  it("works while the search request is still pending, and its late response can never reopen the results", async () => {
    searchOutcome = { pending: true }
    const user = userEvent.setup()
    await renderPhoneHome()
    await submit(user)
    await waitFor(() => expect(searchViewIsOpen()).toBe(true))

    fireEvent.change(headerInput(), { target: { value: "" } })
    expect(homeIsNormal()).toBe(true)
    await act(async () => {
      pendingResolvers.forEach((done) => done()) // the stale response arrives
      await new Promise((done) => setTimeout(done, 80))
    })

    expect(homeIsNormal()).toBe(true)
    expect(screen.queryByText("LATE STALE RESULT")).not.toBeInTheDocument()
  })

  it("works after zero results and after a failed search", async () => {
    searchOutcome = { rows: [] }
    const user = userEvent.setup()
    await renderPhoneHome()
    await submit(user, "zzz")
    await screen.findByText("No matching videos")
    fireEvent.change(headerInput(), { target: { value: "" } })
    expect(homeIsNormal()).toBe(true)

    searchOutcome = { fail: 500 }
    fireEvent.change(headerInput(), { target: { value: "boom" } })
    headerInput().focus()
    await pressEnter(user)
    await screen.findByRole("alert")
    fireEvent.change(headerInput(), { target: { value: "" } })

    expect(homeIsNormal()).toBe(true)
  })

  it("an unsubmitted draft that is emptied leaves Home normal", async () => {
    const user = userEvent.setup()
    await renderPhoneHome()
    await user.type(headerInput(), "VAL")

    fireEvent.change(headerInput(), { target: { value: "" } })

    expect(homeIsNormal()).toBe(true)
    expect(searchRequests()).toEqual([])
  })

  it("a draft that is only spaces counts as empty", async () => {
    const user = userEvent.setup()
    await renderPhoneHome()
    await submit(user)
    await screen.findByText("Search hit one")

    fireEvent.change(headerInput(), { target: { value: "   " } })

    expect(homeIsNormal()).toBe(true)
  })

  it("the previously selected Topic is kept, and its video list is fetched again", async () => {
    const user = userEvent.setup()
    await renderPhoneHome()
    await user.click(await screen.findByText("Singing"))
    await screen.findByText("LIST singing")
    const before = listRequests("singing").length
    await submit(user)
    await screen.findByText("Search hit one")

    fireEvent.change(headerInput(), { target: { value: "" } })

    await screen.findByText("LIST singing") // Singing is still the selected Topic (ALL is never picked by clearing)
    await waitFor(() => expect(listRequests("singing").length).toBeGreaterThan(before)) // refreshed, not left as it was
    expect(listRequests("all").length).toBe(1) // ALL was only the initial load; nothing re-selected it
  })

  it("ALL is restored (and refreshed) when it was the Topic before the search", async () => {
    const user = userEvent.setup()
    await renderPhoneHome()
    const before = listRequests("all").length
    await submit(user, "birthday")
    await screen.findByText("Search hit one")

    fireEvent.change(headerInput(), { target: { value: "" } })

    await waitFor(() => expect(listRequests("all").length).toBeGreaterThan(before))
    expect(await screen.findByText("LIST all")).toBeInTheDocument()
  })

  it("searching again after clearing still works", async () => {
    const user = userEvent.setup()
    await renderPhoneHome()
    await submit(user)
    await screen.findByText("Search hit one")
    fireEvent.change(headerInput(), { target: { value: "" } })
    expect(homeIsNormal()).toBe(true)

    searchOutcome = { rows: [row("n1", "Second search hit")] }
    headerInput().focus()
    await user.type(headerInput(), "apex")
    await pressEnter(user)

    expect(await screen.findByText("Second search hit")).toBeInTheDocument()
    expect(searchViewIsOpen()).toBe(true)
  })
})

describe("the header search belongs to the phone only", () => {
  it("on a desktop width the desktop box is input-driven as before: typing searches with no Enter", async () => {
    setViewport(1366)
    render(<HomePage />)
    await screen.findByText("LIST all")
    const desktopBox = document.querySelector<HTMLInputElement>(".oshi-videos__search input")!

    fireEvent.change(desktopBox, { target: { value: "apex" } })

    await waitFor(() => expect(searchRequests().length).toBeGreaterThan(0))
    expect(document.querySelector(".oshi-videos--results")).toBeNull() // desktop keeps its own results layout, in the shelf
  })
})
