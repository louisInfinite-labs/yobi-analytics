import { describe, expect, it } from "vitest"
import { filterStreamsByOrganization } from "./scheduleCreatorFilter"
import type { ScheduledStream } from "./scheduledStream"

function stream(channelId: string, title = "stream"): ScheduledStream {
  return { id: `${channelId}-${title}`, channelId, videoId: channelId, title, description: "", status: "upcoming", scheduledStartMs: 0, topics: [] }
}

const vspoJp = stream("ch_aizawa_ema")
const vspoEn = stream("ch_jira_jisaki")
const holoJp = stream("ch_usada_pekora")
const holoEn = stream("ch_gawr_gura")
const holoId = stream("ch_iofi")
const all = [vspoJp, vspoEn, holoJp, holoEn, holoId]

describe("filterStreamsByOrganization (canonical registry organization)", () => {
  it("'all' applies no restriction and keeps every stream in order", () => {
    expect(filterStreamsByOrganization(all, "all")).toEqual(all)
    expect(filterStreamsByOrganization([], "all")).toEqual([])
  })

  it("'vspo' keeps VSPO JP and EN streams only", () => {
    expect(filterStreamsByOrganization(all, "vspo")).toEqual([vspoJp, vspoEn])
  })

  it("'hololive' keeps every Hololive branch (JP, EN and ID) -- the canonical organization, not a branch subset", () => {
    expect(filterStreamsByOrganization(all, "hololive")).toEqual([holoJp, holoEn, holoId])
  })

  it("resolves legacy ids (ch_iofi -> airani_iofifteen) and organization-level channels through the registry", () => {
    expect(filterStreamsByOrganization([stream("ch_iofi")], "hololive")).toHaveLength(1)
    expect(filterStreamsByOrganization([stream("ch_vspo_group")], "vspo")).toHaveLength(1)
    expect(filterStreamsByOrganization([stream("ch_vspo_group")], "hololive")).toHaveLength(0)
  })

  it("never classifies from the title or any name text", () => {
    const misleading = [stream("ch_usada_pekora", "VSPO special"), stream("ch_aizawa_ema", "hololive special")]
    expect(filterStreamsByOrganization(misleading, "vspo").map((s) => s.channelId)).toEqual(["ch_aizawa_ema"])
    expect(filterStreamsByOrganization(misleading, "hololive").map((s) => s.channelId)).toEqual(["ch_usada_pekora"])
  })

  it("does not mutate its input, and returns a new array even for 'all'", () => {
    const input = [...all]
    expect(filterStreamsByOrganization(input, "all")).not.toBe(input)
    filterStreamsByOrganization(input, "vspo")
    expect(input).toEqual(all)
  })
})
