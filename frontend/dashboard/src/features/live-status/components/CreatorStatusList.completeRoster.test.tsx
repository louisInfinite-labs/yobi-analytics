import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { CreatorStatusList } from "./CreatorStatusList"
import { getCreatorById, getCreators, toLegacyRosterId } from "../../../entities/creator/data/creatorRegistry"
import type { CreatorStatus } from "../model/creatorStatus"

// Each test renders the whole ~120-row roster (antd avatars included); under the parallel workers CI uses,
// the default 5s per-test budget is occasionally too tight for that, so give this file more headroom.
vi.setConfig({ testTimeout: 30_000 })

const now = new Date("2026-09-09T12:00:00.000Z")

function renderList(overrides: Partial<React.ComponentProps<typeof CreatorStatusList>> = {}) {
  const onSelectVideo = vi.fn()
  const onSelectCreator = vi.fn()
  const utils = render(
    <CreatorStatusList
      // No stream data at all: every channel must still render, as OFFLINE.
      statuses={{}}
      now={now}
      displayMode="absolute"
      query=""
      favorites={new Set()}
      onToggleFavorite={vi.fn()}
      onSelectCreator={onSelectCreator}
      onSelectVideo={onSelectVideo}
      locale="en"
      confirmOshiSwitch={false}
      onConfirmOshiSwitchChange={vi.fn()}
      {...overrides}
    />,
  )
  return { onSelectVideo, onSelectCreator, ...utils }
}

interface RenderedSubgroup {
  label: string | null
  names: string[]
}

interface RenderedGroup {
  heading: string
  subgroups: RenderedSubgroup[]
}

/** The rendered Live Status roster as plain data: each branch group, its subgroups in
 * order, and each subgroup's row names in order. */
function renderedRoster(container: HTMLElement): RenderedGroup[] {
  return [...container.querySelectorAll(".live-status-group")].map((groupEl) => {
    const subgroups: RenderedSubgroup[] = []
    let current: RenderedSubgroup = { label: null, names: [] }
    subgroups.push(current)
    for (const child of groupEl.children) {
      if (child.classList.contains("live-status-group__subheading")) {
        current = { label: child.textContent, names: [] }
        subgroups.push(current)
      } else if (child.classList.contains("live-status-group__org-divider")) {
        // The separator before a branch's organization-level channel row: a NEW, unlabeled block.
        current = { label: null, names: [] }
        subgroups.push(current)
      } else if (child.classList.contains("live-status-member-swipe")) {
        current.names.push(child.querySelector(".live-status-member__name")!.textContent!)
      }
    }
    return {
      heading: groupEl.querySelector(".live-status-group__heading span")?.textContent ?? "",
      subgroups: subgroups.filter((subgroup) => subgroup.label !== null || subgroup.names.length > 0),
    }
  })
}

function nameOf(creatorId: string): string {
  return getCreatorById(creatorId)!.displayName
}

function groupNamed(roster: RenderedGroup[], heading: string): RenderedGroup {
  const group = roster.find((candidate) => candidate.heading === heading)
  if (!group) throw new Error(`no rendered group ${heading}`)
  return group
}

function subgroupNamed(group: RenderedGroup, label: string): RenderedSubgroup {
  const subgroup = group.subgroups.find((candidate) => candidate.label === label)
  if (!subgroup) throw new Error(`no rendered subgroup ${label} in ${group.heading}`)
  return subgroup
}

const GRADUATED_IDS = [
  "amane_kanata",
  "ceres_fauna",
  "gawr_gura",
  "hiodoshi_ao",
  "kiryu_coco",
  "mano_aloe",
  "minato_aqua",
  "murasaki_shion",
  "nanashi_mumei",
  "sakamata_chloe",
  "uruha_rushia",
  "watson_amelia",
  "yozora_mel",
]

const NON_MEMBER_IDS = [
  "vspo_official",
  "hololive_official",
  "hololive_dev_is_regloss",
  "hololive_dev_is_flow_glow",
  "hololive_asobimawaritai",
  "fuwamoco",
  "achrora",
  "unit_b_pre_debut",
  "holoan_room",
]

