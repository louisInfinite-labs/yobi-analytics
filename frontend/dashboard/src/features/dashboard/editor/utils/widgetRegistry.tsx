import type { ReactNode } from "react"
import type { WidgetDefinition, WidgetTypeId } from "../model/widget"
import { CreatorVideoRankingWidget } from "../../../analytics/charts/CreatorVideoRankingWidget"
import { SubscriberLeaderboardWidget } from "../../../analytics/charts/SubscriberLeaderboardWidget"
import { WIDGET_ALLOWED_HEIGHTS } from "./widgetHeightCapabilities"

/** R9 (org-trending retirement): every widget's data is now fetched by the
 * widget itself (CreatorVideoRankingWidget/SubscriberLeaderboardWidget each
 * own their own request, metric/topic/organization selection, and loading/
 * error/not-ready states) -- the page no longer computes any shared
 * kpis/contributions/filteredStats/insights up front. The only thing a page
 * still needs to compute per widget is which single creator (if any) it's
 * scoped to, from that widget's own `creatorScope.creatorIds[0]`. */
export interface DashboardWidgetData {
  creatorId: string | null
}

interface WidgetRegistryEntry {
  definition: WidgetDefinition
  render: (data: DashboardWidgetData) => ReactNode
}

const SUBSCRIBER_LEADERBOARD: WidgetRegistryEntry = {
  definition: {
    type: "subscriber-leaderboard",
    schemaVersion: 1,
    title: "Subscriber Leaderboard",
    description: "Ranked subscriber totals and growth across VSPO/Hololive.",
    sizeLimits: { minW: 4, minH: 3, defaultW: 8, defaultH: 4 },
    allowedHeights: WIDGET_ALLOWED_HEIGHTS["subscriber-leaderboard"],
    permissions: [],
    supportsCreatorScope: false,
    defaultSettings: {},
  },
  render: () => <SubscriberLeaderboardWidget />,
}

const CREATOR_VIDEO_RANKING: WidgetRegistryEntry = {
  definition: {
    type: "creator-video-ranking",
    schemaVersion: 1,
    title: "Creator Video Ranking",
    description: "One creator's own videos, ranked by views or growth.",
    sizeLimits: { minW: 4, minH: 3, defaultW: 8, defaultH: 4 },
    allowedHeights: WIDGET_ALLOWED_HEIGHTS["creator-video-ranking"],
    permissions: [],
    supportsCreatorScope: true,
    // Phase 3's product invariant: one video-ranking widget = exactly one
    // creator. Never a merged multi-creator ranking.
    maxCreatorScopeCount: 1,
    defaultSettings: {},
  },
  render: ({ creatorId }) => <CreatorVideoRankingWidget creatorId={creatorId} />,
}

export const WIDGET_REGISTRY: Record<WidgetTypeId, WidgetRegistryEntry> = {
  "subscriber-leaderboard": SUBSCRIBER_LEADERBOARD,
  "creator-video-ranking": CREATOR_VIDEO_RANKING,
}

export function getWidgetDefinition(type: WidgetTypeId): WidgetDefinition {
  return WIDGET_REGISTRY[type].definition
}

export function renderWidget(type: WidgetTypeId, data: DashboardWidgetData): ReactNode {
  return WIDGET_REGISTRY[type].render(data)
}

export function supportsCreatorScope(type: string): boolean {
  return isKnownWidgetType(type) && WIDGET_REGISTRY[type].definition.supportsCreatorScope
}

/** The maximum creatorIds this widget type's own creatorScope may ever hold
 * -- Infinity when the type doesn't support creator scope at all (so a
 * caller checking `count > max` never needs a separate supportsCreatorScope
 * branch) or sets no cap of its own. */
export function maxCreatorScopeCount(type: string): number {
  if (!isKnownWidgetType(type)) return 0
  const definition = WIDGET_REGISTRY[type].definition
  if (!definition.supportsCreatorScope) return 0
  return definition.maxCreatorScopeCount ?? Infinity
}

export const ALL_WIDGET_TYPES = Object.keys(WIDGET_REGISTRY) as WidgetTypeId[]

/** Guards a persisted layout's widget.type before it reaches getWidgetDefinition/
 * renderWidget, which index WIDGET_REGISTRY directly and would throw on an
 * unregistered type (e.g. a retired widget from an older layoutVersion). */
export function isKnownWidgetType(type: string): type is WidgetTypeId {
  return Object.hasOwn(WIDGET_REGISTRY, type)
}
