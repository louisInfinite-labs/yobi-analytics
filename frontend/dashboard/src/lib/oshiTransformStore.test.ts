import { describe, expect, it } from "vitest"
import {
  clampScale,
  DEFAULT_OSHI_TRANSFORM,
  readOshiTransform,
  resetOshiTransform,
  writeOshiTransform,
} from "./oshiTransformStore"

describe("oshiTransformStore", () => {
  it("returns the default transform when nothing is saved", () => {
    expect(readOshiTransform("ch_unknown", window.localStorage)).toEqual(DEFAULT_OSHI_TRANSFORM)
  })

  it("round-trips a written transform", () => {
    const transform = { x: 12, y: 88, scale: 1.4 }
    writeOshiTransform("ch_a", transform, window.localStorage)
    expect(readOshiTransform("ch_a", window.localStorage)).toEqual(transform)
  })

  it("keeps each creator's transform independent", () => {
    writeOshiTransform("ch_a", { x: 10, y: 10, scale: 1 }, window.localStorage)
    writeOshiTransform("ch_b", { x: 90, y: 90, scale: 2 }, window.localStorage)
    expect(readOshiTransform("ch_a", window.localStorage).x).toBe(10)
    expect(readOshiTransform("ch_b", window.localStorage).x).toBe(90)
  })

  it("falls back to the default on corrupt stored JSON instead of throwing", () => {
    window.localStorage.setItem("yobi.home.oshiTransform.ch_corrupt", "{not json")
    expect(readOshiTransform("ch_corrupt", window.localStorage)).toEqual(DEFAULT_OSHI_TRANSFORM)
  })

  it("falls back to the default when the stored shape is missing fields", () => {
    window.localStorage.setItem("yobi.home.oshiTransform.ch_partial", JSON.stringify({ x: 1 }))
    expect(readOshiTransform("ch_partial", window.localStorage)).toEqual(DEFAULT_OSHI_TRANSFORM)
  })

  it("clamps an out-of-range stored scale back into bounds on read", () => {
    window.localStorage.setItem("yobi.home.oshiTransform.ch_huge", JSON.stringify({ x: 0, y: 0, scale: 99 }))
    expect(readOshiTransform("ch_huge", window.localStorage).scale).toBe(clampScale(99))
    expect(readOshiTransform("ch_huge", window.localStorage).scale).toBeLessThanOrEqual(2.5)
  })

  it("removes the saved override on reset so the next read falls back to the default", () => {
    writeOshiTransform("ch_reset", { x: 5, y: 5, scale: 1 }, window.localStorage)
    resetOshiTransform("ch_reset", window.localStorage)
    expect(readOshiTransform("ch_reset", window.localStorage)).toEqual(DEFAULT_OSHI_TRANSFORM)
  })
})
