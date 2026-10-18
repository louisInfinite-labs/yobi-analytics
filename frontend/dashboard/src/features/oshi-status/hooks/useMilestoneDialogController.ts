import { useCallback, useEffect, useRef, useState, type RefObject } from "react"

const CLOSE_DELAY_MS = 150

interface MilestoneDialogControllerOptions {
  /** Switching creator closes the dialog, so it never shows one creator while another is selected. */
  creatorId: string
  triggerRef: RefObject<HTMLElement | null>
  dialogRef: RefObject<HTMLElement | null>
}

/** Open/close behavior of the milestone dialog.
 *  - Desktop (a mouse): hovering the trigger opens it, and leaving BOTH the trigger and the dialog closes it. The dialog covers the trigger once
 *    open, so the pointer passes from one to the other: closing waits a short moment and is cancelled by entering the other, and it is skipped
 *    outright while either is still hovered, so there is no flicker.
 *  - Touch / pen / keyboard: activating the trigger toggles it; a press anywhere outside the trigger and the dialog closes it.
 *  - Escape closes it. */
export function useMilestoneDialogController({ creatorId, triggerRef, dialogRef }: MilestoneDialogControllerOptions) {
  // Which creator the dialog is open for: switching creator therefore closes it by derivation, with no effect.
  const [openFor, setOpenFor] = useState<string | null>(null)
  // Forget the old creator as soon as it changes (the stored-previous-prop pattern, during render): without this A -> B -> A would make `openFor === creatorId`
  // true again and reopen the dialog, and start a milestone read, with no user action.
  const [lastCreatorId, setLastCreatorId] = useState(creatorId)
  if (lastCreatorId !== creatorId) {
    setLastCreatorId(creatorId)
    if (openFor !== null) setOpenFor(null)
  }
  const open = openFor === creatorId
  const setOpen = useCallback(
    (next: boolean | ((previous: boolean) => boolean)) => {
      setOpenFor((previous) => ((typeof next === "function" ? next(previous === creatorId) : next) ? creatorId : null))
    },
    [creatorId],
  )
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastPointerType = useRef<string>("")

  const cancelClose = useCallback(() => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current)
    closeTimer.current = null
  }, [])

  const scheduleClose = useCallback(() => {
    cancelClose()
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null
      const hovered = (element: HTMLElement | null) => (element ? element.matches(":hover") : false)
      if (hovered(triggerRef.current) || hovered(dialogRef.current)) return
      setOpen(false)
    }, CLOSE_DELAY_MS)
  }, [cancelClose, setOpen, triggerRef, dialogRef])

  useEffect(() => cancelClose, [cancelClose])

  // The Oshi Stream player is a cross-origin iframe: a pointer over it sends the page no move, leave or press events, so a hover-opened dialog would stay
  // open while the mouse rests on the player and a tap on the player would never count as a tap outside. While the dialog is open the player frame lets
  // pointer events through to the page instead (see home.css), so leaving it and tapping it behave like any other area.
  useEffect(() => {
    if (!open) return
    document.documentElement.setAttribute("data-oshi-milestone-open", "true")
    return () => document.documentElement.removeAttribute("data-oshi-milestone-open")
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        cancelClose()
        setOpen(false)
      }
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (target && (triggerRef.current?.contains(target) || dialogRef.current?.contains(target))) return
      cancelClose()
      setOpen(false)
    }
    document.addEventListener("keydown", onKeyDown)
    document.addEventListener("pointerdown", onPointerDown)
    return () => {
      document.removeEventListener("keydown", onKeyDown)
      document.removeEventListener("pointerdown", onPointerDown)
    }
  }, [open, cancelClose, setOpen, triggerRef, dialogRef])

  const onHoverEnter = useCallback(
    (event: { pointerType: string }) => {
      if (event.pointerType !== "mouse") return
      cancelClose()
      setOpen(true)
    },
    [cancelClose, setOpen],
  )
  const onHoverLeave = useCallback(
    (event: { pointerType: string }) => {
      if (event.pointerType !== "mouse") return
      scheduleClose()
    },
    [scheduleClose],
  )

  const triggerProps = {
    onPointerDown: (event: { pointerType: string }) => {
      lastPointerType.current = event.pointerType
    },
    onPointerEnter: onHoverEnter,
    onPointerLeave: onHoverLeave,
    // A mouse click on a hover-opened dialog keeps it open; touch, pen and the keyboard (detail 0) toggle it.
    onClick: (event: { detail: number }) => {
      cancelClose()
      const isMouseClick = event.detail > 0 && lastPointerType.current === "mouse"
      setOpen((previous) => (isMouseClick ? true : !previous))
    },
  }
  const dialogProps = { onPointerEnter: onHoverEnter, onPointerLeave: onHoverLeave }

  return { open, triggerProps, dialogProps }
}