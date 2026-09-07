import { useEffect, useState } from "react"

export type DataSource = "mock" | "live"

const STORAGE_KEY = "yobi:dataSource"

function readStoredDataSource(): DataSource {
  try {
    const hasLiveEndpoint = Boolean(import.meta.env.VITE_API_BASE_URL)
    return hasLiveEndpoint && localStorage.getItem(STORAGE_KEY) === "live" ? "live" : "mock"
  } catch {
    return "mock"
  }
}

/** Reads the current mock/live choice; re-check on mount only — a toggle click
 * in this same tab updates state directly, another tab's change needs a reload. */
export function useDataSource(): [DataSource, (next: DataSource) => void] {
  const [dataSource, setDataSourceState] = useState<DataSource>(readStoredDataSource)

  const setDataSource = (next: DataSource) => {
    setDataSourceState(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Best-effort only; the in-memory toggle still works for this session.
    }
  }

  return [dataSource, setDataSource]
}

interface DataSourceToggleProps {
  value: DataSource
  onChange: (next: DataSource) => void
}

/** Dev/QA control to switch the dashboard between the mock fixture and the
 * real Read API, so real data can be eyeballed against the mock's known
 * shape without editing env files. Hidden entirely when VITE_API_BASE_URL
 * isn't configured — there is nowhere for "live" to fetch from. */
export function DataSourceToggle({ value, onChange }: DataSourceToggleProps) {
  const [apiConfigured, setApiConfigured] = useState(false)

  useEffect(() => {
    setApiConfigured(Boolean(import.meta.env.VITE_API_BASE_URL))
  }, [])

  if (!apiConfigured) return null

  return (
    <div className="data-source-toggle" role="group" aria-label="Data source">
      <button
        type="button"
        className="soft-button data-source-toggle__option"
        aria-pressed={value === "mock"}
        onClick={() => onChange("mock")}
      >
        Mock
      </button>
      <button
        type="button"
        className="soft-button data-source-toggle__option"
        aria-pressed={value === "live"}
        onClick={() => onChange("live")}
      >
        Live
      </button>
    </div>
  )
}
