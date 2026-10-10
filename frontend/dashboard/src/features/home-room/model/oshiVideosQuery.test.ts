import { describe, expect, it } from "vitest"
import {
  OSHI_VIDEOS_RANKING_LIMIT,
  OSHI_VIDEOS_RECENT_PAGE_SIZE,
  VIDEO_CONTENT_TYPES,
  VIDEO_VIEW_WINDOWS,
  buildOshiVideosRequest,
  buildShelfQuery,
  isQuickFilterSelection,
  effectiveViewWindow,
  oshiVideosQueryKey,
  type OshiVideosQuery,
  type VideoContentType,
  type VideoViewWindow,
} from "./oshiVideosQuery"
import { SPECIAL_VIDEO_FILTERS } from "./specialVideoFilters"
import type { VideoSortOption } from "../utils/recentVideosSelection"

const CREATOR = "aizawa_ema"
// A representative sample, deliberately not an exhaustive copy of the real backend
// taxonomy -- these functions must treat `topic` as opaque backend data (GET /topics),
// never a frontend-known set, so "some-future-topic" (not a real backend id) is included
// on purpose to prove nothing here special-cases the topics that happen to exist today.
const SAMPLE_TOPICS = ["all", "sf6", "singing", "mv", "some-future-topic"]

function query(overrides: Partial<OshiVideosQuery> = {}): OshiVideosQuery {
  return { creatorId: CREATOR, topic: "all", contentType: "all", sort: "newest", viewWindow: "total", ...overrides }
}

/** Parse a built request path into its endpoint and parameters. */
function parse(path: string) {
  const url = new URL(path, "https://example.test")
  return { pathname: url.pathname, params: Object.fromEntries(url.searchParams) }
}

describe("B23: the Short filter is a backend contentType=short query", () => {
  const controls = (sort: VideoSortOption, viewWindow: VideoViewWindow = "total") => ({ contentType: "live" as VideoContentType, sort, viewWindow })

  it("asks for this creator's Shorts across all topics, ignoring the content-type dropdown but keeping sort and period", () => {
    expect(buildShelfQuery("short", CREATOR, controls("newest"))).toEqual({ creatorId: CREATOR, topic: "all", contentType: "short", sort: "newest", viewWindow: "total" })
    expect(buildShelfQuery("short", CREATOR, controls("mostViews", "7d"))).toEqual({ creatorId: CREATOR, topic: "all", contentType: "short", sort: "mostViews", viewWindow: "7d" })
    expect(buildShelfQuery("short", undefined, controls("newest"))).toBeNull()
  })

  it("newest/oldest page the recent endpoint and mostViews ranks, all with contentType=short&liveStatus=archived", () => {
    const newest = parse(buildOshiVideosRequest(buildShelfQuery("short", CREATOR, controls("newest"))!, 20).path)
    expect(newest.pathname).toBe(`/creators/${CREATOR}/videos/recent`)
    expect(newest.params).toMatchObject({ topic: "all", contentType: "short", liveStatus: "archived", sort: "newest", offset: "20" })
    const oldest = parse(buildOshiVideosRequest(buildShelfQuery("short", CREATOR, controls("oldest"))!).path)
    expect(oldest.params).toMatchObject({ contentType: "short", sort: "oldest" })
    const ranked = parse(buildOshiVideosRequest(buildShelfQuery("short", CREATOR, controls("mostViews", "30d"))!).path)
    expect(ranked.pathname).toBe(`/creators/${CREATOR}/videos/ranking`)
    expect(ranked.params).toMatchObject({ topic: "all", contentType: "short", liveStatus: "archived", metric: "30d" })
  })

  it("is not a quick filter (its sort stays user-controlled) and has its own shelf identity", () => {
    expect(isQuickFilterSelection("short")).toBe(false)
    const short = oshiVideosQueryKey(buildShelfQuery("short", CREATOR, controls("newest"))!)
    expect(short).not.toBe(oshiVideosQueryKey(buildShelfQuery("latestVideos", CREATOR, controls("newest"))!))
    expect(short).not.toBe(oshiVideosQueryKey(buildShelfQuery("all", CREATOR, { ...controls("newest"), contentType: "all" })!))
  })

  it("leaves 最新影片 as uploads only (Shorts excluded) and the leading filters untouched", () => {
    expect(buildShelfQuery("latestVideos", CREATOR, controls("oldest"))).toEqual({ creatorId: CREATOR, topic: "all", contentType: "upload", sort: "newest", viewWindow: "total" })
    expect(SPECIAL_VIDEO_FILTERS).toEqual(["all", "latestVideos", "latestLive"])
  })
})

