import { execFile } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { discoverClosure, extractAssetRefs, planRetention } from "./retainDeployedAssets.mjs"

const run = promisify(execFile)
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "retainDeployedAssets.mjs")

const HTML = `<script type="module" crossorigin src="/assets/index-Dn5AXzsz.js"></script><link rel="stylesheet" crossorigin href="/assets/index-JPQhNxKg.css">`
const MAIN_JS = `import("./index.esm-D4N8y42I.js");m.f=["assets/index-Dn5AXzsz.js","assets/index.esm-Nr9gEvPL.js"];const logo="/assets/brand-icon-DzThQ0nY.png";const x="/icons/icon-192.png"`
const CHUNK_JS = `import{a}from"./index.esm-Nr9gEvPL.js";export{a}`
const CSS = `.a{background:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'/>")}.b{background:url(/assets/bg-Abcdef12.png)}`

describe("extractAssetRefs", () => {
  it("finds hashed names in HTML tags, relative imports, preload maps and string URLs, without directories", () => {
    expect(extractAssetRefs(HTML)).toEqual(["index-Dn5AXzsz.js", "index-JPQhNxKg.css"])
    expect(extractAssetRefs(MAIN_JS)).toEqual(["brand-icon-DzThQ0nY.png", "index-Dn5AXzsz.js", "index.esm-D4N8y42I.js", "index.esm-Nr9gEvPL.js"])
    expect(extractAssetRefs(CSS)).toEqual(["bg-Abcdef12.png"])
  })

  it("keeps a hash that contains '-' or '_' and ignores unhashed public files and data URIs", () => {
    expect(extractAssetRefs('href="/assets/index-BWbxruu-.css" src="/assets/chunk-a_b-x_yZ.js"')).toEqual(["chunk-a_b-x_yZ.js", "index-BWbxruu-.css"])
    expect(extractAssetRefs('"/icons/icon-192.png" "/sw.js" "/manifest.webmanifest" "/favicon.ico"')).toEqual([])
  })
})

describe("discoverClosure", () => {
  const site = {
    "index-Dn5AXzsz.js": { status: 200, type: "application/javascript", body: Buffer.from(MAIN_JS) },
    "index-JPQhNxKg.css": { status: 200, type: "text/css", body: Buffer.from(CSS) },
    "index.esm-D4N8y42I.js": { status: 200, type: "application/javascript", body: Buffer.from(CHUNK_JS) },
    "index.esm-Nr9gEvPL.js": { status: 200, type: "application/javascript", body: Buffer.from("export const a=1") },
    "brand-icon-DzThQ0nY.png": { status: 200, type: "image/png", body: Buffer.from("png") },
    // the live SPA rewrite answers an unknown path with the HTML shell (200): that is NOT a file
    "bg-Abcdef12.png": { status: 200, type: "text/html; charset=utf-8", body: Buffer.from(HTML) },
  }
  const fetchAsset = async (name) => site[name] ?? { status: 404, type: "text/plain", body: Buffer.from("") }

  it("follows the HTML's assets through JS and CSS to every transitive file, and ignores an HTML or 404 answer as a false match", async () => {
    const { files, ignored } = await discoverClosure({ htmlTexts: [HTML], fetchAsset })
    expect([...files.keys()].sort()).toEqual(["brand-icon-DzThQ0nY.png", "index-Dn5AXzsz.js", "index-JPQhNxKg.css", "index.esm-D4N8y42I.js", "index.esm-Nr9gEvPL.js"])
    expect(ignored.map((entry) => entry.name)).toEqual(["bg-Abcdef12.png"])
  })
})

describe("planRetention", () => {
  it("keeps what the new build lacks, leaves identical files alone and flags a same-name conflict", () => {
    const files = new Map([
      ["old.js", Buffer.from("old")],
      ["same.js", Buffer.from("same")],
      ["clash.js", Buffer.from("live bytes")],
    ])
    const distAssets = new Map([
      ["same.js", Buffer.from("same")],
      ["clash.js", Buffer.from("other bytes")],
      ["new.js", Buffer.from("new")],
    ])
    expect(planRetention({ files, distAssets })).toEqual({ present: ["same.js"], copy: ["old.js"], conflict: ["clash.js"] })
  })
})

