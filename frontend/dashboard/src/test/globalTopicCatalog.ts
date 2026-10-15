import type { BackendVideoTopic } from "../features/home-room/model/videoTopicCatalog"

/** Test helper: the real production GLOBAL topic catalog (tests/fixtures/topic_catalog_global.json, 52 topics), shaped as GET /topics returns it.
 * The fs module is imported dynamically (vitest does not process it and the frontend has no Node types). */
export async function loadGlobalCatalog(): Promise<BackendVideoTopic[]> {
  const fs = await import(/* @vite-ignore */ ["node", "fs"].join(":"))
  const { process } = globalThis as unknown as { process: { cwd(): string } }
  const raw = JSON.parse(String(fs.readFileSync(`${process.cwd()}/../../tests/fixtures/topic_catalog_global.json`, "utf8")))
  return (raw.items as Array<Record<string, unknown>>)
    .sort((a, b) => Number(a.display_order) - Number(b.display_order))
    .map((item) => ({
      id: String(item.topic_tag),
      labels: { "zh-TW": String(item.topic_zh), en: String(item.topic_en), ja: String(item.topic_ja) },
      searchAliases: item.search_aliases as string[],
    }))
}
