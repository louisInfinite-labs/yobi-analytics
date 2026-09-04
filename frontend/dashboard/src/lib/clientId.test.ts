import { describe, expect, it } from "vitest"
import { getOrCreateClientId } from "./clientId"

/** A minimal in-memory Storage implementation, isolated per test (no shared jsdom localStorage state). */
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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

describe("getOrCreateClientId", () => {
  it("creates a UUID-shaped id when nothing is stored yet", () => {
    const id = getOrCreateClientId(memoryStorage())
    expect(id).toMatch(UUID_PATTERN)
  })

  it("persists the created id so a later call returns the same value", () => {
    const storage = memoryStorage()
    const first = getOrCreateClientId(storage)
    const second = getOrCreateClientId(storage)
    expect(second).toBe(first)
  })

  it("returns an already-stored id unchanged rather than generating a new one", () => {
    const storage = memoryStorage()
    storage.setItem("yobi-analytics-client-id", "existing-id-value")
    expect(getOrCreateClientId(storage)).toBe("existing-id-value")
  })

  it("keeps ids from two different storages independent", () => {
    const a = getOrCreateClientId(memoryStorage())
    const b = getOrCreateClientId(memoryStorage())
    expect(a).not.toBe(b)
  })

  it("never throws even if storage.getItem/setItem throw (quota/private mode)", () => {
    const storage = memoryStorage()
    storage.getItem = () => {
      throw new Error("SecurityError")
    }
    expect(() => getOrCreateClientId(storage)).not.toThrow()
    expect(getOrCreateClientId(storage)).toMatch(UUID_PATTERN)
  })
})