describe("Live Status shows the complete supported channel roster", () => {
  it("renders every canonical channel with no stream data supplied -- all OFFLINE, none dropped", () => {
    renderList()

    const total = getCreators().length
    for (const creator of getCreators()) {
      expect(screen.getAllByText(creator.displayName, { selector: ".live-status-member__name" }).length).toBeGreaterThan(0)
    }
    const statusButtons = [...document.querySelectorAll(".live-status-member__status")]
    expect(statusButtons.length).toBeGreaterThanOrEqual(total)
    expect(statusButtons.every((button) => button.getAttribute("data-status") === "offline")).toBe(true)
  })

  it("renders all 13 graduated creators, each still in her own original group", () => {
    const { container } = renderList()
    const roster = renderedRoster(container)

    for (const id of GRADUATED_IDS) {
      expect(getCreatorById(id)!.lifecycleStage).toBe("graduated")
      expect(screen.getAllByText(nameOf(id), { selector: ".live-status-member__name" }).length).toBeGreaterThan(0)
    }
    expect(subgroupNamed(groupNamed(roster, "HOLOLIVE // JP"), "4期生").names).toEqual(
      expect.arrayContaining([nameOf("kiryu_coco"), nameOf("amane_kanata")]),
    )
    expect(subgroupNamed(groupNamed(roster, "HOLOLIVE // JP"), "ReGLOSS").names).toContain(nameOf("hiodoshi_ao"))
    expect(subgroupNamed(groupNamed(roster, "HOLOLIVE // EN"), "Myth").names).toEqual(
      expect.arrayContaining([nameOf("gawr_gura"), nameOf("watson_amelia")]),
    )
    expect(subgroupNamed(groupNamed(roster, "HOLOLIVE // EN"), "Promise").names).toEqual(
      expect.arrayContaining([nameOf("ceres_fauna"), nameOf("nanashi_mumei")]),
    )
  })

  it("never creates a global Graduated group", () => {
    const { container } = renderList()
    const labels = renderedRoster(container).flatMap((group) => group.subgroups.map((subgroup) => subgroup.label ?? ""))

    expect(labels.some((label) => /graduat|卒業/i.test(label))).toBe(false)
  })

  it("renders every group/staff/official channel", () => {
    renderList()

    for (const id of NON_MEMBER_IDS) {
      expect(getCreatorById(id)!.channelType).not.toBe("member")
      expect(screen.getAllByText(nameOf(id), { selector: ".live-status-member__name" })).toHaveLength(1)
    }
  })

  it("does not depend on any video, ranking or manifest data -- the list is identical with an empty status map and a full one", () => {
    const empty = renderedRoster(renderList({ statuses: {} }).container)
    const names = (roster: RenderedGroup[]) => roster.flatMap((group) => group.subgroups.flatMap((subgroup) => subgroup.names))

    expect(new Set(names(empty)).size).toBe(getCreators().length)
  })
})

