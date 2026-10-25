import { describe, expect, it } from "vitest"
import { apiOriginFromBaseUrl, apiPreconnectTags } from "./apiPreconnect"

describe("apiOriginFromBaseUrl", () => {
  it("returns the bare origin of the configured API URL", () => {
    expect(apiOriginFromBaseUrl("https://abc123.execute-api.ap-northeast-1.amazonaws.com")).toBe("https://abc123.execute-api.ap-northeast-1.amazonaws.com")
  })

  it("drops a trailing slash, path, query, fragment and credentials", () => {
    expect(apiOriginFromBaseUrl("https://api.example.com/")).toBe("https://api.example.com")
    expect(apiOriginFromBaseUrl("https://api.example.com/v1/prod?x=1#frag")).toBe("https://api.example.com")
    expect(apiOriginFromBaseUrl("https://user:secret@api.example.com/v1")).toBe("https://api.example.com")
  })

  it("keeps a non-default port and allows plain http (a local API)", () => {
    expect(apiOriginFromBaseUrl("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787")
    expect(apiOriginFromBaseUrl("https://api.example.com:8443/x")).toBe("https://api.example.com:8443")
  })

  it("tolerates surrounding whitespace", () => {
    expect(apiOriginFromBaseUrl("  https://api.example.com  ")).toBe("https://api.example.com")
  })

  it("returns null for anything unusable: unset, blank, not a URL, or not http(s)", () => {
    for (const value of [undefined, null, "", "   ", "not a url", "api.example.com", "/relative/path", "ftp://api.example.com", "ws://api.example.com", "javascript:alert(1)", 42, {}]) {
      expect(apiOriginFromBaseUrl(value), String(value)).toBeNull()
    }
  })
})

describe("apiPreconnectTags", () => {
  it("emits exactly one crossorigin preconnect link into <head> for a valid URL", () => {
    expect(apiPreconnectTags("https://api.example.com/")).toEqual([{ tag: "link", attrs: { rel: "preconnect", href: "https://api.example.com", crossorigin: "" }, injectTo: "head" }])
  })

  it("emits nothing when there is no usable API URL, so no malformed hint is ever written", () => {
    expect(apiPreconnectTags(undefined)).toEqual([])
    expect(apiPreconnectTags("")).toEqual([])
    expect(apiPreconnectTags("::::")).toEqual([])
  })
})
