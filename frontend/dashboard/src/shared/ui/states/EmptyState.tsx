import { Inbox } from "lucide-react"

/** Shown when a filter combination matches zero videos. */
export function EmptyState({ message = "No videos match the current filters." }: { message?: string }) {
  return (
    <div className="state-panel">
      <Inbox size={28} className="state-panel__icon" aria-hidden="true" />
      <p>{message}</p>
    </div>
  )
}
