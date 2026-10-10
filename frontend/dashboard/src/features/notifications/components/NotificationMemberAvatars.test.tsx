import { fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { NotificationSettings } from "./NotificationSettings"
import { fetchVideoTopics } from "../../home-room/data/videoTopics"
import { getAllNotificationCreators, groupCreatorsForNotificationSettings } from "../model/notificationCreatorGrouping"
import { getCreators } from "../../../entities/creator/data/creatorRegistry"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"
import { MemberThemeProvider } from "../../../shared/theme/MemberThemeProvider"

// B24: Push notifications > 管理成員 shows each creator's backend YouTube channel icon (registry `avatarUrl`) -- in the
// management list AND the selected notification-member preview, through one shared avatar -- with the initial only as a
// fallback, and no mouse-hover background on a row.

vi.mock("../../home-room/data/videoTopics", () => ({ fetchVideoTopics: vi.fn() }))
vi.mock("../api/liveReminderApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/liveReminderApi")>()),
  saveCreatorReminder: vi.fn().mockResolvedValue(undefined),
  deleteCreatorReminder: vi.fn().mockResolvedValue(undefined),
}))

const STORAGE_KEY = "yobi.topicNotificationPreferences.v2"
const DEFAULT_ORDER = ["all", "sf6", "valorant", "apex", "minecraft"]
const CREATOR_ID = "aizawa_ema"
const NO_ICON_ID = "ayunda_risu"

const REGISTRY_AVATAR = getCreators().find((creator) => creator.creatorId === CREATOR_ID)!.avatarUrl!

function seed(liveIds: string[]) {
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ topicOrder: DEFAULT_ORDER, topics: { all: { live: liveIds, newVideo: [], reminderOverrides: {}, notificationType: "both" } } }),
  )
  resetAllSharedStateForTests()
}

function renderSettings() {
  return render(
    <MemberThemeProvider>
      <NotificationSettings />
    </MemberThemeProvider>,
  )
}

const detailPanel = () => document.querySelector<HTMLElement>(".notification-detail-panel")!
const rowFor = (name: string) => screen.getAllByText(name, { selector: ".topic-creator-drawer__creator-name" })[0].closest(".topic-creator-drawer__row") as HTMLElement
const avatarOf = (row: Element) => row.querySelector(".topic-creator-drawer__avatar") as HTMLElement
const nameOf = (id: string) => getAllNotificationCreators().find((creator) => creator.creatorId === id)!.displayName

async function openDrawer(user: ReturnType<typeof userEvent.setup>) {
  await user.click(within(detailPanel()).getAllByRole("button", { name: /Manage Members/ })[0])
}

const originalAvatars = new Map<string, string | null>()
beforeEach(() => {
  vi.mocked(fetchVideoTopics).mockResolvedValue([{ id: "other", labels: { en: "other" } }])
  window.localStorage.setItem("yobi.locale", "en")
  resetAllSharedStateForTests()
})
afterEach(() => {
  for (const creator of getAllNotificationCreators()) if (originalAvatars.has(creator.creatorId)) creator.avatarUrl = originalAvatars.get(creator.creatorId)!
  originalAvatars.clear()
})
function removeIconOf(id: string) {
  const creator = getAllNotificationCreators().find((entry) => entry.creatorId === id)!
  originalAvatars.set(id, creator.avatarUrl)
  creator.avatarUrl = null
}

describe("B24: the data path keeps the backend channel icon", () => {
  it("the notification creator model carries the canonical registry avatarUrl for every creator (it used to be dropped)", () => {
    const registry = new Map(getCreators().map((creator) => [creator.creatorId, creator.avatarUrl]))
    const creators = getAllNotificationCreators()

    expect(creators.length).toBeGreaterThan(50)
    for (const creator of creators) expect(creator.avatarUrl).toBe(registry.get(creator.creatorId))
    expect(creators.find((creator) => creator.creatorId === CREATOR_ID)!.avatarUrl).toBe(REGISTRY_AVATAR)
  })
})

