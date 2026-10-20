import { chromium, expect, test as base, type Browser, type BrowserContext, type Page } from "@playwright/test"
import { createServer, type IncomingMessage, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  ANALYTICS_LAUNCH_ARGS,
  apiOriginsFromEnv,
  guardAutomation,
  isAnalyticsCollectUrl,
  isGuardedApiUrl,
  isMutatingMethod,
  launchGuarded,
  launchGuardedPersistent,
} from "../helpers/automationGuard.mjs"
import { test as smokeTest } from "../smoke/helpers"

/** Regression tests for e2e/helpers/automationGuard.mjs. Everything runs against two throwaway local servers (an "app" origin and an
 * "API" origin that counts the requests that actually reach it) -- no test here contacts production. The only requests that could
 * reach a real host if the guard failed carry the fake measurement id G-AUTOMGUARD / a non-existent execute-api id. */

const GA_COLLECT = "https://www.google-analytics.com/g/collect?v=2&tid=G-AUTOMGUARD&en=page_view&dl=https%3A%2F%2Fexample.invalid%2F"
const FAKE_AWS_API = "https://abc123fake.execute-api.ap-northeast-1.amazonaws.com"

interface Servers {
  appOrigin: string
  apiOrigin: string
  apiHits: string[]
  appPosts: string[]
}

let servers: Server[] = []
let local: Servers

/** Starts a throwaway HTTP server on a random loopback port and resolves with it and its origin. */
function listen(handler: (request: IncomingMessage, respond: (status: number, type: string, body: string, headers?: Record<string, string>) => void) => void): Promise<{ server: Server; origin: string }> {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      handler(request, (status, type, body, headers = {}) => {
        response.writeHead(status, { "content-type": type, ...headers })
        response.end(body)
      })
    })
    server.listen(0, "127.0.0.1", () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }))
  })
}

base.beforeAll(async () => {
  const apiHits: string[] = []
  const appPosts: string[] = []
  const api = await listen((request, respond) => {
    apiHits.push(`${request.method} ${request.url}`)
    respond(200, "application/json", JSON.stringify({ ok: true }), { "access-control-allow-origin": "*", "access-control-allow-methods": "*", "access-control-allow-headers": "*" })
  })
  const app = await listen((request, respond) => {
    if (request.url === "/sw.js") {
      respond(200, "text/javascript", 'self.addEventListener("install",()=>self.skipWaiting());self.addEventListener("activate",(e)=>e.waitUntil(self.clients.claim()))')
    } else if (request.method === "POST") {
      appPosts.push(request.url ?? "")
      respond(200, "application/json", "{}")
    } else {
      respond(200, "text/html", "<!doctype html><title>guard</title><body>ok</body>")
    }
  })
  servers = [api.server, app.server]
  local = { appOrigin: app.origin, apiOrigin: api.origin, apiHits, appPosts }
})

base.afterAll(() => {
  for (const server of servers) server.close()
})

base.beforeEach(() => {
  local.apiHits.length = 0
  local.appPosts.length = 0
})

