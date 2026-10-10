import { useMemo } from "react"
import { useLocale } from "../../../shared/i18n/hooks/useLocale"
import { fetchVideoTopics } from "../../home-room/data/videoTopics"
import { useVideoTopicCatalog } from "../../home-room/hooks/useVideoTopicCatalog"
import { buildVideoFilterEntries, type VideoFilterEntry } from "../../home-room/model/videoFilterCatalog"

/** The categories the push-notification settings can add as a card: exactly Home's list (GET /topics in the backend's order, with Short
 * immediately before Other), in the current locale. While GET /topics has not succeeded only Short is known -- never a hardcoded topic list. */
export function useNotificationTopicCatalog(): { entries: readonly VideoFilterEntry[]; isLoaded: boolean } {
  const [locale] = useLocale()
  const { state } = useVideoTopicCatalog(fetchVideoTopics)
  const entries = useMemo(() => buildVideoFilterEntries(state.status === "success" ? state.topics : null, locale), [state, locale])
  return { entries, isLoaded: state.status === "success" }
}
