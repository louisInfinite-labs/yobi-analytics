import { createSharedState, useSharedState } from "../../state/sharedState"
import type { TimeFormat } from "../model/timeFormat"

const STORAGE_KEY = "yobi.timeFormat"

function readTimeFormat(): TimeFormat {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "12h" ? "12h" : "24h"
  } catch {
    return "24h"
  }
}

const timeFormatStore = createSharedState<TimeFormat>(STORAGE_KEY, readTimeFormat, (value) => value)

/** The one global 24-hour / 12-hour clock preference for displayed times. */
export function useTimeFormat() {
  return useSharedState(timeFormatStore)
}
