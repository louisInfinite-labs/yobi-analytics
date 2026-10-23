#!/usr/bin/env node
// Keeps the hashed assets of the CURRENTLY DEPLOYED site alongside a new build, so a browser that still holds the old HTML (production serves it with
// max-age=3600) can finish starting up after the deploy instead of showing a blank page: every release replaces dist/assets, and an old shell asks for
// /assets/index-<oldhash>.js, which the new release no longer has.
//
//   node scripts/retainDeployedAssets.mjs [--dist dist] [--site https://oshiyobi.web.app] [--also <older dist dir>]... [--check]
//
// It reads the live site only (GET requests for static files, no login, no writes to anything but --dist). It starts from the live HTML (the shell is the
// same for every route; several routes are compared), follows every hashed asset reference found in the HTML, JS and CSS until nothing new turns up, and copies
// each live asset that the new build does not already contain into <dist>/assets. A reference that is not on the live site as a real file (an HTML
// response or a 404 is not a file) is ignored as a false match; an asset that IS referenced and cannot be fetched fails the run, because the
// procedure would otherwise silently leave a hole.
//
// --also <dir>   additionally keeps every file of <dir>/assets that the new build lacks (use the previous release's retained dist when two releases are less than
//                an hour apart, so the shell cached by the release before the last one still has its files).
// --check        writes nothing: verifies that <dist> contains the whole closure of the live HTML and that dist/index.html's own references exist. Exit 1 if not.
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { pathToFileURL } from "node:url"

const ASSET_EXT = "js|mjs|css|png|svg|jpe?g|webp|gif|ico|woff2?|ttf|otf|json|map|wasm|mp3|mp4|webm"
/** A Vite output name: "<name>-<8 hash chars>.<ext>", the name part possibly containing dots and hyphens (index.esm-Nr9gEvPL.js, brand-icon-DzThQ0nY.png). */
const HASHED_NAME = new RegExp(`[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8}\\.(?:${ASSET_EXT})(?![A-Za-z0-9_-])`, "g")

/** Every hashed asset file name mentioned anywhere in a text (HTML tag, JS import/preload map/URL string, CSS url()), without its directory. */
export function extractAssetRefs(text) {
  const found = new Set()
  for (const match of text.matchAll(HASHED_NAME)) found.add(match[0].replace(/^\.+/, ""))
  return [...found].sort()
}

const sha = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex")
const isTextAsset = (name) => /\.(?:js|mjs|css|html|json|map)$/.test(name)

/** The live closure: the assets the live HTML needs, directly and through each other. `fetchAsset(name)` returns {status, type, body: Buffer}. */
export async function discoverClosure({ htmlTexts, fetchAsset }) {
  const files = new Map() // name -> Buffer
  const ignored = []
  const queue = htmlTexts.flatMap(extractAssetRefs)
  const seen = new Set(queue)
  while (queue.length > 0) {
    const name = queue.shift()
    const response = await fetchAsset(name)
    const isFile = response.status === 200 && !/text\/html/i.test(response.type ?? "")
    if (!isFile) {
      ignored.push({ name, status: response.status, type: response.type })
      continue
    }
    files.set(name, response.body)
    if (isTextAsset(name)) {
      for (const ref of extractAssetRefs(response.body.toString("utf8"))) {
        if (!seen.has(ref)) {
          seen.add(ref)
          queue.push(ref)
        }
      }
    }
  }
  return { files, ignored }
}

/** What to do with each live asset against the new build's assets directory: already there (same bytes), to copy, or a conflict (same name, other bytes). */
export function planRetention({ files, distAssets }) {
  const plan = { present: [], copy: [], conflict: [] }
  for (const [name, body] of files) {
    const existing = distAssets.get(name)
    if (!existing) plan.copy.push(name)
    else if (sha(existing) === sha(body)) plan.present.push(name)
    else plan.conflict.push(name)
  }
  return plan
}

