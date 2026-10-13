import { useSyncExternalStore } from "react"
import { isNotificationDisabledByUser } from "../api/notificationPreferenceApi"
import { enablePushNotifications } from "./pushEnrollment"
import { getNotificationPermission } from "./pushNotifications"
import { refreshPushState } from "./pushState"

/** How a "the user is turning a notification on" attempt ended. Only "ready" means the change may be saved/applied.
 * - "cancelled": the user declined the explanation (or dismissed the browser prompt, which leaves permission undecided).
 * - "denied": permission is denied; the denied-permission help was shown and nothing was enabled.
 * - "unavailable": this browser/device cannot receive Web Push at all (e.g. iOS Safari outside a Home Screen app); help was shown.
 * - "failed": the subscription or a backend write failed and was undone; the failure dialog was shown. */
export type PushGateResult = "ready" | "cancelled" | "denied" | "unavailable" | "failed"

export type PushDialogKind = "explain" | "denied" | "unsupported" | "failed"

let dialog: PushDialogKind | null = null
let pendingExplain: { resolve: (proceed: boolean) => void } | null = null
let inFlight: Promise<PushGateResult> | null = null
const listeners = new Set<() => void>()

function setDialog(next: PushDialogKind | null) {
  dialog = next
  listeners.forEach((listener) => listener())
}

/** The informational dialog currently open (rendered by PushPermissionHost), or null. */
export function usePushDialog(): PushDialogKind | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => dialog,
  )
}

export function closePushDialog(): void {
  setDialog(null)
}

/** The explanation dialog's answer: true = the user explicitly chose Continue, false = cancelled/dismissed. */
export function answerPushExplanation(proceed: boolean): void {
  const pending = pendingExplain
  pendingExplain = null
  setDialog(null)
  pending?.resolve(proceed)
}

function askToContinue(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    pendingExplain = { resolve }
    setDialog("explain")
  })
}

async function enableAndReport(): Promise<PushGateResult> {
  const outcome = await enablePushNotifications()
  await refreshPushState()
  if (outcome === "enabled") return "ready"
  if (outcome === "not-granted") {
    // Denied at the browser prompt -> help; merely dismissed (permission still undecided) -> nothing to claim, nothing to show.
    if (getNotificationPermission() === "denied") {
      setDialog("denied")
      return "denied"
    }
    return "cancelled"
  }
  setDialog("failed")
  return "failed"
}

/** The one entry point every production "turn a notification on" action goes through (a one-time Schedule reminder, a creator's Live
 * or New Video notification, a creator reminder time): resolves "ready" only when this browser really can deliver Web Push, so the
 * caller saves the change only then and the UI never shows a notification as active that cannot be delivered.
 *
 * It never asks the browser for permission on its own: with permission still undecided it first shows OshiYobi's explanation and
 * waits for an explicit Continue; only then does the browser prompt appear. A denied permission is NOT re-requested -- the help for
 * turning it on in device settings is shown instead. With permission already granted it silently creates a missing subscription
 * (self-healing) and otherwise reuses the existing one. Concurrent calls share one explanation. */
export function ensurePushEnabled(): Promise<PushGateResult> {
  inFlight ??= runGate().finally(() => {
    inFlight = null
  })
  return inFlight
}

async function runGate(): Promise<PushGateResult> {
  const state = await refreshPushState()
  if (!state.supported) {
    setDialog("unsupported")
    return "unavailable"
  }
  if (state.permission === "denied") {
    setDialog("denied")
    return "denied"
  }
  if (state.permission === "granted") {
    if (state.subscribed && !isNotificationDisabledByUser()) return "ready"
    return enableAndReport()
  }
  if (!(await askToContinue())) return "cancelled"
  return enableAndReport()
}

/** Test seam: drop any open dialog / pending explanation between tests. */
export function resetPushGateForTests(): void {
  pendingExplain?.resolve(false)
  pendingExplain = null
  inFlight = null
  dialog = null
  listeners.forEach((listener) => listener())
}

/** Opens the denied-permission help on its own (the persistent notice in Notification Settings uses it) -- no permission request. */
export function showPushDeniedHelp(): void {
  setDialog("denied")
}
