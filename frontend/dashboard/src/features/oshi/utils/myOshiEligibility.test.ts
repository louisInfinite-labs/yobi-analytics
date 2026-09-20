import { describe, expect, it } from "vitest"
import { mockCreators } from "../../../entities/creator/data/mockCreators"
import { isEligibleForMyOshi } from "./myOshiEligibility"

function creator(channelId: string) {
  const found = mockCreators.find((entry) => entry.channelId === channelId)
  if (!found) throw new Error(`fixture creator not found: ${channelId}`)
  return found
}

describe("isEligibleForMyOshi", () => {
  it("excludes VSPO's own official channel", () => {
    expect(isEligibleForMyOshi(creator("ch_vspo_group"))).toBe(false)
  })

  it("excludes hololive Production Staff (channelType staff)", () => {
    expect(isEligibleForMyOshi(creator("ch_hololive_staff"))).toBe(false)
  })

  it("excludes every other channelType-staff entry (e.g. holoAN room), not just hololive Production Staff by name", () => {
    expect(isEligibleForMyOshi(creator("ch_holoan_room"))).toBe(false)
  })

  it("keeps a plain individual member selectable", () => {
    expect(isEligibleForMyOshi(creator("ch_aizawa_ema"))).toBe(true)
  })

  it("keeps Hololive's own group-unit channels (e.g. ReGLOSS) selectable -- only VSPO's official channel and staff-type entries are excluded", () => {
    expect(isEligibleForMyOshi(creator("ch_hololive_dev_is_regloss"))).toBe(true)
  })
})
