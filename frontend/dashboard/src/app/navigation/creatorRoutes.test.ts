import { describe, expect, it } from "vitest"
import { getCreators } from "../../entities/creator/data/creatorRegistry"
import { creatorFromSlug, creatorPath, creatorSlug, parseCreatorRoute } from "./creatorRoutes"

describe("creator slugs come from the canonical creatorId, never the display name", () => {
  it("the slug is the stable creatorId with _ written as -", () => {
    expect(creatorSlug({ creatorId: "aizawa_ema" })).toBe("aizawa-ema")
    expect(creatorSlug({ creatorId: "kurumi_noa" })).toBe("kurumi-noa")
    expect(creatorPath({ creatorId: "aizawa_ema" })).toBe("/creator/aizawa-ema")
  })

  it("every registry creator has a distinct, reversible slug", () => {
    const slugs = getCreators().map(creatorSlug)
    expect(new Set(slugs).size).toBe(slugs.length)
    for (const creator of getCreators().filter((c) => c.active)) expect(creatorFromSlug(creatorSlug(creator))).toBe(creator)
  })

  it("a slug resolves only in its canonical spelling", () => {
    expect(creatorFromSlug("aizawa-ema")?.displayName).toBeTruthy()
    for (const bad of ["aizawa_ema", "AIZAWA-EMA", "aizawa--ema", "-aizawa-ema", "aizawa-ema-", "藍沢エマ", "", "not-a-real-creator", "ch-aizawa-ema"]) {
      expect(creatorFromSlug(bad), bad).toBeUndefined()
    }
  })
})

describe("parseCreatorRoute", () => {
  it("is null for anything outside /creator", () => {
    for (const path of ["/", "/schedule", "/setting", "/about", "/creators/aizawa-ema", "/creatorx"]) expect(parseCreatorRoute(path), path).toBeNull()
  })

  it("names the creator for a valid slug (with or without a trailing slash)", () => {
    expect(parseCreatorRoute("/creator/aizawa-ema")).toMatchObject({ kind: "creator", creator: { creatorId: "aizawa_ema" } })
    expect(parseCreatorRoute("/creator/kurumi-noa/")).toMatchObject({ kind: "creator", creator: { creatorId: "kurumi_noa" } })
  })

  it("is invalid for an unknown, missing, malformed or over-long slug -- never a different creator", () => {
    for (const path of ["/creator/not-a-real-creator", "/creator", "/creator/", "/creator/aizawa-ema/extra", "/creator/%E0%A4%A", "/creator/aizawa_ema"]) {
      expect(parseCreatorRoute(path), path).toEqual({ kind: "invalid" })
    }
  })
})
