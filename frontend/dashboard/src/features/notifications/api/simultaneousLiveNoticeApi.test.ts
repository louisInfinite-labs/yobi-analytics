import { beforeEach, describe, expect, it, vi } from "vitest"
import * as apiClient from "../../../shared/api/apiClient"
import { fetchSimultaneousLiveNotice, saveSimultaneousLiveNotice } from "./simultaneousLiveNoticeApi"

vi.mock("../../../shared/api/apiClient", () => ({ apiRequest: vi.fn() }))
vi.mock("../../../shared/api/clientCredential", () => ({ getOrCreateClientSecret: vi.fn().mockResolvedValue("secret-1") }))
vi.mock("../../../shared/api/clientId", () => ({ getOrCreateClientId: () => "client 1" }))

beforeEach(() => {
  vi.mocked(apiClient.apiRequest).mockReset()
  vi.mocked(apiClient.apiRequest).mockResolvedValue(undefined)
})

describe("saveSimultaneousLiveNotice", () => {
  it("opts in with a PUT to the client's own opt-in route, with the client secret and no preference body", async () => {
    await saveSimultaneousLiveNotice(true)

    expect(apiClient.apiRequest).toHaveBeenCalledWith("/clients/client%201/simultaneous-live-notice", {
      method: "PUT",
      headers: { "X-Client-Secret": "secret-1" },
    })
  })

  it("opts out with a DELETE of the same route", async () => {
    await saveSimultaneousLiveNotice(false)

    expect(apiClient.apiRequest).toHaveBeenCalledWith("/clients/client%201/simultaneous-live-notice", {
      method: "DELETE",
      headers: { "X-Client-Secret": "secret-1" },
    })
  })

  it("propagates a rejected write so the caller never treats it as saved", async () => {
    vi.mocked(apiClient.apiRequest).mockRejectedValue(new Error("403"))

    await expect(saveSimultaneousLiveNotice(true)).rejects.toThrow("403")
  })
})

describe("fetchSimultaneousLiveNotice", () => {
  it("reads only the opt-in key of this client", async () => {
    vi.mocked(apiClient.apiRequest).mockResolvedValue({ configs: [] })

    await fetchSimultaneousLiveNotice()

    expect(apiClient.apiRequest).toHaveBeenCalledWith("/remote-config?clientId=client%201&key=simultaneousLiveNotice", {
      headers: { "X-Client-Secret": "secret-1" },
    })
  })

  it.each([
    [[{ key: "simultaneousLiveNotice", value: { enabled: true } }], true],
    [[{ key: "simultaneousLiveNotice", value: { enabled: false } }], false],
    [[{ key: "simultaneousLiveNotice", value: "yes" }], false],
    [[{ key: "simultaneousLiveNotice", value: null }], false],
    [[{ key: "somethingElse", value: { enabled: true } }], false],
    [[], false],
  ])("treats %j as enabled=%s (only exactly {enabled: true} is on)", async (configs, expected) => {
    vi.mocked(apiClient.apiRequest).mockResolvedValue({ configs })

    expect(await fetchSimultaneousLiveNotice()).toBe(expected)
  })
})
