import { useEffect, useRef, useState } from "react"
import QRCode from "qrcode"

/** Renders `value` (the pairing session's own token -- a temporary, single-use secret, never a long-lived
 * credential, see pairing_token_api.py's own module docstring) as a QR code on a canvas. Desktop-only presentation
 * (PcDeviceSync.tsx): the spec explicitly forbids a mobile QR-display-first flow, so this component is never
 * mounted from MobileDeviceSync.tsx/the guidance components. */
export function QrCodeDisplay({ value, size = 220 }: { value: string; size?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    setError(false)
    QRCode.toCanvas(canvas, value, { width: size, margin: 1 }).catch(() => setError(true))
  }, [value, size])

  if (error) return <div className="device-sync-qr device-sync-qr--error">QR</div>
  return <canvas ref={canvasRef} className="device-sync-qr" width={size} height={size} role="img" aria-label="QR" />
}
