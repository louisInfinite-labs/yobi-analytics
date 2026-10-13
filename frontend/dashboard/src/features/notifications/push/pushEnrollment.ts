import { apiRequest } from "../../../shared/api/apiClient"
import { getOrCreateClientSecret } from "../../../shared/api/clientCredential"
import { getOrCreateClientId } from "../../../shared/api/clientId"
import { putNotificationPreference } from "../api/notificationPreferenceApi"
import { getEffectiveNewVideoCreatorIds, getEffectiveShortCreatorIds } from "../hooks/useTopicNotificationPreferences"
import { subscribeToPush, unsubscribeFromPush } from "./pushNotifications"
import { VAPID_PUBLIC_KEY } from "./vapidPublicKey"

/** Persist this browser's own push subscription under its own clientId (Roadmap 4.6, self-service). `clientSecret` (PR #18
 * CodeRabbit hardening, from clientCredential.ts) proves this call actually owns `clientId` -- api_handler.py's route rejects it
 * without a matching X-Client-Secret header. Returns the in-flight request so the caller can await and coordinate it with
 * syncNotificationEnabledToBackend rather than firing both and hoping -- see enablePushNotifications' own comments for why that
 * coordination matters. */
function syncSubscriptionToBackend(clientId: string, clientSecret: string | null, subscription: PushSubscriptionJSON | null): Promise<unknown> {
  const path = `/clients/${encodeURIComponent(clientId)}/push-subscription`
  const headers = clientSecret ? { "X-Client-Secret": clientSecret } : undefined
  return subscription ? apiRequest(path, { method: "PUT", body: subscription, headers }) : apiRequest(path, { method: "DELETE", headers })
}

/** Persist this browser's own on/off notification preference under its own clientId (Roadmap 4.6, self-service). See
 * syncSubscriptionToBackend's docstring -- same clientSecret/coordination reasoning. */
function syncNotificationEnabledToBackend(clientId: string, clientSecret: string | null, enabled: boolean): Promise<unknown> {
  // The write replaces the whole stored preference, so it carries the Settings per-creator 新片 switches too
  // (otherwise turning notifications on/off would wipe them on the backend).
  return putNotificationPreference(clientId, clientSecret, enabled, getEffectiveNewVideoCreatorIds(), getEffectiveShortCreatorIds())
}

/** How an enable attempt ended.
 * - "enabled": permission granted, subscription created/reused, and both backend writes confirmed.
 * - "not-granted": the browser is unsupported, or permission was denied/dismissed. Nothing was written anywhere.
 * - "failed": the service worker never activated, the subscription could not be created, or a backend step was rejected; every
 *   local/remote half-write was undone.
 * - "uncertain": like "failed", but the cleanup that undoes the backend writes ALSO failed, so the server may still have
 *   notifications enabled. */
export type EnablePushOutcome = "enabled" | "not-granted" | "failed" | "uncertain"

/** Which step of an enable attempt failed -- a short, non-sensitive code the failure dialog can show (and a user can read out) so a
 * failure on a real device is diagnosable. Never carries an endpoint, key, secret or server message.
 * - "subscribe": the service worker never became active, or PushManager.subscribe() threw (the browser/OS side);
 * - "register-subscription": PUT /clients/{id}/push-subscription was rejected (a missing client credential also lands here, as a 403);
 * - "save-preference": PUT /clients/{id}/notification-preference was rejected. */
export type EnablePushFailureStep = "subscribe" | "register-subscription" | "save-preference"

export interface EnablePushFailure {
  step: EnablePushFailureStep
  /** The HTTP status when a backend step answered with an error; absent for browser-side failures and lost responses. */
  status?: number
}

export interface EnablePushResult {
  outcome: EnablePushOutcome
  /** Set exactly when outcome is "failed" or "uncertain". */
  failure?: EnablePushFailure
}

/** The HTTP status of a rejected backend call (ApiError carries it), read structurally so a non-API error simply has none. */
function failureOf(step: EnablePushFailureStep, error: unknown): EnablePushFailure {
  const status = typeof error === "object" && error !== null ? (error as { status?: unknown }).status : undefined
  return typeof status === "number" ? { step, status } : { step }
}

