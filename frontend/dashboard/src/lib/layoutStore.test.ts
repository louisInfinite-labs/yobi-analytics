import { describe, expect, it } from "vitest"
import { ALL_WIDGET_TYPES } from "./widgetRegistry"
import { buildDefaultLayout, readLayout, resetLayout, writeLayout } from "./layoutStore"
import { CURRENT_LAYOUT_VERSION } from "../types/widget"

function memoryStorage(): Storage {
  const store = new Map<string, string>()
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, value),
    removeItem: (key) => void store.delete(key),
    clear: () => store.clear(),
    key: (i) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size
    },
  }
}

describe("buildDefaultLayout", () => {
  it("places exactly one instance of every registered widget type", () => {
    const layout = buildDefaultLayout("default", "desktop")
    expect(layout.widgets.map((w) => w.type).sort()).toEqual([...ALL_WIDGET_TYPES].sort())
  })

  it("stamps the current layout version", () => {
    expect(buildDefaultLayout("default", "desktop").layoutVersion).toBe(CURRENT_LAYOUT_VERSION)
  })
})

describe("readLayout / writeLayout", () => {
  it("returns the default layout when nothing is saved yet", () => {
    const storage = memoryStorage()
    const layout = readLayout("default", "desktop", storage)
    expect(layout.widgets.length).toBe(ALL_WIDGET_TYPES.length)
  })

  it("round-trips a written layout", () => {
    const storage = memoryStorage()
    const layout = buildDefaultLayout("default", "desktop")
    layout.widgets[0].x = 4
    writeLayout(layout, storage)
    expect(readLayout("default", "desktop", storage).widgets[0].x).toBe(4)
  })

  it("keeps desktop and mobile layouts for the same profile separate", () => {
    const storage = memoryStorage()
    const desktopLayout = buildDefaultLayout("default", "desktop")
    desktopLayout.widgets[0].x = 9
    writeLayout(desktopLayout, storage)

    expect(readLayout("default", "mobile", storage).widgets[0].x).not.toBe(9)
  })

  it("falls back to the default layout when the stored value is corrupt JSON", () => {
    const storage = memoryStorage()
    storage.setItem("yobi-analytics-layout:default:desktop", "{not json")
    const layout = readLayout("default", "desktop", storage)
    expect(layout.widgets.length).toBe(ALL_WIDGET_TYPES.length)
  })

  it("falls back to the default layout when the stored value fails shape validation", () => {
    const storage = memoryStorage()
    storage.setItem("yobi-analytics-layout:default:desktop", JSON.stringify({ widgets: "not an array" }))
    const layout = readLayout("default", "desktop", storage)
    expect(layout.widgets.length).toBe(ALL_WIDGET_TYPES.length)
  })

  it("falls back to the default layout when the stored layoutVersion doesn't match", () => {
    const storage = memoryStorage()
    const layout = buildDefaultLayout("default", "desktop")
    storage.setItem("yobi-analytics-layout:default:desktop", JSON.stringify({ ...layout, layoutVersion: 999 }))
    const result = readLayout("default", "desktop", storage)
    expect(result.layoutVersion).toBe(CURRENT_LAYOUT_VERSION)
  })
})

describe("resetLayout", () => {
  it("removes a saved layout so the next read falls back to the default", () => {
    const storage = memoryStorage()
    const layout = buildDefaultLayout("default", "desktop")
    layout.widgets[0].x = 4
    writeLayout(layout, storage)

    resetLayout("default", "desktop", storage)

    expect(readLayout("default", "desktop", storage).widgets[0].x).toBe(0)
  })
})
