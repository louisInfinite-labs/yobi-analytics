/** Semantic asset mapping for the Home OBS-style room scene (ぱるぷんて。
 * "配信部屋 素材セット", https://booth.pm/ja/items/5706710).
 *
 * The actual purchased image files are not committed here — confirm the
 * downloaded tier's licence permits this app's intended use before shipping
 * publicly, and never commit paid/redistribution-restricted source assets.
 * Drop the real files into `public/assets/home/` using these exact
 * filenames (or edit the paths below to match whatever the package's own
 * files are named) once available; every layer falls back to a labeled
 * placeholder box (see HomeScene's onError handling) so the layout is
 * fully reviewable before the real art exists.
 */

export interface HomeRect {
  /** Percentage of the 16:9 scene's width/height, matching the scene's own percentage-based coordinate system. */
  xPercent: number
  yPercent: number
  widthPercent: number
  heightPercent: number
}

export interface HomeAssetConfig {
  background: string
  desk?: string
  chair?: string
  microphone?: string
  keyboard?: string
  mouse?: string
  /** Where the desk monitor's local media renders, in the same percentage coordinate space as every other layer. */
  monitorRect: HomeRect
}

export const HOME_ASSET_BASE = "/assets/home"

export const homeAssetConfig: HomeAssetConfig = {
  background: `${HOME_ASSET_BASE}/background.png`,
  desk: `${HOME_ASSET_BASE}/desk.png`,
  chair: `${HOME_ASSET_BASE}/chair.png`,
  microphone: `${HOME_ASSET_BASE}/microphone.png`,
  keyboard: `${HOME_ASSET_BASE}/keyboard.png`,
  mouse: `${HOME_ASSET_BASE}/mouse.png`,
  monitorRect: { xPercent: 38, yPercent: 52, widthPercent: 20, heightPercent: 15 },
}

/** Per-creator transparent Oshi image path — falls back to a shared placeholder when a creator has none. */
export function oshiImagePathFor(creatorId: string): string {
  return `${HOME_ASSET_BASE}/oshi/${creatorId}.png`
}