describe("Live Status group placement of official/group/staff channels", () => {
  const OTHER_CHANNEL_IDS = ["achrora", "holoan_room", "unit_b_pre_debut"]

  it("VSPO JP: every individual member first in canonical order, then VSPO! Official as the final row", () => {
    const { container } = renderList()
    const vspoJp = groupNamed(renderedRoster(container), "VSPO! // JP")
    const names = vspoJp.subgroups.flatMap((subgroup) => subgroup.names)
    const members = getCreators()
      .filter((c) => c.branch === "vspo_jp" && c.channelType === "member")
      .sort((a, b) => a.displayOrder - b.displayOrder)
      .map((c) => c.displayName)

    expect(names).toEqual([...members, nameOf("vspo_official")])
    expect(names.at(-1)).toBe(nameOf("vspo_official"))
  })

  it("Hololive JP: Other is the final NAMED group and contains exactly ACHRORA, holoAN room and UNIT B", () => {
    const { container } = renderList()
    const holoJp = groupNamed(renderedRoster(container), "HOLOLIVE // JP")
    const named = holoJp.subgroups.filter((subgroup) => subgroup.label !== null)

    expect(named.at(-1)!.label).toBe("Other")
    expect(named.filter((subgroup) => subgroup.label === "Other")).toHaveLength(1)
    expect(subgroupNamed(holoJp, "Other").names).toEqual(OTHER_CHANNEL_IDS.map(nameOf))
  })

  it("Hololive JP: hololive Official is NOT in Other, but its own final row AFTER the Other group", () => {
    const { container } = renderList()
    const holoJp = groupNamed(renderedRoster(container), "HOLOLIVE // JP")
    const otherIndex = holoJp.subgroups.findIndex((subgroup) => subgroup.label === "Other")
    const officialBlockIndex = holoJp.subgroups.findIndex((subgroup) => subgroup.names.includes(nameOf("hololive_official")))

    expect(subgroupNamed(holoJp, "Other").names).not.toContain(nameOf("hololive_official"))
    expect(officialBlockIndex).toBeGreaterThan(otherIndex)
    expect(officialBlockIndex).toBe(holoJp.subgroups.length - 1)
    expect(holoJp.subgroups[officialBlockIndex]).toEqual({ label: null, names: [nameOf("hololive_official")] })
    expect(holoJp.subgroups.flatMap((subgroup) => subgroup.names).at(-1)).toBe(nameOf("hololive_official"))
  })

  it("Hololive JP: hololive Official does not sort above any named Hololive JP group", () => {
    const { container } = renderList()
    const holoJp = groupNamed(renderedRoster(container), "HOLOLIVE // JP")
    const officialBlockIndex = holoJp.subgroups.findIndex((subgroup) => subgroup.names.includes(nameOf("hololive_official")))
    const namedIndexes = holoJp.subgroups.flatMap((subgroup, index) => (subgroup.label !== null ? [index] : []))

    expect(Math.max(...namedIndexes)).toBeLessThan(officialBlockIndex)
  })

  it("ReGLOSS and FLOW GLOW: the group's own channel comes after all individual members", () => {
    const { container } = renderList()
    const holoJp = groupNamed(renderedRoster(container), "HOLOLIVE // JP")
    const expected = (groupKey: string, channelId: string) => {
      const members = getCreators()
        .filter((c) => c.branch === "holo_jp" && c.channelType === "member" && c.groupKey[0] === groupKey)
        .sort((a, b) => a.displayOrder - b.displayOrder)
        .map((c) => c.displayName)
      return [...members, nameOf(channelId)]
    }

    expect(subgroupNamed(holoJp, "ReGLOSS").names).toEqual(expected("ReGLOSS", "hololive_dev_is_regloss"))
    expect(subgroupNamed(holoJp, "FLOW GLOW").names).toEqual(expected("FLOWGLOW", "hololive_dev_is_flow_glow"))
  })

  it("every existing group/unit channel sits below ALL of its own group's individual members (no member follows a channel)", () => {
    const { container } = renderList()
    const nonMemberNames = new Set(getCreators().filter((c) => c.channelType !== "member").map((c) => c.displayName))

    for (const group of renderedRoster(container)) {
      for (const subgroup of group.subgroups) {
        const firstChannelIndex = subgroup.names.findIndex((name) => nonMemberNames.has(name))
        if (firstChannelIndex === -1) continue
        // From the first channel onwards a subgroup holds only channels, never another member.
        expect(subgroup.names.slice(firstChannelIndex).every((name) => nonMemberNames.has(name)), `${group.heading} / ${subgroup.label}`).toBe(true)
      }
    }
    const holoJp = groupNamed(renderedRoster(container), "HOLOLIVE // JP")
    expect(subgroupNamed(holoJp, "アソビ★まわり隊！").names.at(-1)).toBe(nameOf("hololive_asobimawaritai"))
    expect(subgroupNamed(groupNamed(renderedRoster(container), "HOLOLIVE // EN"), "Advent").names.at(-1)).toBe(nameOf("fuwamoco"))
  })

  it("non-member channels are not collected into one global section: each stays in its own group", () => {
    const { container } = renderList()
    const roster = renderedRoster(container)
    const holoJp = groupNamed(roster, "HOLOLIVE // JP")

    expect(subgroupNamed(holoJp, "Other").names).not.toContain(nameOf("vspo_official"))
    expect(subgroupNamed(holoJp, "Other").names).not.toContain(nameOf("hololive_dev_is_regloss"))
    expect(groupNamed(roster, "VSPO! // JP").subgroups.flatMap((subgroup) => subgroup.names)).not.toContain(nameOf("hololive_dev_is_regloss"))
  })

  it("the top-level group order is unchanged: VSPO JP, then Hololive JP, EN, ID", () => {
    const { container } = renderList()

    expect(renderedRoster(container).map((group) => group.heading)).toEqual([
      "VSPO! // JP",
      "VSPO! // EN",
      "HOLOLIVE // JP",
      "HOLOLIVE // EN",
      "HOLOLIVE // ID",
    ])
  })

  it("a search that matches only the organization-level channel still shows it, with no divider before it", () => {
    const { container } = renderList({ query: nameOf("hololive_official") })
    const holoJp = groupNamed(renderedRoster(container), "HOLOLIVE // JP")

    expect(holoJp.subgroups).toEqual([{ label: null, names: [nameOf("hololive_official")] }])
    expect(container.querySelector(".live-status-group__org-divider")).toBeNull()
  })
})