describe("B24: 管理成員 (member management) rows", () => {
  it("show the creator's channel icon image and no initial text", async () => {
    seed([])
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderSettings()
    await openDrawer(user)

    const avatar = avatarOf(rowFor(nameOf(CREATOR_ID)))
    expect(avatar.querySelector("img")).toHaveAttribute("src", REGISTRY_AVATAR)
    expect(avatar.querySelector("img")).toHaveAttribute("alt", "")
    expect(avatar).toHaveTextContent("")
    expect(avatar).toHaveAttribute("aria-hidden", "true")
  })

  it("every row has an icon when the registry has one -- no initials anywhere", async () => {
    seed([])
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderSettings()
    await openDrawer(user)

    const avatars = Array.from(document.querySelectorAll(".topic-creator-drawer__avatar"))
    expect(avatars.length).toBeGreaterThan(50)
    expect(avatars.filter((avatar) => !avatar.querySelector("img"))).toHaveLength(0)
    expect(avatars.filter((avatar) => (avatar.textContent ?? "") !== "")).toHaveLength(0)
  })

  it("fall back to the initial for a creator with no icon, and for an image that fails to load", async () => {
    removeIconOf(NO_ICON_ID)
    seed([])
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderSettings()
    await openDrawer(user)

    const noIcon = avatarOf(rowFor(nameOf(NO_ICON_ID)))
    expect(noIcon.querySelector("img")).toBeNull()
    expect(noIcon).toHaveTextContent(nameOf(NO_ICON_ID).trim().charAt(0))

    const broken = avatarOf(rowFor(nameOf(CREATOR_ID)))
    fireEvent.error(broken.querySelector("img")!)
    expect(broken.querySelector("img")).toBeNull()
    expect(broken).toHaveTextContent(nameOf(CREATOR_ID).trim().charAt(0))
  })

  it("keep the creator name, the order and the switch state exactly as before", async () => {
    seed([CREATOR_ID])
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderSettings()
    await openDrawer(user)

    const names = Array.from(document.querySelectorAll(".topic-creator-drawer__creator-name")).map((node) => node.textContent)
    const expectedOrder = groupCreatorsForNotificationSettings().flatMap((agency) =>
      agency.regions.flatMap((region) => region.subgroups.flatMap((subgroup) => subgroup.creators.map((creator) => creator.displayName))),
    )
    expect(names.length).toBeGreaterThan(50)
    expect(names).toEqual(expectedOrder) // grouping and order are exactly the model's (no favorites in this state)
    const row = rowFor(nameOf(CREATOR_ID))
    expect(within(row).getByRole("switch", { name: /live notifications/ })).toBeChecked()
    expect(within(row).getByRole("switch", { name: /new video notifications/ })).not.toBeChecked()
    // the icon sits first in the row, the name right after it (the existing grid: avatar / name / switches)
    expect(row.firstElementChild).toBe(avatarOf(row))
    expect(row.children[1]).toHaveClass("topic-creator-drawer__creator-name")

    await user.click(within(row).getByRole("switch", { name: /new video notifications/ }))
    expect(within(row).getByRole("switch", { name: /new video notifications/ })).toBeChecked()
  })

  it("search results use the same row and the same icon", async () => {
    seed([])
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderSettings()
    await openDrawer(user)

    await user.type(screen.getByPlaceholderText(/search/i), nameOf(CREATOR_ID))

    expect(document.querySelectorAll(".topic-creator-drawer__row").length).toBeGreaterThanOrEqual(1)
    expect(avatarOf(rowFor(nameOf(CREATOR_ID))).querySelector("img")).toHaveAttribute("src", REGISTRY_AVATAR)
  })
})