/** Sends one request per transport (fetch, XHR, sendBeacon, <img>) to each GA collect URL and resolves once they have been issued. */
async function fireAllGaTransports(page: Page): Promise<void> {
  await page.evaluate(async (url) => {
    const hosts = [url, url.replace("www.google-analytics.com", "region1.google-analytics.com"), url.replace("www.google-analytics.com", "analytics.google.com"), "https://www.google.com/ccm/collect?tid=G-AUTOMGUARD"]
    for (const target of hosts) {
      await fetch(target, { mode: "no-cors", method: "POST", body: "x" }).catch(() => undefined)
      await new Promise<void>((resolve) => {
        const xhr = new XMLHttpRequest()
        xhr.open("GET", target)
        xhr.onloadend = () => resolve()
        xhr.send()
      })
      navigator.sendBeacon(target, "x")
      await new Promise<void>((resolve) => {
        const image = new Image()
        image.onerror = () => resolve()
        image.onload = () => resolve()
        image.src = target
      })
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }, GA_COLLECT)
}

/** Opens a fresh guarded context and a page already loaded from the local app origin. */
async function newGuardedPage(browser: Browser, apiOrigins: string[] = []): Promise<{ context: BrowserContext; page: Page; guard: Awaited<ReturnType<typeof guardAutomation>> }> {
  const context = await browser.newContext()
  const guard = await guardAutomation(context, { apiOrigins })
  const page = await context.newPage()
  await page.goto(local.appOrigin)
  return { context, page, guard }
}

base.describe("automation guard: matchers", () => {
  base("matches GA4 collection endpoints only", () => {
    for (const url of [
      "https://www.google-analytics.com/g/collect?v=2",
      "https://region1.google-analytics.com/g/collect?v=2",
      "https://analytics.google.com/g/collect?v=2",
      "https://stats.g.doubleclick.net/g/collect?v=2",
      "https://www.google.com/g/collect?v=2",
      "https://www.google.com/ccm/collect?tid=G-X",
      "https://www.google-analytics.com/j/collect",
      "https://www.google-analytics.com/collect",
    ]) {
      expect(isAnalyticsCollectUrl(url), url).toBe(true)
    }
    for (const url of [
      "https://www.googletagmanager.com/gtag/js?id=G-X",
      "https://firebase.googleapis.com/v1alpha/projects/-/apps/1:1:web:1/webConfig",
      "https://firebaseinstallations.googleapis.com/v1/projects/p/installations",
      "https://fcm.googleapis.com/fcm/send/abc",
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
      "https://abc.execute-api.ap-northeast-1.amazonaws.com/live-streams",
      "https://oshiyobi.web.app/sw.js",
      "https://www.google.com/search?q=collect",
    ]) {
      expect(isAnalyticsCollectUrl(url), url).toBe(false)
    }
  })

  base("guards the AWS API host pattern and explicit origins; classifies mutating methods", () => {
    expect(isGuardedApiUrl(`${FAKE_AWS_API}/heartbeat`)).toBe(true)
    expect(isGuardedApiUrl("https://xyz.execute-api.us-east-1.amazonaws.com/clients/1/credential")).toBe(true)
    expect(isGuardedApiUrl("http://127.0.0.1:8787/heartbeat")).toBe(false)
    expect(isGuardedApiUrl("https://oshiyobi.web.app/heartbeat")).toBe(false)
    expect(isGuardedApiUrl("https://api.example.test/x", ["https://api.example.test"])).toBe(true)
    expect(apiOriginsFromEnv({ YOBI_GUARD_API_ORIGINS: " https://a.test/path , https://b.test " })).toEqual(["https://a.test", "https://b.test"])
    expect(apiOriginsFromEnv({})).toEqual([])
    for (const method of ["GET", "HEAD", "OPTIONS", "get"]) expect(isMutatingMethod(method), method).toBe(false)
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "post"]) expect(isMutatingMethod(method), method).toBe(true)
  })
})

base.describe("automation guard: GA4 collection", () => {
  base("every GA transport is answered locally and counted", async ({ browser }) => {
    const { context, page, guard } = await newGuardedPage(browser)
    await fireAllGaTransports(page)
    // 4 collect URLs x (fetch + XHR + beacon + image)
    expect(guard.analytics.length).toBe(16)
    expect(new Set(guard.analytics.map((url) => new URL(url).hostname))).toEqual(new Set(["www.google-analytics.com", "region1.google-analytics.com", "analytics.google.com", "www.google.com"]))
    await context.close()
  })

  base("the launch-args backstop alone makes the GA hosts unresolvable (no route installed)", async ({ browser }) => {
    const context = await browser.newContext()
    const page = await context.newPage()
    await page.goto(local.appOrigin)
    const outcome = await page.evaluate(async (url) => fetch(url, { mode: "no-cors" }).then(() => "reached", () => "failed"), GA_COLLECT)
    expect(outcome).toBe("failed")
    await context.close()
  })
})

