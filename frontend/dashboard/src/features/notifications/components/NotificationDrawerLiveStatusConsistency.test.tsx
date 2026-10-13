import { render, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { NotificationSettings } from "./NotificationSettings"
import { fetchVideoTopics } from "../../home-room/data/videoTopics"
import { getAllNotificationCreators } from "../model/notificationCreatorGrouping"
import { isCurrentMemberEligible } from "../../../entities/creator/data/creatorRegistry"
import { formatBranchHeading } from "../../live-status/components/LiveStatusGroups"
import { groupEligibleCreatorsForLiveStatus } from "../../live-status/utils/liveStatusCanonicalRoster"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"
import { MemberThemeProvider } from "../../../shared/theme/MemberThemeProvider"
import { readStylesheet, rulesOf, ruleBody } from "../../../test/readStylesheet"

// A device that can already deliver Web Push: the gate (pushGate.ts) lets every "turn a notification on" action through, so these
// tests keep exercising the save behavior itself. The gate's own behavior is covered in pushGate.test.ts / pushEnableFlow.test.tsx.
vi.mock("../push/pushGate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../push/pushGate")>()),
  ensurePushEnabled: vi.fn(async () => "ready"),
}))


// Task B: the notification-member drawer is Live Status' roster in Home's visual system -- the same grouping, "VSPO! // JP" headings and
// member order, the Live Status avatar with no glow, Home's surface tokens and Home's own dropdown.

vi.mock("../../home-room/data/videoTopics", () => ({ fetchVideoTopics: vi.fn() }))
vi.mock("../api/liveReminderApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/liveReminderApi")>()),
  saveCreatorReminder: vi.fn().mockResolvedValue(undefined),
  deleteCreatorReminder: vi.fn().mockResolvedValue(undefined),
}))

const STORAGE_KEY = "yobi.topicNotificationPreferences.v2"
const DEFAULT_ORDER = ["all", "sf6", "valorant", "apex", "minecraft"]

function seed(liveIds: string[]) {
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ topicOrder: DEFAULT_ORDER, topics: { all: { live: liveIds, newVideo: [], reminderOverrides: {}, notificationType: "both" } } }),
  )
  resetAllSharedStateForTests()
}

async function openDrawer() {
  const user = userEvent.setup({ pointerEventsCheck: 0 })
  render(
    <MemberThemeProvider>
      <NotificationSettings />
    </MemberThemeProvider>,
  )
  await user.click(within(document.querySelector<HTMLElement>(".notification-detail-panel")!).getAllByRole("button", { name: /Manage Members/ })[0])
  return { user, drawer: document.querySelector<HTMLElement>(".topic-creator-drawer")! }
}

beforeEach(() => {
  vi.mocked(fetchVideoTopics).mockResolvedValue([{ id: "other", labels: { en: "other" } }])
  window.localStorage.setItem("yobi.locale", "en")
  resetAllSharedStateForTests()
})

describe("B: grouping, headings and member order are Live Status'", () => {
  const liveStatusGroups = groupEligibleCreatorsForLiveStatus("", (creator) => isCurrentMemberEligible(creator))

  it("each organization group is ONE complete heading -- VSPO! // JP and VSPO! // EN -- with no standalone VSPO / JP / EN parent or child", async () => {
    seed([])
    const { drawer } = await openDrawer()

    const headings = Array.from(drawer.querySelectorAll(".live-status-group__heading")).map((node) => node.textContent)
    expect(headings).toEqual(liveStatusGroups.map((group) => formatBranchHeading(group.branch)))
    expect(headings.slice(0, 2)).toEqual(["VSPO! // JP", "VSPO! // EN"])
    expect(drawer.querySelector(".topic-creator-drawer__group-title, .topic-creator-drawer__region-title")).toBeNull()
    const allHeadingText = Array.from(drawer.querySelectorAll("h3, h4, h5, .live-status-group__heading")).map((node) => node.textContent?.trim())
    for (const bare of ["VSPO", "HOLOLIVE", "JP", "EN", "ID"]) expect(allHeadingText).not.toContain(bare)
  })

  it("the subgroup labels and every member appear in exactly Live Status' order", async () => {
    seed([])
    const { drawer } = await openDrawer()

    const rendered = Array.from(drawer.querySelectorAll(".live-status-group")).map((group) => ({
      subs: Array.from(group.querySelectorAll(".live-status-group__subheading")).map((node) => node.textContent),
      names: Array.from(group.querySelectorAll(".topic-creator-drawer__creator-name")).map((node) => node.textContent),
    }))
    const nameOf = (id: string) => getAllNotificationCreators().find((creator) => creator.creatorId === id)!.displayName
    expect(rendered.map((group) => group.names)).toEqual(
      liveStatusGroups.map((group) => group.subgroups.flatMap((subgroup) => subgroup.creators.map((creator) => nameOf(creator.creatorId)))),
    )
    expect(rendered.map((group) => group.subs.length)).toEqual(liveStatusGroups.map((group) => group.subgroups.filter((subgroup) => subgroup.label).length))
  })
})

