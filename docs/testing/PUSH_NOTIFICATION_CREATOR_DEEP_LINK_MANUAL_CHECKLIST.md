# Push notification creator deep link: manual verification checklist

Status: NOT YET RUN. The automated tests (pytest `tests/notifications`, Vitest `serviceWorker.notificationclick.test.ts` and `creatorRouting.test.ts`)
use a fake service-worker scope and a mocked clock; they prove the payload and the click logic, not what a real iPhone, Chrome or Safari does with
`WindowClient.navigate()` / `clients.openWindow()`. Nothing below may be marked verified from those tests.

What changed: every creator-level push (live start, advance 30/10/1 min, late-discovery catch-up, new video) now carries `data.url` =
`/creator/<slug>` (src/notifications/creator_route.py). The service worker (public/sw.js) opens or navigates to that route. The tap only changes the
SESSION creator through the existing `/creator/:slug` routing; the persistent default Oshi (`yobi.defaultOshiCreatorId`) is never written.
The same payload carries `data.image` = the video's YouTube thumbnail (`https://i.ytimg.com/vi/<videoId>/hqdefault.jpg`, derived from the videoId, no API
call); the service worker validates it again and passes it as `showNotification({ image })`.

## Rules for the tester

- Use your OWN device and your OWN subscription only. Never send a test push to another user's subscription.
- Do not edit notification preferences, subscriptions or production data to set this up. Use a notification that is genuinely due, or a
  one-off local/dev push to your own subscription from the existing admin tooling, if you already use it.
- Start each case from the state described; note the result (pass/fail + what you saw), the device, OS/browser version and the date.
- Before the first case, in Settings note your default Oshi. It must be unchanged after every case.

## Cases (run each on iPhone installed PWA, then on Desktop Web)

| # | Start state | Tap on | Expected |
|---|---|---|---|
| 1 | App fully closed (swiped away / browser closed) | Advance reminder for creator A | OshiYobi opens on `/creator/<A>`; A's upcoming stream is the player/visible; no blank page |
| 2 | App fully closed | Live-start reminder for A | Opens on `/creator/<A>`; the live stream is in the main player when available |
| 3 | App fully closed | Late-discovery catch-up reminder for A (the one saying "N minutes left") | Same as case 1 |
| 4 | App fully closed | New-video notification for A | Opens on `/creator/<A>` |
| 5 | App open on Home of the default Oshi B | Advance reminder for A | The EXISTING window moves to `/creator/<A>` (no second window/tab/app instance) |
| 6 | App open on Schedule or Settings | Any reminder for A | Existing window moves to `/creator/<A>`; no duplicate window |
| 7 | App open and already on `/creator/<A>` | Reminder for A | The window is only brought to the front; no reload loop, no duplicate |
| 8 | App open on creator C (not A, not the Oshi) | Reminder for A | Moves to `/creator/<A>`; afterwards Settings still shows the same default Oshi |
| 9 | App closed | Reminder for a stream that has already ended / was cancelled | Opens `/creator/<A>`; Home shows its normal fallback (latest completed or nothing), never a blank player or an error page |
| 10 | After any case above | Close the app completely, reopen from the icon / `oshiyobi.web.app` | Opens on `/`, i.e. the default Oshi (the notified creator was session-only) |
| 11 | Notification sent while the app is in the background (backgrounded, not closed) | Any reminder | Same destination as case 5; the app comes to the foreground |
| 12 | Tap the same notification type twice in a row | Reminder for A | Still exactly one window |

### Thumbnail image cases (`data.image` -> `showNotification({ image })`)

| # | Device | Expected |
|---|---|---|
| 13 | Android Chrome (browser tab and installed PWA) | The notification shows the video's thumbnail as a large picture (expand the notification if collapsed), for advance, start, catch-up and new-video notifications |
| 14 | Desktop Chrome / Edge (Windows, macOS) | Thumbnail shown where the OS notification UI supports big images; if it is not shown, the notification still appears normally |
| 15 | iPhone installed PWA | Normal notification with title/body and the app icon; NO picture is expected (iOS web push does not support `image`) and nothing breaks |
| 16 | Any device, thumbnail unreachable (go offline right before the tap-time image load, or use a stream whose thumbnail 404s) | The notification is still delivered and still deep links correctly, just without the picture |

Which size appears: HQ (`hqdefault.jpg`, 480x360) by default; `maxresdefault.jpg` (1280x720) only for a new-video event that carries a stored Video Master
thumbnail confirming Maxres (the discovery event writer stores `thumbnailUrl` only after the collector Lambda is redeployed with this change, and only for videos
discovered afterwards; older events and every live-stream reminder show HQ). Note the size you see.

Record the exact result per device; a missing picture on iOS or on a desktop that cannot render it is expected, not a failure.

### Mobile Home scroll reset on a creator change (real-device checks; desktop browsers emulate this only roughly)

| # | Device | Steps | Expected |
|---|---|---|---|
| 17 | iPhone Safari tab and installed PWA; Android Chrome | Scroll Creator A's Home well down, open Live Status, switch to Creator B | B's Home is at the very top immediately (no visible jump back down, no smooth scroll); then switch back to A: top again |
| 18 | Same | Scroll A down, switch to B, scroll B down, use the browser Back gesture/button, then Forward | Each creator route opens at the top, never at the position that history entry was left at |
| 19 | Same | Tap a notification for another creator while the app is open and scrolled down | The creator Home opens at the top |
| 20 | Same | Stay on one creator, scroll down, wait for a data refresh / bring the app back to the foreground, change a topic tag or search | The scroll position is NOT reset |
| 21 | Desktop (>= 1024px) | Switch creators from Live Status | Behavior is unchanged from before (the page does not scroll; nothing is reset) |

iOS Safari restores scroll positions on history traversal differently from Chrome; case 18 on a real iPhone is the one that matters most.

### iPhone installed PWA specifics (to be observed, not assumed)

- Install from Safari "Add to Home Screen", then enable notifications inside the installed app (iOS 16.4+).
- Record whether the tap opens the installed standalone app (no Safari chrome) or a Safari tab; whether it reuses the already-open app; and
  whether the app, when already open, actually moves to the creator (this exercises the `navigate()` -> `openWindow()` fallback in sw.js).
- If a second app window/Safari tab appears in case 5/6, record it: that is the signal to switch the existing-window case to a
  `postMessage`-based in-app navigation instead (a follow-up, not part of this change).
- Re-test once after the service worker updates (the worker has no caches and takes over immediately via skipWaiting/claim; the app checks for an
  update at most hourly).

### Desktop Web specifics

- Test in Chrome and Safari (and Edge/Firefox if you use them) with the site open in one tab and, separately, with no tab open.
- Confirm the browser's notification permission is granted for oshiyobi.web.app before starting.
- With several OshiYobi tabs open, only one should be used (the first window the browser lists).

## Result log

| Case | iPhone PWA (iOS version) | Desktop (browser/version) | Notes |
|---|---|---|---|
| 1 |  |  |  |
| 2 |  |  |  |
| 3 |  |  |  |
| 4 |  |  |  |
| 5 |  |  |  |
| 6 |  |  |  |
| 7 |  |  |  |
| 8 |  |  |  |
| 9 |  |  |  |
| 10 |  |  |  |
| 11 |  |  |  |
| 12 |  |  |  |

Default Oshi unchanged after all cases: ____  Duplicate windows seen: ____
