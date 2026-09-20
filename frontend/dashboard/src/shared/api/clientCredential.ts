import { apiRequest } from "./apiClient"

// Suffixed per clientId (not one shared key) so a browser that has ever
// held more than one clientId — e.g. clientId.ts's own storage-failure
// fallback minting a different id on some calls — keeps each one's
// credential independently retrievable, rather than the latest
// registration overwriting every earlier clientId's stored secret (a PR
// #18 CodeRabbit follow-up: a c1 -> c2 -> c1 sequence must still return
// c1's original credential, not force a doomed re-registration for an
// already-registered id).
//
// No migration from the earlier single-shared-key format this replaced:
// this whole route (POST /clients/{clientId}/credential) has never been
// deployed (Roadmap 4.1 — blocked on AWS console access), so no real
// browser has ever stored a value under the old key. There is nothing to
// migrate from yet.
const CLIENT_SECRET_STORAGE_KEY_PREFIX = "yobi-analytics-client-secret:"

// Fallback cache, keyed by clientId, for when localStorage itself is
// unavailable (private browsing, quota) or silently no-ops a write instead
// of throwing (some private-browsing configurations do this — a bare
// "setItem didn't throw" isn't proof it actually persisted, so the write
// path below reads back what it just wrote to check). Without this, a
// storage failure would make every call re-register: the *first* call's
// registration succeeds and returns a working secret, but nothing
// remembers it, so the *second* call registers again — and
// client_credential_store.create_secret is a one-time conditional write,
// so that second registration is refused and getOrCreateClientSecret
// would return null from then on, even though a perfectly good secret
// already exists in memory from the first call.
const _fallbackSecrets = new Map<string, string>()

/** Return this browser's client secret (PR #18 CodeRabbit hardening on top
 * of clientId.ts's Roadmap 4.3 clientId), registering a new one via
 * `POST /clients/{clientId}/credential` on first call and caching it in
 * `localStorage` under a key specific to this clientId (falling back to
 * `_fallbackSecrets`, also keyed by clientId, when storage itself is
 * unavailable — see its own comment). A clientId alone isn't proof of
 * ownership — this is what api_handler.py's client-scoped routes (GET
 * /remote-config, push-subscription and notification-preference
 * PUT/DELETE) now require in an X-Client-Secret header.
 *
 * Never throws: a failed registration (network, storage — including
 * `window.localStorage` itself throwing on access in strict privacy modes,
 * not just its getItem/setItem methods) returns null — callers already
 * treat a null credential as "this write/read will be rejected", the same
 * degrade-safely contract pushNotifications.ts uses for an unsupported
 * browser, rather than crashing the whole toggle.
 *
 * Registration establishes trust for a clientId the first time anyone
 * calls it for that id — there is no stronger enrollment/attestation check
 * before issuing a secret, since Roadmap 4.3's clientId is itself
 * anonymous and unauthenticated by design (no accounts, no Google login).
 * This is an accepted, deliberate limitation given that design, not an
 * oversight: a clientId is a 122-bit random UUID generated locally and
 * never transmitted anywhere until its own owning browser calls this
 * endpoint, so the practical risk is someone else registering first for a
 * clientId they'd already have had to learn or guess — the same
 * precondition every other client-scoped route in this hardening already
 * accepts as sufficiently unlikely. Similarly, if this call's response is
 * lost after the backend already committed the write (a network drop
 * right after a successful registration), there is no recovery flow to
 * retrieve the same raw secret again — only its hash is ever stored,
 * deliberately, the same way a password would be handled — so the
 * practical fallback is a fresh clientId, which client_id.ts's own
 * storage-failure path already produces whenever local state is lost. */
export async function getOrCreateClientSecret(clientId: string, storage?: Storage): Promise<string | null> {
  const key = CLIENT_SECRET_STORAGE_KEY_PREFIX + clientId

  let existing: string | null = null
  try {
    const store = storage ?? window.localStorage
    existing = store.getItem(key)
  } catch {
    existing = null
  }
  if (existing) return existing

  // Checked whenever storage has nothing to offer for this clientId — not
  // only when accessing/reading storage itself throws. A storage
  // implementation that reads back null without throwing (nothing was
  // ever actually persisted, e.g. writes silently no-op) hits this same
  // "nothing found" path as one that throws, so the fallback must be
  // consulted either way.
  const cached = _fallbackSecrets.get(clientId)
  if (cached) return cached

  try {
    const result = await apiRequest<{ clientId: string; clientSecret: string }>(
      `/clients/${encodeURIComponent(clientId)}/credential`,
      { method: "POST" },
    )
    try {
      const store = storage ?? window.localStorage
      store.setItem(key, result.clientSecret)
      // Some storage implementations silently no-op a write instead of
      // throwing (e.g. certain private-browsing configurations) — a bare
      // "setItem didn't throw" isn't proof it actually persisted. Reading
      // it back catches that case too, not just an outright exception.
      if (store.getItem(key) !== result.clientSecret) {
        _fallbackSecrets.set(clientId, result.clientSecret)
      }
    } catch {
      // Storage itself is unavailable — cache in memory instead so a
      // later call this session reuses this secret rather than trying
      // (and failing, since it's already registered) to mint another one.
      _fallbackSecrets.set(clientId, result.clientSecret)
    }
    return result.clientSecret
  } catch {
    // Registration failed (network, or this clientId already has a
    // credential this browser's storage lost track of — no recovery flow
    // at this scale, see this function's own docstring). Either way,
    // self-service writes/reads will 403 until it succeeds on a later call.
    return null
  }
}
