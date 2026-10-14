import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { getDeliverySlots, useDeliverySlots } from "./useDeliverySlots"
import { useNotificationSaveFailed } from "./notificationSaveStatus"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"
import * as notificationPreferenceApi from "../api/notificationPreferenceApi"
import * as pushNotifications from "../push/pushNotifications"

vi.mock("../api/notificationPreferenceApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/notificationPreferenceApi")>()),
  saveNotificationPreference: vi.fn(),
}))
vi.mock("../push/pushNotifications", () => ({ getPushSubscriptionStatus: vi.fn() }))

const STORAGE_KEY = "yobi.notificationDeliverySlots"
const save = vi.mocked(notificationPreferenceApi.saveNotificationPreference)

function stored() {
  return JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null")
}

function reload() {
  resetAllSharedStateForTests()
}

beforeEach(() => {
  save.mockReset().mockResolvedValue(undefined)
  vi.mocked(pushNotifications.getPushSubscriptionStatus).mockReset().mockResolvedValue("subscribed")
})

describe("persisted selection", () => {
  it("defaults to 08:00 and 18:00 with nothing stored", () => {
    const { result } = renderHook(() => useDeliverySlots())
    expect(result.current.slots).toEqual(["08:00", "18:00"])
    expect(getDeliverySlots()).toEqual(["08:00", "18:00"])
  })

  it("reads a stored selection after a reload", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(["06:30", "12:00", "21:30"]))
    reload()
    expect(getDeliverySlots()).toEqual(["06:30", "12:00", "21:30"])
  })

  it.each([["not json"], ["{}"], ["[]"], ['["08:15","99:00"]'], ['["23:30","01:00","02:00","03:00","04:00","05:00"]'], ["null"]])(
    "normalizes corrupt or legacy storage %s into a valid selection",
    (raw) => {
      window.localStorage.setItem(STORAGE_KEY, raw)
      reload()
      const slots = getDeliverySlots()
      expect(slots.length).toBeGreaterThanOrEqual(1)
      expect(slots.length).toBeLessThanOrEqual(4)
      expect(slots).toEqual([...slots].sort())
      expect(new Set(slots).size).toBe(slots.length)
      expect(slots.every((slot) => /^([01]\d|2[0-3]):(00|30)$/.test(slot))).toBe(true)
    },
  )

  it("caps an over-long stored selection at the earliest 4", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(["23:30", "01:00", "02:00", "03:00", "04:00", "05:00"]))
    reload()
    expect(getDeliverySlots()).toEqual(["01:00", "02:00", "03:00", "04:00"])
  })
})

describe("changing the selection while notifications are enabled (backend-first)", () => {
  it("writes the PROPOSED slots to the backend before the local commit, then persists", async () => {
    const { result } = renderHook(() => useDeliverySlots())
    let seenDuringWrite: string[] | null = null
    let storedDuringWrite: unknown = "unset"
    save.mockImplementationOnce(async () => {
      seenDuringWrite = getDeliverySlots()
      storedDuringWrite = stored()
    })

    let committed: boolean | undefined
    await act(async () => {
      committed = await result.current.addSlot()
    })

    expect(committed).toBe(true)
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][0]).toBe(true)
    expect(save.mock.calls[0][3]).toEqual(["08:00", "12:00", "18:00"])
    expect(seenDuringWrite).toEqual(["08:00", "18:00"])
    expect(storedDuringWrite).toBeNull()
    expect(result.current.slots).toEqual(["08:00", "12:00", "18:00"])
    expect(stored()).toEqual(["08:00", "12:00", "18:00"])
  })

  it("a rejected write leaves the selection (and storage) unchanged and raises the save-failed flag", async () => {
    const { result } = renderHook(() => ({ slots: useDeliverySlots(), failed: useNotificationSaveFailed() }))
    save.mockRejectedValueOnce(Object.assign(new Error("HTTP 400"), { status: 400 }))

    let committed: boolean | undefined
    await act(async () => {
      committed = await result.current.slots.addSlot()
    })

    expect(committed).toBe(false)
    expect(result.current.slots.slots).toEqual(["08:00", "18:00"])
    expect(stored()).toBeNull()
    expect(result.current.failed).toBe(true)
  })

  it("a later successful write clears the failure flag", async () => {
    const { result } = renderHook(() => ({ slots: useDeliverySlots(), failed: useNotificationSaveFailed() }))
    save.mockRejectedValueOnce(new Error("HTTP 500"))
    await act(async () => {
      await result.current.slots.addSlot()
    })
    expect(result.current.failed).toBe(true)

    await act(async () => {
      await result.current.slots.addSlot()
    })

    expect(result.current.failed).toBe(false)
    expect(result.current.slots.slots).toEqual(["08:00", "12:00", "18:00"])
  })

  it("removing a slot sends the reduced selection", async () => {
    const { result } = renderHook(() => useDeliverySlots())
    await act(async () => {
      await result.current.removeSlot("08:00")
    })
    expect(save.mock.calls[0][3]).toEqual(["18:00"])
    expect(result.current.slots).toEqual(["18:00"])
  })

  it("refuses a 5th slot and the removal of the last one without any request", async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(["01:00", "02:00", "03:00", "04:00"]))
    reload()
    const { result } = renderHook(() => useDeliverySlots())
    await act(async () => {
      await result.current.addSlot()
    })
    expect(result.current.slots).toEqual(["01:00", "02:00", "03:00", "04:00"])

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(["01:00"]))
    reload()
    await act(async () => {
      await result.current.removeSlot("01:00")
    })
    expect(result.current.slots).toEqual(["01:00"])
    expect(save).not.toHaveBeenCalled()
  })

  it("serializes two quick additions: the second request is built from the first's committed result", async () => {
    const { result } = renderHook(() => useDeliverySlots())
    let releaseFirst!: () => void
    save.mockImplementationOnce(() => new Promise<void>((resolve) => (releaseFirst = resolve)))

    let first!: Promise<boolean>
    let second!: Promise<boolean>
    await act(async () => {
      first = result.current.addSlot()
      second = result.current.addSlot()
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    expect(save.mock.calls[0][3]).toEqual(["08:00", "12:00", "18:00"])

    await act(async () => {
      releaseFirst()
      await Promise.all([first, second])
    })

    expect(save).toHaveBeenCalledTimes(2)
    expect(save.mock.calls[1][3]).toEqual(["08:00", "12:00", "18:00", "21:00"])
    expect(result.current.slots).toEqual(["08:00", "12:00", "18:00", "21:00"])
  })
})

