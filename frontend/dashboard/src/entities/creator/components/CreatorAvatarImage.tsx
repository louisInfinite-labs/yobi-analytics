import { useState } from "react"

interface CreatorAvatarImageProps {
  /** The canonical Creator Registry's `avatarUrl` (the creator's YouTube channel icon from the backend Creator Master). */
  avatarUrl: string | null | undefined
  displayName: string
  /** Sizes and frames the circle; the image fills it. */
  className: string
}

/** A creator's circular channel icon with the text-initial circle as a FALLBACK only -- shown when the registry has no
 * avatarUrl for the creator or the image fails to load, so a broken-image glyph never appears. Decorative (empty alt,
 * aria-hidden): the creator's name is always rendered right beside it. The image URL comes from the registry; nothing is
 * requested from YouTube per creator. */
export function CreatorAvatarImage({ avatarUrl, displayName, className }: CreatorAvatarImageProps) {
  // Remember WHICH url failed, so a different creator/url reusing this instance is tried again.
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const showImage = Boolean(avatarUrl) && failedUrl !== avatarUrl

  return (
    <span className={className} aria-hidden="true">
      {showImage ? (
        <img className="creator-avatar-image" src={avatarUrl ?? undefined} alt="" draggable={false} onError={() => setFailedUrl(avatarUrl ?? null)} />
      ) : (
        displayName.trim().charAt(0)
      )}
    </span>
  )
}
