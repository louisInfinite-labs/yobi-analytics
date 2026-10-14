import { useEffect, useRef, useState } from "react"
import jsQR from "jsqr"
import { useLocale } from "../../../shared/i18n/hooks/useLocale"
import { t } from "../../../shared/i18n/translations"

/** Chrome/Edge/Android's native QR/barcode decoder. Not in lib.dom -- typed here the same way installState.ts
 * types BeforeInstallPromptEvent. Absent on iOS/iPadOS Safari (every WebKit build to date), which is exactly why
 * this component also carries the jsqr fallback below -- iOS PWA scanning would otherwise be impossible. */
interface BarcodeDetectorLike {
  detect: (source: CanvasImageSource) => Promise<{ rawValue: string }[]>
}
interface BarcodeDetectorConstructor {
  new (options: { formats: string[] }): BarcodeDetectorLike
}

type ScanState = "idle" | "requesting" | "scanning" | "denied" | "unsupported"

/** Decodes one video frame via canvas ImageData -- the jsqr fallback path, and also exercised directly by tests
 * (camera access itself cannot run in jsdom). Returns null for "nothing found in this frame", never throws. */
export function decodeFrame(imageData: ImageData): string | null {
  const result = jsQR(imageData.data, imageData.width, imageData.height)
  return result?.data ?? null
}

/** Camera-gated QR scanner. getUserMedia is requested ONLY from `start()`, itself only ever called by this
 * component's own "Scan QR Code" button onClick -- never on mount, never on prop change, matching the spec's
 * explicit "camera permission only after the user taps Scan QR Code" requirement. Mobile-only presentation
 * (MobileDeviceSync.tsx): PcDeviceSync.tsx never mounts this, matching "do not assume the PC has a camera". */
export function QrCodeScanner({ onDecoded }: { onDecoded: (value: string) => void }) {
  const [locale] = useLocale()
  const [state, setState] = useState<ScanState>("idle")
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef<number | null>(null)
  const detectorRef = useRef<BarcodeDetectorLike | null>(null)

  function stopCamera() {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
  }

  useEffect(() => stopCamera, [])

  async function scanOnce() {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas || video.readyState < video.HAVE_CURRENT_DATA) {
      rafRef.current = requestAnimationFrame(scanOnce)
      return
    }
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    let value: string | null = null
    if (detectorRef.current) {
      try {
        const [hit] = await detectorRef.current.detect(video)
        value = hit?.rawValue ?? null
      } catch {
        value = null
      }
    } else {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      value = decodeFrame(ctx.getImageData(0, 0, canvas.width, canvas.height))
    }

    if (value) {
      stopCamera()
      setState("idle")
      onDecoded(value)
      return
    }
    rafRef.current = requestAnimationFrame(scanOnce)
  }

  async function start() {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setState("unsupported")
      return
    }
    setState("requesting")
    const BarcodeDetectorCtor = (window as unknown as { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector
    detectorRef.current = BarcodeDetectorCtor ? new BarcodeDetectorCtor({ formats: ["qr_code"] }) : null
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play()
      }
      setState("scanning")
      rafRef.current = requestAnimationFrame(scanOnce)
    } catch {
      setState("denied")
    }
  }

  if (state === "idle" || state === "requesting") {
    return (
      <button type="button" className="device-sync-scan-button" onClick={() => void start()} disabled={state === "requesting"}>
        {t(locale, "deviceSync.scanQr")}
      </button>
    )
  }

  if (state === "denied" || state === "unsupported") {
    return <p className="device-sync-scan-fallback">{t(locale, "deviceSync.cameraUnavailable")}</p>
  }

  return (
    <div className="device-sync-scan-viewport">
      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- a live camera preview, not pre-recorded media */}
      <video ref={videoRef} className="device-sync-scan-video" playsInline muted />
      <canvas ref={canvasRef} className="device-sync-scan-canvas" />
      <button type="button" className="device-sync-scan-cancel" onClick={() => { stopCamera(); setState("idle") }}>
        {t(locale, "push.close")}
      </button>
    </div>
  )
}
