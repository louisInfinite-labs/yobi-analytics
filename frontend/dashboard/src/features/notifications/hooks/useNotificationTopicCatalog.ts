import { useMemo } from "react"
import { useLocale } from "../../../shared/i18n/hooks/useLocale"
import { fetchVideoTopics } from "../../home-room/data/videoTopics"
import { useVideoTopicCatalog } from "../../home-room/hooks/useVideoTopicCatalog"
import type { VideoFilterEntry } from "../../home-room/model/videoFilterCatalog"
import { buildNotificationTopicEntries } from "../model/notificationTopicCatalog"

/** The categories the push-notification settings can add as a card: the fixed notification list (NOTIFICATION_TOPIC_IDS -- 雜談, 歌回, MV, Apex,
 * Minecraft, SF6, VALO, Short, 其他, plus the permanent 全部 card), labelled from GET /topics in the current locale. While GET /topics has not
 * succeeded only Short is known -- never a hardcoded topic list. */
export function useNotificationTopicCatalog(): { entries: readonly VideoFilterEntry[]; isLoaded: boolean } {
  const [locale] = useLocale()
  const { state } = useVideoTopicCatalog(fetchVideoTopics)
  const entries = useMemo(() => buildNotificationTopicEntries(state.status === "success" ? state.topics : null, locale), [state, locale])
  return { entries, isLoaded: state.status === "success" }
}
