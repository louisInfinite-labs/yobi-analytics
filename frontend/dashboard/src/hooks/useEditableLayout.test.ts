import { renderHook } from "@testing-library/react"
import { act } from "react"
import { beforeEach, describe, expect, it } from "vitest"
import { useEditableLayout } from "./useEditableLayout"
import { readLayout, writeLayout } from "../lib/layoutStore"
import type { Breakpoint } from "../types/widget"

describe("useEditableLayout", () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it("reloads the layout for the new breakpoint instead of carrying over the previous one's draft", () => {
    const { result, rerender } = renderHook(({ breakpoint }) => useEditableLayout("dashboard", breakpoint), {
      // Widened to Breakpoint (not `as const`'s literal "desktop") so
      // rerender() below can pass any other Breakpoint value without a type
      // error -- renderHook infers its Props generic from this object.
      initialProps: { breakpoint: "desktop" as Breakpoint },
    })

    act(() => {
      // Any call that produces a new object reference marks the layout
      // dirty (isDirty compares by reference) without needing a real
      // widget type -- an empty update list is enough to prove the point.
      result.current.updateWidgetPositions([])
    })
    expect(result.current.isDirty).toBe(true)

    rerender({ breakpoint: "mobile" })

    // The unsaved desktop draft must not leak into the mobile layout --
    // check identity, not a second buildDefaultLayout() call's own output
    // (its widgets' updatedAt uses `new Date().toISOString()`, which two
    // separate calls aren't guaranteed to produce byte-identical).
    expect(result.current.layout.breakpoint).toBe("mobile")
    expect(result.current.layout.widgets.length).toBe(readLayout("dashboard", "mobile").widgets.length)
    expect(result.current.isDirty).toBe(false)
  })

  it("saves to the new breakpoint's own storage key after switching, not the previous one's", () => {
    const { result, rerender } = renderHook(({ breakpoint }) => useEditableLayout("dashboard", breakpoint), {
      // Widened to Breakpoint (not `as const`'s literal "desktop") so
      // rerender() below can pass any other Breakpoint value without a type
      // error -- renderHook infers its Props generic from this object.
      initialProps: { breakpoint: "desktop" as Breakpoint },
    })

    rerender({ breakpoint: "mobile" })
    const mobileWidgetCountBeforeAdd = result.current.layout.widgets.length
    act(() => {
      result.current.addWidget("kpi-summary")
    })
    act(() => {
      result.current.save()
    })

    const savedMobile = readLayout("dashboard", "mobile")
    expect(savedMobile.widgets).toHaveLength(mobileWidgetCountBeforeAdd + 1)

    // Nothing was ever saved for desktop in this test -- confirm no entry
    // exists for it at all, rather than asserting a specific widget count
    // against readLayout's own default fallback (which would pass either
    // way, saved-and-empty or never-saved).
    expect(window.localStorage.getItem("yobi-analytics-layout:dashboard:desktop")).toBeNull()
  })

  it("re-reads storage on a profileId change even at the same breakpoint", () => {
    const seeded = { ...readLayout("profile-b", "desktop"), widgets: [] }
    writeLayout(seeded)

    const { result, rerender } = renderHook(({ profileId }) => useEditableLayout(profileId, "desktop"), {
      initialProps: { profileId: "profile-a" },
    })

    rerender({ profileId: "profile-b" })

    expect(result.current.layout).toEqual(readLayout("profile-b", "desktop"))
  })
})
