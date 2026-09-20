import { createBackendComparisonSource } from "./backendComparisonSource"
import { MOCK_REPORT_DATE } from "../../../analytics/utils/dashboardAnalyticsSource"
import { detectDeviceTimeZone } from "../../../../shared/i18n/timezone"
import type { ComparisonSource } from "./dashboardComparisonSource"

/** The comparison source the production Dashboard uses when none is injected:
 * the real backend. It evaluates at the Dashboard's own report date (the same
 * `MOCK_REPORT_DATE` constant the live analytics request already uses) and the
 * device time zone. */
export const defaultComparisonSource: ComparisonSource = createBackendComparisonSource(() => ({
  reportDate: MOCK_REPORT_DATE,
  timeZone: detectDeviceTimeZone(),
}))