base.describe("automation guard: AWS API writes", () => {
  base("blocks client registration, heartbeat and preference/subscription/reminder writes; reads still reach the API", async ({ browser }) => {
    const { context, page, guard } = await newGuardedPage(browser, [local.apiOrigin])
    const call = (method: string, pathName: string) =>
      page.evaluate(
        async ({ url, method }) => {
          const response = await fetch(url, { method, headers: { "content-type": "application/json" }, body: method === "GET" ? undefined : "{}" })
          return { status: response.status, body: await response.json() }
        },
        { url: `${local.apiOrigin}${pathName}`, method },
      )

    const writes: Array<[string, string]> = [
      ["POST", "/clients/c1/credential"],
      ["POST", "/heartbeat"],
      ["PUT", "/clients/c1/notification-preference"],
      ["PUT", "/clients/c1/push-subscription"],
      ["DELETE", "/clients/c1/push-subscription"],
      ["PUT", "/clients/c1/creator-reminder/aizawa-ema/all"],
      ["DELETE", "/clients/c1/stream-notification-override/vid1"],
      ["PATCH", "/anything"],
    ]
    for (const [method, pathName] of writes) {
      const result = await call(method, pathName)
      expect(result, `${method} ${pathName}`).toEqual({ status: 403, body: { error: "Blocked by the test automation guard", code: "automation_guard_blocked" } })
    }
    expect(local.apiHits).toEqual([]) // nothing mutating ever reached the API
    expect(guard.apiWrites).toEqual(writes.map(([method, pathName]) => ({ method, path: pathName })))

    const read = await call("GET", "/remote-config?clientId=c1")
    expect(read).toEqual({ status: 200, body: { ok: true } })
    expect(local.apiHits).toEqual(["GET /remote-config?clientId=c1"])
    await context.close()
  })

  base("blocks writes to the AWS execute-api host pattern with no explicit origin, and leaves other POSTs alone", async ({ browser }) => {
    const { context, page, guard } = await newGuardedPage(browser)
    const blocked = await page.evaluate(async (url) => {
      const response = await fetch(url, { method: "POST", body: "{}" })
      return { status: response.status, header: response.headers.get("x-automation-guard") }
    }, `${FAKE_AWS_API}/heartbeat`)
    expect(blocked).toEqual({ status: 403, header: "blocked" })
    expect(guard.apiWrites).toEqual([{ method: "POST", path: "/heartbeat" }])

    const unrelated = await page.evaluate(async (url) => (await fetch(url, { method: "POST", body: "{}" })).status, `${local.appOrigin}/echo`)
    expect(unrelated).toBe(200)
    expect(local.appPosts).toEqual(["/echo"])
    await context.close()
  })
})

base.describe("automation guard: site functionality, Service Worker, Web Push and browser identity are untouched", () => {
  /** Exercises storage/identity/Service Worker/Push surfaces and returns what a page would observe. */
  async function probe(page: Page) {
    const first = await page.evaluate(async () => {
      localStorage.setItem("probe", "1")
      document.cookie = "probe=1; path=/; max-age=60"
      const idb = await new Promise<boolean>((resolve, reject) => {
        const request = indexedDB.open("probe", 1)
        request.onsuccess = () => resolve(true)
        request.onerror = () => reject(request.error)
      })
      const registration = await navigator.serviceWorker.register("/sw.js")
      await navigator.serviceWorker.ready
      return { idb, scope: registration.scope.replace(location.origin, ""), pushManager: "PushManager" in window, notification: typeof Notification }
    })
    await page.reload()
    const after = await page.evaluate(async () => ({
      localStorage: localStorage.getItem("probe"),
      cookie: document.cookie.includes("probe=1"),
      controlled: (await navigator.serviceWorker.getRegistration())?.active?.state ?? null,
    }))
    return { ...first, ...after }
  }

  base("a guarded context behaves exactly like an unguarded one", async ({ browser }) => {
    const plain = await browser.newContext()
    const plainPage = await plain.newPage()
    await plainPage.goto(local.appOrigin)
    const unguarded = await probe(plainPage)
    await plain.close()

    const { context, page, guard } = await newGuardedPage(browser, [local.apiOrigin])
    const guarded = await probe(page)
    await context.close()

    expect(guarded).toEqual(unguarded)
    expect(guarded).toMatchObject({ idb: true, scope: "/", pushManager: true, localStorage: "1", cookie: true, controlled: "activated" })
    expect(guard).toEqual({ analytics: [], apiWrites: [] }) // none of the above was treated as analytics or an API write
  })
})