describe("B: the surface and the dropdown are Home's", () => {
  let settingsCss = ""
  beforeAll(async () => {
    settingsCss = await readStylesheet("src/pages/settings/styles/settings.css")
  })

  it("the drawer's variables are Home's tokens (the Live Status drawer surface and the --oshi-* scale), not a notification palette", () => {
    const vars = ruleBody(settingsCss, ".topic-creator-drawer")
    expect(vars).toMatch(/--drawer-bg:\s*#0b1521/)
    expect(vars).toMatch(/--drawer-surface:\s*var\(--oshi-surface-2\)/)
    expect(vars).toMatch(/--drawer-border:\s*var\(--oshi-border\)/)
    expect(vars).toMatch(/--drawer-text-primary:\s*var\(--oshi-text-1\)/)
    expect(vars).toMatch(/--drawer-text-tertiary:\s*var\(--oshi-text-3\)/)
    expect(vars).not.toMatch(/#17141d|#211d29|#292432|#393342|#f3eff7|#b9b1c5|#948b9f/)
  })

  it("a creator name stays whole on one line: the row measures its own width and, below the width a ten-character name needs beside the controls, gives the name its own full-width line", () => {
    expect(ruleBody(settingsCss, ".topic-creator-drawer__content")).toMatch(/container-type:\s*inline-size/)
    expect(ruleBody(settingsCss, ".topic-creator-drawer__creator-name")).toMatch(/white-space:\s*nowrap/)
    // 36 avatar + 132 name + 2 x 48 switches + 134 (the widest, English, reminder column) + 4 x 4 gaps = 414px, so the stacked layout starts below 418px.
    expect(settingsCss).toMatch(/@container \(max-width: 418px\)/)
    expect(ruleBody(settingsCss, ".topic-creator-drawer__row > .topic-creator-drawer__creator-name")).toMatch(/grid-column:\s*2 \/ -1/)
    for (const [child, column] of [[3, 3], [4, 4], [5, 5]]) {
      expect(ruleBody(settingsCss, `.topic-creator-drawer__row > :nth-child(${child})`)).toMatch(new RegExp(`grid-column:\\s*${column}`))
    }
  })

  it("the search is Home's search (.live-status-search), not an antd Input in a private colour", async () => {
    seed([])
    const { drawer } = await openDrawer()

    expect(drawer.querySelector("label.live-status-search input")).not.toBeNull()
    expect(drawer.querySelector(".ant-input, .ant-input-affix-wrapper")).toBeNull()
  })

  it("the reminder control is Home's own dropdown: the same native <select> and class Home's sort / content-type controls use", async () => {
    seed(["aizawa_ema"])
    const { drawer } = await openDrawer()

    const select = within(drawer).getAllByRole("combobox", { name: /'s reminder time/ })[0]
    expect(select.tagName).toBe("SELECT")
    expect(select).toHaveClass("oshi-videos__sort")
    expect(drawer.querySelector(".ant-btn, .ant-dropdown-trigger")).toBeNull()
    expect(select).toHaveDisplayValue("—") // unset: a placeholder, not an option in the list
    // only the width is the drawer's own; every other look is Home's .oshi-videos__sort
    expect(ruleBody(settingsCss, ".topic-creator-drawer__reminder-select").replace(/\s+/g, " ").trim()).toBe("width: 100%;")
  })

  it("choosing a reminder still stores it for that creator + topic (behavior unchanged)", async () => {
    seed(["aizawa_ema"])
    const { drawer, user } = await openDrawer()

    await user.selectOptions(within(drawer).getAllByRole("combobox", { name: /'s reminder time/ })[0], "10 minutes before")

    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}").topics.all.reminderOverrides).toEqual({ aizawa_ema: "10min" })
  })
})

describe("B: creator avatars are Live Status' avatar with zero glow", () => {
  let settingsCss = ""
  let homeCss = ""
  let avatarCss = ""
  beforeAll(async () => {
    settingsCss = await readStylesheet("src/pages/settings/styles/settings.css")
    homeCss = await readStylesheet("src/pages/home/styles/home.css")
    avatarCss = await readStylesheet("src/shared/styles/creatorAvatar.css")
  })

  it("the drawer rows, the selected-member preview and the 收藏 roster all use the shared circle (Live Status' size / crop / no ring)", async () => {
    seed(["aizawa_ema"])
    const { drawer } = await openDrawer()

    expect(drawer.querySelector(".topic-creator-drawer__avatar")).toHaveClass("creator-avatar-circle")
    expect(document.querySelector(".notification-member-preview__avatar")).toHaveClass("creator-avatar-circle")
    expect(ruleBody(avatarCss, ":root")).toMatch(/--creator-avatar-size:\s*36px/)
    expect(ruleBody(homeCss, ".live-status-member__avatar")).toMatch(/width:\s*var\(--creator-avatar-size\)/)
    expect(ruleBody(avatarCss, ".creator-avatar-circle")).toMatch(/width:\s*var\(--creator-avatar-size\)/)
    expect(drawer.querySelector(".topic-creator-drawer__row")!.parentElement).not.toBeNull()
  })

  it("no avatar rule in the notification drawer, the preview or the 收藏 roster adds a border, ring, shadow, filter or hover/selected glow", () => {
    const avatarRules = rulesOf(settingsCss).filter(({ selector }) =>
      selector.split(",").some((part) => /(topic-creator-drawer__avatar|notification-member-preview__avatar|favorites-roster__avatar(?!-wrap))/.test(part)),
    )
    expect(avatarRules.length).toBeGreaterThanOrEqual(3)
    for (const { selector, body } of avatarRules) {
      expect(selector).not.toMatch(/:hover|--selected|:focus/) // no state ever touches the avatar itself
      expect(body).not.toMatch(/box-shadow|drop-shadow|filter:|outline|border(?!-radius)|ring|halo|glow/)
    }
    // pseudo-element glows
    expect(rulesOf(settingsCss).filter(({ selector }) => /(favorites-roster__avatar|topic-creator-drawer__avatar|notification-member-preview__avatar)[^,{]*::(before|after)/.test(selector))).toEqual([])
  })
})

/** Every declaration of every rule whose selector list contains exactly `selector` (a selector can appear in several grouped rules). */
function bodiesOf(css: string, selector: string): string {
  return rulesOf(css)
    .filter((rule) => rule.selector.split(",").some((part) => part.trim() === selector))
    .map((rule) => rule.body)
    .join(" ")
}

describe("the member drawer's six-point correction", () => {
  let settingsCss = ""
  let homeCss = ""
  let avatarCss = ""
  beforeAll(async () => {
    settingsCss = await readStylesheet("src/pages/settings/styles/settings.css")
    homeCss = await readStylesheet("src/pages/home/styles/home.css")
    avatarCss = await readStylesheet("src/shared/styles/creatorAvatar.css")
  })

  it("1. no layout shift: the row has no border or background in any state, and the drawer body's scrollbar track is constant (only its colors change on hover)", () => {
    const rowRules = rulesOf(settingsCss).filter(({ selector }) => selector.split(",").some((part) => /^\.topic-creator-drawer__row(\.[\w-]+)*$/.test(part.trim())))
    expect(rowRules.length).toBeGreaterThan(0)
    for (const { body } of rowRules) expect(body).not.toMatch(/border(-left|-right|-top|-bottom)?\s*:|border-\w+-color|background|box-shadow/)
    const bodyRule = bodiesOf(settingsCss, ".topic-creator-drawer .ant-drawer-body")
    expect(bodyRule).toMatch(/scrollbar-gutter:\s*stable/)
    expect(bodyRule).toMatch(/scrollbar-width:\s*thin/)
    expect(ruleBody(settingsCss, ".topic-creator-drawer .ant-drawer-body:hover")).toMatch(/scrollbar-color/)
    expect(ruleBody(settingsCss, ".topic-creator-drawer .ant-drawer-body:hover")).not.toMatch(/scrollbar-width/) // hover changes colors, never the width
  })

  it("2. the reminder-time list holds only real timings: no 'No reminder' option, and the unset placeholder is a hidden, disabled option", async () => {
    seed(["aizawa_ema"])
    const { drawer } = await openDrawer()

    const select = within(drawer).getAllByRole("combobox", { name: /'s reminder time/ })[0]
    const options = Array.from(select.querySelectorAll("option"))
    const listed = options.filter((option) => !option.hidden).map((option) => option.textContent)
    expect(listed).toEqual(["At start", "1 minute before", "10 minutes before", "30 minutes before", "1 hour before"])
    const placeholder = options.find((option) => option.hidden)!
    expect(placeholder).toBeDisabled()
    expect(placeholder.value).toBe("")
  })

  it("3. the reminder column is sized to its select (a per-locale fixed width) and the name column takes the rest", () => {
    const row = ruleBody(settingsCss, ".topic-creator-drawer__row")
    expect(row).toMatch(/grid-template-columns:\s*var\(--creator-avatar-size\) minmax\(44px, 1fr\) var\(--drawer-switch-col\) var\(--drawer-switch-col\) var\(--drawer-reminder-col\)/)
    expect(ruleBody(settingsCss, ".topic-creator-drawer")).toMatch(/--drawer-switch-col:\s*48px/)
    for (const [locale, px] of [["zh-TW", 80], ["ja", 86], ["en", 122]] as const) {
      expect(ruleBody(settingsCss, `.topic-creator-drawer__content[data-locale="${locale}"]`).replace(/\s+/g, " ")).toContain(`calc(${px}px + var(--drawer-reminder-pad))`)
    }
    // 8px column gap + 8px cell padding (4px + 12px on narrow screens) = 16px of room before the select
    expect(bodiesOf(settingsCss, ".topic-creator-drawer__reminder-cell")).toMatch(/padding-left:\s*var\(--drawer-reminder-pad\)/)
  })

  it("4. an enabled creator's row gets no special background and no left accent border", async () => {
    seed(["aizawa_ema"])
    const { drawer } = await openDrawer()

    expect(drawer.querySelector(".ant-switch-checked")).not.toBeNull() // the switches carry the ON state...
    expect(settingsCss).not.toMatch(/topic-creator-drawer__row:has\(/) // ...the row carries nothing
  })

  it("5. the ON track is the dropdown-list highlight token (Home's `Highlight`), with no pink left in the drawer's theme", () => {
    expect(ruleBody(homeCss, ":root")).toMatch(/--oshi-select-highlight:\s*Highlight/)
    expect(ruleBody(settingsCss, ".topic-creator-drawer .ant-switch.ant-switch-checked")).toMatch(/background:\s*var\(--oshi-select-highlight\)/)
    expect(ruleBody(settingsCss, ".topic-creator-drawer")).toMatch(/color-scheme:\s*dark/) // the scheme the highlight is resolved under
    const drawerCss = rulesOf(settingsCss)
      .filter(({ selector }) => /topic-creator-drawer/.test(selector))
      .map(({ selector, body }) => selector + body)
      .join(" ")
    expect(drawerCss).not.toMatch(/c779a3|d28db2/i)
  })

  it("5b. the drawer's source carries no pink accent constant", async () => {
    const fs = await import(/* @vite-ignore */ ["node", "fs"].join(":"))
    const { process } = globalThis as unknown as { process: { cwd(): string } }
    const source = String(fs.readFileSync(`${process.cwd()}/src/features/notifications/components/TopicCreatorManagementDrawer.tsx`, "utf8"))
    expect(source).not.toMatch(/c779a3|d28db2|NOTIFICATION_ACCENT/i)
    expect(source).not.toContain("★")
  })

  it("6. a favorite's avatar carries the shared heart in the drawer (and the Favorites heading uses that same heart, never a star)", async () => {
    window.localStorage.setItem("yobi.favoriteCreatorIds", JSON.stringify(["ch_aizawa_ema"]))
    seed([])
    const { drawer } = await openDrawer()

    const section = drawer.querySelector(".topic-creator-drawer__group")!
    const hearted = Array.from(section.querySelectorAll(".topic-creator-drawer__row")).filter((row) => row.querySelector(".creator-avatar-heart"))
    expect(hearted.length).toBeGreaterThan(0)
    for (const row of hearted) expect(row.querySelector(".creator-avatar-heart")!.parentElement).toHaveClass("creator-tile__avatar-wrap")
    const regularRows = Array.from(drawer.querySelectorAll(".live-status-group .topic-creator-drawer__row"))
    expect(regularRows.some((row) => row.querySelector(".creator-avatar-heart"))).toBe(false) // non-favorites carry none
    const heading = section.querySelector(".live-status-group__heading")!
    expect(heading.querySelector(".creator-avatar-heart")).not.toBeNull()
    expect(heading.textContent).not.toContain("★")
    // the one shared heart definition: pinned top-right, 10px, an explicit outline (so it reads identically on every screen)
    const heart = ruleBody(avatarCss, ".creator-avatar-heart")
    expect(heart).toMatch(/top:\s*-2px/)
    expect(heart).toMatch(/right:\s*-2px/)
    expect(heart).toMatch(/stroke:\s*rgba\(0, 0, 0, 0\.88\)/)
  })

  it("the notification-type line uses the main page's labels (直播+新片 / 直播 / 新片), never 'Both'", async () => {
    seed([])
    const { drawer } = await openDrawer()

    expect(drawer.querySelector(".topic-creator-drawer__notification-type-context")!.textContent).toBe("Notification type: Live + New Video")
  })
})
