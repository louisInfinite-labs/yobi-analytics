import { render, act } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { createSharedState, useSharedState, resetAllSharedStateForTests } from "./sharedState"

function Reader({ store, onRender }: { store: ReturnType<typeof createSharedState<string>>; onRender: (value: string) => void }) {
  const [value] = useSharedState(store)
  onRender(value)
  return null
}

describe("createSharedState / useSharedState", () => {
  it("updates every mounted consumer immediately when one of them calls set — not just a freshly-mounted one", () => {
    const store = createSharedState("test.sharedState.sync", () => "initial", (v) => v)
    const seenByFirst: string[] = []
    const seenBySecond: string[] = []

    render(<Reader store={store} onRender={(v) => seenByFirst.push(v)} />)
    render(<Reader store={store} onRender={(v) => seenBySecond.push(v)} />)

    expect(seenByFirst.at(-1)).toBe("initial")
    expect(seenBySecond.at(-1)).toBe("initial")

    act(() => {
      store.set("changed")
    })

    // Both already-mounted consumers reflect the change without remounting.
    expect(seenByFirst.at(-1)).toBe("changed")
    expect(seenBySecond.at(-1)).toBe("changed")
  })

  it("persists to localStorage on set", () => {
    const store = createSharedState("test.sharedState.persist", () => "a", (v) => v)
    act(() => store.set("b"))
    expect(window.localStorage.getItem("test.sharedState.persist")).toBe("b")
  })

  it("resetAllSharedStateForTests re-reads every store from its read function", () => {
    let backing = "x"
    const store = createSharedState("test.sharedState.reset", () => backing, (v) => v)
    act(() => store.set("y"))
    expect(store.get()).toBe("y")

    backing = "z" // simulates localStorage having changed/cleared externally
    resetAllSharedStateForTests()
    expect(store.get()).toBe("z")
  })
})