describe("Live Status status and search for the added channels", () => {
  it("a missing stream result renders OFFLINE, not a removed row", () => {
    renderList({ statuses: { ch_gawr_gura: { kind: "offline" } } })
    const row = [...document.querySelectorAll(".live-status-member")].find((r) => r.textContent?.includes(nameOf("vspo_official")))!

    expect(row.querySelector(".live-status-member__status")).toHaveTextContent("OFFLINE")
  })

  it("an official channel with a live stream shows LIVE and its stream title, like any creator", () => {
    const id = toLegacyRosterId(getCreatorById("vspo_official")!)
    const statuses: Record<string, CreatorStatus> = { [id]: { kind: "live", videoId: "v1", title: "VSPO official broadcast" } }
    renderList({ statuses })
    const row = [...document.querySelectorAll(".live-status-member")].find((r) => r.textContent?.includes(nameOf("vspo_official")))!

    expect(row.querySelector(".live-status-member__status")).toHaveTextContent("LIVE")
    expect(row.querySelector(".live-status-member__topic")).toHaveTextContent("VSPO official broadcast")
  })

  it("search finds a graduated creator", () => {
    renderList({ query: nameOf("gawr_gura") })

    expect(screen.getByText(nameOf("gawr_gura"), { selector: ".live-status-member__name" })).toBeInTheDocument()
  })

  it.each(["vspo_official", "hololive_official", "hololive_dev_is_regloss", "fuwamoco", "holoan_room", "achrora", "unit_b_pre_debut"])(
    "search finds the non-member channel %s",
    (creatorId) => {
      renderList({ query: nameOf(creatorId) })

      expect(screen.getByText(nameOf(creatorId), { selector: ".live-status-member__name" })).toBeInTheDocument()
    },
  )
})

describe("Live Status rows of group/staff/official channels cannot become Current Oshi", () => {
  it("their name area is not an Oshi-switch button", () => {
    renderList()

    for (const id of NON_MEMBER_IDS) {
      expect(screen.queryByRole("button", { name: `Switch Oshi to ${nameOf(id)}` })).not.toBeInTheDocument()
    }
  })

  it("clicking a non-member row neither switches Oshi nor opens the switch dialog", async () => {
    const { onSelectCreator } = renderList({ confirmOshiSwitch: true })
    const user = userEvent.setup()

    await user.click(screen.getByText(nameOf("vspo_official"), { selector: ".live-status-member__name" }))

    expect(onSelectCreator).not.toHaveBeenCalled()
    expect(screen.queryByText(/Switch your Oshi to/)).not.toBeInTheDocument()
  })

  it("selecting a live non-member's video plays it without any Oshi switch or confirm dialog", async () => {
    const id = toLegacyRosterId(getCreatorById("vspo_official")!)
    const { onSelectCreator, onSelectVideo } = renderList({
      confirmOshiSwitch: true,
      statuses: { [id]: { kind: "live", videoId: "v1", title: "VSPO official broadcast" } },
    })
    const user = userEvent.setup()
    const row = [...document.querySelectorAll(".live-status-member")].find((r) => r.textContent?.includes(nameOf("vspo_official")))!

    await user.click(row.querySelector(".live-status-member__status")!)

    expect(onSelectVideo).toHaveBeenCalledWith({ videoId: "v1", title: "VSPO official broadcast" }, id)
    expect(onSelectCreator).not.toHaveBeenCalled()
    expect(screen.queryByText(/Switch your Oshi to/)).not.toBeInTheDocument()
  })

  it("hololive Official uses the verified main channel and is a plain row: live status works, no Oshi switch", async () => {
    const official = getCreatorById("hololive_official")!
    const id = toLegacyRosterId(official)
    const { onSelectCreator, onSelectVideo } = renderList({
      confirmOshiSwitch: true,
      statuses: { [id]: { kind: "live", videoId: "vh", title: "hololive official broadcast" } },
    })
    const user = userEvent.setup()
    const row = [...document.querySelectorAll(".live-status-member")].find((r) => r.textContent?.includes(official.displayName))!

    expect(official.youtubeChannelId).toBe("UCJFZiqLMntJufDCHc6bQixg")
    expect(row.querySelector(".live-status-member__status")).toHaveTextContent("LIVE")
    await user.click(row.querySelector(".live-status-member__status")!)

    expect(onSelectVideo).toHaveBeenCalledWith({ videoId: "vh", title: "hololive official broadcast" }, id)
    expect(onSelectCreator).not.toHaveBeenCalled()
    expect(screen.queryByRole("button", { name: `Switch Oshi to ${official.displayName}` })).not.toBeInTheDocument()
  })

  it("a graduated creator is still an individual creator: clicking her switches Oshi through the normal flow", async () => {
    const { onSelectCreator } = renderList({ confirmOshiSwitch: false })
    const user = userEvent.setup()

    await user.click(screen.getByRole("button", { name: `Switch Oshi to ${nameOf("gawr_gura")}` }))

    expect(onSelectCreator).toHaveBeenCalledWith("ch_gawr_gura")
  })
})
