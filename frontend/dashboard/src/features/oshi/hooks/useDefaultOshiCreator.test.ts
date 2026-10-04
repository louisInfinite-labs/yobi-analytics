import { act, renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { getCreators, isCurrentMemberEligible, toLegacyRosterId } from "../../../entities/creator/data/creatorRegistry"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"
import { useDefaultOshiCreator } from "./useDefaultOshiCreator"

const STORAGE_KEY = "yobi.defaultOshiCreatorId"

/** The real production fallback, derived the same way the hook itself
 * derives it -- never a hardcoded id (aizawa_ema is a CONSEQUENCE of the
 * current real roster's displayOrder, not a special-cased default). */
function expectedFallbackLegacyId(): string {
  const [first] = [...getCreators()].filter(isCurrentMemberEligible).sort((a, b) => a.displayOrder - b.displayOrder)
  return toLegacyRosterId(first)
}

describe("useDefaultOshiCreator", () => {
  it("defaults to the first eligible creator by canonical displayOrder when nothing is stored", () => {
    const { result } = renderHook(() => useDefaultOshiCreator())
    expect(result.current[0]).toBe(expectedFallbackLegacyId())
  })

  it("in current production data, that fallback is aizawa_ema -- an ordering consequence, not a hardcoded rule", () => {
    const [first] = [...getCreators()].filter(isCurrentMemberEligible).sort((a, b) => a.displayOrder - b.displayOrder)
    expect(first.creatorId).toBe("aizawa_ema")

    const { result } = renderHook(() => useDefaultOshiCreator())
    expect(result.current[0]).toBe("ch_aizawa_ema")
  })

  it("persists across hook instances mounted after the change", () => {
    const first = renderHook(() => useDefaultOshiCreator())
    act(() => first.result.current[1]("ch_gawr_gura"))

    const second = renderHook(() => useDefaultOshiCreator())
    expect(second.result.current[0]).toBe("ch_gawr_gura")
  })

  it("updates an already-mounted consumer immediately when another mounted consumer picks a new default -- no remount required", () => {
    const settingsPage = renderHook(() => useDefaultOshiCreator())
    const otherConsumer = renderHook(() => useDefaultOshiCreator())

    act(() => {
      settingsPage.result.current[1]("ch_gawr_gura")
    })

    expect(settingsPage.result.current[0]).toBe("ch_gawr_gura")
    expect(otherConsumer.result.current[0]).toBe("ch_gawr_gura")
  })

  it("a valid, eligible canonical (bare) stored id is resolved and used directly", () => {
    window.localStorage.setItem(STORAGE_KEY, "usada_pekora")
    resetAllSharedStateForTests()
    const { result } = renderHook(() => useDefaultOshiCreator())
    // Re-normalized to the legacy roster-id form (still readable by
    // not-yet-migrated consumers, e.g. CreatorStatusList's MAIN badge).
    expect(result.current[0]).toBe("ch_usada_pekora")
  })

  it("a valid, eligible legacy ch_* stored id is resolved and used", () => {
    window.localStorage.setItem(STORAGE_KEY, "ch_usada_pekora")
    resetAllSharedStateForTests()
    const { result } = renderHook(() => useDefaultOshiCreator())
    expect(result.current[0]).toBe("ch_usada_pekora")
  })

  it("ch_iofi (legacy alias) resolves to airani_iofifteen and is used directly -- she is eligible", () => {
    window.localStorage.setItem(STORAGE_KEY, "ch_iofi")
    resetAllSharedStateForTests()
    const { result } = renderHook(() => useDefaultOshiCreator())
    expect(result.current[0]).toBe("ch_iofi")
  })

  it("ch_amelia_myth_graduated (legacy alias) resolves to watson_amelia -- graduated creators are still valid Oshi, so the saved pick is kept", () => {
    window.localStorage.setItem(STORAGE_KEY, "ch_amelia_myth_graduated")
    resetAllSharedStateForTests()
    const { result } = renderHook(() => useDefaultOshiCreator())
    expect(result.current[0]).toBe("ch_amelia_myth_graduated")
  })

  it.each(["gawr_gura", "ch_gawr_gura", "mano_aloe", "nanashi_mumei"])(
    "a saved graduated Oshi (%s) stays valid after a reload -- graduation never invalidates a selection",
    (stored) => {
      window.localStorage.setItem(STORAGE_KEY, stored)
      resetAllSharedStateForTests()
      const { result } = renderHook(() => useDefaultOshiCreator())
      expect(result.current[0]).not.toBe(expectedFallbackLegacyId())
      expect(result.current[0]).toBe(toLegacyRosterId(getCreators().find((c) => c.creatorId === stored.replace(/^ch_/, ""))!))
    },
  )

  it("the fresh-install fallback is never a graduated creator, even though graduated creators are selectable", () => {
    const { result } = renderHook(() => useDefaultOshiCreator())
    const fallback = getCreators().find((c) => toLegacyRosterId(c) === result.current[0])!
    expect(fallback.lifecycleStage).not.toBe("graduated")
  })

  it("ch_vspo_group (legacy alias) resolves to vspo_official but it is a group channel -- falls back", () => {
    window.localStorage.setItem(STORAGE_KEY, "ch_vspo_group")
    resetAllSharedStateForTests()
    const { result } = renderHook(() => useDefaultOshiCreator())
    expect(result.current[0]).toBe(expectedFallbackLegacyId())
  })

  it("ch_hololive_staff (mock-only, no canonical record) is unresolved -- falls back safely, never crashes", () => {
    window.localStorage.setItem(STORAGE_KEY, "ch_hololive_staff")
    resetAllSharedStateForTests()
    const { result } = renderHook(() => useDefaultOshiCreator())
    expect(result.current[0]).toBe(expectedFallbackLegacyId())
  })

  it("an invalid/unresolvable stored id falls back", () => {
    window.localStorage.setItem(STORAGE_KEY, "not_a_real_creator_id_at_all")
    resetAllSharedStateForTests()
    const { result } = renderHook(() => useDefaultOshiCreator())
    expect(result.current[0]).toBe(expectedFallbackLegacyId())
  })

  it("a missing stored id falls back", () => {
    resetAllSharedStateForTests()
    const { result } = renderHook(() => useDefaultOshiCreator())
    expect(result.current[0]).toBe(expectedFallbackLegacyId())
  })
})