/** Subscribes this browser to Web Push (asking for permission first only if it is still undecided) and records the subscription and
 * the on/off preference on the backend. The one implementation behind every enable path (the Settings/Schedule gate in pushGate.ts
 * and the dev-only NotificationToggle). Must only run as the result of an explicit user action -- it can raise the permission prompt. */
export async function enablePushNotifications(): Promise<EnablePushResult> {
  const clientId = getOrCreateClientId()

  let subscription: PushSubscriptionJSON | null
  try {
    subscription = await subscribeToPush(VAPID_PUBLIC_KEY)
  } catch (error) {
    // The service worker never activated (or registration / subscribe failed): nothing was written to the backend yet, so only the
    // browser side needs undoing -- leave no half-made subscription.
    await unsubscribeFromPush().catch(() => false)
    return { outcome: "failed", failure: failureOf("subscribe", error) }
  }
  if (!subscription) return { outcome: "not-granted" }

  // Declared outside the try so the catch below can still use it for best-effort reconciliation (see catch's own comment) even when
  // the failure happened partway through, after a secret was obtained.
  let clientSecret: string | null = null
  let step: EnablePushFailureStep = "register-subscription"
  try {
    clientSecret = await getOrCreateClientSecret(clientId)
    await syncSubscriptionToBackend(clientId, clientSecret, subscription)
    step = "save-preference"
    await syncNotificationEnabledToBackend(clientId, clientSecret, true)
    return { outcome: "enabled" }
  } catch (error) {
    const failure = failureOf(step, error)
    // Neither backend write is confirmed from this call's own point of view, so undo the local browser subscription rather than
    // showing "on" for a subscription the backend might not actually have. But "not confirmed here" isn't the same as "didn't
    // happen": a write can commit server-side even though this call's own promise rejected (e.g. its response was lost after the
    // server already processed it) -- the AND-gate safety note (the dispatcher only delivers to a client that has BOTH an enabled
    // preference and a stored subscription) only holds if a partial failure doesn't quietly leave *both* pieces present. So clean up
    // any such orphaned state with the same secret -- each call on its own, so one failing never stops the other. The server can only
    // still push if BOTH cleanups failed; only then say so ("uncertain") instead of swallowing it.
    await unsubscribeFromPush()
    if (clientSecret) {
      let preferenceCleaned = true
      let subscriptionCleaned = true
      try {
        await syncNotificationEnabledToBackend(clientId, clientSecret, false)
      } catch {
        preferenceCleaned = false
      }
      try {
        await syncSubscriptionToBackend(clientId, clientSecret, null)
      } catch {
        subscriptionCleaned = false
      }
      if (!preferenceCleaned && !subscriptionCleaned) return { outcome: "uncertain", failure }
    }
    return { outcome: "failed", failure }
  }
}

/** How a disable attempt ended.
 * - "disabled": backend preference off, browser unsubscribed, stale backend subscription removed.
 * - "failed": the preference write was rejected, so NOTHING changed (still on, locally and on the server).
 * - "disabled-cleanup-failed": notifications are off (preference written, browser unsubscribed), but deleting the now-stale backend
 *   subscription record failed. */
export type DisablePushOutcome = "disabled" | "failed" | "disabled-cleanup-failed"

/** Turns notifications off for this browser, backend first. The preference write (`enabled: false`) is what actually stops
 * notification_dispatcher.py, so it must succeed before anything local changes: if it fails, the browser subscription stays exactly
 * as it was and the caller never claims "off" while the backend still has notifications on. A null secret (registration failed --
 * network, or storage) is still passed through: the call 403s and lands in the same failure path. */
export async function disablePushNotifications(): Promise<DisablePushOutcome> {
  const clientId = getOrCreateClientId()
  let clientSecret: string | null
  try {
    clientSecret = await getOrCreateClientSecret(clientId)
    await syncNotificationEnabledToBackend(clientId, clientSecret, false)
  } catch {
    return "failed"
  }
  await unsubscribeFromPush()
  try {
    // Only cleanup remains. The preference is already disabled, and notification_dispatcher.py only delivers to a client that has
    // both an enabled preference and a stored subscription -- so a failure here leaves a stale subscription record that can never
    // cause an unwanted push; it is still reported so the user knows.
    await syncSubscriptionToBackend(clientId, clientSecret, null)
  } catch {
    return "disabled-cleanup-failed"
  }
  return "disabled"
}
