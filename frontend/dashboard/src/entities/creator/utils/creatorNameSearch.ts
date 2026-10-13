/** The single creator-name search matcher shared by every screen: display-name substring OR canonical romanized form (no fuzzy matching). */
export interface NameSearchableCreator {
  creatorId: string
  displayName: string
  channelType: "member" | "group" | "staff"
}

/** Explicit alternate romanizations, keyed by creatorId. */
const EXPLICIT_ROMANIZED_ALIASES: Readonly<Record<string, readonly string[]>> = {
  laplus_darkness: ["Laplus Darknesss"],
  hyakuto_kyoko: ["Hyakutou Kyouko"],
}

const SEPARATORS = /[\s_-]+/

/** Lowercases and strips spaces, underscores and hyphens -- the only normalization applied. */
export function normalizeRomanizedSearchText(text: string): string {
  return text.toLowerCase().replace(/[\s_-]+/g, "")
}

/** Tokens as written, plus the reversed order only when there are exactly two. */
function formsForTokens(tokens: string[]): string[] {
  const joined = normalizeRomanizedSearchText(tokens.join(""))
  if (joined === "") return []
  return tokens.length === 2 ? [joined, normalizeRomanizedSearchText(`${tokens[1]}${tokens[0]}`)] : [joined]
}

const formsCache = new Map<string, readonly string[]>()

/** Normalized romanized forms for a member (none for group/staff channels), from creatorId plus explicit aliases. */
export function getRomanizedSearchForms(creator: Pick<NameSearchableCreator, "creatorId" | "channelType">): readonly string[] {
  if (creator.channelType !== "member") return []
  const cached = formsCache.get(creator.creatorId)
  if (cached) return cached

  const idTokens = creator.creatorId.split(SEPARATORS).filter(Boolean)
  const aliasTokenLists = (EXPLICIT_ROMANIZED_ALIASES[creator.creatorId] ?? []).map((alias) => alias.split(SEPARATORS).filter(Boolean))
  const forms = [...new Set([idTokens, ...aliasTokenLists].flatMap(formsForTokens))]
  formsCache.set(creator.creatorId, forms)
  return forms
}

/** Empty/whitespace query matches everyone. */
export function creatorMatchesNameQuery(creator: NameSearchableCreator, query: string): boolean {
  const trimmed = query.trim().toLowerCase()
  if (trimmed === "") return true
  if (creator.displayName.toLowerCase().includes(trimmed)) return true

  const normalizedQuery = normalizeRomanizedSearchText(trimmed)
  if (normalizedQuery === "") return false
  return getRomanizedSearchForms(creator).some((form) => form.includes(normalizedQuery))
}
