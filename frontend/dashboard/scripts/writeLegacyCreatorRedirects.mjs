// Writes firebase.json's legacy creator redirects from src/app/seo/legacyCreatorRoutes.json: one exact 301 per retired /creator/<slug> page to the
// root Home naming that creator (/?creator=<creatorId>). Firebase Hosting appends the request's own query string to the destination, so a
// notification's ?video=<id> survives as /?creator=<creatorId>&video=<id>. Only the "redirects" array is rewritten; the rest of the file is kept
// byte for byte. Usage: node scripts/writeLegacyCreatorRedirects.mjs  (hosting.test.ts fails if firebase.json and the JSON list disagree).
import { readFileSync, writeFileSync } from "node:fs"

const { routes } = JSON.parse(readFileSync(new URL("../src/app/seo/legacyCreatorRoutes.json", import.meta.url), "utf8"))
const path = new URL("../firebase.json", import.meta.url)
const config = readFileSync(path, "utf8")
const rules = [
  '      { "source": "/index.html", "destination": "/", "type": 301 }',
  ...routes.map(({ slug, creatorId }) => `      { "source": "/creator/${slug}", "destination": "/?creator=${creatorId}", "type": 301 }`),
]
const block = /("redirects": \[)[\s\S]*?(\n    \])/
if (!block.test(config)) throw new Error("firebase.json: redirects array not found")
writeFileSync(path, config.replace(block, (_, open, close) => `${open}\n${rules.join(",\n")}${close}`))
console.log(`firebase.json: ${rules.length} redirects (1 + ${routes.length} legacy creator routes)`)
