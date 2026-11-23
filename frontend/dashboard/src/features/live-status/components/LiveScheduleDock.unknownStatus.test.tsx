/** The Live Status dock: the roster is mounted only once the drawer has been opened (no creator rows, links or avatar requests on a page that
 * never opens it), and the closed trigger never claims OFFLINE before this session's first live-status response. */
import { render } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { LiveScheduleDock } from "./LiveScheduleDock"
import * as useCurrentPageModule from "../../../app/navigation/useCurrentPage"
import * as useCreatorStatusesModule from "../hooks/useCreatorStatuses"

vi.mock("../../../app/navigation/useCurrentPage")
vi.mock("../hooks/useCreatorStatuses", async () => {
  const actual = await vi.importActual<typeof import("../hooks/useCreatorStatuses")>("../hooks/useCreatorStatuses")
  return { ...actual, useCreatorStatuses: vi.fn() }
})

vi.setConfig({ testTimeout: 20_000 })
const now = new Date("2026-09-10T12:00:00+09:00")

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(useCurrentPageModule.useCurrentPage).mockReturnValue(["home", vi.fn()])
})

const triggerText = () => document.querySelector(".live-status-trigger")?.textContent

describe("LiveScheduleDock before it is opened", () => {
  it("renders no creator rows and no creator URL while the drawer has never been opened", () => {
    vi.mocked(useCreatorStatusesModule.useCreatorStatuses).mockReturnValue({ statuses: {}, now, statusKnown: true })
    render(<LiveScheduleDock />)
    expect(document.querySelector(".live-status-dock")?.getAttribute("data-live-status-open")).toBe("false")
    expect(document.querySelectorAll(".live-status-member")).toHaveLength(0)
    expect(document.body.innerHTML).not.toContain("/creator")
  })

  it("the closed trigger shows a neutral dash, not OFFLINE, until live data exists", () => {
    vi.mocked(useCreatorStatusesModule.useCreatorStatuses).mockReturnValue({ statuses: {}, now, statusKnown: false })
    render(<LiveScheduleDock />)
    expect(triggerText()).toBe("—")
  })

  it("with live data the trigger summary is unchanged", () => {
    vi.mocked(useCreatorStatusesModule.useCreatorStatuses).mockReturnValue({ statuses: {}, now, statusKnown: true })
    render(<LiveScheduleDock />)
    expect(triggerText()).toBe("OFFLINE")
  })
})