describe("changing one chosen time", () => {
  it("sends the proposed selection with the time moved, backend-first, and keeps the canonical 24-hour strings", async () => {
    const { result } = renderHook(() => useDeliverySlots())
    await act(async () => {
      expect(await result.current.changeSlot("08:00", "07:30")).toBe(true)
    })
    expect(save.mock.calls[0][3]).toEqual(["07:30", "18:00"])
    expect(result.current.slots).toEqual(["07:30", "18:00"])
    expect(stored()).toEqual(["07:30", "18:00"])
  })

  it("refuses a time that is already chosen without any request (duplicates are impossible)", async () => {
    const { result } = renderHook(() => useDeliverySlots())
    await act(async () => {
      await result.current.changeSlot("08:00", "18:00")
    })
    expect(save).not.toHaveBeenCalled()
    expect(result.current.slots).toEqual(["08:00", "18:00"])
  })

  it("never stores a formatted string such as '8:00 AM': a value that is not a canonical half-hour time is refused", async () => {
    const { result } = renderHook(() => useDeliverySlots())
    await act(async () => {
      await result.current.changeSlot("08:00", "8:00 AM")
    })
    expect(save).not.toHaveBeenCalled()
    expect(stored()).toBeNull()
  })

  it("a removed extra time lets the next addition suggest it again, and the maximum is four", async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(["08:00", "12:00", "18:00", "21:00"]))
    reload()
    const { result } = renderHook(() => useDeliverySlots())
    await act(async () => {
      expect(await result.current.addSlot()).toBe(true) // refused (a no-op) at four: nothing is sent
    })
    expect(save).not.toHaveBeenCalled()
    await act(async () => {
      await result.current.removeSlot("21:00")
    })
    expect(result.current.slots).toEqual(["08:00", "12:00", "18:00"])
    await act(async () => {
      await result.current.addSlot()
    })
    expect(result.current.slots).toEqual(["08:00", "12:00", "18:00", "21:00"])
  })
})

describe("changing the selection while notifications are not enabled in this browser", () => {
  it.each(["unsubscribed", "unsupported"] as const)("commits locally with no request when the push status is %s", async (status) => {
    vi.mocked(pushNotifications.getPushSubscriptionStatus).mockResolvedValue(status)
    const { result } = renderHook(() => useDeliverySlots())
    await act(async () => {
      await result.current.addSlot()
    })
    expect(save).not.toHaveBeenCalled()
    expect(result.current.slots).toEqual(["08:00", "12:00", "18:00"])
    expect(stored()).toEqual(["08:00", "12:00", "18:00"])
  })

  it("commits locally when the push status cannot be read", async () => {
    vi.mocked(pushNotifications.getPushSubscriptionStatus).mockRejectedValue(new Error("no service worker"))
    const { result } = renderHook(() => useDeliverySlots())
    await act(async () => {
      await result.current.addSlot()
    })
    expect(save).not.toHaveBeenCalled()
    expect(result.current.slots).toEqual(["08:00", "12:00", "18:00"])
  })
})
