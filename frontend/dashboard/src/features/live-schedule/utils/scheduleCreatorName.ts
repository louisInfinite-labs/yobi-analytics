import { resolveCreatorKey } from "../../../entities/creator/data/creatorRegistry"
import { mockCreators } from "../../../entities/creator/data/mockCreators"

const mockNameByChannelId = new Map(mockCreators.map((creator) => [creator.channelId, creator.channelName]))

/** The name every Schedule surface shows for a stream's creator, given its legacy roster id ("ch_" + creatorId). The roster's own name comes
 * first (unchanged from before this helper); a creator it does not list -- e.g. the Hololive official channel -- resolves through the Creator
 * Registry, whose displayName is the canonical user-facing name (including the registry layer's own display overrides), so the raw id
 * ("ch_hololive_official") is never shown. The raw id is only the last resort for an id neither source knows. */
export function getScheduleCreatorName(channelId: string): string {
  return mockNameByChannelId.get(channelId) ?? resolveCreatorKey(channelId)?.displayName ?? channelId
}
