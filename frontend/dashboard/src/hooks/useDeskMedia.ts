import { useCallback, useEffect, useRef, useState } from "react"
import {
  createIndexedDbMediaBlobStore,
  deskMediaKindFor,
  DEFAULT_DESK_MEDIA_SETTINGS,
  readDeskMediaSettings,
  resetDeskMediaSettings,
  writeDeskMediaSettings,
  type DeskMediaSettings,
  type MediaBlobStore,
} from "../lib/deskMediaStore"

const defaultStore = typeof indexedDB !== "undefined" ? createIndexedDbMediaBlobStore() : null

/** Loads/persists one creator's desk-monitor local media: blob in
 * `store` (real IndexedDB in production; inject a fake for tests),
 * lightweight settings in localStorage. Owns the one live object URL for
 * whichever blob is currently loaded and revokes it on every replacement/
 * unmount so object URLs never leak (spec: "Revoke replaced/unused object
 * URLs"). */
export function useDeskMedia(creatorId: string, store: MediaBlobStore | null = defaultStore) {
  const [settings, setSettings] = useState<DeskMediaSettings>(() => readDeskMediaSettings(creatorId))
  const [mediaUrl, setMediaUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const objectUrlRef = useRef<string | null>(null)
  // Bumped by every upload/remove so a slow initial IndexedDB read that's
  // still in flight can tell it's now stale and must not overwrite
  // (and orphan the object URL of) whatever the user already did.
  const localOverrideRef = useRef(0)

  const revokeCurrent = useCallback(() => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current)
      objectUrlRef.current = null
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const loadGeneration = localOverrideRef.current
    setSettings(readDeskMediaSettings(creatorId))
    setLoading(true)
    revokeCurrent()
    setMediaUrl(null)

    if (!store) {
      setLoading(false)
      return
    }

    store
      .get(creatorId)
      .then((blob) => {
        // An upload/remove that landed while this read was in flight
        // already reflects the user's latest intent — applying this
        // now-stale read on top would revert it and orphan its object URL.
        if (cancelled || localOverrideRef.current !== loadGeneration) return
        if (blob) {
          const url = URL.createObjectURL(blob)
          objectUrlRef.current = url
          setMediaUrl(url)
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
      revokeCurrent()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creatorId, store])

  const upload = useCallback(
    async (file: File) => {
      const kind = deskMediaKindFor(file)
      if (!kind || !store) return false
      await store.put(creatorId, file)
      localOverrideRef.current += 1
      revokeCurrent()
      const url = URL.createObjectURL(file)
      objectUrlRef.current = url
      setMediaUrl(url)
      const next: DeskMediaSettings = { ...settings, mediaKind: kind }
      writeDeskMediaSettings(creatorId, next)
      setSettings(next)
      return true
    },
    [creatorId, revokeCurrent, settings, store],
  )

  const remove = useCallback(async () => {
    if (store) await store.remove(creatorId)
    localOverrideRef.current += 1
    revokeCurrent()
    setMediaUrl(null)
    resetDeskMediaSettings(creatorId)
    setSettings(DEFAULT_DESK_MEDIA_SETTINGS)
  }, [creatorId, revokeCurrent, store])

  const setFitMode = useCallback(
    (fitMode: DeskMediaSettings["fitMode"]) => {
      const next = { ...settings, fitMode }
      writeDeskMediaSettings(creatorId, next)
      setSettings(next)
    },
    [creatorId, settings],
  )

  const setMuted = useCallback(
    (muted: boolean) => {
      const next = { ...settings, muted }
      writeDeskMediaSettings(creatorId, next)
      setSettings(next)
    },
    [creatorId, settings],
  )

  return { settings, mediaUrl, loading, upload, remove, setFitMode, setMuted }
}
