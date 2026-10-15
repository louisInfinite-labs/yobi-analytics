/** Editing 我推設定 must not change the creator Home is showing. Root cause fixed here: when Home's route was the entry "/", coming back to it
 * (the nav's Home, or the browser's back) re-seeded the active creator from the CURRENT default Oshi, so adding or changing an Oshi in Settings
 * silently replaced the creator Home had been showing. Now the active creator is kept while it is still a valid creator in the roster; it changes
 * only on an explicit selection, or when it is genuinely invalid (the existing safe fallback to the Oshi). A fresh page load still starts from the
 * Oshi. All of this is in-session state: nothing here reloads the page, and it is viewport-independent (desktop, tablet and phone share it).
 *
 * The router keeps module-level state, so each test loads it fresh (vi.resetModules) -- the same way a new page load would. */
import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const A = "ch_aizawa_ema" // the roster's first creator: the fallback Oshi
const B = "ch_kurumi_noa"

async function loadRouter() {
  vi.resetModules()
  const nav = await import("./useCurrentPage")
  const selected = await import("../../features/oshi/hooks/useSelectedCreator")
  const oshi = await import("../../features/oshi/hooks/useDefaultOshiCreator")
  const favorites = await import("../../features/favorites/hooks/useFavoriteCreators")
  return { nav, selected, oshi, favorites }
}

/** What "我推設定" does when the user picks a different Oshi. */
function changeOshiTo(oshi: Awaited<ReturnType<typeof loadRouter>>["oshi"], creatorId: string) {
  const { result } = renderHook(() => oshi.useDefaultOshiCreator())
  act(() => result.current[1](creatorId))
}

beforeEach(() => {
  window.history.pushState({}, "", "/")
  window.localStorage.clear()
  window.sessionStorage.clear()
})

describe("Settings -> Home keeps the creator Home was showing", () => {
  it("adding / changing the Oshi in 我推設定, then returning Home: still Creator A, at the same URL", async () => {
    const { nav, selected, oshi } = await loadRouter()
    expect(selected.selectedCreatorStore.get()).toBe(A)

    nav.goToPage("settings")
    changeOshiTo(oshi, B) // Creator B becomes the Oshi
    nav.goToPage("home")

    expect(selected.selectedCreatorStore.get()).toBe(A)
    expect(window.location.pathname).toBe("/")
  })

  it("never switches to the new Oshi even for a moment: every value the active creator takes on the way is A", async () => {
    const { nav, selected, oshi } = await loadRouter()
    const seen: string[] = []
    selected.selectedCreatorStore.subscribe(() => seen.push(selected.selectedCreatorStore.get()))

    nav.goToPage("settings")
    changeOshiTo(oshi, B)
    nav.goToPage("home")

    expect(seen.filter((value) => value !== A)).toEqual([])
  })

  it("removing and reordering Favorites in Settings changes nothing either", async () => {
    const { nav, selected, favorites } = await loadRouter()
    const { result } = renderHook(() => favorites.useFavoriteCreators())

    nav.goToPage("settings")
    act(() => result.current.toggleFavorite(B)) // add
    act(() => result.current.toggleFavorite(A)) // add
    act(() => result.current.toggleFavorite(B)) // remove
    nav.goToPage("home")
    expect(selected.selectedCreatorStore.get()).toBe(A)

    nav.goToPage("settings")
    act(() => result.current.toggleFavorite(B)) // re-add: the order changes
    act(() => result.current.toggleFavorite(A)) // remove the creator Home is showing -- not proof it is invalid
    nav.goToPage("home")

    expect(selected.selectedCreatorStore.get()).toBe(A)
  })

  it("editing notification / other preference pages in between changes nothing", async () => {
    const { nav, selected, oshi } = await loadRouter()

    nav.goToPage("settings")
    changeOshiTo(oshi, B)
    nav.goToPage("schedule")
    nav.goToPage("settings")
    nav.goToPage("about")
    nav.goToPage("home")

    expect(selected.selectedCreatorStore.get()).toBe(A)
  })

  it("the browser's Back from Settings to Home also keeps Creator A", async () => {
    const { nav, selected, oshi } = await loadRouter()
    nav.goToPage("settings")
    changeOshiTo(oshi, B)

    window.history.back()
    await waitFor(() => expect(window.location.pathname).toBe("/"))

    expect(selected.selectedCreatorStore.get()).toBe(A)
  })
})

describe("explicit selection still works", () => {
  it("picking Creator B (Live Status) switches Home to B, and B then survives Settings and back", async () => {
    const { nav, selected, oshi } = await loadRouter()

    nav.selectCreator(B)
    expect(selected.selectedCreatorStore.get()).toBe(B)
    expect(window.location.pathname).toBe("/creator/kurumi-noa")

    nav.goToPage("settings")
    changeOshiTo(oshi, A)
    nav.goToPage("home")

    expect(selected.selectedCreatorStore.get()).toBe(B)
  })

  it("selecting B after the Settings round trip switches Home to B", async () => {
    const { nav, selected, oshi } = await loadRouter()
    nav.goToPage("settings")
    changeOshiTo(oshi, B)
    nav.goToPage("home")
    expect(selected.selectedCreatorStore.get()).toBe(A)

    nav.selectCreator(B)

    expect(selected.selectedCreatorStore.get()).toBe(B)
  })
})

describe("the existing behavior that must stay", () => {
  it("a genuinely invalid creator still falls back safely to the Oshi when Home is re-entered", async () => {
    const { nav, selected, oshi } = await loadRouter()
    changeOshiTo(oshi, B)
    selected.selectedCreatorStore.set("ch_not_in_the_roster")

    nav.goToPage("settings")
    nav.goToPage("home")

    expect(selected.selectedCreatorStore.get()).toBe(B)
  })

  it("a fresh page load starts from the Oshi (the Oshi is only ignored within a running session)", async () => {
    window.localStorage.setItem("yobi.defaultOshiCreatorId", B)

    const { selected } = await loadRouter()

    expect(selected.selectedCreatorStore.get()).toBe(B)
    expect(window.location.pathname).toBe("/")
  })

  it("going back from an explicit creator page to the root Home still shows the Oshi (a Home-to-Home move follows the URL)", async () => {
    const { nav, selected } = await loadRouter()
    nav.selectCreator(B) // /creator/kurumi-noa

    window.history.back()
    await waitFor(() => expect(window.location.pathname).toBe("/"))

    expect(selected.selectedCreatorStore.get()).toBe(A)
  })

  it("a direct /creator/:slug link beats the Oshi", async () => {
    window.history.pushState({}, "", "/creator/kurumi-noa")

    const { selected } = await loadRouter()

    expect(selected.selectedCreatorStore.get()).toBe(B)
  })
})
