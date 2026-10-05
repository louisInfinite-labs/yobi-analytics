/** Firebase App Check token acquisition (SEC-API-BOT-002, roadmap MT-30).
 *
 * The web app attests itself with the reCAPTCHA Enterprise provider and sends the token in `X-Firebase-AppCheck` (see
 * apiClient.ts). Everything configured here is PUBLIC by design (a Firebase web-app config and a reCAPTCHA site key); no
 * secret and no token is ever stored in source. A valid token proves the request came from an attested app instance, NOT
 * that a human is present.
 *
 * Nothing is fabricated: when the configuration is absent (local development, tests, a build without the Firebase values)
 * no token is produced and no request header is added. The debug provider exists for local development ONLY: it is behind
 * `import.meta.env.DEV`, so a production build contains none of it (the bundle gate fails the build if it ever does).
 */

export interface AppCheckConfig {
  apiKey: string
  projectId: string
  appId: string
  siteKey: string
}

/** The raw public values, read with STATIC `import.meta.env.VITE_*` references so Vite inlines only these four values (never
 * the whole environment object, which would ship every VITE_ variable in the bundle). */
function rawBuildConfig(): Record<keyof AppCheckConfig, unknown> {
  return {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
    siteKey: import.meta.env.VITE_RECAPTCHA_ENTERPRISE_SITE_KEY,
  }
}

/** The public configuration, or null when any part is missing or blank. */
export function readAppCheckConfig(raw: Record<string, unknown> = rawBuildConfig()): AppCheckConfig | null {
  const get = (name: keyof AppCheckConfig) => (typeof raw[name] === "string" ? (raw[name] as string).trim() : "")
  const config = { apiKey: get("apiKey"), projectId: get("projectId"), appId: get("appId"), siteKey: get("siteKey") }
  return Object.values(config).every(Boolean) ? config : null
}

type AppCheckHandle = { appCheck: unknown; getToken: (appCheck: never, forceRefresh?: boolean) => Promise<{ token: string }> }

let handle: Promise<AppCheckHandle | null> | null = null

function initialize(config: AppCheckConfig): Promise<AppCheckHandle | null> {
  return (async () => {
    try {
      const [{ initializeApp }, appCheckModule] = await Promise.all([import("@firebase/app"), import("@firebase/app-check")])
      if (import.meta.env.DEV) {
        // Local development only (never present in a production build). The debug token is a developer-supplied value.
        const debugToken = import.meta.env.VITE_APPCHECK_DEBUG_TOKEN
        if (typeof debugToken === "string" && debugToken) {
          ;(globalThis as Record<string, unknown>)["FIREBASE_APPCHECK_DEBUG_TOKEN"] = debugToken
        }
      }
      const app = initializeApp({ apiKey: config.apiKey, projectId: config.projectId, appId: config.appId })
      const appCheck = appCheckModule.initializeAppCheck(app, {
        provider: new appCheckModule.ReCaptchaEnterpriseProvider(config.siteKey),
        isTokenAutoRefreshEnabled: true,
      })
      return { appCheck, getToken: appCheckModule.getToken as unknown as AppCheckHandle["getToken"] }
    } catch {
      return null
    }
  })()
}

/** The current App Check token, or null when App Check is not configured or a token could not be obtained.
 * `forceRefresh` asks for a brand-new token (used for the one recovery attempt after an attestation rejection). */
export async function getAppCheckToken(forceRefresh = false): Promise<string | null> {
  const config = readAppCheckConfig()
  if (config === null) return null
  if (handle === null) handle = initialize(config)
  const ready = await handle
  if (ready === null) return null
  try {
    const { token } = await ready.getToken(ready.appCheck as never, forceRefresh)
    return token || null
  } catch {
    // e.g. the attestation script was blocked: send no header and let the backend decide (never log the token).
    return null
  }
}

/** Test-only: forget the initialized instance so a test can re-initialize with different configuration. */
export function resetAppCheckForTests(): void {
  handle = null
}
