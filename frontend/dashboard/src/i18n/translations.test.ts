import { describe, expect, it } from "vitest"
import { t } from "./translations"

describe("t", () => {
  it("substitutes {{creatorName}} in the zh-TW confirm message", () => {
    expect(t("zh-TW", "oshiSwitch.confirmMessage", { creatorName: "藍沢エマ" })).toBe("要將推し切換為「藍沢エマ」嗎？")
  })

  it("substitutes {{creatorName}} in the en confirm message", () => {
    expect(t("en", "oshiSwitch.confirmMessage", { creatorName: "藍沢エマ" })).toBe('Switch your Oshi to "藍沢エマ"?')
  })

  it("substitutes {{creatorName}} in the ja confirm message", () => {
    expect(t("ja", "oshiSwitch.confirmMessage", { creatorName: "藍沢エマ" })).toBe("「藍沢エマ」に推しを切り替えますか？")
  })

  it("returns a key with no placeholders unchanged when no params are given", () => {
    expect(t("en", "common.cancel")).toBe("Cancel")
    expect(t("zh-TW", "common.cancel")).toBe("取消")
    expect(t("ja", "common.cancel")).toBe("キャンセル")
  })

  it("returns the confirmAction/dontAskAgain strings for every locale", () => {
    expect(t("zh-TW", "oshiSwitch.confirmAction")).toBe("切換")
    expect(t("en", "oshiSwitch.confirmAction")).toBe("Switch")
    expect(t("ja", "oshiSwitch.confirmAction")).toBe("切り替える")

    expect(t("zh-TW", "oshiSwitch.dontAskAgain")).toBe("以後不再提示")
    expect(t("en", "oshiSwitch.dontAskAgain")).toBe("Don't ask again")
    expect(t("ja", "oshiSwitch.dontAskAgain")).toBe("今後この確認を表示しない")
  })
})
