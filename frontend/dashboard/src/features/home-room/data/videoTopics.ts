import { apiRequest } from "../../../shared/api/apiClient"
import type { BackendVideoTopic } from "../model/videoTopicCatalog"

/** The production topic-catalog fetcher: `GET /topics` on the real backend
 * (src/api/dashboard_catalog_api.py), the single source of truth for which
 * backend topics Home's Oshi Videos tag bar may offer -- mirrors
 * features/dashboard/catalog/data/dashboardChartCatalogSource.ts's
 * fetchChartCatalog exactly (same endpoint family, same one-request/one-array
 * shape). Injected into useVideoTopicCatalog exactly like that hook's
 * fetchCatalog, so it doesn't know or care that this is a real endpoint. */
export async function fetchVideoTopics(): Promise<BackendVideoTopic[]> {
  const response = await apiRequest<{ topics: BackendVideoTopic[] }>("/topics")
  return response.topics
}
