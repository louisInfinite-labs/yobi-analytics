/** The routing matrix for Home's two kinds of route: the root "/" (always the Oshi/default, URL stays "/") and an explicit /creator/:slug. Each case
 * loads the router fresh (vi.resetModules) at a given URL with a given Oshi/session, so it exercises exactly what a page load does; `keepSession`
 * reloads within the SAME browser session (F5). Hooks are not used here (a reset module graph has its own React); the router's plain functions
 * are what the hooks wrap. */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { getCreators, isCurrentMemberEligible, toLegacyRosterId } from "../../entities/creator/data/creatorRegistry"

const OSHI = "ch_kurumi_noa"
const EMA = "ch_aizawa_ema"
const HOME_KEY = "yobi.session.homePath"
const path = () => window.location.pathname

interface Boot {
  oshi?: string
  homePath?: string
}

async function loadApp(url: string, { oshi, homePath }: Boot = {}, keepSession = false) {
  vi.resetModules()
  if (!keepSession) {
    window.localStorage.clear()
    window.sessionStorage.clear()
    if (oshi) window.localStorage.setItem("yobi.defaultOshiCreatorId", oshi)
    if (homePath) window.sessionStorage.setItem(HOME_KEY, homePath)
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

function nextPopstate() {
  return new Promise<void>((resolve) => window.addEventListener("popstate", () => resolve(), { once: true }))
}

beforeEach(() => {
  window.history.replaceState({}, "", "/")
})

describe("A/B. the root route stays the root and shows the Oshi / default creator", () => {
  it("A: fresh session with an Oshi -> URL stays /, the Oshi is displayed", async () => {
    const app = await loadApp("/", { oshi: OSHI })
    expect(path()).toBe("/")
    expect(app.shown()).toBe(OSHI)
  })

  it("B: fresh session with no Oshi -> URL stays /, the existing first creator by display order is displayed", async () => {
    const app = await loadApp("/")
    expect(path()).toBe("/")
    expect(app.shown()).toBe(toLegacyRosterId(firstCreatorByDisplayOrder()))
  })

  it("the root URL is never rewritten: query string, hash and history length are untouched", async () => {
    window.history.pushState({}, "", "/schedule")
    const before = window.history.length
    await loadApp("/?utm_source=x#top", { oshi: OSHI })
    expect(window.location.pathname + window.location.search + window.location.hash).toBe("/?utm_source=x#top")
    expect(window.history.length).toBe(before)
  })
})

describe("C. F5 / reload is not a new session", () => {
  it("C: reload on / stays / and shows the Oshi/default", async () => {
    await loadApp("/", { oshi: OSHI })
    const reloaded = await loadApp("/", {}, true)
    expect(path()).toBe("/")
    expect(reloaded.shown()).toBe(OSHI)
  })

  it("reload on / after the user had picked another creator in this session still shows the Oshi on /", async () => {
    const app = await loadApp("/", { oshi: OSHI })
    app.selectCreator(EMA)
    const reloaded = await loadApp("/", {}, true)
    expect(path()).toBe("/")
    expect(reloaded.shown()).toBe(OSHI)
  })

  it("reload on /creator/aizawa-ema stays on that creator", async () => {
    await loadApp("/creator/aizawa-ema", { oshi: OSHI })
    const reloaded = await loadApp("/creator/aizawa-ema", {}, true)
    expect(path()).toBe("/creator/aizawa-ema")
    expect(reloaded.shown()).toBe(EMA)
  })

  it("reload on /schedule stays on /schedule and the session's Home destination is preserved", async () => {
    const app = await loadApp("/", { oshi: OSHI })
    app.selectCreator(EMA)
    app.goToPage("schedule")
    const reloaded = await loadApp("/schedule", {}, true)
    expect(path()).toBe("/schedule")
    reloaded.goToPage("home")
    expect(path()).toBe("/creator/aizawa-ema")
    expect(reloaded.shown()).toBe(EMA)
  })
})

describe("C/J. an explicit creator URL wins over the Oshi", () => {
  it("/creator/aizawa-ema with another Oshi shows 藍沢エマ, records it as the session Home, and leaves the Oshi alone", async () => {
    const app = await loadApp("/creator/aizawa-ema", { oshi: OSHI })
    expect(path()).toBe("/creator/aizawa-ema")
    expect(app.shown()).toBe(EMA)
    expect(window.sessionStorage.getItem(HOME_KEY)).toBe("/creator/aizawa-ema")
    expect(window.localStorage.getItem("yobi.defaultOshiCreatorId")).toBe(OSHI)
  })
})

describe("D/E/F. explicit selection, and returning Home during the same session", () => {
  it("D: selecting エマ from the root Home moves to /creator/aizawa-ema and shows her", async () => {
    const app = await loadApp("/", { oshi: OSHI })
    app.selectCreator(EMA)
    expect(path()).toBe("/creator/aizawa-ema")
    expect(app.shown()).toBe(EMA)
  })

  it("E: /creator/aizawa-ema -> /schedule -> Home returns to /creator/aizawa-ema", async () => {
    const app = await loadApp("/creator/aizawa-ema", { oshi: OSHI })
    app.goToPage("schedule")
    expect(path()).toBe("/schedule")
    app.goToPage("home")
    expect(path()).toBe("/creator/aizawa-ema")
    expect(app.shown()).toBe(EMA)
  })

  it("F: root Home / -> /schedule -> Home returns to / (the Oshi), never to a creator path", async () => {
    const app = await loadApp("/", { oshi: OSHI })
    app.goToPage("schedule")
    expect(path()).toBe("/schedule")
    app.goToPage("home")
    expect(path()).toBe("/")
    expect(app.shown()).toBe(OSHI)
  })

  it("F: ... and Home from a page loaded directly (no Home visit yet this session) goes to /", async () => {
    const app = await loadApp("/about", { oshi: OSHI })
    app.goToPage("home")
    expect(path()).toBe("/")
    expect(app.shown()).toBe(OSHI)
  })

  it("an Oshi changed in Settings is what the root Home shows when Home is next opened", async () => {
    const app = await loadApp("/", { oshi: OSHI })
    app.goToPage("settings")
    window.localStorage.setItem("yobi.defaultOshiCreatorId", EMA)
    app.goToPage("home")
    expect(path()).toBe("/")
    expect(app.shown()).toBe(EMA)
  })

  it("choosing Home while already on that Home changes nothing (no extra history entry)", async () => {
    const app = await loadApp("/", { oshi: OSHI })
    const before = window.history.length
    app.goToPage("home")
    expect(window.history.length).toBe(before)
  })
})

describe("G. a new browser session starts from the Oshi again", () => {
  it("the previous session ended on /creator/aizawa-ema; a new session opens / -> stays /, shows the Oshi", async () => {
    await loadApp("/creator/aizawa-ema", { oshi: OSHI })
    expect(window.sessionStorage.getItem(HOME_KEY)).toBe("/creator/aizawa-ema")
    expect(window.localStorage.getItem(HOME_KEY)).toBeNull() // never a permanent preference

    window.sessionStorage.clear() // the browser session ended; local storage (the Oshi) stays
    const next = await loadApp("/", {}, true)
    expect(path()).toBe("/")
    expect(next.shown()).toBe(OSHI)
    expect(window.localStorage.getItem("yobi.defaultOshiCreatorId")).toBe(OSHI)
  })
})

describe("H. Live Status picks a creator from any page and lands on that creator's Home", () => {
  for (const [label, page] of [
    ["Schedule", "/schedule"],
    ["Settings", "/setting"],
    ["About", "/about"],
    ["root Home", "/"],
  ] as const) {
    it(`${label}: selecting 藍沢エマ moves to /creator/aizawa-ema immediately, showing her`, async () => {
      const app = await loadApp(page, { oshi: OSHI })
      expect(path()).toBe(page)
      app.selectCreator(EMA)
      expect(path()).toBe("/creator/aizawa-ema")
      expect(app.shown()).toBe(EMA)
    })
  }

  it("an unknown creator key changes nothing", async () => {
    const app = await loadApp("/schedule", { oshi: OSHI })
    app.selectCreator("ch_not_a_creator")
    expect(path()).toBe("/schedule")
  })
})

describe("I. picking another creator's STREAM does not navigate off a non-Home page", () => {
  it("off Home the creator is switched (so Home later shows them) without leaving the page -- the stream still opens in the existing modal", async () => {
    const app = await loadApp("/schedule", { oshi: OSHI })
    app.switchCreatorForVideo(EMA)
    expect(path()).toBe("/schedule")
    expect(app.shown()).toBe(EMA)
    app.goToPage("home")
    expect(path()).toBe("/creator/aizawa-ema")
  })

  it("on Home the URL follows the creator the stream belongs to", async () => {
    const app = await loadApp("/", { oshi: OSHI })
    app.switchCreatorForVideo(EMA)
    expect(path()).toBe("/creator/aizawa-ema")
    expect(app.shown()).toBe(EMA)
  })
})

describe("K. Back / Forward keep the route and the creator in step", () => {
  it("/ -> /creator/aizawa-ema -> /schedule -> /creator/kurumi-noa, then Back x3 and Forward x3", async () => {
    const app = await loadApp("/", { oshi: EMA })
    app.selectCreator(EMA)
    app.goToPage("schedule")
    app.selectCreator(OSHI)
    expect(path()).toBe("/creator/kurumi-noa")

    const back = async (expected: string, shown?: string) => {
      const moved = nextPopstate()
      window.history.back()
      await moved
      expect(path()).toBe(expected)
      if (shown) expect(app.shown()).toBe(shown)
    }
    const forward = async (expected: string, shown?: string) => {
      const moved = nextPopstate()
      window.history.forward()
      await moved
      expect(path()).toBe(expected)
      if (shown) expect(app.shown()).toBe(shown)
    }
    await back("/schedule")
    await back("/creator/aizawa-ema", EMA)
    await back("/", EMA) // the root Home entry shows the Oshi/default (here: エマ)
    await forward("/creator/aizawa-ema", EMA)
    await forward("/schedule")
    await forward("/creator/kurumi-noa", OSHI)
  })

  it("Back onto the root entry shows the Oshi, not the creator that was just left", async () => {
    const app = await loadApp("/", { oshi: OSHI })
    app.selectCreator(EMA)
    const moved = nextPopstate()
    window.history.back()
    await moved
    expect(path()).toBe("/")
    expect(app.shown()).toBe(OSHI)
  })
})

describe("invalid URLs", () => {
  it("an unknown creator slug is never shown (nor a different creator under it): it falls back to the root Home", async () => {
    const app = await loadApp("/creator/not-a-real-creator", { oshi: OSHI })
    expect(path()).toBe("/")
    expect(app.shown()).toBe(OSHI)
  })

  it("/creator with no slug falls back the same way; fixed pages and other unknown paths are left alone", async () => {
    await loadApp("/creator", { oshi: OSHI })
    expect(path()).toBe("/")
    await loadApp("/about", { oshi: OSHI })
    expect(path()).toBe("/about")
    await loadApp("/some/unknown/page", { oshi: OSHI })
    expect(path()).toBe("/some/unknown/page")
  })

  it("the unlinked ?admin tool is never touched", async () => {
    await loadApp("/?admin", { oshi: OSHI })
    expect(window.location.pathname + window.location.search).toBe("/?admin")
  })
})
