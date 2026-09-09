import { describe, expect, it } from "vitest"
import { creatorMatchesSearch, groupCreatorsForDock, DOCK_BRANCH_ORDER } from "./dockCreatorOrder"
import { mockCreators } from "../data/mockCreators"

describe("groupCreatorsForDock", () => {
  it("orders groups as VSPO JP, VSPO EN, hololive JP, EN, ID", () => {
    const groups = groupCreatorsForDock(mockCreators)
    const order = groups.map((g) => g.branch)
    // Only asserts relative order among branches actually present — some
    // (e.g. holo_id has just one mock creator) aren't guaranteed non-empty
    // for every fixture, but whichever are present must appear in this order.
    const presentInOrder = DOCK_BRANCH_ORDER.filter((branch) => order.includes(branch))
    expect(order).toEqual(presentInOrder)
  })

  it("preserves each branch's own array order within mockCreators, not alphabetical", () => {
    const groups = groupCreatorsForDock(mockCreators)
    const holoJp = groups.find((g) => g.branch === "holo_jp")!
    const expectedIds = mockCreators.filter((c) => c.branch === "holo_jp").map((c) => c.channelId)
    expect(holoJp.creators.map((c) => c.channelId)).toEqual(expectedIds)
  })

  it("omits a branch entirely when the filtered creator list has none", () => {
    const onlyOneCreator = mockCreators.filter((c) => c.branch === "vspo_jp")
    const groups = groupCreatorsForDock(onlyOneCreator)
    expect(groups.map((g) => g.branch)).toEqual(["vspo_jp"])
  })
})

describe("creatorMatchesSearch", () => {
  const creator = mockCreators.find((c) => c.channelName === "白上フブキ")!

  it("matches the Japanese name case-insensitively", () => {
    expect(creatorMatchesSearch(creator, "フブキ")).toBe(true)
  })

  it("does not match an unrelated query", () => {
    expect(creatorMatchesSearch(creator, "ぺこら")).toBe(false)
  })

  it("treats an empty/whitespace query as matching everything", () => {
    expect(creatorMatchesSearch(creator, "")).toBe(true)
    expect(creatorMatchesSearch(creator, "   ")).toBe(true)
  })

  it("matches an English channel name case-insensitively", () => {
    const gura = mockCreators.find((c) => c.channelName === "Gawr Gura")!
    expect(creatorMatchesSearch(gura, "gura")).toBe(true)
  })
})
