import { describe, expect, it } from "vitest"
import { getCreatorById, getCreators } from "../data/creatorRegistry"
import { creatorMatchesNameQuery, getRomanizedSearchForms, normalizeRomanizedSearchText } from "./creatorNameSearch"

function creator(creatorId: string) {
  const found = getCreatorById(creatorId)
  if (!found) throw new Error(`Test setup: ${creatorId} is not in the creator registry`)
  return found
}

function matchingIds(query: string): string[] {
  return getCreators()
    .filter((c) => creatorMatchesNameQuery(c, query))
    .map((c) => c.creatorId)
}

describe("normalizeRomanizedSearchText", () => {
  it("lowercases and removes spaces, underscores and hyphens -- nothing else", () => {
    for (const text of ["Aizawa Ema", "aizawa_ema", "AIZAWA-EMA", "aizawaema", "  Aizawa _ - Ema "]) {
      expect(normalizeRomanizedSearchText(text)).toBe("aizawaema")
    }
    expect(normalizeRomanizedSearchText("aizamaema")).toBe("aizamaema")
  })
})

describe("creatorMatchesNameQuery: two-token canonical names (藍沢エマ / aizawa_ema)", () => {
  const aizawa = creator("aizawa_ema")

  it.each(["aizawaema", "AizawaEma", "EMA AIZaWa", "ema aizawa", "aizawa_ema", "ema-aizawa", "Aizawa Ema", "  aizawa-ema  "])(
    "matches %j (surname+given or given+surname, any case, any separator)",
    (query) => {
      expect(creatorMatchesNameQuery(aizawa, query)).toBe(true)
    },
  )

  it.each(["aizamaema", "aizazwaema", "aizawaemma", "aizawa ema x", "aizawa enma"])(
    "does not match the typo %j (no fuzzy / edit-distance matching)",
    (query) => {
      expect(creatorMatchesNameQuery(aizawa, query)).toBe(false)
    },
  )

  it("still matches by its Japanese display name, unchanged", () => {
    expect(creatorMatchesNameQuery(aizawa, "エマ")).toBe(true)
    expect(creatorMatchesNameQuery(aizawa, "藍沢")).toBe(true)
  })

  it("an empty or whitespace query matches everyone", () => {
    expect(creatorMatchesNameQuery(aizawa, "")).toBe(true)
    expect(creatorMatchesNameQuery(aizawa, "   ")).toBe(true)
  })

  it("a query of only separators does not match everyone", () => {
    expect(creatorMatchesNameQuery(aizawa, "-")).toBe(false)
    expect(creatorMatchesNameQuery(aizawa, " _ - ")).toBe(false)
  })

  it("finds exactly that one creator across the whole roster, in both orders, and nobody for a typo", () => {
    expect(matchingIds("aizawaema")).toEqual(["aizawa_ema"])
    expect(matchingIds("ema aizawa")).toEqual(["aizawa_ema"])
    expect(matchingIds("aizamaema")).toEqual([])
    expect(matchingIds("aizazwaema")).toEqual([])
  })
})

describe("creatorMatchesNameQuery: one-word canonical names", () => {
  it.each(["irys", "azki", "robocosan"])("%s matches its one canonical form, case-insensitively", (creatorId) => {
    const c = creator(creatorId)
    expect(getRomanizedSearchForms(c)).toEqual([creatorId])
    expect(creatorMatchesNameQuery(c, creatorId)).toBe(true)
    expect(creatorMatchesNameQuery(c, creatorId.toUpperCase())).toBe(true)
  })

  it("does not match a one-letter-off typo of a one-word name", () => {
    expect(creatorMatchesNameQuery(creator("irys"), "irysy")).toBe(false)
    expect(creatorMatchesNameQuery(creator("azki"), "azuki")).toBe(false)
    expect(creatorMatchesNameQuery(creator("robocosan"), "robokosan")).toBe(false)
  })
})

