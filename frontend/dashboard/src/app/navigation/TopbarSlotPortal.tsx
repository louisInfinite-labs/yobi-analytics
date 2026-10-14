import { useEffect, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"

/** Portals `children` into MainNavbar's phone-only `#main-topbar-slot` (see MainNavbar.tsx) -- the
 * mechanism that lets a page (Home's Search entry, mobile Videos' Search+Filter row) share the
 * hamburger's own top row on a phone without MainNavbar itself knowing anything about that page.
 * MainNavbar is mounted once, app-wide, for the lifetime of the app, so the slot element always exists
 * by the time this component's own effect runs (both are committed together in App.tsx's single render
 * tree) -- the `useState`+effect here only avoids reading the DOM during render itself, not working
 * around any real race. Renders nothing until then, and nothing at all on a page that never mounts it. */
export function TopbarSlotPortal({ children }: { children: ReactNode }) {
  const [node, setNode] = useState<HTMLElement | null>(null)
  useEffect(() => {
    setNode(document.getElementById("main-topbar-slot"))
  }, [])
  if (!node) return null
  return createPortal(children, node)
}
