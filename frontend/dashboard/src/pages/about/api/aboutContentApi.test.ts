import { describe, expect, it } from "vitest"
import { validateAboutContent } from "./aboutContentApi"

// Deliberately loosely typed (`any`) -- these tests feed intentionally
// malformed/unsupported shapes to the validator, so the fixture itself
// cannot be the well-typed AboutContent shape.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function minimalPayload(overrides: Record<string, unknown> = {}): any {
  return {
    schemaVersion: 1,
    contentVersion: "1.0",
    locales: {
      "zh-TW": { pages: [{ id: "about", title: "t", markdown: "hi" }] },
      en: { pages: [{ id: "about", title: "t", markdown: "hi" }] },
      ja: { pages: [{ id: "about", title: "t", markdown: "hi" }] },
    },
    ...overrides,
  }
}

describe("validateAboutContent", () => {
  it("accepts a well-formed payload", () => {
    expect(validateAboutContent(minimalPayload())).not.toBeNull()
  })

  it("rejects a non-numeric or missing schemaVersion", () => {
    expect(validateAboutContent(minimalPayload({ schemaVersion: "1" }))).toBeNull()
    expect(validateAboutContent(minimalPayload({ schemaVersion: undefined }))).toBeNull()
  })

  it("rejects any schemaVersion other than the one version this build can render", () => {
    expect(validateAboutContent(minimalPayload({ schemaVersion: 2 }))).toBeNull()
    expect(validateAboutContent(minimalPayload({ schemaVersion: 0 }))).toBeNull()
  })

  it("rejects an empty contentVersion", () => {
    expect(validateAboutContent(minimalPayload({ contentVersion: "" }))).toBeNull()
  })

  it("rejects a non-object payload", () => {
    expect(validateAboutContent(null)).toBeNull()
    expect(validateAboutContent("a string")).toBeNull()
    expect(validateAboutContent(42)).toBeNull()
  })

  it("a page missing markdown is dropped, sibling pages still validate", () => {
    const payload = minimalPayload()
    payload.locales.en.pages.push({ id: "broken", title: "Broken" })
    payload.locales.en.pages.push({ id: "about2", title: "ok", markdown: "more text" })
    const validated = validateAboutContent(payload)
    expect(validated?.locales.en.pages.map((p) => p.id)).toEqual(["about", "about2"])
  })

  it("a page with empty markdown is dropped", () => {
    const payload = minimalPayload()
    payload.locales.en.pages = [{ id: "about", title: "t", markdown: "" }]
    const validated = validateAboutContent(payload)
    expect(validated?.locales.en).toBeUndefined()
  })

  it("an unknown extra field on a page is ignored, not fatal", () => {
    const payload = minimalPayload()
    payload.locales.en.pages[0].futureField = { anything: true }
    const validated = validateAboutContent(payload)
    expect(validated?.locales.en.pages[0]).toEqual({ id: "about", title: "t", markdown: "hi" })
  })

  it("returns a payload missing a locale entirely when that locale is unusable, others survive", () => {
    const payload = minimalPayload()
    payload.locales.en.pages = [{ id: "broken" }]
    const validated = validateAboutContent(payload)
    // "en" is dropped entirely, but zh-TW/ja are still usable -- the whole
    // payload is still valid as long as at least one locale survives.
    expect(validated?.locales.en).toBeUndefined()
    expect(validated?.locales["zh-TW"]).toBeDefined()
  })

  it("returns null when every locale is unusable", () => {
    const payload = minimalPayload({ locales: { en: { pages: [] } } })
    expect(validateAboutContent(payload)).toBeNull()
  })

  it("returns null when locales is missing or not an object", () => {
    expect(validateAboutContent(minimalPayload({ locales: undefined }))).toBeNull()
    expect(validateAboutContent(minimalPayload({ locales: "not-an-object" }))).toBeNull()
  })
})
