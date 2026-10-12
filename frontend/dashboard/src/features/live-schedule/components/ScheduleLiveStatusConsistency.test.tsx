import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { ScheduleGrid } from "./ScheduleGrid"
import { ScheduleCreatorFilter } from "./ScheduleCreatorFilter"
import { toLegacyRosterId } from "../../../entities/creator/data/creatorRegistry"
import { formatBranchHeading } from "../../live-status/components/LiveStatusGroups"
import { groupEligibleCreatorsForLiveStatus } from "../../live-status/utils/liveStatusCanonicalRoster"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"
import { readStylesheet, rulesOf, ruleBody } from "../../../test/readStylesheet"
import { SLOT_COUNT } from "../model/scheduleGrid"
import type { CreatorFilterOption } from "../model/scheduleCreatorFilter"
import type { ScheduleDay } from "../hooks/useWeeklySchedule"
import type { ScheduledStream } from "../model/scheduledStream"

const NOW = new Date(2026, 8, 21, 22, 10)

function stream(index: number, status: ScheduledStream["status"] = "upcoming"): ScheduledStream {
  return {
    id: `s${index}`,
    channelId: `ch_creator_${index}`,
    videoId: `video_${index}`,
    title: `stream title ${index}`,
    description: "",
    status,
    scheduledStartMs: NOW.getTime() + 60 * 60_000,
    thumbnailUrl: `https://img.example/video_${index}.jpg`,
    topics: [],
  }
}

function days(count: number): { days: ScheduleDay[]; streams: ScheduledStream[] } {
  const streams = Array.from({ length: count }, (_, index) => stream(index + 1))
  const slots = Array.from({ length: SLOT_COUNT }, (_, slot) => (slot === 10 ? streams : []))
  return { days: [{ date: new Date(2026, 8, 21), isToday: true, slots }], streams }
}

function renderGrid(count: number) {
  const data = days(count)
  const onSelectStream = vi.fn()
  render(<ScheduleGrid locale="en" days={data.days} now={NOW} selectedStreamId={null} onSelectStream={onSelectStream} />)
  return { ...data, onSelectStream, trigger: () => document.querySelector<HTMLButtonElement>(".more-streams")! }
}