describe("B24: the selected notification members use the same icon", () => {
  it("the preview shows the channel icon, the same URL the management row uses", async () => {
    seed([CREATOR_ID])
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderSettings()

    const item = Array.from(document.querySelectorAll(".notification-member-preview__item")).find((node) => node.textContent?.includes(nameOf(CREATOR_ID)))!
    const previewImg = item.querySelector(".notification-member-preview__avatar img")!
    expect(previewImg).toHaveAttribute("src", REGISTRY_AVATAR)
    expect(item.querySelector(".notification-member-preview__avatar")).toHaveTextContent("")
    expect(item.querySelector(".notification-member-preview__name")).toHaveTextContent(nameOf(CREATOR_ID))

    await openDrawer(user)
    expect(avatarOf(rowFor(nameOf(CREATOR_ID))).querySelector("img")!.getAttribute("src")).toBe(previewImg.getAttribute("src"))
  })

  it("falls back to the initial for a selected member with no icon", () => {
    removeIconOf(CREATOR_ID)
    seed([CREATOR_ID])
    renderSettings()

    const avatar = document.querySelector(".notification-member-preview__avatar")!
    expect(avatar.querySelector("img")).toBeNull()
    expect(avatar).toHaveTextContent(nameOf(CREATOR_ID).trim().charAt(0))
  })

  it("shows no avatar tile when nobody is selected", () => {
    seed([])
    renderSettings()

    expect(document.querySelector(".notification-member-preview__avatar")).toBeNull()
  })
})

describe("B24: no mouse-hover background on a creator row, selected and focus states intact", () => {
  // Vitest does not process CSS (a ?raw import is empty), so read the stylesheet from disk; the frontend has no Node types.
  let css = ""
  beforeAll(async () => {
    const fs = await import(/* @vite-ignore */ ["node", "fs"].join(":"))
    const { process } = globalThis as unknown as { process: { cwd(): string } }
    css = String(fs.readFileSync(`${process.cwd()}/src/pages/settings/styles/settings.css`, "utf8")).replace(/\/\*[\s\S]*?\*\//g, "")
  })
  const allRules = (): { selector: string; body: string }[] => Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/g)).map((match) => ({ selector: match[1].trim(), body: match[2] }))

  it("reads the real stylesheet (so the rule checks below cannot pass vacuously)", () => {
    expect(css.length).toBeGreaterThan(10000)
    expect(allRules().some(({ selector }) => selector === ".topic-creator-drawer__row")).toBe(true)
  })

  it("has no :hover rule on the row at all, so the pointer can never change its background or border", () => {
    const rowHoverRules = allRules().filter(({ selector }) => selector.split(",").some((part) => /\.topic-creator-drawer__row(?![\w-])[^,]*:hover\s*$/.test(part.trim())))
    expect(rowHoverRules).toEqual([])
  })

  it("keeps the SELECTED row's own background and accent border", () => {
    const selected = allRules().find(({ selector }) => selector === ".topic-creator-drawer__row:has(.ant-switch-checked)")!
    expect(selected.body).toMatch(/border-left-color:\s*var\(--drawer-accent\)/)
    expect(selected.body).toMatch(/background:\s*color-mix\(in srgb, var\(--drawer-accent\) 9%/)
  })

  it("does not suppress the keyboard focus affordance on the drawer rows or their controls", () => {
    const suppressing = allRules().filter(({ selector, body }) => /topic-creator-drawer__(row|switch-cell|reminder)/.test(selector) && /outline:\s*(none|0)\b/.test(body))
    expect(suppressing).toEqual([])
    expect(allRules().some(({ selector, body }) => selector === ".notification-settings-page :focus-visible" && /outline:\s*2px solid/.test(body))).toBe(true)
  })

  it("a creator row's switch is still reachable and operable by keyboard, and the row is a plain container", async () => {
    seed([])
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderSettings()
    await openDrawer(user)

    const row = rowFor(nameOf(CREATOR_ID))
    const toggle = within(row).getByRole("switch", { name: /live notifications/ })
    toggle.focus()
    expect(toggle).toHaveFocus()
    await user.keyboard(" ")
    expect(toggle).toBeChecked()
    expect(row.getAttribute("role")).toBeNull()
  })
})
