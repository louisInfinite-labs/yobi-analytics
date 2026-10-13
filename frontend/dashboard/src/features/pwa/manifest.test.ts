import { existsSync, readFileSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const root = resolve(__dirname, "../../..")
const publicDir = resolve(root, "public")
const manifest = JSON.parse(readFileSync(resolve(publicDir, "manifest.webmanifest"), "utf-8"))
const html = readFileSync(resolve(root, "index.html"), "utf-8")

describe("web app manifest", () => {
  it("names the app OshiYobi and launches it as a standalone app at the site root", () => {
    expect(manifest).toMatchObject({ name: "OshiYobi", short_name: "OshiYobi", start_url: "/", scope: "/", display: "standalone" })
  })

  it("uses the app's own existing colors (page background / navbar), as valid hex colors", () => {
    expect(manifest.background_color).toBe("#f7f6f8") // --surface-bg
    expect(manifest.theme_color).toBe("#242424") // the main navbar's own background
  })

  it("declares 192 and 512 icons plus a maskable 512, and every icon file exists", () => {
    const bySize = (size: string, purpose: string) => manifest.icons.find((icon: { sizes: string; purpose: string }) => icon.sizes === size && icon.purpose === purpose)
    expect(bySize("192x192", "any")).toBeTruthy()
    expect(bySize("512x512", "any")).toBeTruthy()
    expect(bySize("512x512", "maskable")).toBeTruthy()
    for (const icon of manifest.icons) {
      expect(icon.type).toBe("image/png")
      expect(existsSync(resolve(publicDir, icon.src.replace(/^\//, ""))), icon.src).toBe(true)
    }
  })

  it("keeps the start URL inside the scope", () => {
    expect(manifest.start_url.startsWith(manifest.scope)).toBe(true)
  })
})

describe("index.html PWA metadata", () => {
  it("links the manifest, the theme color, the apple-touch-icon and the favicon", () => {
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />')
    expect(html).toContain('<meta name="theme-color" content="#242424" />')
    expect(html).toContain('<link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon.png" />')
    expect(html).toMatch(/<link rel="icon" [^>]*href="\/icons\/icon-192\.png"/)
    expect(existsSync(resolve(publicDir, "icons/apple-touch-icon.png"))).toBe(true)
  })

  it("has the iOS Home Screen metadata", () => {
    expect(html).toContain('<meta name="apple-mobile-web-app-capable" content="yes" />')
    expect(html).toContain('<meta name="apple-mobile-web-app-title" content="OshiYobi" />')
    expect(html).toContain('<meta name="mobile-web-app-capable" content="yes" />')
    expect(html).toContain('<meta name="apple-mobile-web-app-status-bar-style" content="default" />')
  })

  it("keeps zoom and accessibility scaling: the viewport meta does not disable user scaling", () => {
    const viewport = html.match(/<meta name="viewport" content="([^"]*)"/)?.[1] ?? ""
    expect(viewport).toContain("width=device-width")
    expect(viewport).not.toMatch(/user-scalable\s*=\s*(no|0)/)
    expect(viewport).not.toMatch(/maximum-scale/)
  })

  it("does not use viewport-fit=cover, so no safe-area padding is needed anywhere", () => {
    expect(html).not.toContain("viewport-fit")
  })
})

describe("service worker files", () => {
  it("there is exactly ONE service worker script, public/sw.js (no second competing worker, no Firebase messaging worker)", () => {
    const files = readdirSync(publicDir)
    expect(files.filter((name) => /sw|service-?worker|firebase-messaging/i.test(name))).toEqual(["sw.js"])
  })

  it("sw.js caches nothing and has no fetch handler (a live-data product must never answer from a stale copy)", () => {
    const source = readFileSync(resolve(publicDir, "sw.js"), "utf-8")
    expect(source).not.toMatch(/addEventListener\(\s*["']fetch["']/)
    expect(source).not.toMatch(/\bcaches\./)
    expect(source).not.toMatch(/firebase/i)
  })
})
