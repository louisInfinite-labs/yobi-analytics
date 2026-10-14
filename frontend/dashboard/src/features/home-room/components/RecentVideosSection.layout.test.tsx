import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { RecentVideosSection } from "./RecentVideosSection"
import { fetchOshiVideos } from "../data/oshiVideos"
import { mediaBlocks, outsideMedia, readStylesheet, rulesOf } from "../../../test/readStylesheet"

// The Home video list's tag strip and its sort / filter dropdowns must never be drawn on top of each other. jsdom has no layout, so this is
// asserted on the two things that decide it: the DOM structure (the strip and the dropdowns are separate boxes) and the stylesheet that
// sizes them (the strip owns its own scroll; below 768px the dropdowns take a row of their own). The real overlap was measured in a browser
// at 390 / 393 / 430 / 440 px wide.

vi.mock("../data/oshiVideos", () => ({ fetchOshiVideos: vi.fn() }))
vi.stubEnv("VITE_API_BASE_URL", "") // nothing here may reach a real API

Element.prototype.setPointerCapture ??= () => {}
Element.prototype.releasePointerCapture ??= () => {}
Element.prototype.hasPointerCapture ??= () => false

beforeEach(() => {
  vi.mocked(fetchOshiVideos).mockReset().mockResolvedValue({ videos: [], nextOffset: 0, hasMore: false })
})

describe("the tag strip and the dropdowns are separate boxes", () => {
  it("renders the Segmented tags inside .oshi-videos__tags and every dropdown inside .oshi-videos__controls, side by side under .oshi-videos__filters", async () => {
    render(<RecentVideosSection creatorId="ch_aizawa_ema" onSelectVideo={() => {}} />)
    await screen.findByRole("combobox", { name: /sort|排序|並び/i })

    const filters = document.querySelector(".oshi-videos__filters") as HTMLElement
    const tags = filters.querySelector(".oshi-videos__tags") as HTMLElement
    const controls = filters.querySelector(".oshi-videos__controls") as HTMLElement
    // The Video Search trigger button is a THIRD child, leading the row (left of the tag strip, see
    // VideoTagSegmented's own `leading` slot) -- it is neither the tag strip nor the controls box.
    const children = Array.from(filters.children)
    expect(children).toHaveLength(3)
    expect(children[0]).toHaveClass("video-search-trigger")
    expect(children.slice(1)).toEqual([tags, controls])
    expect(tags.querySelector(".oshi-videos__segmented")).not.toBeNull()
    expect(controls.querySelector(".oshi-videos__segmented")).toBeNull()
    expect(tags.querySelector("select")).toBeNull() // a dropdown is never inside the scrolling strip
    expect(controls.querySelectorAll("select.oshi-videos__sort").length).toBeGreaterThanOrEqual(2) // content type + sort
  })

  it("keeps the category semantics: choosing a tag still selects exactly that tag, and the dropdowns stay in the controls row", async () => {
    const user = userEvent.setup()
    render(<RecentVideosSection creatorId="ch_aizawa_ema" onSelectVideo={() => {}} />)
    await screen.findByRole("combobox", { name: /sort|排序|並び/i })

    const radios = Array.from(document.querySelectorAll<HTMLInputElement>(".oshi-videos__tags input[type='radio']"))
    expect(radios.length).toBeGreaterThan(2)
    expect(radios.filter((radio) => radio.checked)).toHaveLength(1)
    await user.click(radios[1].closest("label") as HTMLElement)

    expect(radios[1].checked).toBe(true)
    expect(radios.filter((radio) => radio.checked)).toHaveLength(1)
    expect(document.querySelector(".oshi-videos__controls")).not.toBeNull()
  })
})

