import { useRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react"

/** How far (px) a finger must travel sideways before it counts as a deliberate day swipe rather than a tap or a wobble. */
export const SWIPE_MIN_DISTANCE_PX = 56

/** A swipe must be this many times wider than it is tall: a mostly-vertical drag is the page scrolling, never a day change. */
export const SWIPE_DOMINANCE_RATIO = 1.5

/** Movement (px) after which the gesture's axis is decided. A vertical start is abandoned right there, leaving the page scroll alone. */
const AXIS_LOCK_SLOP_PX = 10

/** After a recognised swipe, a click that the browser still dispatches at release (the finger stayed on one card) is swallowed for this long. */
const CLICK_SUPPRESS_MS = 400

/** Controls that need their own touch interaction (the "+N" trigger and its panel, any text field or slider): a gesture that STARTS on one
 * never changes the day. Stream cards are deliberately not listed -- a swipe may begin over one, and the click it would end with is swallowed. */
const OWN_INTERACTION_SELECTOR = 'input, select, textarea, [role="slider"], [role="dialog"], .more-streams, [data-swipe-ignore]'

interface DaySwipeOptions {
  /** Phone single-day layout only; otherwise the handlers do nothing. */
  enabled: boolean
  canPrevious: boolean
  canNext: boolean
  onPrevious: () => void
  onNext: () => void
}

interface Gesture {
  pointerId: number
  startX: number
  startY: number
  decided: boolean
}

/** Horizontal day swiping for the phone Schedule: swipe left = the next day, swipe right = the previous day, never wrapping.
 *
 * Touch and pen only (a mouse is left alone). The browser keeps the vertical page scroll (the element carries `touch-action: pan-y
 * pinch-zoom`, schedule.css), so a vertical drag is cancelled by the browser before it can reach here, and a horizontal one is delivered
 * to these handlers. The decision is made at release: far enough, and clearly more horizontal than vertical. A second finger (a pinch)
 * abandons the gesture. Returns the props to spread on the swipeable element. */
export function useDaySwipe({ enabled, canPrevious, canNext, onPrevious, onNext }: DaySwipeOptions) {
  const gesture = useRef<Gesture | null>(null)
  const activePointers = useRef(new Set<number>())
  const swipedAt = useRef(Number.NEGATIVE_INFINITY)

  function onPointerDown(event: ReactPointerEvent<HTMLElement>) {
    if (event.pointerType === "mouse") return
    activePointers.current.add(event.pointerId)
    const target = event.target instanceof Element ? event.target : null
    if (!enabled || activePointers.current.size > 1 || event.isPrimary === false || target?.closest(OWN_INTERACTION_SELECTOR)) {
      gesture.current = null
      return
    }
    swipedAt.current = Number.NEGATIVE_INFINITY
    gesture.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, decided: false }
  }

  function onPointerMove(event: ReactPointerEvent<HTMLElement>) {
    const current = gesture.current
    if (!current || current.pointerId !== event.pointerId || current.decided) return
    const dx = Math.abs(event.clientX - current.startX)
    const dy = Math.abs(event.clientY - current.startY)
    if (Math.max(dx, dy) < AXIS_LOCK_SLOP_PX) return
    current.decided = true
    if (dy > dx) gesture.current = null // vertical: the page is scrolling
  }

  function onPointerUp(event: ReactPointerEvent<HTMLElement>) {
    activePointers.current.delete(event.pointerId)
    const current = gesture.current
    if (!current || current.pointerId !== event.pointerId) return
    gesture.current = null
    const dx = event.clientX - current.startX
    const dy = event.clientY - current.startY
    if (Math.abs(dx) < SWIPE_MIN_DISTANCE_PX || Math.abs(dx) < SWIPE_DOMINANCE_RATIO * Math.abs(dy)) return
    // A deliberate swipe -- even one that hits the first or last day (nothing to move to, and no wrap-around) must not open the card under the finger.
    swipedAt.current = performance.now()
    if (dx < 0) {
      if (canNext) onNext()
    } else if (canPrevious) {
      onPrevious()
    }
  }

  function onPointerCancel(event: ReactPointerEvent<HTMLElement>) {
    activePointers.current.delete(event.pointerId)
    if (gesture.current?.pointerId === event.pointerId) gesture.current = null
  }

  function onClickCapture(event: ReactMouseEvent<HTMLElement>) {
    if (performance.now() - swipedAt.current > CLICK_SUPPRESS_MS) return
    swipedAt.current = Number.NEGATIVE_INFINITY
    event.preventDefault()
    event.stopPropagation()
  }

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClickCapture }
}