function readDistAssets(distDir) {
  const dir = path.join(distDir, "assets")
  const map = new Map()
  if (fs.existsSync(dir)) for (const name of fs.readdirSync(dir)) map.set(name, fs.readFileSync(path.join(dir, name)))
  return map
}

function parseArgs(argv) {
  const options = { dist: "dist", site: "https://oshiyobi.web.app", also: [], check: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--dist") options.dist = argv[++i]
    else if (arg === "--site") options.site = argv[++i].replace(/\/+$/, "")
    else if (arg === "--also") options.also.push(argv[++i])
    else if (arg === "--check") options.check = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const get = async (url) => {
    const response = await fetch(url, { headers: { "user-agent": "oshiyobi-retain-assets/1" } })
    return { status: response.status, type: response.headers.get("content-type"), body: Buffer.from(await response.arrayBuffer()) }
  }
  // The live shell: "/" plus a few routes that the live SPA rewrite answers with the same HTML. They must agree, or one of them needs its own handling.
  const routes = ["/", "/index.html", "/schedule", "/about", "/creator/aizawa-ema"]
  const pages = await Promise.all(routes.map(async (route) => ({ route, ...(await get(options.site + route)) })))
  for (const page of pages) if (page.status !== 200) throw new Error(`live ${page.route} answered ${page.status}`)
  const distinct = new Set(pages.map((page) => sha(page.body)))
  if (distinct.size > 1) console.warn(`NOTE: the live routes do not all return the same HTML (${distinct.size} variants); every variant's assets are followed`)
  const htmlTexts = [...new Map(pages.map((page) => [sha(page.body), page.body.toString("utf8")])).values()]

  const { files, ignored } = await discoverClosure({
    htmlTexts,
    fetchAsset: (name) => get(`${options.site}/assets/${name}`),
  })
  const htmlRefs = new Set(htmlTexts.flatMap(extractAssetRefs))
  const missingRoots = [...htmlRefs].filter((name) => !files.has(name))
  if (missingRoots.length > 0) throw new Error(`the live HTML references assets that are not on the live site: ${missingRoots.join(", ")}`)

  const distAssets = readDistAssets(options.dist)
  const plan = planRetention({ files, distAssets })
  const report = { site: options.site, liveAssets: [...files.keys()].sort(), ignoredFalseMatches: ignored.map((entry) => entry.name), ...plan }

  if (options.check) {
    const newHtml = fs.readFileSync(path.join(options.dist, "index.html"), "utf8")
    const newMissing = extractAssetRefs(newHtml).filter((name) => !distAssets.has(name))
    report.newBuildMissing = newMissing
    report.stillMissingFromDist = plan.copy
    console.log(JSON.stringify(report, null, 2))
    if (plan.copy.length > 0 || plan.conflict.length > 0 || newMissing.length > 0) {
      console.error("CHECK FAILED: the build does not contain everything the live shell (or the new shell) needs")
      process.exitCode = 1 // not process.exit(): exiting with fetch sockets still open crashes Node on Windows (0xC0000409)
      return
    }
    console.log("CHECK OK")
    return
  }

  if (plan.conflict.length > 0) throw new Error(`same file name, different bytes (refusing to overwrite): ${plan.conflict.join(", ")}`)
  const assetsDir = path.join(options.dist, "assets")
  fs.mkdirSync(assetsDir, { recursive: true })
  for (const name of plan.copy) fs.writeFileSync(path.join(assetsDir, name), files.get(name))
  const also = []
  for (const dir of options.also) {
    for (const [name, body] of readDistAssets(dir)) {
      if (!fs.existsSync(path.join(assetsDir, name))) {
        fs.writeFileSync(path.join(assetsDir, name), body)
        also.push(name)
      }
    }
  }
  report.alsoCopied = also.sort()
  console.log(JSON.stringify(report, null, 2))
  console.log(`retained ${plan.copy.length} live asset(s) not in the new build, ${plan.present.length} already identical in it, ${also.length} from --also`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(String(error?.message ?? error))
    process.exitCode = 1
  })
}
