import { useEffect, useRef, useState } from 'react'
import jsQR from 'jsqr'

/** Full-screen camera view that reads a QR code. Calls onText with each code it can read. */
export function QrScanner({ onText, onClose }: { onText: (text: string) => boolean; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState<string | null>(null)
  const onTextRef = useRef(onText)
  onTextRef.current = onText

  useEffect(() => {
    let stream: MediaStream | null = null
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false
        })
      } catch (e) {
        const name = (e as { name?: string }).name
        setError(
          name === 'NotAllowedError'
            ? 'Camera permission was refused. Allow the camera for Personal PACS in Android Settings › Apps, or use “Enter code” instead.'
            : `The camera could not be started (${(e as Error).message}). Use “Enter code” instead.`
        )
        return
      }
      if (stopped) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      const v = videoRef.current
      if (!v) return
      v.srcObject = stream
      await v.play().catch(() => {})
      const tick = () => {
        if (stopped) return
        if (v.readyState >= 2 && v.videoWidth && ctx) {
          const scale = Math.min(1, 720 / Math.max(v.videoWidth, v.videoHeight))
          const w = Math.round(v.videoWidth * scale)
          const h = Math.round(v.videoHeight * scale)
          canvas.width = w
          canvas.height = h
          ctx.drawImage(v, 0, 0, w, h)
          const img = ctx.getImageData(0, 0, w, h)
          const code = jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' })
          if (code?.data && onTextRef.current(code.data)) {
            stopped = true
            return
          }
        }
        timer = setTimeout(tick, 150)
      }
      tick()
    })()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  return (
    <div className="m-scanner">
      <video ref={videoRef} playsInline muted />
      <div className="m-scanner-frame" />
      <div className="m-scanner-hint">{error ?? 'Point the camera at the QR code on the PC screen'}</div>
      <button className="m-btn primary m-scanner-close" onClick={onClose} data-close>
        Close
      </button>
    </div>
  )
}
