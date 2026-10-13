import { afterEach, describe, expect, it } from "vitest"
import { getNotificationPermission, subscribeToPush } from "./pushNotifications"
import { installFakePushDevice } from "../../../test/fakePushDevice"

let fake: ReturnType<typeof installFakePushDevice> | undefined
afterEach(() => {
  fake?.restore()
  fake = undefined
})

describe("getNotificationPermission", () => {
  it("reports the browser's own permission, and 'unsupported' when there is no Notification API", () => {
    expect(getNotificationPermission()).toBe("unsupported")
    fake = installFakePushDevice({ permission: "denied" })
    expect(getNotificationPermission()).toBe("denied")
    fake.device.permission = "granted"
    expect(getNotificationPermission()).toBe("granted")
  })
})

describe("subscribeToPush by permission state", () => {
  it("default: asks the browser for permission, then subscribes", async () => {
    fake = installFakePushDevice({ permission: "default" })

    await expect(subscribeToPush("SGVsbG8")).resolves.toMatchObject({ endpoint: expect.any(String) })

    expect(fake.requestPermission).toHaveBeenCalledTimes(1)
    expect(fake.subscribe).toHaveBeenCalledTimes(1)
  })

  it("granted: skips the prompt entirely and goes straight to the subscription", async () => {
    fake = installFakePushDevice({ permission: "granted" })

    await subscribeToPush("SGVsbG8")

    expect(fake.requestPermission).not.toHaveBeenCalled()
    expect(fake.subscribe).toHaveBeenCalledTimes(1)
  })

  it("denied: is never re-requested (browsers do not reliably re-open the prompt) and creates no subscription", async () => {
    fake = installFakePushDevice({ permission: "denied" })

    await expect(subscribeToPush("SGVsbG8")).resolves.toBeNull()

    expect(fake.requestPermission).not.toHaveBeenCalled()
    expect(fake.subscribe).not.toHaveBeenCalled()
  })

  it("granted with an existing subscription: reuses it, no second subscribe", async () => {
    fake = installFakePushDevice({ permission: "granted", subscribed: true })

    await expect(subscribeToPush("SGVsbG8")).resolves.toMatchObject({ endpoint: "https://fcm.example.com/device-1" })

    expect(fake.subscribe).not.toHaveBeenCalled()
  })

  it("granted with the subscription missing: creates it again", async () => {
    fake = installFakePushDevice({ permission: "granted", subscribed: false })

    await subscribeToPush("SGVsbG8")

    expect(fake.subscribe).toHaveBeenCalledTimes(1)
  })

  it("registers /sw.js through the shared registration (one register call even across two subscribe calls)", async () => {
    fake = installFakePushDevice({ permission: "granted" })

    await subscribeToPush("SGVsbG8")
    await subscribeToPush("SGVsbG8")

    expect(fake.register).toHaveBeenCalledTimes(1)
    expect(fake.register).toHaveBeenCalledWith("/sw.js", expect.objectContaining({ scope: "/" }))
  })
})
