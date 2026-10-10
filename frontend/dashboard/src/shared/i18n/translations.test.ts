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

  it("returns the localized Save-topic-card button label for every locale", () => {
    expect(t("zh-TW", "notificationSettings.saveTopicButton")).toBe("儲存")
    expect(t("en", "notificationSettings.saveTopicButton")).toBe("Save")
    expect(t("ja", "notificationSettings.saveTopicButton")).toBe("保存")
  })

  it("returns the localized notification toggle labels for every locale", () => {
    expect(t("en", "notificationToggle.enable")).toBe("Enable notifications")
    expect(t("zh-TW", "notificationToggle.enable")).toBe("開啟通知")
    expect(t("ja", "notificationToggle.enable")).toBe("通知をオンにする")

    expect(t("en", "notificationToggle.on")).toBe("Notifications on")
    expect(t("zh-TW", "notificationToggle.on")).toBe("通知已開啟")
    expect(t("ja", "notificationToggle.on")).toBe("通知オン")

    expect(t("en", "notificationToggle.unavailable")).toBe("Notifications unavailable")
    expect(t("zh-TW", "notificationToggle.unavailable")).toBe("無法使用通知")
    expect(t("ja", "notificationToggle.unavailable")).toBe("通知は利用できません")
  })

  it("translates the upcoming-stream countdown option for zh-TW and ja (it was left in English for zh-TW)", () => {
    expect(t("zh-TW", "displaySettings.upcomingCountdownOption")).toBe("倒數計時")
    expect(t("ja", "displaySettings.upcomingCountdownOption")).toBe("カウントダウン")
    expect(t("en", "displaySettings.upcomingCountdownOption")).toBe("Countdown")
  })
})
