import { describe, expect, it } from "vitest"
import type { RecentVideo } from "../data/mockRecentVideos"
import { selectLiveEmbedVideo } from "./liveEmbed"

const now = new Date("2026-09-12T12:00:00.000Z")

function archive(hoursAgo: number, videoId = `archive_${hoursAgo}`): RecentVideo {
  return {
    videoId,
    title: `stream ${hoursAgo}h ago`,
    publishedAt: new Date(now.getTime() - hoursAgo * 60 * 60 * 1000).toISOString(),
    contentFormat: "live_archive",
  }
}

describe("selectLiveEmbedVideo", () => {
  it("prefers the current live broadcast over any archive", () => {
    const result = selectLiveEmbedVideo({ kind: "live", videoId: "v_live", title: "Live now" }, [archive(1)], now)
    expect(result).toEqual({ videoId: "v_live", title: "Live now" })
  })

  it("falls back to the most recent archive within 24h when offline", () => {
    const result = selectLiveEmbedVideo({ kind: "offline" }, [archive(30), archive(5), archive(23.9)], now)
    expect(result?.videoId).toBe("archive_5")
  })

  it("returns null when the newest archive is older than 24h", () => {
    const result = selectLiveEmbedVideo({ kind: "offline" }, [archive(25), archive(48)], now)
    expect(result).toBeNull()
  })

  it("returns null when offline with no stream history at all", () => {
    expect(selectLiveEmbedVideo({ kind: "offline" }, [], now)).toBeNull()
  })

  it("ignores non-archive entries (live_now/shorts/normal_video) when offline", () => {
    const liveNow: RecentVideo = { videoId: "v1", title: "t", publishedAt: now.toISOString(), contentFormat: "live_now" }
    expect(selectLiveEmbedVideo({ kind: "offline" }, [liveNow], now)).toBeNull()
  })

  it("still checks the recent-archive fallback for an upcoming status (not live yet)", () => {
    const result = selectLiveEmbedVideo(
      { kind: "upcoming", videoId: "v2", title: "t2", scheduledStart: now.toISOString() },
      [archive(1)],
      now,
    )
    expect(result?.videoId).toBe("archive_1")
  })

  it("treats undefined status (no data yet) the same as offline", () => {
    expect(selectLiveEmbedVideo(undefined, [archive(1)], now)?.videoId).toBe("archive_1")
  })

  it("ignores an archive with a future publishedAt instead of treating its negative age as recent", () => {
    const result = selectLiveEmbedVideo({ kind: "offline" }, [archive(-2), archive(23)], now)
    expect(result?.videoId).toBe("archive_23")
  })
})
