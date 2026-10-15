import { resolveCreatorKey } from "../../../entities/creator/data/creatorRegistry"
import type { OrganizationKey } from "../../../entities/creator/model/domain"
import type { ScheduledStream } from "./scheduledStream"

/** The Schedule page's creator filter: an EMPTY selection means "no filter" (every creator's streams are shown); a non-empty
 * selection shows exactly the streams of the selected creators -- no more, no fewer. Creators are the roster's legacy channel ids
 * (ScheduledStream.channelId), the same id space Favorites and the main Oshi use. */
export function filterStreamsByCreators(streams: readonly ScheduledStream[], selected: ReadonlySet<string>): ScheduledStream[] {
  return selected.size === 0 ? [...streams] : streams.filter((stream) => selected.has(stream.channelId))
}

/** The Schedule organization filter: "all" applies no organization restriction at all; otherwise only that organization's streams. */
export type ScheduleOrganizationFilter = "all" | OrganizationKey

/** Organization comes from the canonical creator registry (CanonicalCreator.organization, resolved from the stream's creator id) -- never
 * from a creator name or a hand-kept membership list. */
export function filterStreamsByOrganization(streams: readonly ScheduledStream[], organization: ScheduleOrganizationFilter): ScheduledStream[] {
  return organization === "all" ? [...streams] : streams.filter((stream) => resolveCreatorKey(stream.channelId)?.organization === organization)
}

export interface CreatorFilterOption {
  channelId: string
  name: string
  isFavorite: boolean
}

/** One option per creator that has a stream in `streams` -- the caller passes the streams actually on the displayed schedule (already scoped
 * to the organization), so a creator with no matching event is never offered. Neither the roster nor Favorites add choices; they only
 * decorate them (heart, favorites first). Each group alphabetical by name. */
export function buildCreatorFilterOptions(
  streams: readonly ScheduledStream[],
  favorites: ReadonlySet<string>,
  nameFor: (channelId: string) => string,
): CreatorFilterOption[] {
  const ids = new Set<string>(streams.map((stream) => stream.channelId))
  return [...ids]
    .map((channelId) => ({ channelId, name: nameFor(channelId), isFavorite: favorites.has(channelId) }))
    .sort((a, b) => Number(b.isFavorite) - Number(a.isFavorite) || a.name.localeCompare(b.name))
}
