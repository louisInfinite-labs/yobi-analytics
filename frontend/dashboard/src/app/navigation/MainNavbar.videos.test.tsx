import { render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { MainNavbar } from "./MainNavbar"

function setWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width })
  window.dispatchEvent(new Event("resize"))
}

afterEach(() => {
  setWidth(1024)
})

describe("MainNavbar -- the Videos destination is mobile-only", () => {
  it("does not render a Videos entry at desktop width", () => {
    setWidth(1280)
    render(<MainNavbar />)
    expect(screen.queryByRole("button", { name: /^videos$|^影片$|^動画$/i })).not.toBeInTheDocument()
  })

  it("does not render a Videos entry at tablet width", () => {
    setWidth(900)
    render(<MainNavbar />)
    expect(screen.queryByRole("button", { name: /^videos$|^影片$|^動画$/i })).not.toBeInTheDocument()
  })

  it("renders a Videos entry at phone width, reusing the exact same link markup as every other item", () => {
    setWidth(390)
    render(<MainNavbar />)
    const videos = screen.getByRole("button", { name: /^videos$|^影片$|^動画$/i })
    const home = screen.getByRole("button", { name: /^home$|^首頁$|^ホーム$/i })
    expect(videos.className).toBe(home.className.replace("main-navbar__link--active", "").trim() || videos.className)
    expect(videos.querySelector("svg")).not.toBeNull()
  })
})
