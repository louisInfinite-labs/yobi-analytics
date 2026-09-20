/** Per-creator desk-monitor local media (spec: "Store media blobs in
 * IndexedDB, keyed by creator ID. Do not store blobs/base64 in
 * localStorage."). The blob store is a small interface rather than a
 * direct IndexedDB dependency throughout the app, so tests can inject an
 * in-memory fake instead of needing a real IndexedDB polyfill — the same
 * boundary shape as the backend's own HistoryStore Protocol. */

export type DeskMediaKind = "image" | "gif" | "video"

export interface MediaBlobStore {
  get(creatorId: string): Promise<Blob | null>
  put(creatorId: string, blob: Blob): Promise<void>
  remove(creatorId: string): Promise<void>
}

const DB_NAME = "yobi-home-media"
const STORE_NAME = "deskMedia"
const DB_VERSION = 1

/** Real, browser-only IndexedDB-backed store. Never call this from a test — inject an in-memory fake instead. */
export function createIndexedDbMediaBlobStore(): MediaBlobStore {
  function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME)
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  }

  async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await openDb()
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, mode)
        const request = fn(tx.objectStore(STORE_NAME))
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
    } finally {
      db.close()
    }
  }

  return {
    async get(creatorId) {
      const result = await withStore<Blob | undefined>("readonly", (store) => store.get(creatorId))
      return result ?? null
    },
    async put(creatorId, blob) {
      await withStore<IDBValidKey>("readwrite", (store) => store.put(blob, creatorId))
    },
    async remove(creatorId) {
      await withStore<undefined>("readwrite", (store) => store.delete(creatorId))
    },
  }
}

export interface DeskMediaSettings {
  mediaKind: DeskMediaKind | null
  fitMode: "cover" | "contain"
  muted: boolean
}

export const DEFAULT_DESK_MEDIA_SETTINGS: DeskMediaSettings = { mediaKind: null, fitMode: "cover", muted: true }

function settingsKey(creatorId: string): string {
  return `yobi.home.deskMedia.${creatorId}`
}

function isValidSettings(value: unknown): value is DeskMediaSettings {
  if (typeof value !== "object" || value === null) return false
  const settings = value as DeskMediaSettings
  return (
    (settings.mediaKind === null || ["image", "gif", "video"].includes(settings.mediaKind)) &&
    (settings.fitMode === "cover" || settings.fitMode === "contain") &&
    typeof settings.muted === "boolean"
  )
}

export function readDeskMediaSettings(creatorId: string, storage?: Storage): DeskMediaSettings {
  try {
    const raw = (storage ?? window.localStorage).getItem(settingsKey(creatorId))
    if (!raw) return DEFAULT_DESK_MEDIA_SETTINGS
    const parsed: unknown = JSON.parse(raw)
    return isValidSettings(parsed) ? parsed : DEFAULT_DESK_MEDIA_SETTINGS
  } catch {
    return DEFAULT_DESK_MEDIA_SETTINGS
  }
}

export function writeDeskMediaSettings(creatorId: string, settings: DeskMediaSettings, storage?: Storage): boolean {
  try {
    ;(storage ?? window.localStorage).setItem(settingsKey(creatorId), JSON.stringify(settings))
    return true
  } catch {
    return false
  }
}

export function resetDeskMediaSettings(creatorId: string, storage?: Storage): void {
  try {
    ;(storage ?? window.localStorage).removeItem(settingsKey(creatorId))
  } catch {
    // Best-effort, matching layoutStore.resetLayout's own reasoning.
  }
}

/** Infer the desk-monitor media kind from a File's MIME type. Returns null for anything unsupported (spec: image/GIF/MP4/WebM only). */
export function deskMediaKindFor(file: File): DeskMediaKind | null {
  if (file.type === "image/gif") return "gif"
  if (file.type.startsWith("image/")) return "image"
  if (file.type === "video/mp4" || file.type === "video/webm") return "video"
  return null
}
