import hongKongFlag from "../../../assets/flags/hk.svg"
import unitedKingdomFlag from "../../../assets/flags/gb.svg"
import japanFlag from "../../../assets/flags/jp.svg"
import type { Locale } from "../translations"

/** The picker's flags: the standard 4:3 flag artwork from the flag-icons set (src/assets/flags, MIT, copied unmodified), all from that one
 * source so the three read as one style. Static images rather than Unicode flag emoji, which Windows renders as bare letters. */
const FLAGS: Record<Locale, { flag: "hk" | "gb" | "jp"; src: string }> = {
  "zh-TW": { flag: "hk", src: hongKongFlag },
  en: { flag: "gb", src: unitedKingdomFlag },
  ja: { flag: "jp", src: japanFlag },
}

/** The picker flag for a locale: Hong Kong for Traditional Chinese, the United Kingdom for English, Japan for Japanese. */
export function LanguageFlagIcon({ locale }: { locale: Locale }) {
  const { flag, src } = FLAGS[locale]
  return <img className="language-flag-icon" data-flag={flag} src={src} alt="" width={20} height={15} draggable={false} aria-hidden="true" />
}