beforeEach(() => {
  window.localStorage.clear()
  resetAllSharedStateForTests()
  vi.spyOn(window, "scrollTo").mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe("Schedule +N: every hidden stream, and only the hidden ones", () => {
  it.each([
    [5, 2],
    [6, 3],
    [9, 6],
  ])("%i streams in one slot: three avatars, '+%i', and the popover lists exactly the %i hidden streams", async (count, hiddenCount) => {
    const { streams, trigger } = renderGrid(count)
    const user = userEvent.setup()

    expect(document.querySelectorAll(".stream-avatar-button")).toHaveLength(3)
    expect(trigger()).toHaveTextContent(`+${hiddenCount}`)
    await user.hover(trigger())

    const rows = Array.from(document.querySelectorAll<HTMLElement>(".hidden-streams-popover__item"))
    expect(rows).toHaveLength(hiddenCount)
    expect(rows.map((row) => row.dataset.videoId)).toEqual(streams.slice(3).map((entry) => entry.videoId))
    // the three visible streams are never repeated
    const visibleTitles = Array.from(document.querySelectorAll(".stream-avatar-button")).map((button) => button.getAttribute("aria-label"))
    for (const row of rows) expect(visibleTitles).not.toContain(row.querySelector(".hidden-streams-popover__title")!.textContent)
  })

  it("four or fewer streams show every avatar and no +N at all", () => {
    renderGrid(4)

    expect(document.querySelectorAll(".stream-avatar-button")).toHaveLength(4)
    expect(document.querySelector(".more-streams")).toBeNull()
  })

  it("a row shows the avatar, creator, title, time/status and thumbnail from the stream's own data", async () => {
    const { streams, trigger } = renderGrid(5)
    await userEvent.setup().hover(trigger())

    const row = document.querySelector<HTMLElement>(`.hidden-streams-popover__item[data-video-id="${streams[3].videoId}"]`)!
    expect(row.querySelector(".creator-avatar-circle")).not.toBeNull()
    expect(row.querySelector(".hidden-streams-popover__creator")!.textContent).toBeTruthy()
    expect(row.querySelector(".hidden-streams-popover__title")).toHaveTextContent("stream title 4")
    expect(row.querySelector(".hidden-streams-popover__time")!.textContent).toBeTruthy()
    expect(row.querySelector(".hidden-streams-popover__thumb img")).toHaveAttribute("src", "https://img.example/video_4.jpg")
  })

  it("falls back to the videoId thumbnail when the stream has none, then to a placeholder", async () => {
    const data = days(5)
    delete data.streams[3].thumbnailUrl
    render(<ScheduleGrid locale="en" days={data.days} now={NOW} selectedStreamId={null} onSelectStream={() => {}} />)
    await userEvent.setup().hover(document.querySelector(".more-streams")!)

    const img = document.querySelector<HTMLImageElement>(`.hidden-streams-popover__item[data-video-id="video_4"] img.hidden-streams-popover__thumb, .hidden-streams-popover__item[data-video-id="video_4"] .hidden-streams-popover__thumb img`)!
    expect(img.getAttribute("src")).toBe("https://img.youtube.com/vi/video_4/hqdefault.jpg")
    fireEvent.error(img)
    await waitFor(() => expect(document.querySelector('.hidden-streams-popover__item[data-video-id="video_4"] .hidden-streams-popover__thumb-placeholder')).not.toBeNull())
  })
})

describe("Schedule +N: the trigger and the popover", () => {
  it("the +N trigger itself never opens a stream: hover/focus/click only show the list", async () => {
    const { trigger, onSelectStream } = renderGrid(5)
    const user = userEvent.setup()

    await user.hover(trigger())
    await user.click(trigger())
    trigger().focus()

    expect(onSelectStream).not.toHaveBeenCalled()
    expect(document.querySelector(".hidden-streams-popover")).not.toBeNull()
  })

  it("hovering opens it, and keyboard focus opens it too", async () => {
    const { trigger } = renderGrid(5)
    const user = userEvent.setup()
    expect(document.querySelector(".hidden-streams-popover")).toBeNull()

    await user.hover(trigger())
    expect(document.querySelector(".hidden-streams-popover")).not.toBeNull()
    await user.keyboard("{Escape}")
    await waitFor(() => expect(document.querySelector(".hidden-streams-popover")).toBeNull())

    await user.unhover(trigger())
    trigger().blur() // Escape handed focus back to the trigger; focusing it afresh is what keyboard users do
    trigger().focus()
    await waitFor(() => expect(document.querySelector(".hidden-streams-popover")).not.toBeNull())
  })

  it("moving the pointer from the trigger into the popover keeps it open; leaving both closes it", async () => {
    const { trigger } = renderGrid(5)
    const user = userEvent.setup()

    await user.hover(trigger())
    await user.unhover(trigger())
    await user.hover(document.querySelector(".hidden-streams-popover")!)
    await new Promise((resolve) => setTimeout(resolve, 400)) // longer than the close delay: it was cancelled by entering the panel
    expect(document.querySelector(".hidden-streams-popover")).not.toBeNull()

    await user.unhover(document.querySelector(".hidden-streams-popover")!)
    await waitFor(() => expect(document.querySelector(".hidden-streams-popover")).toBeNull(), { timeout: 1000 })
  })

  it("Escape closes it, and so does an outside click", async () => {
    const { trigger } = renderGrid(5)
    const user = userEvent.setup()

    await user.hover(trigger())
    await user.keyboard("{Escape}")
    await waitFor(() => expect(document.querySelector(".hidden-streams-popover")).toBeNull())

    await user.unhover(trigger())
    await user.hover(trigger())
    expect(document.querySelector(".hidden-streams-popover")).not.toBeNull()
    fireEvent.pointerDown(document.body)
    await waitFor(() => expect(document.querySelector(".hidden-streams-popover")).toBeNull())
  })

  it.each(["row", "thumbnail"] as const)("clicking a hidden stream's %s opens that exact stream's existing preview", async (part) => {
    const { streams, trigger, onSelectStream } = renderGrid(6)
    const user = userEvent.setup()
    await user.hover(trigger())

    const row = document.querySelector<HTMLElement>(`.hidden-streams-popover__item[data-video-id="${streams[4].videoId}"]`)!
    await user.click(part === "row" ? row : row.querySelector(".hidden-streams-popover__thumb")!)

    expect(onSelectStream).toHaveBeenCalledTimes(1)
    expect(onSelectStream).toHaveBeenCalledWith(streams[4])
    expect(document.querySelector(".hidden-streams-popover")).toBeNull()
  })
})

describe("Schedule avatars are the Live Status avatar", () => {
  let scheduleCss = ""
  let homeCss = ""
  let avatarCss = ""
  beforeAll(async () => {
    scheduleCss = await readStylesheet("src/pages/schedule/styles/schedule.css")
    homeCss = await readStylesheet("src/pages/home/styles/home.css")
    avatarCss = await readStylesheet("src/shared/styles/creatorAvatar.css")
  })

  it("the shared token is 36px and Live Status, Schedule and the +N popover all read it (no private size)", () => {
    expect(avatarCss).toMatch(/--creator-avatar-size:\s*36px/)
    expect(ruleBody(homeCss, ".live-status-member__avatar")).toMatch(/width:\s*var\(--creator-avatar-size\)/)
    expect(ruleBody(homeCss, ".live-status-member__avatar")).toMatch(/height:\s*var\(--creator-avatar-size\)/)
    expect(ruleBody(scheduleCss, ".stream-avatar-button")).toMatch(/width:\s*var\(--creator-avatar-size\)/)
    expect(ruleBody(scheduleCss, ".stream-avatar-group")).toMatch(/height:\s*var\(--creator-avatar-size\)/)
    expect(ruleBody(scheduleCss, ".hidden-streams-popover__item")).toMatch(/grid-template-columns:\s*var\(--creator-avatar-size\)/)
    expect(scheduleCss).not.toMatch(/(width|height):\s*27px/)
  })

  it("every Schedule avatar uses the shared circle, which has no border, ring, shadow, filter or outline", () => {
    renderGrid(5)
    expect(document.querySelector(".stream-avatar")).toHaveClass("creator-avatar-circle")
    const shared = ruleBody(avatarCss, ".creator-avatar-circle")
    expect(shared).toMatch(/border:\s*0/)
    expect(shared).toMatch(/box-shadow:\s*none/)
    expect(shared).toMatch(/filter:\s*none/)
    expect(shared).toMatch(/border-radius:\s*50%/)
    expect(ruleBody(avatarCss, ".creator-avatar-circle img")).toMatch(/object-fit:\s*cover/)
  })

  it("no Schedule avatar rule adds a border, shadow, ring or hover glow", () => {
    const avatarRules = rulesOf(scheduleCss).filter(({ selector }) => /\.stream-avatar(?![\w-])|\.stream-avatar-button(?![\w-])/.test(selector))
    expect(avatarRules.length).toBeGreaterThan(0)
    for (const { selector, body } of avatarRules) {
      if (selector.includes(":focus-visible")) continue // the keyboard focus outline is an accessibility affordance, not a glow
      expect(`${selector} {${body}}`).not.toMatch(/box-shadow|drop-shadow|border:\s*[1-9]|outline:\s*[1-9]|:hover/)
    }
  })
})

describe("Schedule creator filter drawer", () => {
  const liveStatusGroups = groupEligibleCreatorsForLiveStatus("", () => true)
  const everyCreator = liveStatusGroups.flatMap((group) => group.subgroups.flatMap((subgroup) => subgroup.creators))
  const options: CreatorFilterOption[] = [...new Map(everyCreator.map((creator) => [toLegacyRosterId(creator), creator])).values()].map((creator) => ({
    channelId: toLegacyRosterId(creator),
    name: creator.displayName,
    isFavorite: false,
  }))

  function Harness({ initial = [] as string[], onChange = (_: string[]) => {} }) {
    const [selected, setSelected] = useState<string[]>(initial)
    return (
      <ScheduleCreatorFilter
        locale="en"
        creatorOptions={options}
        selectedCreators={selected}
        onSelectedCreatorsChange={(next) => {
          setSelected(next)
          onChange(next)
        }}
      />
    )
  }
  const open = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole("button", { name: /filter/i }))
    return await screen.findByRole("dialog")
  }
  const items = () => Array.from(document.querySelectorAll<HTMLElement>(".schedule-creator-item"))

  it("opens as a drawer from the RIGHT, and Escape closes it, leaving the page behind it intact", async () => {
    render(
      <div>
        <p>schedule stays</p>
        <Harness />
      </div>,
    )
    const user = userEvent.setup()
    await open(user)

    expect(document.querySelector(".ant-drawer-right")).not.toBeNull()
    expect(screen.getByText("schedule stays")).toBeInTheDocument()
    await user.keyboard("{Escape}")
    await waitFor(() => expect(document.querySelector(".ant-drawer-open")).toBeNull())
    expect(screen.getByText("schedule stays")).toBeInTheDocument()
  })

  it("groups, labels and orders the creators exactly as Live Status does (VSPO! // JP, VSPO! // EN, ... and the same member order)", async () => {
    render(<Harness />)
    await open(userEvent.setup())

    const headings = Array.from(document.querySelectorAll(".schedule-creator-drawer .live-status-group__heading")).map((node) => node.textContent)
    expect(headings).toEqual(liveStatusGroups.map((group) => formatBranchHeading(group.branch)))
    expect(headings.slice(0, 2)).toEqual(["VSPO! // JP", "VSPO! // EN"])
    expect(items().map((item) => item.querySelector(".schedule-creator-item__name")!.textContent)).toEqual(
      liveStatusGroups.flatMap((group) => group.subgroups.flatMap((subgroup) => subgroup.creators.map((creator) => creator.displayName))),
    )
  })

  it("each creator is the shared centered tile: the avatar on top, the name directly below it, both on one center line", async () => {
    render(<Harness />)
    await open(userEvent.setup())

    const item = items()[0]
    expect(item).toHaveClass("creator-tile")
    expect(item.children).toHaveLength(2)
    expect(item.firstElementChild).toHaveClass("creator-tile__avatar-wrap")
    expect(item.firstElementChild!.querySelector(".creator-avatar-circle")).not.toBeNull()
    expect(item.children[1]).toHaveClass("creator-tile__name")
    const css = await readStylesheet("src/shared/styles/creatorAvatar.css")
    const tile = ruleBody(css, ".creator-tile")
    expect(tile).toMatch(/flex-direction:\s*column/)
    expect(tile).toMatch(/align-items:\s*center/)
    expect(ruleBody(css, ".creator-tile__name")).toMatch(/text-align:\s*center/) // a wrapped second line stays centered
    expect(ruleBody(css, ".creator-tile__name")).toMatch(/white-space:\s*pre-line/)
  })

  it("Schedule has no creator-tile layout of its own beyond the grid's column sizing: no flex/grid/padding/size/alignment on its tile, only the button reset and colors", async () => {
    const css = await readStylesheet("src/pages/schedule/styles/schedule.css")
    for (const selector of [".schedule-creator-item", ".schedule-creator-item:hover", '.schedule-creator-item[aria-pressed="true"]']) {
      expect(ruleBody(css, selector)).not.toMatch(/display:|flex|grid|padding|width|height|text-align|gap|margin|border-radius/)
    }
    // The ONE Schedule-specific layout rule: column sizing, so a creator name stays on one line (the shared fixed 124px tile wrapped any name wider
    // than its 108px interior). The gap stays the shared one.
    const grid = ruleBody(css, ".creator-tile-grid.schedule-creator-grid")
    expect(grid).toMatch(/grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(calc\(8\.2rem \+ 2 \* var\(--space-2\) \+ 4px\),\s*1fr\)\)/)
    expect(grid).not.toMatch(/gap/)
    expect(css).not.toMatch(/schedule-creator-item__(avatar|name)\s*\{/)
  })

  it("three tiles still fit a row of the 520px drawer, and the grid reflows to fewer columns by itself when narrower", async () => {
    const css = await readStylesheet("src/shared/styles/creatorAvatar.css")
    const scheduleCss = await readStylesheet("src/pages/schedule/styles/schedule.css")
    // The shared tile (收藏名單) is unchanged: a fixed 124px tile.
    expect(ruleBody(css, ".creator-tile-grid")).toMatch(/grid-template-columns:\s*repeat\(auto-fill,\s*124px\)/)
    // Schedule's tile minimum: ten full-width characters at the name's 0.82rem (8.2rem = 131.2px at a 16px root) + 2 x 8px padding + 4px slack.
    const scheduleTileMin = 8.2 * 16 + 2 * 8 + 4
    const drawerWidth = 520
    const gridPadding = 12 * 2 // .schedule-creator-grid padding-inline
    const scrollbar = 15 // a classic scrollbar in the drawer list
    const gap = 12 // --space-3
    expect(Math.floor((drawerWidth - gridPadding - scrollbar + gap) / (scheduleTileMin + gap))).toBe(3)
    expect(ruleBody(scheduleCss, ".schedule-creator-drawer__list")).toMatch(/overflow-y:\s*auto/)
  })

  it("a favorite creator's avatar carries the shared heart; the others carry none", async () => {
    const favorite = options[0].channelId
    render(
      <ScheduleCreatorFilter
        locale="en"
        creatorOptions={options.map((option) => ({ ...option, isFavorite: option.channelId === favorite }))}
        selectedCreators={[]}
        onSelectedCreatorsChange={() => {}}
      />,
    )
    await open(userEvent.setup())

    const hearts = Array.from(document.querySelectorAll<HTMLElement>(".schedule-creator-item .creator-avatar-heart"))
    expect(hearts).toHaveLength(1)
    expect(hearts[0].closest<HTMLElement>(".schedule-creator-item")!.dataset.channelId).toBe(favorite)
    expect(hearts[0].parentElement).toHaveClass("creator-tile__avatar-wrap")
  })

  it("search narrows the list; multi-select, deselect and clear work", async () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    const user = userEvent.setup()
    await open(user)
    const [first, second, third] = items()

    await user.click(first)
    await user.click(third)
    expect(onChange).toHaveBeenLastCalledWith([first.dataset.channelId, third.dataset.channelId])
    expect(items()[0]).toHaveAttribute("aria-pressed", "true")
    expect(items()[2]).toHaveAttribute("aria-pressed", "true")
    expect(second).toHaveAttribute("aria-pressed", "false")
    expect(document.querySelector(".schedule-creator-drawer__selected-count")).toHaveTextContent("2")

    await user.click(first) // deselect
    expect(onChange).toHaveBeenLastCalledWith([third.dataset.channelId])

    await user.type(within(document.querySelector<HTMLElement>(".schedule-creator-drawer")!).getByRole("textbox"), everyCreator[0].displayName)
    expect(items().length).toBeLessThan(options.length)
    expect(items().some((item) => item.textContent === everyCreator[0].displayName)).toBe(true)
    await user.clear(screen.getByRole("textbox"))

    await user.click(screen.getByRole("button", { name: /clear/i }))
    expect(onChange).toHaveBeenLastCalledWith([])
    expect(items().every((item) => item.getAttribute("aria-pressed") === "false")).toBe(true)
  })

  it("two quick selections before the parent re-renders both land", async () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    await open(userEvent.setup())
    const [first, second] = items()

    fireEvent.click(first)
    fireEvent.click(second)

    expect(onChange).toHaveBeenLastCalledWith([first.dataset.channelId, second.dataset.channelId])
  })

  it("the trigger shows how many creators are selected", async () => {
    render(<Harness initial={[options[0].channelId, options[1].channelId]} />)

    expect(document.querySelector(".schedule-creator-filter__count")).toHaveTextContent("2")
  })
})