describe("Home video list controls (home.css)", () => {
  let css = ""
  let phone = ""
  beforeAll(async () => {
    css = await readStylesheet("src/pages/home/styles/home.css")
    phone = mediaBlocks(css, "(max-width: 767px)")
  })
  const bodies = (source: string, selector: string) => rulesOf(source).filter((rule) => rule.selector.split(",").some((part) => part.trim() === selector)).map((rule) => rule.body)
  const declared = (source: string, selector: string) => bodies(source, selector).join("\n")

  it("the tag strip owns its own horizontal scroll, so labels can never be painted over a neighbouring control", () => {
    const tags = declared(outsideMedia(css), ".oshi-videos__tags")
    expect(tags).toMatch(/overflow-x:\s*auto/)
    expect(tags).toMatch(/min-width:\s*0/)
    expect(tags).toMatch(/flex:\s*0 1 auto/) // shrinks only when the tags do not fit
    expect(tags).toMatch(/scrollbar-width:\s*none/)
  })

  it("the Segmented is sized to its labels and never squeezed into the strip's box (the cause of the overlap)", () => {
    const segmented = declared(outsideMedia(css), ".oshi-videos__segmented.ant-segmented")
    expect(segmented).toMatch(/flex:\s*0 0 auto/)
    expect(segmented).toMatch(/width:\s*max-content/)
    expect(declared(outsideMedia(css), ".oshi-videos__segment-label")).toMatch(/white-space:\s*nowrap/) // text keeps its size and stays on one line
  })

  it("desktop and tablet are unchanged: one row, the dropdowns right after the tags, the original 34px header and 22px / 10px controls", () => {
    const base = outsideMedia(css)
    const filters = declared(base, ".oshi-videos__filters")
    expect(filters).toMatch(/display:\s*flex/)
    expect(filters).toMatch(/align-items:\s*center/)
    expect(filters).toMatch(/gap:\s*5px/)
    expect(filters).not.toMatch(/flex-direction/)
    expect(declared(base, ".oshi-videos__header")).not.toMatch(/flex-direction/)
    expect(declared(base, ".oshi-videos")).toMatch(/grid-template-rows:\s*34px\s+minmax\(0,\s*1fr\)/)
    const sort = declared(base, ".oshi-videos__sort")
    expect(sort).toMatch(/height:\s*22px/)
    expect(sort).toMatch(/font-size:\s*10px/)
    expect(declared(base, ".oshi-videos__controls")).toMatch(/flex:\s*0 0 auto/)
  })

  it("below 768px the dropdowns get a row of their own under the tag strip, and share the full width", () => {
    expect(declared(phone, ".oshi-videos__header")).toMatch(/flex-direction:\s*column/)
    expect(declared(phone, ".oshi-videos__filters")).toMatch(/flex-direction:\s*column/)
    expect(declared(phone, ".oshi-videos__filters")).toMatch(/align-items:\s*stretch/)
    expect(declared(phone, ".oshi-videos")).toMatch(/grid-template-rows:\s*auto\s+minmax\(0,\s*1fr\)/)
    expect(declared(phone, ".oshi-videos__tags")).toMatch(/height:\s*34px/)
    const select = declared(phone, ".oshi-videos__controls .oshi-videos__sort")
    expect(select).toMatch(/flex:\s*1 1 0/)
    expect(select).toMatch(/min-width:\s*0/)
    expect(select).toMatch(/height:\s*32px/) // tall enough for the installed app's 16px form-control text
    expect(declared(phone, ".oshi-videos__segment-label")).toMatch(/font-size:\s*12px/) // text is not shrunk on a phone
  })

  it("never wraps or overflows the page: no flex-wrap anywhere in the controls, and the dev-only View All is not given a row of its own", () => {
    for (const selector of [".oshi-videos__filters", ".oshi-videos__tags", ".oshi-videos__controls", ".oshi-videos__header"]) {
      expect(declared(css, selector), selector).not.toMatch(/flex-wrap:\s*wrap/)
    }
    expect(declared(phone, ".oshi-videos__view-all")).toMatch(/display:\s*none/)
  })

  it("the shelf is exactly one row taller on a phone, declared AFTER the single-column rule that sets the shelf's height (else it would lose)", () => {
    const raw = css
    const phoneHeight = raw.lastIndexOf("height: calc(var(--oshi-videos-height) + 38px)")
    const singleColumnHeight = raw.indexOf("height: var(--oshi-videos-height)", raw.indexOf("@media (max-width: 1023px)"))
    expect(phoneHeight).toBeGreaterThan(-1)
    expect(singleColumnHeight).toBeGreaterThan(-1)
    expect(phoneHeight).toBeGreaterThan(singleColumnHeight)
  })
})
