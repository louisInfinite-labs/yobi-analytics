import { fireEvent, render } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { CreatorAvatarImage } from "./CreatorAvatarImage"

const URL_A = "https://yt3.ggpht.com/a=s800-c-k-c0x00ffffff-no-rj"
const URL_B = "https://yt3.ggpht.com/b=s800-c-k-c0x00ffffff-no-rj"

const frame = (container: HTMLElement) => container.querySelector(".frame") as HTMLElement

describe("CreatorAvatarImage", () => {
  it("renders the backend channel icon, decorative, and no initial text, when a url exists", () => {
    const { container } = render(<CreatorAvatarImage avatarUrl={URL_A} displayName="藍沢エマ" className="frame" />)

    const img = frame(container).querySelector("img")!
    expect(img).toHaveAttribute("src", URL_A)
    expect(img).toHaveAttribute("alt", "")
    expect(frame(container)).toHaveAttribute("aria-hidden", "true")
    expect(frame(container)).not.toHaveTextContent("藍")
  })

  it.each([null, undefined, ""])("falls back to the initial when the url is %s (no <img>, no broken image)", (avatarUrl) => {
    const { container } = render(<CreatorAvatarImage avatarUrl={avatarUrl} displayName="  藍沢エマ" className="frame" />)

    expect(frame(container).querySelector("img")).toBeNull()
    expect(frame(container)).toHaveTextContent("藍")
  })

  it("falls back to the initial when the image fails to load, and tries a different url again", () => {
    const { container, rerender } = render(<CreatorAvatarImage avatarUrl={URL_A} displayName="Pekora" className="frame" />)

    fireEvent.error(frame(container).querySelector("img")!)
    expect(frame(container).querySelector("img")).toBeNull()
    expect(frame(container)).toHaveTextContent("P")

    rerender(<CreatorAvatarImage avatarUrl={URL_B} displayName="Marine" className="frame" />)
    expect(frame(container).querySelector("img")).toHaveAttribute("src", URL_B)
  })
})
