import type { ScheduledStream } from "./scheduledStream"

/** The Schedule page's creator filter: an EMPTY selection means "no filter" (every creator's streams are shown); a non-empty
 * selection shows exactly the streams of the selected creators -- no more, no fewer. Creators are the roster's legacy channel ids
 * (ScheduledStream.channelId), the same id space Favorites and the main Oshi use. */
export function filterStreamsByCreators(streams: readonly ScheduledStream[], selected: ReadonlySet<string>): ScheduledStream[] {
  return selected.size === 0 ? [...streams] : streams.filter((stream) => selected.has(stream.channelId))
}

export interface CreatorFilterOption {
  channelId: string
  name: string
  isFavorite: boolean
}

/** One option per creator that has a stream in the schedule (plus any currently selected creator, so a selection never shows a raw id),
 * favorites first, each group alphabetical by name. */
export function buildCreatorFilterOptions(
  streams: readonly ScheduledStream[],
  selected: ReadonlySet<string>,
  favorites: ReadonlySet<string>,
  nameFor: (channelId: string) => string,
): CreatorFilterOption[] {
  const ids = new Set<string>([...streams.map((stream) => stream.channelId), ...selected])
  return [...ids]
    .map((channelId) => ({ channelId, name: nameFor(channelId), isFavorite: favorites.has(channelId) }))
    .sort((a, b) => Number(b.isFavorite) - Number(a.isFavorite) || a.name.localeCompare(b.name))
}
