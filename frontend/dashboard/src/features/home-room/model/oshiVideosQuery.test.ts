import { describe, expect, it } from "vitest"
import {
  OSHI_VIDEOS_RANKING_LIMIT,
  OSHI_VIDEOS_RECENT_PAGE_SIZE,
  VIDEO_CONTENT_TYPES,
  VIDEO_VIEW_WINDOWS,
  buildOshiVideosRequest,
  buildShelfQuery,
  isQuickFilterTag,
  effectiveViewWindow,
  oshiVideosQueryKey,
  topicForTag,
  type OshiVideosQuery,
  type VideoContentType,
  type VideoTopic,
  type VideoViewWindow,
} from "./oshiVideosQuery"
import { VIDEO_SECTION_TAGS } from "./videoCategories"
import type { VideoSortOption } from "../utils/recentVideosSelection"

const CREATOR = "aizawa_ema"
const TOPICS: VideoTopic[] = ["all", "chatting", "singing", "valorant", "apex", "sf6", "minecraft", "other"]

function query(overrides: Partial<OshiVideosQuery> = {}): OshiVideosQuery {
  return { creatorId: CREATOR, topic: "all", contentType: "all", sort: "newest", viewWindow: "total", ...overrides }
}

/** Parse a built request path into its endpoint and parameters. */
function parse(path: string) {
  const url = new URL(path, "https://example.test")
  return { pathname: url.pathname, params: Object.fromEntries(url.searchParams) }
}

describe("topicForTag", () => {
  it("maps ALL and the 7 category tags to the backend's canonical topic ids", () => {
    expect(topicForTag("all")).toBe("all")
    expect(topicForTag("valo")).toBe("valorant") // the UI's VALO is the backend's valorant
    expect(topicForTag("sf6")).toBe("sf6")
    expect(topicForTag("minecraft")).toBe("minecraft")
    expect(topicForTag("apex")).toBe("apex")
    expect(topicForTag("singing")).toBe("singing")
    expect(topicForTag("chatting")).toBe("chatting")
    expect(topicForTag("other")).toBe("other")
  })

  it("gives the quick filters no topic: they are fixed shortcuts (see buildShelfQuery), not topic tags", () => {
    expect(topicForTag("latestVideos")).toBeNull()
    expect(topicForTag("latestLive")).toBeNull()
    // every tag is either a quick filter or maps to exactly one of the 8 topics
    const mapped = VIDEO_SECTION_TAGS.map(topicForTag).filter((topic) => topic !== null)
    expect(new Set(mapped)).toEqual(new Set(TOPICS))
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

describe("capability matrix: every topic x content type supports every sort and view window", () => {
  const sorts: { sort: VideoSortOption; window: VideoViewWindow }[] = [
    { sort: "newest", window: "total" },
    { sort: "oldest", window: "total" },
    { sort: "mostViews", window: "total" },
    { sort: "mostViews", window: "1d" },
    { sort: "mostViews", window: "7d" },
    { sort: "mostViews", window: "30d" },
  ]

  it("builds a creator-scoped, correctly filtered request for all 8 topics x 3 content types x 6 sorts", () => {
    let cells = 0
    for (const topic of TOPICS) {
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
    expect(cells).toBe(8 * 3 * 6)
  })

  it("covers the explicit acceptance cases", () => {
    const cases: [VideoTopic, VideoContentType, VideoSortOption, VideoViewWindow, string, Record<string, string>][] = [
      ["all", "all", "newest", "total", "recent", { topic: "all", contentType: "all", sort: "newest" }],
      ["all", "live", "oldest", "total", "recent", { topic: "all", contentType: "live", sort: "oldest" }],
      ["other", "live", "mostViews", "7d", "ranking", { topic: "other", contentType: "live", metric: "7d" }],
      ["sf6", "live", "newest", "total", "recent", { topic: "sf6", contentType: "live", sort: "newest" }],
      ["sf6", "live", "oldest", "total", "recent", { topic: "sf6", contentType: "live", sort: "oldest" }],
      ["sf6", "live", "mostViews", "total", "ranking", { topic: "sf6", contentType: "live", metric: "total" }],
      ["sf6", "live", "mostViews", "1d", "ranking", { topic: "sf6", contentType: "live", metric: "1d" }],
      ["sf6", "live", "mostViews", "7d", "ranking", { topic: "sf6", contentType: "live", metric: "7d" }],
      ["sf6", "live", "mostViews", "30d", "ranking", { topic: "sf6", contentType: "live", metric: "30d" }],
      ["sf6", "upload", "newest", "total", "recent", { topic: "sf6", contentType: "upload", sort: "newest" }],
      ["sf6", "upload", "oldest", "total", "recent", { topic: "sf6", contentType: "upload", sort: "oldest" }],
      ["valorant", "live", "newest", "total", "recent", { topic: "valorant", contentType: "live", sort: "newest" }],
      ["valorant", "live", "oldest", "total", "recent", { topic: "valorant", contentType: "live", sort: "oldest" }],
      ["valorant", "upload", "newest", "total", "recent", { topic: "valorant", contentType: "upload", sort: "newest" }],
      ["valorant", "upload", "oldest", "total", "recent", { topic: "valorant", contentType: "upload", sort: "oldest" }],
      ["valorant", "upload", "mostViews", "total", "ranking", { topic: "valorant", contentType: "upload", metric: "total" }],
      ["valorant", "upload", "mostViews", "1d", "ranking", { topic: "valorant", contentType: "upload", metric: "1d" }],
      ["valorant", "upload", "mostViews", "7d", "ranking", { topic: "valorant", contentType: "upload", metric: "7d" }],
      ["valorant", "upload", "mostViews", "30d", "ranking", { topic: "valorant", contentType: "upload", metric: "30d" }],
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

describe("buildShelfQuery: quick filters and topic tags, always for the current creator", () => {
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

  it("a topic tag takes the user's content type, sort and period", () => {
    expect(buildShelfQuery("sf6", CREATOR, controls)).toEqual({ creatorId: CREATOR, topic: "sf6", ...controls })
    expect(buildShelfQuery("valo", CREATOR, { contentType: "upload", sort: "oldest", viewWindow: "30d" })).toMatchObject({
      topic: "valorant",
      contentType: "upload",
      sort: "oldest",
    })
  })

  it("has nothing to ask the backend for when the creator has no canonical id", () => {
    expect(buildShelfQuery("latestVideos", undefined, controls)).toBeNull()
    expect(buildShelfQuery("sf6", undefined, controls)).toBeNull()
  })

  it("knows which tags are quick filters", () => {
    expect(VIDEO_SECTION_TAGS.filter(isQuickFilterTag)).toEqual(["latestVideos", "latestLive"])
  })
})
