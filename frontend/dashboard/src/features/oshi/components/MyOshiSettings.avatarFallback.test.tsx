import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { CanonicalCreator } from "../../../entities/creator/model/creatorMaster"

// Proves canonical avatarUrl rendering AND the nullable-avatar fallback
// (schema stays nullable regardless of current 118/118 production coverage,
// C7B) against a small synthetic roster -- mocking getCreators alone, same
// convention as notifications/model/notificationCreatorGrouping.test.ts and
// useDefaultOshiCreator.syntheticOrdering.test.ts.
const { FIXTURE_CREATORS } = vi.hoisted(() => {
  function fixture(creatorId: string, displayOrder: number, overrides: Record<string, unknown> = {}) {
    return {
      creatorId,
      displayName: creatorId,
      avatarUrl: null,
      organization: "vspo",
      branch: "vspo_jp",
      groupKey: ["NO"],
      channelType: "member",
      themeColor: null,
      lifecycleStage: "active",
      displayOrder,
      active: true,
      youtubeChannelId: `UC_${creatorId}`,
      ...overrides,
    }
  }
  return {
    FIXTURE_CREATORS: [
      fixture("fixture_with_avatar", 0, { avatarUrl: "https://example.com/avatar.jpg" }),
      fixture("fixture_without_avatar", 1, { avatarUrl: null }),
    ],
  }
})

vi.mock("../../../entities/creator/data/creatorRegistry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../entities/creator/data/creatorRegistry")>()
  return {
    ...actual,
    getCreators: (): readonly CanonicalCreator[] => FIXTURE_CREATORS as unknown as CanonicalCreator[],
  }
})

vi.mock("../../../shared/i18n/hooks/useLocale", () => ({ useLocale: () => ["en"] }))

const { MyOshiSettings } = await import("./MyOshiSettings")
const { MemberThemeProvider } = await import("../../../shared/theme/MemberThemeProvider")

function renderMyOshiSettings() {
  return render(
    <MemberThemeProvider>
      <MyOshiSettings />
    </MemberThemeProvider>,
  )
}

describe("MyOshiSettings avatar rendering", () => {
  it("renders the canonical avatarUrl as the creator's image", () => {
    renderMyOshiSettings()
    const images = screen.getAllByRole("img", { name: "fixture_with_avatar" })
    expect(images.length).toBeGreaterThan(0)
    for (const image of images) {
      expect(image).toHaveAttribute("src", "https://example.com/avatar.jpg")
    }
  })

  it("falls back to the initial-letter placeholder when avatarUrl is null", () => {
    renderMyOshiSettings()
    expect(screen.queryByRole("img", { name: "fixture_without_avatar" })).not.toBeInTheDocument()
    // antd Avatar renders its children (the initial letter) when src is unset.
    expect(screen.getAllByText("f").length).toBeGreaterThan(0)
  })
})
