/** The API origin for a `<link rel="preconnect">` hint, from the configured `VITE_API_BASE_URL`. Dependency-free on purpose: the Vite config loads it in a
 * Node context (like sitemap.ts and pageSeo.ts). */

/** The origin (scheme + host + port, no path, query, fragment or credentials) of a configured API base URL, or null when there is no usable one: unset,
 * blank, not a URL, or not http(s). A hint for a wrong or unusable address would only waste a connection, so nothing is emitted for those. */
export function apiOriginFromBaseUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return null
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null
  return url.origin
}

/** The one preconnect tag to inject into <head>, or none. `crossorigin` is required: the app reaches the API with CORS fetch(), and a preconnect without it
 * opens a connection the fetch cannot reuse. */
export function apiPreconnectTags(value: unknown): { tag: "link"; attrs: Record<string, string | boolean>; injectTo: "head" }[] {
  const origin = apiOriginFromBaseUrl(value)
  return origin ? [{ tag: "link", attrs: { rel: "preconnect", href: origin, crossorigin: "" }, injectTo: "head" }] : []
}
