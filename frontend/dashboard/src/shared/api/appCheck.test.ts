import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getAppCheckToken, readAppCheckConfig, resetAppCheckForTests } from "./appCheck"

const initializeApp = vi.fn(() => ({ name: "app" }))
const initializeAppCheck = vi.fn(() => ({ name: "appCheck" }))
const getToken = vi.fn()
const ReCaptchaEnterpriseProvider = vi.fn()

vi.mock("@firebase/app", () => ({ initializeApp: (...args: unknown[]) => initializeApp(...(args as [])) }))
vi.mock("@firebase/app-check", () => ({
  initializeAppCheck: (...args: unknown[]) => initializeAppCheck(...(args as [])),
  getToken: (...args: unknown[]) => getToken(...args),
  ReCaptchaEnterpriseProvider: function (this: unknown, siteKey: string) {
    ReCaptchaEnterpriseProvider(siteKey)
  },
}))

const CONFIG = { apiKey: "public-web-key", projectId: "demo-project", appId: "1:123:web:abc", siteKey: "site-key" }
const ENV_NAMES: Record<keyof typeof CONFIG, string> = {
  apiKey: "VITE_FIREBASE_API_KEY",
  projectId: "VITE_FIREBASE_PROJECT_ID",
  appId: "VITE_FIREBASE_APP_ID",
  siteKey: "VITE_RECAPTCHA_ENTERPRISE_SITE_KEY",
}

beforeEach(() => {
  resetAppCheckForTests()
  vi.clearAllMocks()
  getToken.mockResolvedValue({ token: "token-1" })
})

afterEach(() => vi.unstubAllEnvs())

function configure(values: Record<string, string> = CONFIG) {
  for (const [field, value] of Object.entries(values)) vi.stubEnv(ENV_NAMES[field as keyof typeof CONFIG], value)
}

describe("readAppCheckConfig", () => {
  it("returns the public configuration only when every value is present", () => {
    expect(readAppCheckConfig(CONFIG)).toEqual(CONFIG)
    for (const name of Object.keys(CONFIG)) {
      expect(readAppCheckConfig({ ...CONFIG, [name]: "" })).toBeNull()
      expect(readAppCheckConfig({ ...CONFIG, [name]: undefined })).toBeNull()
    }
    expect(readAppCheckConfig({})).toBeNull()
  })
})

describe("getAppCheckToken", () => {
  it("is null and never loads Firebase when App Check is not configured", async () => {
    expect(await getAppCheckToken()).toBeNull()
    expect(initializeApp).not.toHaveBeenCalled()
  })

  it("initializes once with the reCAPTCHA Enterprise provider and auto-refresh, then returns the token", async () => {
    configure()

    expect(await getAppCheckToken()).toBe("token-1")
    expect(await getAppCheckToken()).toBe("token-1")

    expect(initializeApp).toHaveBeenCalledTimes(1)
    expect(initializeApp).toHaveBeenCalledWith({ apiKey: "public-web-key", projectId: "demo-project", appId: "1:123:web:abc" })
    expect(ReCaptchaEnterpriseProvider).toHaveBeenCalledWith("site-key")
    expect(initializeAppCheck).toHaveBeenCalledWith({ name: "app" }, expect.objectContaining({ isTokenAutoRefreshEnabled: true }))
  })

  it("passes forceRefresh through for the recovery attempt", async () => {
    configure()

    await getAppCheckToken(true)

    expect(getToken).toHaveBeenCalledWith({ name: "appCheck" }, true)
  })

  it("is null (no header, no throw) when a token cannot be obtained", async () => {
    configure()
    getToken.mockRejectedValue(new Error("script blocked"))

    expect(await getAppCheckToken()).toBeNull()
  })

  it("is null when Firebase fails to initialize", async () => {
    configure()
    initializeApp.mockImplementationOnce(() => {
      throw new Error("bad config")
    })

    expect(await getAppCheckToken()).toBeNull()
  })

  it("does not set the debug token global unless one is supplied (development only)", async () => {
    configure()
    delete (globalThis as Record<string, unknown>)["FIREBASE_APPCHECK_DEBUG_TOKEN"]

    await getAppCheckToken()

    expect((globalThis as Record<string, unknown>)["FIREBASE_APPCHECK_DEBUG_TOKEN"]).toBeUndefined()
  })
})