describe("Live Status, 收藏名單 and the Schedule filter agree on avatar, tile and heart", () => {
  let homeCss = ""
  let settingsCss = ""
  let avatarCss = ""
  beforeAll(async () => {
    homeCss = await readStylesheet("src/pages/home/styles/home.css")
    settingsCss = await readStylesheet("src/pages/settings/styles/settings.css")
    avatarCss = await readStylesheet("src/shared/styles/creatorAvatar.css")
  })

  it("the favorite heart is ONE shared rule: Live Status' own (top-right, 10px, --live-red) -- no screen positions or sizes it independently", () => {
    const heart = ruleBody(avatarCss, ".creator-avatar-heart")
    expect(heart).toMatch(/top:\s*-2px/)
    expect(heart).toMatch(/right:\s*-2px/)
    expect(heart).toMatch(/width:\s*10px/)
    expect(heart).toMatch(/height:\s*10px/)
    expect(heart).toMatch(/fill:\s*var\(--live-red\)/)
    const allCss = `${homeCss}\n${settingsCss}\n`
    expect(allCss).not.toMatch(/favorite-indicator\s*\{|favorites-roster__favorite-icon/)
  })

  it("no avatar rule on any of the three screens adds a glow: box-shadow, drop-shadow, colored ring, halo or pseudo-element", () => {
    const rules = [...rulesOf(settingsCss), ...rulesOf(homeCss), ...rulesOf(avatarCss)].filter(({ selector }) =>
      /(favorites-roster__avatar(?!-wrap)|live-status-member__avatar(?!-wrap)|creator-avatar-circle|topic-creator-drawer__avatar|stream-avatar(?![\w-]))/.test(selector),
    )
    expect(rules.length).toBeGreaterThanOrEqual(4)
    for (const { selector, body } of rules) {
      expect(selector).not.toMatch(/::(before|after)|:hover|--selected/)
      expect(body).not.toMatch(/box-shadow:\s*(?!none)\S|drop-shadow|filter:\s*(?!none)\S|\bring\b|halo|glow/)
    }
  })

  it("the three screens draw the avatar from the same token and the 收藏名單 tile is the shared one", () => {
    expect(ruleBody(homeCss, ".live-status-member__avatar")).toMatch(/var\(--creator-avatar-size\)/)
    expect(ruleBody(avatarCss, ".creator-avatar-circle")).toMatch(/var\(--creator-avatar-size\)/)
    expect(ruleBody(settingsCss, ".favorites-roster__avatar")).not.toMatch(/width|height|border|shadow/)
    // the 收藏名單 tile / grid / name no longer carry their own copy of the layout
    expect(settingsCss).not.toMatch(/\.favorites-roster__tile\s*,|\.favorites-roster__grid\s*,|\.favorites-roster__name\s*,/)
  })
})
