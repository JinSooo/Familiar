import { useEffect, useRef, useState } from 'react'
import type { PetGesture, PetSkin, PetState, Settings } from '../../shared'
import { api } from '../api'
import { animation, scales, sweep, type Action, type Sweep } from './logic'

export function PerceptionIndicator({
  mode,
}: {
  mode: 'capturing' | 'paused' | 'chat-only'
}) {
  return mode === 'chat-only' ? null : (
    <span className={`perception ${mode}`} aria-label={mode} />
  )
}
export function Pet({
  embedded = false,
  scale,
  forceState,
}: {
  embedded?: boolean
  scale?: number
  forceState?: PetState
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [skin, setSkin] = useState<PetSkin>()
  const [size, setSize] = useState<Settings['pet']['size']>('medium')
  const [state, setState] = useState<PetState>('idle')
  const [gesture, setGesture] = useState<PetGesture>()
  const [direction, setDirection] = useState<'running-left' | 'running-right'>()
  const [reduced, setReduced] = useState(
    matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  const hit = useRef<(x: number, y: number) => boolean>(() => false)
  const sequence = useRef(0)
  const [gestureKey, setGestureKey] = useState(0)
  useEffect(() => {
    const off = [
      api.onState(setState),
      api.onSkin(setSkin),
      api.onSize(setSize),
      api.onGesture((g) => {
        setGesture(g)
        setGestureKey(++sequence.current)
      }),
    ]
    void api.getPetSkin().then(setSkin).catch(console.error)
    void api
      .getSettings()
      .then((s) => setSize(s.pet.size))
      .catch(console.error)
    const media = matchMedia('(prefers-reduced-motion: reduce)')
    const change = () => setReduced(media.matches)
    media.addEventListener('change', change)
    api.ready()
    return () => {
      off.forEach((f) => f())
      media.removeEventListener('change', change)
    }
  }, [])
  useEffect(() => {
    if (!skin || !canvas.current) return
    let disposed = false
    let timer: ReturnType<typeof setInterval> | undefined
    hit.current = () => false
    const action: Action = reduced
      ? 'idle'
      : (forceState ?? direction ?? gesture ?? state)
    const spec = animation(action, skin)
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.onload = () => {
      if (disposed) return
      const context = canvas.current!.getContext('2d', {
        willReadFrequently: true,
      })!
      let frame = 0
      const draw = () => {
        context.clearRect(0, 0, 192, 208)
        context.globalAlpha = spec.opacity
        context.drawImage(
          image,
          frame * 192,
          spec.row * 208,
          192,
          208,
          0,
          0,
          192,
          208,
        )
        const pixels = context.getImageData(0, 0, 192, 208).data
        hit.current = (x, y) => {
          const rect = canvas.current!.getBoundingClientRect()
          const px = Math.floor(((x - rect.left) * 192) / rect.width)
          const py = Math.floor(((y - rect.top) * 208) / rect.height)
          return (
            px >= 0 &&
            px < 192 &&
            py >= 0 &&
            py < 208 &&
            pixels[(py * 192 + px) * 4 + 3]! > 32
          )
        }
      }
      draw()
      timer = setInterval(() => {
        if (reduced || (++frame >= spec.frames && !spec.loop)) {
          clearInterval(timer)
          if (gesture) setGesture(undefined)
          if (state === 'failed') api.animationFinished()
          return
        }
        frame %= spec.frames
        draw()
      }, 1000 / spec.fps)
    }
    image.onerror = () => {
      if (!disposed) {
        console.error('Pet atlas could not be loaded', image.src)
        setGesture(undefined)
      }
    }
    image.src =
      spec.source === 'extension'
        ? skin.extension!.sheetUrl
        : skin.spritesheetUrl
    return () => {
      disposed = true
      clearInterval(timer)
      hit.current = () => false
    }
  }, [skin, state, gesture, gestureKey, direction, reduced, forceState])
  useEffect(() => {
    if (embedded) return
    let down:
      { x: number; y: number; lastX: number; moved: boolean } | undefined
    let lastHit = false
    let stroking: Sweep = { x: 0, direction: 0, reversals: [] }
    let lastPetting = 0
    const move = (event: PointerEvent) => {
      if (down) {
        if (Math.hypot(event.screenX - down.x, event.screenY - down.y) > 4)
          down.moved = true
        if (down.moved && event.screenX !== down.lastX)
          setDirection(
            event.screenX > down.lastX ? 'running-right' : 'running-left',
          )
        down.lastX = event.screenX
        api.drag('move')
        return
      }
      const inside =
        hit.current(event.clientX, event.clientY) ||
        Boolean((event.target as Element).closest('[data-overlay-hit]'))
      if (inside !== lastHit) {
        lastHit = inside
        api.hit(inside)
      }
      if (inside && !event.buttons) {
        const now = Date.now()
        const next = sweep(stroking, event.screenX, now)
        stroking = next
        if (next.petted && now - lastPetting > 1500) {
          lastPetting = now
          setGesture('petted')
          setGestureKey(++sequence.current)
        }
      } else stroking = { x: event.screenX, direction: 0, reversals: [] }
    }
    const start = (event: PointerEvent) => {
      if (event.button !== 0 || !hit.current(event.clientX, event.clientY))
        return
      canvas.current?.setPointerCapture(event.pointerId)
      down = {
        x: event.screenX,
        y: event.screenY,
        lastX: event.screenX,
        moved: false,
      }
      api.drag('start')
    }
    const end = () => {
      if (!down) return
      down = undefined
      setDirection(undefined)
      api.drag('end')
      lastHit = false
      api.hit(false)
    }
    const leave = () => {
      if (!down) {
        lastHit = false
        api.hit(false)
        stroking.reversals = []
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerdown', start)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    window.addEventListener('blur', end)
    document.addEventListener('pointerleave', leave)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerdown', start)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      window.removeEventListener('blur', end)
      document.removeEventListener('pointerleave', leave)
    }
  }, [embedded])
  return (
    <div className="pet">
      <canvas
        ref={canvas}
        width={192}
        height={208}
        style={{
          width: 192 * (scale ?? scales[size]),
          height: 208 * (scale ?? scales[size]),
        }}
        aria-label={`Familiar, ${state}`}
      />
      <PerceptionIndicator mode="chat-only" />
    </div>
  )
}
