import { describe, expect, it } from "vitest"
import type { RecentVideo } from "../../../shared/media/model/recentVideo"
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

  it("falls back to the most recent completed livestream when offline", () => {
    const result = selectLiveEmbedVideo({ kind: "offline" }, [archive(30), archive(5), archive(23.9)], now)
    expect(result?.videoId).toBe("archive_5")
  })

  it("still falls back to the latest completed livestream when it ended days or weeks ago (no 24h cut-off)", () => {
    expect(selectLiveEmbedVideo({ kind: "offline" }, [archive(25), archive(48)], now)?.videoId).toBe("archive_25")
    expect(selectLiveEmbedVideo({ kind: "offline" }, [archive(24 * 40), archive(24 * 9)], now)?.videoId).toBe("archive_216")
  })

  it("returns null when offline with no stream history at all", () => {
    expect(selectLiveEmbedVideo({ kind: "offline" }, [], now)).toBeNull()
  })

  it("ignores non-archive entries (live_now/shorts/normal_video) when offline", () => {
    const liveNow: RecentVideo = { videoId: "v1", title: "t", publishedAt: now.toISOString(), contentFormat: "live_now" }
    expect(selectLiveEmbedVideo({ kind: "offline" }, [liveNow], now)).toBeNull()
    const normal: RecentVideo = { videoId: "n1", title: "t", publishedAt: now.toISOString(), contentFormat: "normal_video" }
    expect(selectLiveEmbedVideo({ kind: "offline" }, [normal, archive(100)], now)?.videoId).toBe("archive_100")
  })

  it("an upcoming stream wins over a completed archive, and a live stream wins over both", () => {
    const upcoming = { kind: "upcoming", videoId: "u", title: "up", scheduledStart: now.toISOString() } as const
    expect(selectLiveEmbedVideo(upcoming, [archive(1)], now)?.videoId).toBe("u")
    expect(selectLiveEmbedVideo({ kind: "live", videoId: "l", title: "lv" }, [archive(1)], now)?.videoId).toBe("l")
  })

  it("loads the upcoming stream's own videoId rather than falling back to a recent archive", () => {
    const result = selectLiveEmbedVideo(
      { kind: "upcoming", videoId: "v2", title: "t2", scheduledStart: now.toISOString() },
      [archive(1)],
      now,
    )
    expect(result).toEqual({ videoId: "v2", title: "t2" })
  })

  it("treats undefined status (no data yet) the same as offline", () => {
    expect(selectLiveEmbedVideo(undefined, [archive(1)], now)?.videoId).toBe("archive_1")
  })

  it("ignores an archive with a future publishedAt instead of treating its negative age as recent", () => {
    const result = selectLiveEmbedVideo({ kind: "offline" }, [archive(-2), archive(23)], now)
    expect(result?.videoId).toBe("archive_23")
  })
})
