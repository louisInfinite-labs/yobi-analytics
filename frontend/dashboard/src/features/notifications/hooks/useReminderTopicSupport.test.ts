import { renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useReminderTopicSupport } from "./useReminderTopicSupport"
import { fetchVideoTopics } from "../../home-room/data/videoTopics"

vi.mock("../../home-room/data/videoTopics", () => ({ fetchVideoTopics: vi.fn() }))

const topics = (...ids: string[]) => ids.map((id) => ({ id, labels: { en: id } }))

beforeEach(() => {
  vi.mocked(fetchVideoTopics).mockReset()
})

describe("useReminderTopicSupport", () => {
  it("supports exactly the topics GET /topics returns, using the same machine ids (no mapping layer)", async () => {
    vi.mocked(fetchVideoTopics).mockResolvedValue(topics("valorant", "sf6", "apex", "minecraft", "singing", "mv", "chatting", "other"))
    const { result } = renderHook(() => useReminderTopicSupport())
    await waitFor(() => expect(result.current.isSupportKnown).toBe(true))

    for (const id of ["valorant", "sf6", "apex", "minecraft", "singing", "mv", "chatting"]) expect(result.current.isReminderTopicSupported(id)).toBe(true)
    // Display-only categories (not returned by the backend) and the old pre-contract VALO id are not.
    for (const id of ["gta", "seven_days_to_die", "mahjong_soul", "endfield", "valo"]) expect(result.current.isReminderTopicSupported(id)).toBe(false)
  })

  it("never treats the backend's 'other' fallback as a topic that can have its own reminder", async () => {
    vi.mocked(fetchVideoTopics).mockResolvedValue(topics("sf6", "other"))
    const { result } = renderHook(() => useReminderTopicSupport())
    await waitFor(() => expect(result.current.isSupportKnown).toBe(true))

    expect(result.current.isReminderTopicSupported("other")).toBe(false)
  })

  it("always supports the creator-level 全部 scope, whatever the backend list says", async () => {
    vi.mocked(fetchVideoTopics).mockResolvedValue(topics("sf6"))
    const { result } = renderHook(() => useReminderTopicSupport())
    await waitFor(() => expect(result.current.isSupportKnown).toBe(true))

    expect(result.current.isReminderTopicSupported("all")).toBe(true)
  })

  it("while the list is still loading: support is not yet known, only 全部 is supported", () => {
    vi.mocked(fetchVideoTopics).mockReturnValue(new Promise(() => {}))
    const { result } = renderHook(() => useReminderTopicSupport())

    expect(result.current.isSupportKnown).toBe(false)
    expect(result.current.isReminderTopicSupported("all")).toBe(true)
    expect(result.current.isReminderTopicSupported("sf6")).toBe(false)
  })

  it("if the list fails to load: support is settled as unknown-to-backend, so topics are not supported but 全部 is", async () => {
    vi.mocked(fetchVideoTopics).mockRejectedValue(new Error("offline"))
    const { result } = renderHook(() => useReminderTopicSupport())
    await waitFor(() => expect(result.current.isSupportKnown).toBe(true))

    expect(result.current.isReminderTopicSupported("sf6")).toBe(false)
    expect(result.current.isReminderTopicSupported("all")).toBe(true)
  })
})
