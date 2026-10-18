import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { describe, expect, it, vi } from "vitest"

/** The safety net in src/test/setup.ts: a unit test cannot reach a real server even when .env.local points the API at production. */
describe("test network guard", () => {
  it("rejects a request to any remote host, including the production-style API URL", async () => {
    await expect(fetch("https://api.example.com/milestones")).rejects.toThrow(/blocked in tests/)
    await expect(fetch(new URL("https://abc123.execute-api.ap-northeast-1.amazonaws.com/milestones"))).rejects.toThrow(/blocked in tests/)
    await expect(fetch(new Request("https://api.example.com/x"))).rejects.toThrow(/blocked in tests/)
  })

  it("rejects the API request function too when VITE_API_BASE_URL is set to a remote host, as .env.local would", async () => {
    vi.stubEnv("VITE_API_BASE_URL", "https://abc123.execute-api.ap-northeast-1.amazonaws.com")
    try {
      const { apiRequest } = await import("../shared/api/apiClient")
      await expect(apiRequest("/milestones")).rejects.toThrow(/Real network access is blocked in tests/)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("a test that stubs fetch gets its own response, and the guard comes back afterwards", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}")))
    await expect(fetch("https://api.example.com/anything")).resolves.toBeInstanceOf(Response)
    vi.unstubAllGlobals()
    await expect(fetch("https://api.example.com/anything")).rejects.toThrow(/blocked in tests/)
  })

  it("lets a request to the local machine through to the real fetch (a localhost dev mock stays reachable)", async () => {
    // Port 9 (discard) is closed: the call is attempted for real and fails with a connection error, NOT with the guard message.
    const result = await fetch("http://127.0.0.1:9/ping").then(
      () => "answered",
      (error: Error) => error.message,
    )
    expect(result).not.toMatch(/blocked in tests/)
  })

  it("never follows a redirect from an allowed local request on to a remote host", async () => {
    const hits: string[] = []
    const server = createServer((request, response) => {
      hits.push(request.url ?? "")
      response.writeHead(302, { Location: "https://api.example.com/stolen" })
      response.end()
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
    try {
      const { port } = server.address() as AddressInfo
      await expect(fetch(`http://127.0.0.1:${port}/start`)).rejects.toThrow()
      // Only the local request was ever made: the redirect target was not requested (and nothing was returned to the caller).
      expect(hits).toEqual(["/start"])
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})