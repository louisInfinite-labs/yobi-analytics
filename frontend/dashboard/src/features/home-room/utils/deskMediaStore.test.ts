import { describe, expect, it } from "vitest"
import {
  DEFAULT_DESK_MEDIA_SETTINGS,
  deskMediaKindFor,
  readDeskMediaSettings,
  resetDeskMediaSettings,
  writeDeskMediaSettings,
  type MediaBlobStore,
} from "./deskMediaStore"

describe("deskMediaKindFor", () => {
  it("recognizes GIF distinctly from other images", () => {
    expect(deskMediaKindFor(new File([], "a.gif", { type: "image/gif" }))).toBe("gif")
  })

  it("recognizes still images", () => {
    expect(deskMediaKindFor(new File([], "a.png", { type: "image/png" }))).toBe("image")
  })

  it("recognizes mp4 and webm as video", () => {
    expect(deskMediaKindFor(new File([], "a.mp4", { type: "video/mp4" }))).toBe("video")
    expect(deskMediaKindFor(new File([], "a.webm", { type: "video/webm" }))).toBe("video")
  })

  it("rejects unsupported types instead of guessing", () => {
    expect(deskMediaKindFor(new File([], "a.pdf", { type: "application/pdf" }))).toBeNull()
  })
})

describe("deskMediaSettings", () => {
  it("returns the default settings when nothing is saved", () => {
    expect(readDeskMediaSettings("ch_unknown", window.localStorage)).toEqual(DEFAULT_DESK_MEDIA_SETTINGS)
  })

  it("round-trips written settings", () => {
    const settings = { mediaKind: "video" as const, fitMode: "contain" as const, muted: false }
    writeDeskMediaSettings("ch_a", settings, window.localStorage)
    expect(readDeskMediaSettings("ch_a", window.localStorage)).toEqual(settings)
  })

  it("falls back to the default on corrupt stored JSON instead of throwing", () => {
    window.localStorage.setItem("yobi.home.deskMedia.ch_corrupt", "{not json")
    expect(readDeskMediaSettings("ch_corrupt", window.localStorage)).toEqual(DEFAULT_DESK_MEDIA_SETTINGS)
  })

  it("removes the saved override on reset", () => {
    writeDeskMediaSettings("ch_reset", { mediaKind: "image", fitMode: "contain", muted: false }, window.localStorage)
    resetDeskMediaSettings("ch_reset", window.localStorage)
    expect(readDeskMediaSettings("ch_reset", window.localStorage)).toEqual(DEFAULT_DESK_MEDIA_SETTINGS)
  })
})

/** In-memory MediaBlobStore fake — the interface hooks/consumers depend on
 * instead of a real IndexedDB, so this suite (and useDeskMedia's own tests)
 * never need a real browser or an IndexedDB polyfill. */
export function createFakeMediaBlobStore(): MediaBlobStore {
  const blobs = new Map<string, Blob>()
  return {
    async get(creatorId) {
      return blobs.get(creatorId) ?? null
    },
    async put(creatorId, blob) {
      blobs.set(creatorId, blob)
    },
    async remove(creatorId) {
      blobs.delete(creatorId)
    },
  }
}

describe("createFakeMediaBlobStore (self-test)", () => {
  it("stores, retrieves, and removes a blob by creator id", async () => {
    const store = createFakeMediaBlobStore()
    const blob = new Blob(["x"], { type: "image/png" })
    await store.put("ch_a", blob)
    expect(await store.get("ch_a")).toBe(blob)
    expect(await store.get("ch_b")).toBeNull()
    await store.remove("ch_a")
    expect(await store.get("ch_a")).toBeNull()
  })
})
