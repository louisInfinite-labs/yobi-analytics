import { useMemo, useState } from "react"
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react"
import type { DailyVideoStat } from "../types/domain"
import { CONTENT_FORMAT_LABELS, CONTENT_TAG_LABELS } from "../types/domain"
import { formatFullNumber, formatTimeInZone } from "../lib/format"
import { GrowthBadge } from "./GrowthBadge"
import { EmptyState } from "./states/EmptyState"

type SortKey = "channelName" | "videoTitle" | "publishedAt" | "totalViews" | "dailyIncrease" | "growthPercent" | "sevenDayAverage" | "collectedAt"

interface Column {
  key: SortKey
  label: string
  numeric?: boolean
}

const COLUMNS: Column[] = [
  { key: "channelName", label: "Channel" },
  { key: "videoTitle", label: "Video Title" },
  { key: "publishedAt", label: "Published" },
  { key: "totalViews", label: "Total Views", numeric: true },
  { key: "dailyIncrease", label: "Daily Increase", numeric: true },
  { key: "growthPercent", label: "Growth %", numeric: true },
  { key: "sevenDayAverage", label: "7d Avg", numeric: true },
  { key: "collectedAt", label: "Last Collected" },
]

const PAGE_SIZE = 8

interface VideoStatsTableProps {
  stats: DailyVideoStat[]
  timeZone: string
}

/** Searchable, sortable, paginated video statistics table. */
export function VideoStatsTable({ stats, timeZone }: VideoStatsTableProps) {
  const [search, setSearch] = useState("")
  const [sortKey, setSortKey] = useState<SortKey>("dailyIncrease")
  const [sortDesc, setSortDesc] = useState(true)
  const [page, setPage] = useState(0)

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return stats
    return stats.filter((s) => s.videoTitle.toLowerCase().includes(term) || s.channelName.toLowerCase().includes(term))
  }, [stats, search])

  const sorted = useMemo(() => {
    const copy = [...filtered]
    copy.sort((a, b) => {
      const av = a[sortKey]
      const bv = b[sortKey]
      const aMissing = av === null || av === undefined
      const bMissing = bv === null || bv === undefined
      if (aMissing && bMissing) return 0
      if (aMissing) return 1
      if (bMissing) return -1
      if (typeof av === "string" && typeof bv === "string") {
        const cmp = av.localeCompare(bv, ["ja", "en"])
        return sortDesc ? -cmp : cmp
      }
      if (av < bv) return sortDesc ? 1 : -1
      if (av > bv) return sortDesc ? -1 : 1
      return 0
    })
    return copy
  }, [filtered, sortKey, sortDesc])

  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE))
  const currentPage = Math.min(page, pageCount - 1)
  const pageRows = sorted.slice(currentPage * PAGE_SIZE, currentPage * PAGE_SIZE + PAGE_SIZE)

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDesc((d) => !d)
    } else {
      setSortKey(key)
      setSortDesc(true)
    }
    setPage(0)
  }

  return (
    <div className="card">
      <div className="table-toolbar">
        <h2 className="section-header" style={{ marginBottom: 0 }}>
          Video Statistics
        </h2>
        <input
          className="table-search"
          type="search"
          placeholder="Search channel or title…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value)
            setPage(0)
          }}
          aria-label="Search video statistics"
        />
      </div>

      {sorted.length === 0 ? (
        <EmptyState message="No videos match this search." />
      ) : (
        <>
          <div className="table-scroll">
            <table className="video-table">
              <thead>
                <tr>
                  {COLUMNS.map((col) => (
                    <th key={col.key} aria-sort={sortKey === col.key ? (sortDesc ? "descending" : "ascending") : "none"}>
                      <button
                        type="button"
                        className="table-sort-button"
                        onClick={() => toggleSort(col.key)}
                        style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "none", border: "none", padding: 0, font: "inherit", color: "inherit", cursor: "pointer" }}
                      >
                        {col.label}
                        {sortKey === col.key ? (
                          sortDesc ? (
                            <ArrowDown size={12} aria-hidden="true" />
                          ) : (
                            <ArrowUp size={12} aria-hidden="true" />
                          )
                        ) : (
                          <ArrowUpDown size={12} aria-hidden="true" style={{ opacity: 0.35 }} />
                        )}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pageRows.map((video) => (
                  <tr key={video.videoId}>
                    <td data-label="Channel">{video.channelName}</td>
                    <td data-label="Video Title" className="video-table__title-cell" title={video.videoTitle}>
                      {video.videoTitle}
                      <div style={{ display: "flex", gap: 4, marginTop: 4, flexWrap: "wrap" }}>
                        <span className="video-table__format-badge">{CONTENT_FORMAT_LABELS[video.contentFormat]}</span>
                        {video.contentTags.slice(0, 2).map((tag) => (
                          <span key={tag} className="video-table__format-badge">
                            {CONTENT_TAG_LABELS[tag]}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td data-label="Published">{video.publishedAt ? formatTimeInZone(video.publishedAt, timeZone) : "—"}</td>
                    <td data-label="Total Views" className="video-table__numeric">
                      {formatFullNumber(video.totalViews)}
                    </td>
                    <td data-label="Daily Increase" className="video-table__numeric">
                      {video.status === "ok" ? formatFullNumber(video.dailyIncrease) : "—"}
                    </td>
                    <td data-label="Growth %" className="video-table__numeric">
                      <GrowthBadge percent={video.status === "ok" ? video.growthPercent : null} />
                    </td>
                    <td data-label="7d Avg" className="video-table__numeric">
                      {video.sevenDayAverage !== undefined ? formatFullNumber(video.sevenDayAverage) : "—"}
                    </td>
                    <td data-label="Last Collected">{formatTimeInZone(video.collectedAt, timeZone)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="table-pagination">
            <span>
              Page {currentPage + 1} of {pageCount} ({sorted.length} video{sorted.length === 1 ? "" : "s"})
            </span>
            <button type="button" className="soft-button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>
              Previous
            </button>
            <button type="button" className="soft-button" disabled={currentPage >= pageCount - 1} onClick={() => setPage(currentPage + 1)}>
              Next
            </button>
          </div>
        </>
      )}
    </div>
  )
}
