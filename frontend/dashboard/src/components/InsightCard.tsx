import { Lightbulb } from "lucide-react"

interface InsightCardProps {
  text: string
}

export function InsightCard({ text }: InsightCardProps) {
  return (
    <div className="card insight-card">
      <Lightbulb size={16} className="insight-card__icon" aria-hidden="true" />
      <p className="insight-card__text">{text}</p>
    </div>
  )
}
