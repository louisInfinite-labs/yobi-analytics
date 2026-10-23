import { BRANCH_LABELS, ORGANIZATION_LABELS } from "../model/domain"
import type { CanonicalCreator } from "../model/creatorMaster"

/** The placeholder groupKey the registry uses for "no generation/unit"; it is data, not a name to show. */
const NO_GROUP = "NO"

/** A creator's stable one-line identity from the Creator Registry alone ("Hololive JP · 2期生", "VSPO JP", "Hololive"): proper nouns only, so it needs no
 * translation, and it needs no API data, so Home can show it from the very first render. A member shows their branch and generation/unit; a group or
 * staff channel shows its organization. */
export function creatorCaption(creator: Pick<CanonicalCreator, "organization" | "branch" | "groupKey" | "channelType">): string {
  if (creator.channelType !== "member") return ORGANIZATION_LABELS[creator.organization]
  const groups = creator.groupKey.filter((group) => group !== NO_GROUP)
  return [BRANCH_LABELS[creator.branch], ...groups].join(" · ")
}