describe("B23: Short is exclusive -- topic tags exclude Shorts, nothing else does", () => {
  const controls = { contentType: "all" as VideoContentType, sort: "newest" as VideoSortOption, viewWindow: "total" as VideoViewWindow }

  it("every backend topic id asks for excludeShorts=true on both the paged and the ranking endpoint", () => {
    for (const topic of ["valorant", "sf6", "apex", "minecraft", "singing", "mv", "chatting", "other", "some-future-topic"]) {
      const recent = buildOshiVideosRequest(buildShelfQuery(topic, CREATOR, controls)!)
      expect(parse(recent.path).params).toMatchObject({ topic, contentType: "all", excludeShorts: "true" })
      const ranked = buildOshiVideosRequest(buildShelfQuery(topic, CREATOR, { ...controls, sort: "mostViews" })!)
      expect(parse(ranked.path).pathname).toBe(`/creators/${CREATOR}/videos/ranking`)
      expect(parse(ranked.path).params).toMatchObject({ topic, excludeShorts: "true" })
    }
  })

  it("最新影片, 最新直播 and Short never send it (fixed content types); ALL and every topic do", () => {
    for (const selection of ["latestVideos", "latestLive", "short"]) {
      const query = buildShelfQuery(selection, CREATOR, controls)!
      expect(query.excludeShorts).toBeUndefined()
      expect(buildOshiVideosRequest(query).path).not.toContain("excludeShorts")
    }
    // ALL = the union of 最新直播 and 最新影片 across every topic (the dropdown still narrows it), without Shorts
    expect(buildShelfQuery("all", CREATOR, controls)).toEqual({ creatorId: CREATOR, topic: "all", ...controls, excludeShorts: true })
    expect(parse(buildOshiVideosRequest(buildShelfQuery("all", CREATOR, controls)!).path).params).toMatchObject({ topic: "all", contentType: "all", excludeShorts: "true" })
  })

  it("is part of the shelf identity so a topic shelf and an unfiltered one never share a result", () => {
    const withFlag: OshiVideosQuery = { creatorId: CREATOR, topic: "mv", contentType: "all", sort: "newest", viewWindow: "total", excludeShorts: true }
    expect(oshiVideosQueryKey(withFlag)).not.toBe(oshiVideosQueryKey({ ...withFlag, excludeShorts: undefined }))
  })
})

describe("buildShelfQuery / buildOshiVideosRequest treat topic as opaque backend data", () => {
  it("passes a topic id straight through, including one that isn't a real backend topic yet", () => {
    const shelf = buildShelfQuery("some-future-topic", CREATOR, { contentType: "all", sort: "newest", viewWindow: "total" })
    expect(shelf).toEqual({ creatorId: CREATOR, topic: "some-future-topic", contentType: "all", sort: "newest", viewWindow: "total", excludeShorts: true })
    const { params } = parse(buildOshiVideosRequest(shelf!).path)
    expect(params.topic).toBe("some-future-topic")
  })

  it("never translates one backend topic id into another (no frontend alias table)", () => {
    expect(buildShelfQuery("valorant", CREATOR, { contentType: "all", sort: "newest", viewWindow: "total" })).toMatchObject({ topic: "valorant" })
    expect(buildShelfQuery("singing", CREATOR, { contentType: "all", sort: "newest", viewWindow: "total" })).toMatchObject({ topic: "singing" })
  })
})

