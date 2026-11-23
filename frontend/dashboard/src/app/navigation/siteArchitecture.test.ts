/** The site's routing after the per-creator pages were retired: Home is always "/", and which creator it shows is in-app state (the session's
 * pick, else the Oshi/default). Each case loads the router fresh (vi.resetModules) at a given URL with a given Oshi/session, exactly like a page
 * load; `keepSession` reloads within the SAME browser session (F5). Hooks are not used here (a reset module graph has its own React); the
 * router's plain functions are what the hooks wrap. */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { getCreators, isCurrentMemberEligible, toLegacyRosterId } from "../../entities/creator/data/creatorRegistry"

const OSHI = "ch_kurumi_noa"
const EMA = "ch_aizawa_ema"
const SESSION_KEY = "yobi.session.homeCreator"
const where = () => window.location.pathname + window.location.search

async function loadApp(url: string, { oshi, sessionCreator }: { oshi?: string; sessionCreator?: string } = {}, keepSession = false) {
  vi.resetModules()
  if (!keepSession) {
    window.localStorage.clear()
    window.sessionStorage.clear()
    if (oshi) window.localStorage.setItem("yobi.defaultOshiCreatorId", oshi)
    if (sessionCreator) window.sessionStorage.setItem(SESSION_KEY, sessionCreator)
  }
  window.history.replaceState({}, "", url)
  const router = await import("./useCurrentPage")
  const { selectedCreatorStore } = await import("../../features/oshi/hooks/useSelectedCreator")
  return { ...router, shown: () => selectedCreatorStore.get() }
}

function firstCreatorByDisplayOrder() {
  const [first] = getCreators()
    .filter(isCurrentMemberEligible)
    .slice()
    .sort((a, b) => a.displayOrder - b.displayOrder)
  return first
}

beforeEach(() => {
  window.history.replaceState({}, "", "/")
})

describe("Home is always the root URL", () => {
  it("a fresh session shows the Oshi at /, else the first creator by display order", async () => {
    expect((await loadApp("/", { oshi: OSHI })).shown()).toBe(OSHI)
    expect((await loadApp("/")).shown()).toBe(toLegacyRosterId(firstCreatorByDisplayOrder()))
    expect(where()).toBe("/")
  })

  it("switching creator on Home keeps the URL /, adds no history entry, and is remembered for the session", async () => {
    const app = await loadApp("/", { oshi: OSHI })
    const before = window.history.length
    app.selectCreator(EMA)
    expect(app.shown()).toBe(EMA)
    expect(where()).toBe("/")
    expect(window.history.length).toBe(before)
    expect(window.sessionStorage.getItem(SESSION_KEY)).toBe(EMA)
  })

  it.each(["/schedule", "/setting", "/about"])("selecting a creator on %s moves to Home (/) at once, showing them", async (page) => {
    const app = await loadApp(page, { oshi: OSHI })
    app.selectCreator(EMA)
    expect(where()).toBe("/")
    expect(app.shown()).toBe(EMA)
  })

  it("off Home a stream pick switches the creator without leaving the page; on Home it is a plain switch", async () => {
    const app = await loadApp("/schedule", { oshi: OSHI })
    app.switchCreatorForVideo(EMA)
    expect(where()).toBe("/schedule")
    expect(app.shown()).toBe(EMA)
    app.goToPage("home")
    expect(where()).toBe("/")
    expect(app.shown()).toBe(EMA)
  })

  it("an unknown creator key changes nothing", async () => {
    const app = await loadApp("/schedule", { oshi: OSHI })
    app.selectCreator("ch_not_in_the_roster")
    expect(where()).toBe("/schedule")
    expect(app.shown()).toBe(OSHI)
  })

  it("every page link points at its own fixed path; Home is /", async () => {
    const app = await loadApp("/", { oshi: OSHI })
    app.selectCreator(EMA)
    expect(["home", "schedule", "settings", "about"].map((page) => app.pageHref(page as "home"))).toEqual(["/", "/schedule", "/setting", "/about"])
  })
})

describe("reloads and sessions", () => {
  it("F5 after a switch keeps the switched creator (same session); a new session starts from the Oshi again", async () => {
    const app = await loadApp("/", { oshi: OSHI })
    app.selectCreator(EMA)
    expect((await loadApp("/", {}, true)).shown()).toBe(EMA)
    expect((await loadApp("/", { oshi: OSHI })).shown()).toBe(OSHI)
  })

  it("a session creator that is no longer in the roster is ignored: the Oshi is shown", async () => {
    expect((await loadApp("/", { oshi: OSHI, sessionCreator: "ch_not_in_the_roster" })).shown()).toBe(OSHI)
  })

  it("the old session key of the retired creator routes is not read", async () => {
    window.localStorage.clear()
    window.sessionStorage.clear()
    window.localStorage.setItem("yobi.defaultOshiCreatorId", OSHI)
    window.sessionStorage.setItem("yobi.session.homePath", "/creator/aizawa-ema")
    expect((await loadApp("/", {}, true)).shown()).toBe(OSHI)
  })
})

describe("notification links: /?creator=<creatorId>", () => {
  it("shows that creator, records it for the session, and removes the parameter", async () => {
    const app = await loadApp("/?creator=aizawa_ema", { oshi: OSHI })
    expect(app.shown()).toBe(EMA)
    expect(where()).toBe("/")
    expect(window.sessionStorage.getItem(SESSION_KEY)).toBe(EMA)
  })

  it("keeps the parameter while a ?video= deep link still needs it (useVideoDeepLink removes both)", async () => {
    const app = await loadApp("/?creator=aizawa_ema&video=dQw4w9WgXcQ", { oshi: OSHI })
    expect(app.shown()).toBe(EMA)
    expect(where()).toBe("/?creator=aizawa_ema&video=dQw4w9WgXcQ")
  })

  it("an unknown creator id is ignored and removed: the Oshi is shown", async () => {
    const app = await loadApp("/?creator=not_a_creator", { oshi: OSHI })
    expect(app.shown()).toBe(OSHI)
    expect(where()).toBe("/")
  })

  it("other query parameters on / are left alone, and ?creator on another page is not applied", async () => {
    expect(where()).toBe("/")
    await loadApp("/?utm_source=x", { oshi: OSHI })
    expect(where()).toBe("/?utm_source=x")
    const app = await loadApp("/schedule?creator=aizawa_ema", { oshi: OSHI })
    expect(app.shown()).toBe(OSHI)
  })
})

describe("retired creator URLs", () => {
  it("/creator/... is not a route: the router neither selects that creator nor rewrites the URL (the host answers 404)", async () => {
    for (const url of ["/creator/aizawa-ema", "/creator", "/creator/not-a-creator"]) {
      const app = await loadApp(url, { oshi: OSHI })
      expect(app.shown(), url).toBe(OSHI)
      expect(window.location.pathname, url).toBe(url)
    }
  })
})
