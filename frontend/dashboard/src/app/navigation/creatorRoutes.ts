import { getCreatorById } from "../../entities/creator/data/creatorRegistry"
import type { CanonicalCreator } from "../../entities/creator/model/creatorMaster"
import { CREATOR_SLUG_PATTERN, creatorIdToSlug } from "./creatorSlugRule"

/** Home's creator URLs: /creator/:creatorSlug. The slug is the creator's canonical, backend-stable creatorId (the Creator Registry's
 * `creatorId`, e.g. "aizawa_ema") with "_" written as "-" ("aizawa-ema"). Canonical ids only use [a-z0-9_] and never "-", so the mapping is
 * exact and reversible, and it never touches the displayed name, array position or display order -- renaming a creator or reordering the
 * roster cannot change a URL. */
export const CREATOR_ROUTE_PREFIX = "/creator/"

export function creatorSlug(creator: Pick<CanonicalCreator, "creatorId">): string {
  return creatorIdToSlug(creator.creatorId)
}

export function creatorPath(creator: Pick<CanonicalCreator, "creatorId">): string {
  return `${CREATOR_ROUTE_PREFIX}${creatorSlug(creator)}`
}

/** The creator a slug names, or undefined (a malformed slug, a creator that is not in the registry, or one that is not active). Strict: only the
 * canonical spelling resolves, so there is exactly one URL per creator. */
export function creatorFromSlug(slug: string): CanonicalCreator | undefined {
  if (!CREATOR_SLUG_PATTERN.test(slug)) return undefined
  const creator = getCreatorById(slug.replace(/-/g, "_"))
  return creator?.active && creatorSlug(creator) === slug ? creator : undefined
}

export type CreatorRoute = { kind: "creator"; creator: CanonicalCreator } | { kind: "invalid" }

/** null when the path is not under /creator at all; otherwise the creator it names, or "invalid" (an unknown slug, a missing slug, extra segments). */
export function parseCreatorRoute(pathname: string): CreatorRoute | null {
  const trimmed = pathname.replace(/\/+$/, "")
  if (trimmed !== "/creator" && !trimmed.startsWith(CREATOR_ROUTE_PREFIX)) return null
  const rest = trimmed.slice(CREATOR_ROUTE_PREFIX.length)
  let slug = rest
  try {
    slug = decodeURIComponent(rest)
  } catch {
    return { kind: "invalid" }
  }
  const creator = rest && !slug.includes("/") ? creatorFromSlug(slug) : undefined
  return creator ? { kind: "creator", creator } : { kind: "invalid" }
}