describe("buildOshiVideosRequest: newest / oldest use the archive endpoint", () => {
  it("scopes the path to the creator and sends topic, content type, archive scope, sort and paging", () => {
    const { path, paged } = buildOshiVideosRequest(query({ topic: "sf6", contentType: "live", sort: "newest" }), 40)
    const { pathname, params } = parse(path)

    expect(paged).toBe(true)
    expect(pathname).toBe(`/creators/${CREATOR}/videos/recent`)
    expect(params).toEqual({
      topic: "sf6",
      contentType: "live",
      liveStatus: "archived",
      sort: "newest",
      limit: String(OSHI_VIDEOS_RECENT_PAGE_SIZE),
      offset: "40",
    })
  })

  it("sends the content type as the backend's canonical value (all / live / upload)", () => {
    expect(VIDEO_CONTENT_TYPES).toEqual(["all", "live", "upload"])
    expect(parse(buildOshiVideosRequest(query({ contentType: "upload" })).path).params.contentType).toBe("upload")
    expect(parse(buildOshiVideosRequest(query({ contentType: "live" })).path).params.contentType).toBe("live")
    expect(parse(buildOshiVideosRequest(query({ contentType: "all" })).path).params.contentType).toBe("all")
  })

  it("never sends a metric for newest/oldest, whatever window was last chosen", () => {
    for (const sort of ["newest", "oldest"] as const) {
      const { params } = parse(buildOshiVideosRequest(query({ sort, viewWindow: "7d" })).path)
      expect(params.sort).toBe(sort)
      expect(params).not.toHaveProperty("metric")
    }
  })

  it("encodes the creator id into the path", () => {
    expect(parse(buildOshiVideosRequest(query({ creatorId: "a/b c" })).path).pathname).toBe("/creators/a%2Fb%20c/videos/recent")
  })
})

describe("buildOshiVideosRequest: views use the ranking endpoint", () => {
  it.each(VIDEO_VIEW_WINDOWS)("ranks by %s through the creator's ranking endpoint, bounded and unpaged", (window) => {
    const { path, paged } = buildOshiVideosRequest(query({ topic: "valorant", contentType: "upload", sort: "mostViews", viewWindow: window }))
    const { pathname, params } = parse(path)

    expect(paged).toBe(false)
    expect(pathname).toBe(`/creators/${CREATOR}/videos/ranking`)
    expect(params).toEqual({
      metric: window,
      topic: "valorant",
      contentType: "upload",
      liveStatus: "archived",
      limit: String(OSHI_VIDEOS_RANKING_LIMIT),
    })
    expect(params).not.toHaveProperty("sort")
    expect(params).not.toHaveProperty("offset")
  })
})

describe("capability matrix: every sampled topic x content type supports every sort and view window", () => {
  const sorts: { sort: VideoSortOption; window: VideoViewWindow }[] = [
    { sort: "newest", window: "total" },
    { sort: "oldest", window: "total" },
    { sort: "mostViews", window: "total" },
    { sort: "mostViews", window: "1d" },
    { sort: "mostViews", window: "7d" },
    { sort: "mostViews", window: "30d" },
  ]

  it(`builds a creator-scoped, correctly filtered request for all sampled topics x 3 content types x 6 sorts`, () => {
    let cells = 0
    for (const topic of SAMPLE_TOPICS) {
      for (const contentType of VIDEO_CONTENT_TYPES) {
        for (const { sort, window } of sorts) {
          const { path } = buildOshiVideosRequest(query({ topic, contentType, sort, viewWindow: window }))
          const { pathname, params } = parse(path)

          expect(pathname.startsWith(`/creators/${CREATOR}/videos/`)).toBe(true) // one creator, never aggregated
          expect(params.topic).toBe(topic)
          expect(params.contentType).toBe(contentType)
          expect(params.liveStatus).toBe("archived")
          if (sort === "mostViews") {
            expect(pathname.endsWith("/ranking")).toBe(true)
            expect(params.metric).toBe(window)
          } else {
            expect(pathname.endsWith("/recent")).toBe(true)
            expect(params.sort).toBe(sort)
          }
          cells += 1
        }
      }
    }
    expect(cells).toBe(SAMPLE_TOPICS.length * VIDEO_CONTENT_TYPES.length * sorts.length)
  })

  it("covers the explicit acceptance cases, including the real singing/mv ids", () => {
    const cases: [string, VideoContentType, VideoSortOption, VideoViewWindow, string, Record<string, string>][] = [
      ["all", "all", "newest", "total", "recent", { topic: "all", contentType: "all", sort: "newest" }],
      ["all", "live", "oldest", "total", "recent", { topic: "all", contentType: "live", sort: "oldest" }],
      ["other", "live", "mostViews", "7d", "ranking", { topic: "other", contentType: "live", metric: "7d" }],
      ["singing", "upload", "newest", "total", "recent", { topic: "singing", contentType: "upload", sort: "newest" }],
      ["mv", "upload", "newest", "total", "recent", { topic: "mv", contentType: "upload", sort: "newest" }],
      ["sf6", "live", "mostViews", "total", "ranking", { topic: "sf6", contentType: "live", metric: "total" }],
      ["valorant", "upload", "mostViews", "7d", "ranking", { topic: "valorant", contentType: "upload", metric: "7d" }],
    ]

    for (const [topic, contentType, sort, window, endpoint, expected] of cases) {
      const { pathname, params } = parse(buildOshiVideosRequest(query({ topic, contentType, sort, viewWindow: window })).path)
      expect(pathname).toBe(`/creators/${CREATOR}/videos/${endpoint}`)
      expect(params).toMatchObject(expected)
    }
  })
})

