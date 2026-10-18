import { act, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useTodayMilestoneIndicators } from "./useTodayMilestoneIndicators"
import { resetAllCreatorMilestonesForTests } from "../../oshi-status/data/allCreatorMilestones"

vi.mock("../../../shared/api/apiClient", async () => {
  const actual = await vi.importActual<typeof import("../../../shared/api/apiClient")>("../../../shared/api/apiClient")
  return { ...actual, apiRequest: vi.fn() }
})
import { apiRequest } from "../../../shared/api/apiClient"

const requestMock = vi.mocked(apiRequest)
const jst = (year: number, month: number, day: number, hour = 0, minute = 0, second = 0) => Date.UTC(year, month - 1, day, hour, minute, second) - 9 * 3600 * 1000
const BODY = {
  milestones: [
    { creatorId: "hoshimachi_suisei", birthday: "03-22", debutDate: "2018-03-22" },
    { creatorId: "kaga_nazuna", birthday: "04-02", debutDate: "2018-10-20" },
  ],
}

let seen: Record<string, string>[] = []
function Consumer({ id }: { id: string }) {
  const indicators = useTodayMilestoneIndicators()
  seen[Number(id)] = indicators
  return <span data-testid={`consumer-${id}`}>{JSON.stringify(indicators)}</span>
}

const settle = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

beforeEach(() => {
  seen = []
  requestMock.mockReset()
  requestMock.mockResolvedValue(BODY)
  resetAllCreatorMilestonesForTests()
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] })
  vi.setSystemTime(jst(2027, 3, 22, 9))
})

afterEach(() => {
  vi.useRealTimers()
})

describe("useTodayMilestoneIndicators: shared, once, local", () => {
  it("several components at once make ONE request between them and all see the same indicators", async () => {
    render(
      <>
        <Consumer id="0" />
        <Consumer id="1" />
        <Consumer id="2" />
      </>,
    )
    await settle()
    expect(requestMock).toHaveBeenCalledTimes(1)
    expect(requestMock).toHaveBeenCalledWith("/milestones")
    for (const indicators of seen) expect(indicators).toEqual({ hoshimachi_suisei: "both" })
  })

  it("a later mount reuses the data already loaded: no second request", async () => {
    const first = render(<Consumer id="0" />)
    await settle()
    first.unmount()
    render(<Consumer id="1" />)
    await settle()
    expect(requestMock).toHaveBeenCalledTimes(1)
    expect(seen[1]).toEqual({ hoshimachi_suisei: "both" })
  })

  it("the JST date change is computed locally from the cached dates: new indicators, with no request of its own", async () => {
    render(<Consumer id="0" />)
    await settle()
    expect(seen[0]).toEqual({ hoshimachi_suisei: "both" })
    // The whole of March 22 passes, then the next JST midnight: the indicator clears with no request at all.
    await settle(24 * 3600 * 1000)
    expect(seen[0]).toEqual({})
    expect(requestMock).toHaveBeenCalledTimes(1)
    // Days later the window regains focus: the data is by now older than its hour, so it is revalidated ONCE (because it is stale and needed, not because
    // of the date), and the new day's indicators come from the (re)loaded dates.
    vi.setSystemTime(jst(2027, 4, 2, 0, 0, 1))
    act(() => {
      window.dispatchEvent(new Event("focus"))
    })
    await settle()
    expect(seen[0]).toEqual({ kaga_nazuna: "birthday" })
    expect(requestMock).toHaveBeenCalledTimes(2)
  })
  it("no request happens per second: a minute of ticking adds none", async () => {
    render(<Consumer id="0" />)
    await settle()
    await settle(60_000)
    expect(requestMock).toHaveBeenCalledTimes(1)
  })

  it("an unavailable endpoint shows nothing and a remount inside the cool-down does not hammer it", async () => {
    requestMock.mockRejectedValue(new Error("404"))
    const first = render(<Consumer id="0" />)
    await settle()
    expect(seen[0]).toEqual({})
    first.unmount()
    render(<Consumer id="1" />)
    await settle()
    expect(seen[1]).toEqual({})
    expect(requestMock).toHaveBeenCalledTimes(1)
  })
})

describe("revalidation: when next needed, never on a schedule", () => {
  it("passing JST midnight (and a whole day) makes no request by itself; the indicators still move on locally", async () => {
    render(<Consumer id="0" />)
    await settle()
    expect(requestMock).toHaveBeenCalledTimes(1)
    await settle(3 * 24 * 3600 * 1000)
    expect(requestMock).toHaveBeenCalledTimes(1)
    expect(seen[0]).toEqual({})
  })

  it("a stale copy is revalidated once when the window regains focus, and focus while fresh asks for nothing", async () => {
    render(<Consumer id="0" />)
    await settle()
    act(() => {
      window.dispatchEvent(new Event("focus"))
    })
    await settle()
    expect(requestMock).toHaveBeenCalledTimes(1)

    vi.setSystemTime(jst(2027, 3, 22, 11, 30))
    requestMock.mockResolvedValue({ milestones: [{ creatorId: "hoshimachi_suisei", birthday: "03-22", debutDate: "2018-03-22" }, { creatorId: "x_new", birthday: "03-22", debutDate: "2019-03-22" }] })
    act(() => {
      window.dispatchEvent(new Event("focus"))
    })
    await settle()
    expect(requestMock).toHaveBeenCalledTimes(2)
    expect(seen[0]).toEqual({ hoshimachi_suisei: "both", x_new: "both" })
  })

  it("a tab becoming visible revalidates stale data once; becoming hidden asks for nothing", async () => {
    render(<Consumer id="0" />)
    await settle()
    vi.setSystemTime(jst(2027, 3, 22, 12))
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" })
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    await settle()
    expect(requestMock).toHaveBeenCalledTimes(1)
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" })
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    await settle()
    expect(requestMock).toHaveBeenCalledTimes(2)
  })

  it("a failing revalidation keeps showing the last good indicators", async () => {
    render(<Consumer id="0" />)
    await settle()
    expect(seen[0]).toEqual({ hoshimachi_suisei: "both" })
    vi.setSystemTime(jst(2027, 3, 22, 11, 30))
    requestMock.mockRejectedValue(new Error("offline"))
    act(() => {
      window.dispatchEvent(new Event("focus"))
    })
    await settle()
    expect(requestMock).toHaveBeenCalledTimes(2)
    expect(seen[0]).toEqual({ hoshimachi_suisei: "both" })
  })

  it("several consumers revalidating at once still make one request", async () => {
    render(
      <>
        <Consumer id="0" />
        <Consumer id="1" />
      </>,
    )
    await settle()
    vi.setSystemTime(jst(2027, 3, 22, 11, 30))
    act(() => {
      window.dispatchEvent(new Event("focus"))
    })
    await settle()
    expect(requestMock).toHaveBeenCalledTimes(2)
  })
})