describe("creatorMatchesNameQuery: the three-part canonical name (elizabeth_rose_bloodflame)", () => {
  const elizabeth = creator("elizabeth_rose_bloodflame")

  it("matches its canonical order with any separators and case", () => {
    for (const query of ["elizabethrosebloodflame", "Elizabeth Rose Bloodflame", "elizabeth_rose_bloodflame", "ELIZABETH-ROSE-BLOODFLAME"]) {
      expect(creatorMatchesNameQuery(elizabeth, query)).toBe(true)
    }
  })

  it("does not invent other token orders", () => {
    expect(getRomanizedSearchForms(elizabeth)).toEqual(["elizabethrosebloodflame"])
    for (const query of ["bloodflame elizabeth rose", "rose elizabeth bloodflame", "bloodflamerose elizabeth", "bloodflame rose elizabeth"]) {
      expect(creatorMatchesNameQuery(elizabeth, query)).toBe(false)
    }
  })
})

describe("creatorMatchesNameQuery: explicit aliases", () => {
  it("laplus_darkness: canonical name and the alias 'Laplus Darknesss' both match, in both orders", () => {
    const laplus = creator("laplus_darkness")
    for (const query of ["laplus darkness", "darkness laplus", "Laplus Darknesss", "darknesss laplus", "laplus_darknesss", "laplus-darknesss"]) {
      expect(creatorMatchesNameQuery(laplus, query)).toBe(true)
    }
    expect(creatorMatchesNameQuery(laplus, "laplus darknessss")).toBe(false)
  })

  it("hyakuto_kyoko: canonical name and the alias 'Hyakutou Kyouko' both match, in both orders", () => {
    const hyakuto = creator("hyakuto_kyoko")
    for (const query of ["hyakuto kyoko", "kyoko hyakuto", "Hyakutou Kyouko", "kyouko hyakutou", "hyakutou_kyouko", "kyouko-hyakutou"]) {
      expect(creatorMatchesNameQuery(hyakuto, query)).toBe(true)
    }
    expect(creatorMatchesNameQuery(hyakuto, "hyakutou kyoko")).toBe(false)
  })

  it("an alias belongs only to its own creator", () => {
    expect(matchingIds("Laplus Darknesss")).toEqual(["laplus_darkness"])
    expect(matchingIds("Hyakutou Kyouko")).toEqual(["hyakuto_kyoko"])
  })
})

describe("creatorMatchesNameQuery: only members are romanized-searchable", () => {
  it("a group or staff channel is found by its display name only", () => {
    const nonMembers = getCreators().filter((c) => c.channelType !== "member")
    expect(nonMembers.length).toBeGreaterThan(0)
    for (const c of nonMembers) {
      expect(getRomanizedSearchForms(c)).toEqual([])
      expect(creatorMatchesNameQuery(c, c.displayName)).toBe(true)
    }
    // A non-member's id is never searchable: only its display name is. These spellings are not substrings of any display name,
    // so they could only match through a leaked romanized id form.
    expect(matchingIds("vspo_official")).not.toContain("vspo_official")
    expect(matchingIds("holoanroom")).not.toContain("holoan_room")
    expect(matchingIds("hololive-official")).not.toContain("hololive_official")
  })
})

describe("the canonical member roster's romanized shape", () => {
  const members = getCreators().filter((c) => c.channelType === "member")
  const tokenCount = (id: string) => id.split("_").length

  it("has 110 members: 106 two-token, 3 one-word and 1 three-part", () => {
    expect(members).toHaveLength(110)
    expect(members.filter((c) => tokenCount(c.creatorId) === 2)).toHaveLength(106)
    expect(members.filter((c) => tokenCount(c.creatorId) === 1).map((c) => c.creatorId).sort()).toEqual(["azki", "irys", "robocosan"])
    expect(members.filter((c) => tokenCount(c.creatorId) === 3).map((c) => c.creatorId)).toEqual(["elizabeth_rose_bloodflame"])
  })

  it("every two-token member is found by both token orders; every other member by its single canonical form", () => {
    for (const c of members) {
      const tokens = c.creatorId.split("_")
      expect(creatorMatchesNameQuery(c, tokens.join(" "))).toBe(true)
      if (tokens.length === 2) {
        expect(creatorMatchesNameQuery(c, `${tokens[1]} ${tokens[0]}`)).toBe(true)
        expect(getRomanizedSearchForms(c).length).toBeGreaterThanOrEqual(2)
      }
    }
  })

  it("every member's id can be found through the roster-wide filter", () => {
    for (const c of members) expect(matchingIds(c.creatorId.replace(/_/g, " "))).toContain(c.creatorId)
  })
})
