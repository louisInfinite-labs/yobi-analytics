import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { RecentVideosSection } from "./RecentVideosSection"
import { fetchOshiVideos } from "../data/oshiVideos"
import { mediaBlocks, outsideMedia, readStylesheet, rulesOf } from "../../../test/readStylesheet"

// Desktop Search View: the input is always visible (never a collapsed icon the user must click to
// expand), and the Topic Tags STAY visible while a query is typed (typing never changes the header).
// The backend search wiring is covered in RecentVideosSection.desktopSearchBackend.test.tsx.

vi.mock("../data/oshiVideos", () => ({ fetchOshiVideos: vi.fn() }))
vi.stubEnv("VITE_API_BASE_URL", "")

Element.prototype.setPointerCapture ??= () => {}
Element.prototype.releasePointerCapture ??= () => {}
Element.prototype.hasPointerCapture ??= () => false

beforeEach(() => {
  vi.mocked(fetchOshiVideos).mockReset().mockResolvedValue({ videos: [], nextOffset: 0, hasMore: false })
})

describe("Desktop video search box", () => {
  it("is visible by default, with no trigger icon to click first", async () => {
    render(<RecentVideosSection creatorId="ch_aizawa_ema" onSelectVideo={() => {}} />)
    await screen.findByRole("combobox", { name: /sort|排序|並び/i })

    const search = document.querySelector(".oshi-videos__search input") as HTMLInputElement
    expect(search).not.toBeNull()
    expect(search).toBeVisible()
  })

  it("keeps the Topic Tags visible while a query is typed and after it is cleared", async () => {
    const user = userEvent.setup()
    render(<RecentVideosSection creatorId="ch_aizawa_ema" onSelectVideo={() => {}} />)
    await screen.findByRole("combobox", { name: /sort|排序|並び/i })

    expect(document.querySelector(".oshi-videos__tags")).not.toBeNull()

    const search = document.querySelector(".oshi-videos__search input") as HTMLInputElement
    await user.type(search, "sing")
    expect(document.querySelector(".oshi-videos__tags")).not.toBeNull() // typing must NOT hide the Topic Tags
    expect(search.value).toBe("sing") // typing never clears its own query

    await user.clear(search)
    expect(document.querySelector(".oshi-videos__tags")).not.toBeNull()
  })

  it("never clears the query itself (whitespace-only input still counts as active, not reset)", async () => {
    const user = userEvent.setup()
    render(<RecentVideosSection creatorId="ch_aizawa_ema" onSelectVideo={() => {}} />)
    await screen.findByRole("combobox", { name: /sort|排序|並び/i })

    const search = document.querySelector(".oshi-videos__search input") as HTMLInputElement
    await user.type(search, "a")
    await user.type(search, "{Backspace}")
    expect(search.value).toBe("")
    expect(document.querySelector(".oshi-videos__tags")).not.toBeNull() // back to inactive, not stuck
  })
})

describe("Desktop video search box sizing (home.css)", () => {
  let css = ""
  let tablet = ""
  beforeEach(async () => {
    css = await readStylesheet("src/pages/home/styles/home.css")
    tablet = mediaBlocks(css, "(max-width: 1023px)")
  })
  const declared = (source: string, selector: string) =>
    rulesOf(source)
      .filter((rule) => rule.selector.split(",").some((part) => part.trim() === selector))
      .map((rule) => rule.body)
      .join("\n")

  it("has no rigid fixed width: a flexible, clamped preferred size with a shrink floor and a growth ceiling", () => {
    const search = declared(outsideMedia(css), ".oshi-videos__search")
    expect(search).toMatch(/flex:\s*1 1 clamp\(/) // shrinks AND grows -- never a bare fixed width
    expect(search).toMatch(/min-width/)
    expect(search).toMatch(/max-width/)
    expect(search).not.toMatch(/(?<![a-z-])width:\s*\d/) // no separate fixed `width` declaration (min-/max-width don't count)
  })

  it("is hidden on tablet/phone (<=1023px) -- this task does not touch that layout", () => {
    expect(declared(tablet, ".oshi-videos__search")).toMatch(/display:\s*none/)
  })
})
