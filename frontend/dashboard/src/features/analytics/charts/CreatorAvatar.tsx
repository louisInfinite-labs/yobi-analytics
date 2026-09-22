import { mockCreators } from "../../../entities/creator/data/mockCreators"
import { getMemberAccent } from "../../../shared/theme/memberAccent"

interface CreatorAvatarProps {
  channelId: string
  channelName: string
  size?: "small" | "medium"
}

const creatorsById = new Map(mockCreators.map((creator) => [creator.channelId, creator]))

export function getCreatorAvatarVisual(channelId: string, channelName: string) {
  const creator = creatorsById.get(channelId)
  const accent = getMemberAccent(channelId)
  return {
    avatarUrl: creator?.avatarUrl,
    initial: channelName.trim().charAt(0).toUpperCase() || "?",
    background: accent.primary,
    color: accent.textAccent,
  }
}

export function CreatorAvatar({ channelId, channelName, size = "small" }: CreatorAvatarProps) {
  const visual = getCreatorAvatarVisual(channelId, channelName)

  return (
    <span
      className={`analytics-creator-avatar analytics-creator-avatar--${size}`}
      style={visual.avatarUrl ? undefined : { background: visual.background, color: visual.color }}
      aria-hidden="true"
    >
      {visual.avatarUrl ? <img src={visual.avatarUrl} alt="" /> : visual.initial}
    </span>
  )
}
