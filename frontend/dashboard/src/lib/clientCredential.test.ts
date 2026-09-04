import { beforeEach, describe, expect, it, vi } from "vitest"
import { getOrCreateClientSecret } from "./clientCredential"
import * as apiClient from "./apiClient"

vi.mock("./apiClient", () => ({ apiRequest: vi.fn() }))

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

describe("getOrCreateClientSecret", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("registers a new secret via POST /clients/{clientId}/credential when none is stored yet", async () => {
    vi.mocked(apiClient.apiRequest).mockResolvedValue({ clientId: "c1", clientSecret: "fresh-secret" })
    const storage = memoryStorage()

    const secret = await getOrCreateClientSecret("c1", storage)

    expect(secret).toBe("fresh-secret")
    expect(apiClient.apiRequest).toHaveBeenCalledWith("/clients/c1/credential", { method: "POST" })
  })

  it("caches the registered secret in storage for a later call", async () => {
    vi.mocked(apiClient.apiRequest).mockResolvedValue({ clientId: "c1", clientSecret: "fresh-secret" })
    const storage = memoryStorage()

    await getOrCreateClientSecret("c1", storage)
    const second = await getOrCreateClientSecret("c1", storage)

    expect(second).toBe("fresh-secret")
    expect(apiClient.apiRequest).toHaveBeenCalledTimes(1)
  })

  it("returns an already-stored secret unchanged rather than registering a new one", async () => {
    const storage = memoryStorage()
    storage.setItem("yobi-analytics-client-secret", "existing-secret")

    const secret = await getOrCreateClientSecret("c1", storage)

    expect(secret).toBe("existing-secret")
    expect(apiClient.apiRequest).not.toHaveBeenCalled()
  })

  it("returns null instead of throwing when registration fails", async () => {
    vi.mocked(apiClient.apiRequest).mockRejectedValue(new Error("network error"))
    const storage = memoryStorage()

    await expect(getOrCreateClientSecret("c1", storage)).resolves.toBeNull()
  })

  it("still returns the freshly registered secret even if caching it in storage fails", async () => {
    vi.mocked(apiClient.apiRequest).mockResolvedValue({ clientId: "c1", clientSecret: "fresh-secret" })
    const storage = memoryStorage()
    storage.setItem = () => {
      throw new Error("QuotaExceededError")
    }

    // setItem throwing must not stop the freshly registered secret from
    // still being returned for this call, even though it won't be cached.
    const secret = await getOrCreateClientSecret("c1", storage)

    expect(secret).toBe("fresh-secret")
  })

  it("reuses an in-memory fallback secret across calls when getItem returns null but setItem always throws", async () => {
    // A storage implementation that reads back null without throwing
    // (nothing ever actually persisted) must hit the same fallback path
    // as one where getItem itself throws — otherwise a second call would
    // try to register again and fail, since the backend refuses a second
    // registration for an already-registered clientId.
    vi.mocked(apiClient.apiRequest).mockResolvedValue({ clientId: "c-null-read-test", clientSecret: "fallback-secret-2" })
    const storage = memoryStorage()
    storage.setItem = () => {
      throw new Error("QuotaExceededError")
    }

    const first = await getOrCreateClientSecret("c-null-read-test", storage)
    const second = await getOrCreateClientSecret("c-null-read-test", storage)

    expect(first).toBe("fallback-secret-2")
    expect(second).toBe("fallback-secret-2")
    expect(apiClient.apiRequest).toHaveBeenCalledTimes(1)
  })

  it("reuses an in-memory fallback secret across calls when storage keeps throwing", async () => {
    // Without the module-level fallback cache, a broken store would let
    // the first call register successfully but forget the result, so a
    // second call would try to register again — and the backend's
    // one-time conditional write refuses a second registration for an
    // already-registered clientId, silently breaking every call after
    // the first for the rest of the page session.
    //
    // A clientId distinct from every other test in this file: the
    // fallback cache is module-level state that (deliberately, see its
    // own comment) outlives any single call, so reusing "c1" here could
    // pick up another test's leftover cached entry instead of exercising
    // this test's own registration.
    vi.mocked(apiClient.apiRequest).mockResolvedValue({ clientId: "c-fallback-test", clientSecret: "fallback-secret" })
    const storage = memoryStorage()
    storage.getItem = () => {
      throw new Error("SecurityError")
    }
    storage.setItem = () => {
      throw new Error("SecurityError")
    }

    const first = await getOrCreateClientSecret("c-fallback-test", storage)
    const second = await getOrCreateClientSecret("c-fallback-test", storage)

    expect(first).toBe("fallback-secret")
    expect(second).toBe("fallback-secret")
    expect(apiClient.apiRequest).toHaveBeenCalledTimes(1)
  })
})
