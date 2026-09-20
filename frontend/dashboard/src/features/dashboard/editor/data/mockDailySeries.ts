export interface DailySeriesPoint {
  date: string
  totalViews: number
  dailyIncrease: number
}

// A 14-day trailing series ending on MOCK_REPORT_DATE, for the default
// GrowthBarChart view. Deliberately not derived from mockVideoStats (which
// only carries one day's snapshot per video) — a real 14-day history would
// come from the Read API's stored snapshots.
export const mockDailySeries: DailySeriesPoint[] = [
  { date: "2026-08-21", totalViews: 18_420_000, dailyIncrease: 612_000 },
  { date: "2026-08-22", totalViews: 19_050_000, dailyIncrease: 630_000 },
  { date: "2026-08-23", totalViews: 19_610_000, dailyIncrease: 560_000 },
  { date: "2026-08-24", totalViews: 20_040_000, dailyIncrease: 430_000 },
  { date: "2026-08-25", totalViews: 20_710_000, dailyIncrease: 670_000 },
  { date: "2026-08-26", totalViews: 21_260_000, dailyIncrease: 550_000 },
  { date: "2026-08-27", totalViews: 21_990_000, dailyIncrease: 730_000 },
  { date: "2026-08-28", totalViews: 22_540_000, dailyIncrease: 550_000 },
  { date: "2026-08-29", totalViews: 23_310_000, dailyIncrease: 770_000 },
  { date: "2026-08-30", totalViews: 24_120_000, dailyIncrease: 810_000 },
  { date: "2026-08-31", totalViews: 24_690_000, dailyIncrease: 570_000 },
  { date: "2026-09-01", totalViews: 25_610_000, dailyIncrease: 920_000 },
  { date: "2026-09-02", totalViews: 26_340_000, dailyIncrease: 730_000 },
  { date: "2026-09-03", totalViews: 27_600_000, dailyIncrease: 1_260_000 },
]
