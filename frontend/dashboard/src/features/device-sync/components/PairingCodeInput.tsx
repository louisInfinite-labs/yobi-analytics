import { useState } from "react"
import { useLocale } from "../../../shared/i18n/hooks/useLocale"
import { t } from "../../../shared/i18n/translations"

/** A plain label + input + submit, with no panel/card chrome of its own -- deliberately layout-agnostic (no fixed
 * width, no desktop-card padding) so both PcDeviceSync.tsx and MobileDeviceSync.tsx can drop it into their own,
 * genuinely different surrounding layouts without inheriting one platform's spacing. This is the one small piece
 * of UI the spec's own "share business logic, allow platform-specific presentation" note treats as safe to share
 * outright: a code-entry form has no inherent desktop/mobile shape to get wrong. */
export function PairingCodeInput({ onSubmit, pending }: { onSubmit: (code: string) => void; pending: boolean }) {
  const [locale] = useLocale()
  const [value, setValue] = useState("")

  return (
    <form
      className="device-sync-code-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (value.trim()) onSubmit(value.trim())
      }}
    >
      <label className="device-sync-code-label" htmlFor="device-sync-code-input">
        {t(locale, "deviceSync.enterCode")}
      </label>
      <input
        id="device-sync-code-input"
        className="device-sync-code-input"
        type="text"
        inputMode="text"
        autoComplete="off"
        autoCapitalize="characters"
        placeholder="ABCD-EFGH"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <button type="submit" className="device-sync-code-submit" disabled={pending || !value.trim()}>
        {t(locale, "deviceSync.enterCode")}
      </button>
    </form>
  )
}
