import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { VideoDeepLinkDialog } from "./VideoDeepLinkDialog"
import type { VideoDeepLinkDialogKind } from "./useVideoDeepLink"
import { t, type Locale } from "../../shared/i18n/translations"

const current = vi.hoisted(() => ({ locale: "ja" as "ja" | "zh-TW" | "en" }))
vi.mock("../../shared/i18n/hooks/useLocale", () => ({ useLocale: () => [current.locale, vi.fn()] }))

beforeEach(() => {
  current.locale = "ja"
})

const show = (kind: VideoDeepLinkDialogKind) => {
  const onRetry = vi.fn()
  const onClose = vi.fn()
  const view = render(<VideoDeepLinkDialog kind={kind} onRetry={onRetry} onClose={onClose} />)
  return { onRetry, onClose, unmount: view.unmount }
}

describe("the video deep-link dialog", () => {
  it("members-only, private/deleted, generic-unavailable and temporary-failure each show their own Japanese message", () => {
    const expected: Array<[VideoDeepLinkDialogKind, string]> = [
      ["members_only", "この動画はメンバー限定に変更されたため、表示できません。"],
      ["private_or_deleted", "この動画は非公開または削除されたため、表示できません。"],
      ["unavailable", "この動画は現在視聴できません。"],
      ["unknown", "動画の状態を確認できませんでした。時間をおいて再度お試しください。"],
    ]
    for (const [kind, message] of expected) {
      const { unmount } = render(<VideoDeepLinkDialog kind={kind} onRetry={vi.fn()} onClose={vi.fn()} />)
      expect(screen.getByRole("dialog")).toHaveTextContent(message)
      unmount()
    }
  })

  it("every message exists in Japanese, Traditional Chinese and English, and the three differ", () => {
    for (const key of ["videoLink.membersOnly", "videoLink.privateOrDeleted", "videoLink.unavailable", "videoLink.unknown", "videoLink.retry", "videoLink.close"] as const) {
      const texts = (["ja", "zh-TW", "en"] as Locale[]).map((locale) => t(locale, key))
      expect(texts.every((text) => text.length > 0), key).toBe(true)
      expect(new Set(texts).size, key).toBe(3)
    }
    current.locale = "en"
    show("private_or_deleted")
    expect(screen.getByRole("dialog")).toHaveTextContent("This video is private or has been deleted and can't be shown.")
  })

  it("a temporary failure has Retry and Close; Retry calls onRetry", () => {
    const { onRetry, onClose } = show("unknown")
    fireEvent.click(screen.getByRole("button", { name: "再試行" }))
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "閉じる" })).toBeInTheDocument()
  })

  it("a confirmed-unavailable video has only Close (no Retry), and Close, Escape and the backdrop all dismiss it", () => {
    for (const dismiss of [
      () => fireEvent.click(screen.getByRole("button", { name: "閉じる" })),
      () => fireEvent.keyDown(document, { key: "Escape" }),
      () => fireEvent.click(document.querySelector(".simple-dialog__backdrop") as Element),
    ]) {
      const { onClose, unmount } = show("private_or_deleted")
      expect(screen.queryByRole("button", { name: "再試行" })).toBeNull()
      dismiss()
      expect(onClose).toHaveBeenCalledTimes(1)
      unmount()
    }
  })
})
