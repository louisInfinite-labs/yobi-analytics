import { DEFAULT_SMOKE_API_BASE_URL } from "../../playwright.smoke.config"

/** The backend base URL this smoke run targets -- the real deployed API when
 * SMOKE_API_BASE_URL is set (see the MD's Preconditions table for why that
 * isn't done automatically from this repo), else this config's own local
 * fixture (scripts/local_api_server.py --enable-smoke-routes). */
export function smokeApiBaseURL(): string {
  return process.env.SMOKE_API_BASE_URL || DEFAULT_SMOKE_API_BASE_URL
}