base.describe("automation guard: ad-hoc script helpers", () => {
  base("launchGuarded installs the guard before any page exists", async () => {
    const { browser, context, guard } = await launchGuarded(chromium, { apiOrigins: [local.apiOrigin] })
    try {
      const page = await context.newPage()
      await page.goto(local.appOrigin)
      await fireAllGaTransports(page)
      const status = await page.evaluate(async (url) => (await fetch(url, { method: "POST", body: "{}" })).status, `${local.apiOrigin}/heartbeat`)
      expect(status).toBe(403)
      expect(guard.analytics.length).toBe(16)
      expect(local.apiHits).toEqual([])
    } finally {
      await browser.close()
    }
  })

  base("launchGuardedPersistent guards a persistent profile (headless Chromium)", async () => {
    const profile = mkdtempSync(path.join(tmpdir(), "yobi-guard-profile-"))
    const { context, guard } = await launchGuardedPersistent(chromium, profile, { launchOptions: { headless: true }, apiOrigins: [local.apiOrigin] })
    try {
      const page = await context.newPage()
      await page.goto(local.appOrigin)
      await fireAllGaTransports(page)
      const status = await page.evaluate(async (url) => (await fetch(url, { method: "PUT", body: "{}" })).status, `${local.apiOrigin}/clients/c1/notification-preference`)
      expect(status).toBe(403)
      expect(guard.analytics.length).toBe(16)
      expect(local.apiHits).toEqual([])
    } finally {
      await context.close()
      rmSync(profile, { recursive: true, force: true })
    }
  })

  const chromePath = "C:/Program Files/Google/Chrome/Application/chrome.exe"
  base("launchGuardedPersistent also guards real Chrome (channel: chrome), the CDP replacement for Web Push work", async () => {
    base.skip(!existsSync(chromePath), "Google Chrome is not installed at the default Windows path")
    const profile = mkdtempSync(path.join(tmpdir(), "yobi-guard-chrome-"))
    const { context, guard } = await launchGuardedPersistent(chromium, profile, { launchOptions: { channel: "chrome", headless: true }, apiOrigins: [local.apiOrigin] })
    try {
      const page = await context.newPage()
      await page.goto(local.appOrigin)
      await fireAllGaTransports(page)
      const status = await page.evaluate(async (url) => (await fetch(url, { method: "POST", body: "{}" })).status, `${local.apiOrigin}/heartbeat`)
      expect(status).toBe(403)
      expect(guard.analytics.length).toBe(16)
      expect(local.apiHits).toEqual([])
    } finally {
      await context.close()
      rmSync(profile, { recursive: true, force: true })
    }
  })

  base("the default launch args resolve to the documented backstop", () => {
    expect(ANALYTICS_LAUNCH_ARGS).toHaveLength(1)
    expect(ANALYTICS_LAUNCH_ARGS[0]).toContain("--host-resolver-rules=")
    expect(ANALYTICS_LAUNCH_ARGS[0]).not.toMatch(/googleapis|gstatic|googletagmanager|fcm|amazonaws/)
  })
})

smokeTest.describe("automation guard: smoke suite helper", () => {
  smokeTest("the smoke suite's own test fixture also answers GA collection locally", async ({ page, analyticsGuard }) => {
    await page.goto(local.appOrigin)
    await fireAllGaTransports(page)
    expect(analyticsGuard.analytics.length).toBe(16)
  })
})