describe("command line", () => {
  let server
  let base
  let tmp
  beforeAll(async () => {
    const routes = {
      "/assets/index-Dn5AXzsz.js": ["application/javascript", MAIN_JS],
      "/assets/index-JPQhNxKg.css": ["text/css", CSS.replace("url(/assets/bg-Abcdef12.png)", "url(/icons/x.png)")],
      "/assets/index.esm-D4N8y42I.js": ["application/javascript", CHUNK_JS],
      "/assets/index.esm-Nr9gEvPL.js": ["application/javascript", "export const a=1"],
      "/assets/brand-icon-DzThQ0nY.png": ["image/png", "png"],
    }
    server = http.createServer((req, res) => {
      const route = routes[req.url]
      if (route) res.writeHead(200, { "content-type": route[0] }).end(route[1])
      else if (req.url.startsWith("/assets/")) res.writeHead(200, { "content-type": "text/html" }).end(HTML) // SPA fallback
      else res.writeHead(200, { "content-type": "text/html" }).end(HTML)
    })
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    base = `http://127.0.0.1:${server.address().port}`
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "retain-"))
  })
  afterAll(() => {
    server.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  const newDist = (name) => {
    const dist = path.join(tmp, name)
    fs.mkdirSync(path.join(dist, "assets"), { recursive: true })
    fs.writeFileSync(path.join(dist, "index.html"), '<script type="module" src="/assets/index-NEWHASH1.js"></script>')
    fs.writeFileSync(path.join(dist, "assets", "index-NEWHASH1.js"), "new")
    fs.writeFileSync(path.join(dist, "assets", "index.esm-Nr9gEvPL.js"), "export const a=1") // a chunk both releases share
    return dist
  }

  it("--check fails on a bare new build, the run copies exactly the missing old files, and --check then passes", async () => {
    const dist = newDist("a")
    await expect(run("node", [SCRIPT, "--site", base, "--dist", dist, "--check"])).rejects.toMatchObject({ code: 1 })
    const { stdout } = await run("node", [SCRIPT, "--site", base, "--dist", dist])
    expect(stdout).toContain("retained 4 live asset(s)")
    expect(fs.readdirSync(path.join(dist, "assets")).sort()).toEqual([
      "brand-icon-DzThQ0nY.png",
      "index-Dn5AXzsz.js",
      "index-JPQhNxKg.css",
      "index-NEWHASH1.js",
      "index.esm-D4N8y42I.js",
      "index.esm-Nr9gEvPL.js",
    ])
    expect((await run("node", [SCRIPT, "--site", base, "--dist", dist, "--check"])).stdout).toContain("CHECK OK")
  })

  it("is idempotent, and --also carries over an older release's retained files", async () => {
    const dist = newDist("b")
    const older = path.join(tmp, "older")
    fs.mkdirSync(path.join(older, "assets"), { recursive: true })
    fs.writeFileSync(path.join(older, "assets", "index-OLDER123.js"), "older")
    await run("node", [SCRIPT, "--site", base, "--dist", dist, "--also", older])
    const again = await run("node", [SCRIPT, "--site", base, "--dist", dist, "--also", older])
    expect(again.stdout).toContain("retained 0 live asset(s)")
    expect(fs.existsSync(path.join(dist, "assets", "index-OLDER123.js"))).toBe(true)
  })

  it("refuses to overwrite a same-named file that has different bytes", async () => {
    const dist = newDist("c")
    fs.writeFileSync(path.join(dist, "assets", "index-Dn5AXzsz.js"), "not the live bytes")
    await expect(run("node", [SCRIPT, "--site", base, "--dist", dist])).rejects.toMatchObject({ code: 1 })
    expect(fs.readFileSync(path.join(dist, "assets", "index-Dn5AXzsz.js"), "utf8")).toBe("not the live bytes")
  })
})
