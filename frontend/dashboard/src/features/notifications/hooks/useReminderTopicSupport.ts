import { useCallback, useMemo } from "react"
import { fetchVideoTopics } from "../../home-room/data/videoTopics"
import { useVideoTopicCatalog } from "../../home-room/hooks/useVideoTopicCatalog"
import { ALL_TOPICS_ID, type TopicCatalogId } from "../model/notificationTopicCatalog"

/** The backend's "nothing matched" fallback topic: returned by GET /topics but not a
 * topic a creator + topic reminder can target (such a stream follows 全部 only). */
const OTHER_TOPIC_ID = "other"

/** Whether a topic can have its OWN reminder, decided by the backend's canonical topic
 * list (GET /topics) -- the same machine ids the frontend topics use, so there is no
 * frontend-to-backend mapping. The creator-level 全部 scope is always supported. A topic
 * the backend does not return (a display-only category), or any topic while that list is
 * still loading or failed to load, is NOT supported: its reminder control stays disabled
 * and it follows the creator's 全部 setting. */
export function useReminderTopicSupport(): {
  isReminderTopicSupported: (topicId: TopicCatalogId) => boolean
  /** False only while GET /topics is still loading -- so a caller can avoid flashing a
   * "not supported" message for a topic whose support just hasn't been confirmed yet. */
  isSupportKnown: boolean
} {
  const { state } = useVideoTopicCatalog(fetchVideoTopics)
  const backendTopicIds = useMemo(() => {
    if (state.status !== "success") return new Set<string>()
    return new Set(state.topics.map((topic) => topic.id).filter((id) => id !== OTHER_TOPIC_ID))
  }, [state])

  const isReminderTopicSupported = useCallback(
    (topicId: TopicCatalogId) => topicId === ALL_TOPICS_ID || backendTopicIds.has(topicId),
    [backendTopicIds],
  )
  return { isReminderTopicSupported, isSupportKnown: state.status !== "loading" }
}