describe("oshiVideosQueryKey", () => {
  it("differs by creator, topic, content type, sort and (for views) window", () => {
    const base = query({ sort: "mostViews", viewWindow: "7d" })
    const keys = new Set([
      oshiVideosQueryKey(base),
      oshiVideosQueryKey({ ...base, creatorId: "subaru" }),
      oshiVideosQueryKey({ ...base, topic: "sf6" }),
      oshiVideosQueryKey({ ...base, contentType: "live" }),
      oshiVideosQueryKey({ ...base, sort: "oldest" }),
      oshiVideosQueryKey({ ...base, viewWindow: "30d" }),
    ])
    expect(keys.size).toBe(6)
  })

  it("ignores the view window unless the sort is views, so changing it for newest/oldest is not a new shelf", () => {
    expect(oshiVideosQueryKey(query({ sort: "newest", viewWindow: "1d" }))).toBe(oshiVideosQueryKey(query({ sort: "newest", viewWindow: "30d" })))
    expect(effectiveViewWindow("oldest", "7d")).toBe("total")
    expect(effectiveViewWindow("mostViews", "7d")).toBe("7d")
  })
})

describe("buildShelfQuery: quick filters and backend topic ids, always for the current creator", () => {
  const controls = { contentType: "live" as const, sort: "mostViews" as const, viewWindow: "7d" as const }

  it("最新影片 = this creator + all topics + upload + archived + newest, ignoring the dropdown controls", () => {
    const shelf = buildShelfQuery("latestVideos", CREATOR, controls)

    expect(shelf).toEqual({ creatorId: CREATOR, topic: "all", contentType: "upload", sort: "newest", viewWindow: "total" })
    const { pathname, params } = parse(buildOshiVideosRequest(shelf!).path)
    expect(pathname).toBe(`/creators/${CREATOR}/videos/recent`)
    expect(params).toMatchObject({ topic: "all", contentType: "upload", liveStatus: "archived", sort: "newest" })
  })

  it("最新直播 = this creator + all topics + live + archived + newest (completed archives, never /live-streams)", () => {
    const shelf = buildShelfQuery("latestLive", CREATOR, controls)

    expect(shelf).toEqual({ creatorId: CREATOR, topic: "all", contentType: "live", sort: "newest", viewWindow: "total" })
    const { pathname, params } = parse(buildOshiVideosRequest(shelf!).path)
    expect(pathname).toBe(`/creators/${CREATOR}/videos/recent`)
    expect(params).toMatchObject({ topic: "all", contentType: "live", liveStatus: "archived", sort: "newest" })
  })

  it("scopes both quick filters to whichever creator is current", () => {
    expect(buildShelfQuery("latestVideos", "subaru", controls)?.creatorId).toBe("subaru")
    expect(buildShelfQuery("latestLive", "subaru", controls)?.creatorId).toBe("subaru")
  })

  it("a backend topic id takes the user's content type, sort and period, sent through unchanged", () => {
    expect(buildShelfQuery("sf6", CREATOR, controls)).toEqual({ creatorId: CREATOR, topic: "sf6", ...controls, excludeShorts: true })
    expect(buildShelfQuery("valorant", CREATOR, { contentType: "upload", sort: "oldest", viewWindow: "30d" })).toMatchObject({
      topic: "valorant",
      contentType: "upload",
      sort: "oldest",
    })
  })

  it("has nothing to ask the backend for when the creator has no canonical id", () => {
    expect(buildShelfQuery("latestVideos", undefined, controls)).toBeNull()
    expect(buildShelfQuery("sf6", undefined, controls)).toBeNull()
  })

  it("knows which special filters are quick filters -- 'all' is not one (it uses the dropdown controls)", () => {
    expect(SPECIAL_VIDEO_FILTERS.filter(isQuickFilterSelection)).toEqual(["latestVideos", "latestLive"])
    expect(isQuickFilterSelection("sf6")).toBe(false)
  })
})
