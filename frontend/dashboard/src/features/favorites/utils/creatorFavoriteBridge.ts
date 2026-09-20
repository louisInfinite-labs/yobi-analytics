import { mockCreators, type MockCreator } from "../../../entities/creator/data/mockCreators"

/** Bridges Notification Settings' own creatorId space (data/creators.json,
 * the real Creator Master roster) to mockCreators' channelId space (the
 * small, hand-curated roster, e.g. "ch_aizawa_ema", that both Favorites
 * (useFavoriteCreators) and Live Status's own ordering (lib/
 * dockCreatorOrder.ts) are keyed on) -- creators.json carries neither a
 * `channelId` nor a `kana` reading field of its own. Comparing both files
 * directly (there is no documented mapping in either): 110 of
 * creators.json's 112 creatorIds equal a mockCreators channelId with its
 * "ch_" prefix stripped; the 2 that don't (watson_amelia,
 * airani_iofifteen) have no mockCreators counterpart at all -- they
 * already cannot be favorited anywhere in the app today (OshiSettings' own
 * favorite-management grid reads this same mockCreators roster and has no
 * tile for them either), and have no Live Status ordering to borrow
 * either, so both isFavoriteCreatorId and findMockCreatorForCreatorId
 * below return their own "nothing to bridge" result for them rather than
 * guessing. This file is the one place the "ch_" + creatorId convention is
 * applied, so a future rename only needs updating here. */
const MOCK_CREATOR_BY_CREATOR_ID = new Map<string, MockCreator>(mockCreators.map((creator) => [creator.channelId.replace(/^ch_/, ""), creator]))

export function isFavoriteCreatorId(creatorId: string, favoriteChannelIds: ReadonlySet<string>): boolean {
  return favoriteChannelIds.has(`ch_${creatorId}`)
}

/** The mockCreators record for a given creators.json creatorId, if the "ch_"
 * bridge above resolves to one -- used only to borrow Live Status's own
 * ordering data (kana reading, declared roster position; see
 * notificationCreatorOrder.ts), never to read anything display-related
 * (creators.json's own displayName, with its own override corrections, is
 * always what actually renders). */
export function findMockCreatorForCreatorId(creatorId: string): MockCreator | undefined {
  return MOCK_CREATOR_BY_CREATOR_ID.get(creatorId)
}
