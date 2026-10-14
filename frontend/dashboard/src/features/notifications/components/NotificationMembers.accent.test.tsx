import { render, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NotificationSettings } from "./NotificationSettings"
import { OshiSettings } from "../../oshi/components/OshiSettings"
import { getAllNotificationCreators } from "../model/notificationCreatorGrouping"
import { fetchVideoTopics } from "../../home-room/data/videoTopics"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"
import { MemberThemeProvider } from "../../../shared/theme/MemberThemeProvider"

vi.mock("../push/pushGate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../push/pushGate")>()),
  ensurePushEnabled: vi.fn(async () => "ready"),
}))
vi.mock("../../home-room/data/videoTopics", () => ({ fetchVideoTopics: vi.fn() }))
vi.mock("../api/liveReminderApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/liveReminderApi")>()),
  saveCreatorReminder: vi.fn().mockResolvedValue(undefined),
  deleteCreatorReminder: vi.fn().mockResolvedValue(undefined),
}))

beforeEach(() => {
  vi.mocked(fetchVideoTopics).mockResolvedValue([])
  window.localStorage.setItem("yobi.locale", "en")
  resetAllSharedStateForTests()
})

const norm = (text: string | null) => (text ?? "").replace(/\s+/g, " ").trim()

/** displayName -> the --creator-accent / --creator-accent-soft a surface paints that creator with. */
function favoritesAccents(): Map<string, { accent: string; soft: string }> {
  const out = new Map<string, { accent: string; soft: string }>()
  for (const tile of document.querySelectorAll<HTMLElement>(".favorites-roster__tile")) {
    const name = norm(tile.querySelector(".favorites-roster__name")?.textContent ?? null)
    out.set(name, { accent: tile.style.getPropertyValue("--creator-accent"), soft: tile.style.getPropertyValue("--creator-accent-soft") })
  }
  return out
}

function drawerAccents(): Map<string, { accent: string; soft: string }> {
  const out = new Map<string, { accent: string; soft: string }>()
  for (const row of document.querySelectorAll<HTMLElement>(".topic-creator-drawer__row")) {
    const name = norm(row.querySelector(".topic-creator-drawer__creator-name")?.textContent ?? null)
    out.set(name, { accent: row.style.getPropertyValue("--creator-accent"), soft: row.style.getPropertyValue("--creator-accent-soft") })
  }
  return out
}

describe("Notification Members member colors are My Favorites' colors", () => {
  it("every creator shown in BOTH surfaces gets the identical accent and soft accent, across VSPO JP/EN and hololive JP/EN/ID", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })

    const favorites = render(
      <MemberThemeProvider>
        <OshiSettings />
      </MemberThemeProvider>,
    )
    const fromFavorites = favoritesAccents()
    favorites.unmount()
    expect(fromFavorites.size).toBeGreaterThan(50)

    render(
      <MemberThemeProvider>
        <NotificationSettings />
      </MemberThemeProvider>,
    )
    await user.click(within(document.querySelector<HTMLElement>(".notification-detail-panel")!).getAllByRole("button", { name: /Manage Members/ })[0])
    const fromDrawer = drawerAccents()
    expect(fromDrawer.size).toBeGreaterThan(50)

    // Names that appear once per surface and in both; the branch of each compared creator, to prove the spread of organizations.
    const branchByName = new Map<string, string[]>()
    for (const creator of getAllNotificationCreators()) {
      const key = norm(creator.displayName)
      branchByName.set(key, [...(branchByName.get(key) ?? []), creator.branch])
    }
    const compared: string[] = []
    const branches = new Set<string>()
    for (const [name, drawerAccent] of fromDrawer) {
      const favoritesAccent = fromFavorites.get(name)
      if (!favoritesAccent) continue
      expect(drawerAccent, name).toEqual(favoritesAccent)
      expect(drawerAccent.accent, name).not.toBe("")
      compared.push(name)
      for (const branch of branchByName.get(name) ?? []) branches.add(branch)
    }
    expect(compared.length).toBeGreaterThan(50)
    expect([...branches].sort()).toEqual(expect.arrayContaining(["holo_en", "holo_id", "holo_jp", "vspo_en", "vspo_jp"]))
  })
})
