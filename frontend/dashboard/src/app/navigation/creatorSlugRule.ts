/** The creator URL slug rule, kept free of imports so both the router (creatorRoutes.ts) and the build-time sitemap (app/seo/sitemap.ts, loaded by
 * the Vite config in a Node context) share exactly one definition. */

/** A canonical creatorId: lowercase [a-z0-9] words joined by single "_" -- never "-", so the id <-> slug mapping is exact and reversible. */
const CANONICAL_CREATOR_ID_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/

/** A creator slug as the router accepts it: lowercase [a-z0-9] words joined by single "-". */
export const CREATOR_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function isCanonicalCreatorId(creatorId: string): boolean {
  return CANONICAL_CREATOR_ID_PATTERN.test(creatorId)
}

/** The slug of a creatorId: "_" written as "-" ("aizawa_ema" -> "aizawa-ema"). */
export function creatorIdToSlug(creatorId: string): string {
  return creatorId.replace(/_/g, "-")
}
