/** Brings Home's player to the visible top of the viewport -- immediately (never an animated scroll), and below the app's own sticky
 * top bar on a phone (`--main-topbar-height`, main-navbar.css; unset, i.e. 0, where there is none) so the player is never hidden under it.
 *
 * Only a deliberate user pick calls this (HomePage's openVideo, which the shelf cards and every Oshi Status title/thumbnail share): it is
 * never wired to the selected-video state itself, so the initial selection, polling, a creator change and every background refresh leave
 * the viewport alone. Where the page does not scroll (the desktop one-viewport layout) the target is already 0 and this is a no-op. */
export function scrollToHomePlayer(player: HTMLElement | null): void {
  if (!player) return
  const reserved = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--main-topbar-height")) || 0
  const top = player.getBoundingClientRect().top + window.scrollY - reserved
  window.scrollTo({ top: Math.max(0, top), left: 0, behavior: "instant" })
}
