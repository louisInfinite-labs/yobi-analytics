import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { CreatorStatusList } from "./CreatorStatusList"
import {
  getCreators,
  isLiveStatusDisplayEligible,
  isMyOshiEligible,
  toLegacyRosterId,
} from "../../../entities/creator/data/creatorRegistry"
import { groupSelectableCreatorsForMyOshi } from "../../oshi/utils/myOshiCanonicalRoster"
import { resetAllSharedStateForTests } from "../../../shared/state/sharedState"
import type { CreatorStatus } from "../model/creatorStatus"

/** Live Status shows every displayable channel and every one of them keeps the normal Live Status click actions;
 * My Oshi eligibility (individual creators only) decides who can become a saved Oshi, never who is clickable here.
 * The affected channels are derived from the registry (displayable but not My-Oshi-eligible: group and staff
 * channels such as hololive_official, vspo_official, unit channels, holoan_room) -- nothing is hard-coded per agency. */
const now = new Date("2026-09-09T12:00:00.000Z")
const displayed = getCreators().filter(isLiveStatusDisplayEligible)
const nonIndividual = displayed.filter((creator) => !isMyOshiEligible(creator))
const individual = displayed.find((creator) => isMyOshiEligible(creator))!

function renderList(overrides: Partial<React.ComponentProps<typeof CreatorStatusList>> = {}) {
  const onSelectVideo = vi.fn()
  const onSelectCreator = vi.fn()
  const utils = render(
    <CreatorStatusList
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

function rowButton(displayName: string) {
  return screen.getByRole("button", { name: `Switch Oshi to ${displayName}` })
}

beforeEach(() => {
  resetAllSharedStateForTests()
})

describe("Live Status rows for non-individual channels", () => {
  it("covers the group and staff channel types the registry actually displays", () => {
    expect(nonIndividual.length).toBeGreaterThan(0)
    expect(new Set(nonIndividual.map((creator) => creator.channelType))).toEqual(new Set(["group", "staff"]))
    for (const id of ["hololive_official", "vspo_official", "holoan_room", "unit_b_pre_debut", "achrora"]) {
      expect(nonIndividual.map((creator) => creator.creatorId), id).toContain(id)
    }
  })

  it("an individual creator row stays clickable and behaves as before", async () => {
    const { onSelectCreator, onSelectVideo } = renderList()
    const user = userEvent.setup()

    await user.click(rowButton(individual.displayName))

    expect(onSelectCreator).toHaveBeenCalledWith(toLegacyRosterId(individual))
    expect(onSelectVideo).not.toHaveBeenCalled()
  })

  it.each(nonIndividual.map((creator) => [creator.creatorId, creator] as const))(
    "%s renders as an enabled button and its click performs the normal current-channel selection",
    async (_id, creator) => {
      const { onSelectCreator, onSelectVideo } = renderList()
      const user = userEvent.setup()
      const button = rowButton(creator.displayName)

      expect(button).toBeEnabled() // myOshiEligible=false must not disable Live Status interaction
      await user.click(button)

      expect(onSelectCreator).toHaveBeenCalledTimes(1)
      expect(onSelectCreator).toHaveBeenCalledWith(toLegacyRosterId(creator))
      expect(onSelectVideo).not.toHaveBeenCalled()
    },
  )

  it.each(nonIndividual.map((creator) => [creator.creatorId, creator] as const))(
    "%s is keyboard accessible: it takes focus and Enter / Space select it",
    async (_id, creator) => {
      const { onSelectCreator } = renderList()
      const user = userEvent.setup()
      const button = rowButton(creator.displayName)

      button.focus()
      expect(button).toHaveFocus()
      await user.keyboard("{Enter}")
      await user.keyboard(" ")

      expect(onSelectCreator).toHaveBeenCalledTimes(2)
      expect(onSelectCreator).toHaveBeenCalledWith(toLegacyRosterId(creator))
    },
  )

  it("follows the same Oshi-switch confirmation preference as an individual row, instead of doing nothing", async () => {
    const official = nonIndividual.find((creator) => creator.creatorId === "hololive_official")!
    const { onSelectCreator } = renderList({ confirmOshiSwitch: true })
    const user = userEvent.setup()

    await user.click(rowButton(official.displayName))

    expect(onSelectCreator).not.toHaveBeenCalled()
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /^Switch$/ }))
    expect(onSelectCreator).toHaveBeenCalledWith(toLegacyRosterId(official))
  })

  it.each(nonIndividual.map((creator) => [creator.creatorId, creator] as const))(
    "%s: a live status click makes it the current channel and then selects its video, like an individual row",
    async (_id, creator) => {
      const legacyId = toLegacyRosterId(creator)
      const statuses: Record<string, CreatorStatus> = { [legacyId]: { kind: "live", videoId: "vid1", title: "On air" } }
      const { onSelectCreator, onSelectVideo } = renderList({ statuses })
      const user = userEvent.setup()

      await user.click(screen.getByRole("button", { name: /LIVE/ }))

      expect(onSelectCreator).toHaveBeenCalledWith(legacyId)
      expect(onSelectVideo).toHaveBeenCalledWith({ videoId: "vid1", title: "On air" }, legacyId)
    },
  )
})

describe("My Oshi Settings is unchanged", () => {
  it("still offers none of the non-individual channels Live Status now lets you click", () => {
    const offered = new Set(
      groupSelectableCreatorsForMyOshi("").flatMap((agency) =>
        agency.regions.flatMap((region) => region.subgroups.flatMap((subgroup) => subgroup.creators.map((creator) => creator.creatorId))),
      ),
    )

    for (const creator of nonIndividual) expect(offered.has(creator.creatorId), creator.creatorId).toBe(false)
    expect(nonIndividual.every((creator) => !isMyOshiEligible(creator))).toBe(true)
  })
})
