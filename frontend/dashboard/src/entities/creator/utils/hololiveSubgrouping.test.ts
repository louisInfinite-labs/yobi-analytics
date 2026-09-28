import { describe, expect, it } from "vitest"
import { getCreators } from "../data/creatorRegistry"
import { groupHololiveJp, OTHER_GROUP_LABEL_KEY } from "./hololiveSubgrouping"

interface Fixture {
  creatorId: string
  groupKey: string[]
  channelType: "member" | "group" | "staff"
  displayOrder: number
}

function fixture(creatorId: string, groupKey: string[], displayOrder: number, channelType: Fixture["channelType"] = "member"): Fixture {
  return { creatorId, groupKey, channelType, displayOrder }
}

const ASOBIMAWARITAI_KEY = "アソビ★まわり隊！"

describe("groupHololiveJp: アソビ★まわり隊！ subgroup (bug fix)", () => {
  it("exposes アソビ★まわり隊！ as its own first-class subgroup, same as ReGLOSS/FLOW GLOW -- not folded into Other", () => {
    const creators = [
      fixture("member_a", [ASOBIMAWARITAI_KEY], 0),
      fixture("member_b", [ASOBIMAWARITAI_KEY], 1),
      fixture("group_channel", [ASOBIMAWARITAI_KEY], 2, "group"),
    ]

    const subgroups = groupHololiveJp(creators, (c) => c.creatorId)

    const asobiSubgroup = subgroups.find((sg) => sg.label === ASOBIMAWARITAI_KEY)
    expect(asobiSubgroup).toBeDefined()
    expect(asobiSubgroup!.creators.map((c) => c.creatorId).sort()).toEqual(["group_channel", "member_a", "member_b"].sort())

    const otherSubgroup = subgroups.find((sg) => sg.label === OTHER_GROUP_LABEL_KEY)
    expect(otherSubgroup).toBeUndefined()
  })

  it("group-channel-first convention: the アソビ★まわり隊！ channel record sorts before its members, same as ReGLOSS/FLOW GLOW's groupChannelFirst", () => {
    const creators = [
      fixture("member_a", [ASOBIMAWARITAI_KEY], 0),
      fixture("group_channel", [ASOBIMAWARITAI_KEY], 1, "group"),
      fixture("member_b", [ASOBIMAWARITAI_KEY], 2),
    ]

    const subgroups = groupHololiveJp(creators, (c) => c.creatorId)
    const asobiSubgroup = subgroups.find((sg) => sg.label === ASOBIMAWARITAI_KEY)!
    expect(asobiSubgroup.creators[0].creatorId).toBe("group_channel")
  })

  it("preserves the caller's own input order (e.g. sorted by canonical displayOrder) within the subgroup, aside from the group-channel-first pin", () => {
    const creators = [
      fixture("member_b", [ASOBIMAWARITAI_KEY], 1),
      fixture("member_a", [ASOBIMAWARITAI_KEY], 0),
      fixture("member_c", [ASOBIMAWARITAI_KEY], 2),
    ].sort((a, b) => a.displayOrder - b.displayOrder)

    const subgroups = groupHololiveJp(creators, (c) => c.creatorId)
    const asobiSubgroup = subgroups.find((sg) => sg.label === ASOBIMAWARITAI_KEY)!
    expect(asobiSubgroup.creators.map((c) => c.creatorId)).toEqual(["member_a", "member_b", "member_c"])
  })

  it("existing ReGLOSS/FLOW GLOW grouping is unchanged by this fix", () => {
    const creators = [
      fixture("regloss_channel", ["ReGLOSS"], 0, "group"),
      fixture("regloss_member", ["ReGLOSS"], 1),
      fixture("flowglow_channel", ["FLOWGLOW"], 2, "group"),
      fixture("flowglow_member", ["FLOWGLOW"], 3),
    ]

    const subgroups = groupHololiveJp(creators, (c) => c.creatorId)
    expect(subgroups.find((sg) => sg.label === "ReGLOSS")?.creators.map((c) => c.creatorId)).toEqual(["regloss_channel", "regloss_member"])
    expect(subgroups.find((sg) => sg.label === "FLOW GLOW")?.creators.map((c) => c.creatorId)).toEqual(["flowglow_channel", "flowglow_member"])
  })
})

describe("groupHololiveJp against the real canonical roster", () => {
  const holoJpCreators = [...getCreators()].filter((c) => c.branch === "holo_jp").sort((a, b) => a.displayOrder - b.displayOrder)
  const subgroups = groupHololiveJp(holoJpCreators, (c) => c.displayName)
  const asobiSubgroup = subgroups.find((sg) => sg.label === ASOBIMAWARITAI_KEY)
  const otherIds = subgroups.find((sg) => sg.label === OTHER_GROUP_LABEL_KEY)?.creators.map((c) => c.creatorId) ?? []

  it("Hololive JP exposes an アソビ★まわり隊！ subgroup", () => {
    expect(asobiSubgroup).toBeDefined()
  })

  it.each([
    ["hyakuto_kyoko", "百灯キョーコ"],
    ["achichi_mela", "熱千めら"],
    ["suzuna_tsuzuri", "鈴鳴つづり"],
    ["sorashina_sopia", "宙科そぴあ"],
  ])("%s (%s) belongs to the アソビ★まわり隊！ subgroup, not Other", (creatorId) => {
    expect(asobiSubgroup!.creators.some((c) => c.creatorId === creatorId)).toBe(true)
    expect(otherIds).not.toContain(creatorId)
  })

  it("orders the four members by canonical displayOrder (channel record first)", () => {
    const ids = asobiSubgroup!.creators.map((c) => c.creatorId)
    expect(ids).toEqual(["hololive_asobimawaritai", "hyakuto_kyoko", "achichi_mela", "suzuna_tsuzuri", "sorashina_sopia"])
  })
})
