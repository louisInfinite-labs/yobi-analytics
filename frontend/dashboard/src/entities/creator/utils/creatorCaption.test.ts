import { describe, expect, it } from "vitest"
import { getCreators, getCreatorById } from "../data/creatorRegistry"
import { creatorCaption } from "./creatorCaption"

describe("creatorCaption", () => {
  it("shows a member's branch and generation/unit from the registry", () => {
    expect(creatorCaption(getCreatorById("kurumi_noa")!)).toBe("VSPO JP")
    expect(creatorCaption({ organization: "hololive", branch: "holo_jp", groupKey: ["2期生"], channelType: "member" })).toBe("Hololive JP · 2期生")
    expect(creatorCaption({ organization: "hololive", branch: "holo_en", groupKey: ["Advent", "FUWAMOCO"], channelType: "member" })).toBe("Hololive EN · Advent · FUWAMOCO")
  })

  it("never shows the registry's NO placeholder", () => {
    for (const creator of getCreators()) expect(creatorCaption(creator), creator.creatorId).not.toMatch(/(^|·\s)NO(\s·|$)/)
  })

  it("shows the organization for a group or staff channel", () => {
    expect(creatorCaption(getCreatorById("hololive_official")!)).toBe("Hololive")
    expect(creatorCaption(getCreatorById("vspo_official")!)).toBe("VSPO")
  })

  it("is non-empty for every registry creator", () => {
    for (const creator of getCreators()) expect(creatorCaption(creator).length, creator.creatorId).toBeGreaterThan(0)
  })
})
