import { useEffect, useRef, useState } from 'react'
import type { Mood, PetGesture, PetSkin, PetState } from '../../shared'
import { api, subscribe } from '../api'
import { observeSnapshot } from '../shared-ui/synchronization'
import { IPC, perceptionMode } from '../../shared'
import { alphaHit, overlayHit } from './hit'
import {
  animation,
  clickSequence,
  idleAction,
  moodRate,
  sweep,
  type Action,
  type Sweep,
} from './logic'

/** At the pet's feet: a dot while it watches, a ring while paused, nothing when it only chats. */
function PerceptionIndicator() {
  const [mode, setMode] = useState<ReturnType<typeof perceptionMode>>()
  useEffect(() => {
    return observeSnapshot(api.perceptionStatus, api.onPerceptionChanged, (s) =>
      setMode(perceptionMode(s)),
    )
  }, [])
  if (!mode || mode === 'chat-only') return null
  return (
    <span
      className={`perception ${mode}`}
      aria-label={mode === 'paused' ? '电脑活动记录已暂停' : '正在记录电脑活动'}
    />
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
  const [size, setSize] = useState<number>(0.73)
  const [speed, setSpeed] = useState<number>(1)
  const [wander, setWander] = useState(false)
  const [state, setState] = useState<PetState>('idle')
  const [mood, setMood] = useState<Mood>()
  const lastMood = useRef<Mood>(undefined)
  const [gesture, setGesture] = useState<PetGesture>()
  const [direction, setDirection] = useState<'running-left' | 'running-right'>()
  /** Tucked into a screen edge; the peeking row faces left, so the left edge mirrors it. */
  const [tucked, setTucked] = useState<'left' | 'right'>()
  const [reduced, setReduced] = useState(
    matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  const hit = useRef<(x: number, y: number) => boolean>(() => false)
  const sequence = useRef(0)
  const [gestureKey, setGestureKey] = useState(0)
  useEffect(() => {
    const settings = api.getSettings()
    const off = [
      api.onState(setState),
      observeSnapshot(api.getPetSkin, api.onSkin, setSkin),
      observeSnapshot(
        () => settings.then((s) => s.pet.scale),
        api.onSize,
        setSize,
      ),
      observeSnapshot(
        () => settings.then((s) => s.pet.rate),
        api.onSpeed,
        setSpeed,
      ),
      observeSnapshot(
        () => settings.then((s) => s.pet.wander),
        api.onWander,
        setWander,
      ),
      observeSnapshot(
        api.getMood,
        (receive) =>
          api.onMood((value) => {
            if (value.mood === 'happy' && lastMood.current !== 'happy') {
              setGesture('jump')
              setGestureKey(++sequence.current)
            }
            receive(value)
          }),
        ({ mood: next }) => {
          lastMood.current = next
          setMood(next)
        },
      ),
      api.onGesture((g) => {
        setGesture(g)
        setGestureKey(++sequence.current)
      }),
    ]
    const media = matchMedia('(prefers-reduced-motion: reduce)')
    const change = () => setReduced(media.matches)
    media.addEventListener('change', change)
    if (!embedded) api.ready()
    return () => {
      off.forEach((f) => f())
      media.removeEventListener('change', change)
    }
  }, [])
  useEffect(() => {
    if (!skin || !canvas.current) return
    let disposed = false
    let timer: ReturnType<typeof setInterval> | undefined
    // Keep the previous frame's hit test until the new animation draws, so a stationary
    // cursor is not dropped to click-through while the next atlas row loads.
    const action: Action = reduced
      ? 'idle'
      : (forceState ??
        direction ??
        gesture ??
        (tucked && !embedded ? 'peeking' : idleAction(state, mood)))
    const spec = animation(action, skin)
    const mirror = action === 'peeking' && tucked === 'left'
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
        // Mirrored in the drawing itself, so the hit test reads the pixels as they show.
        context.setTransform(mirror ? -1 : 1, 0, 0, 1, mirror ? 192 : 0, 0)
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
        context.setTransform(1, 0, 0, 1, 0, 0)
        const pixels = context.getImageData(0, 0, 192, 208).data
        hit.current = (x, y) => {
          const rect = canvas.current!.getBoundingClientRect()
          return alphaHit(pixels, 192, 208, rect, x, y)
        }
      }
      draw()
      timer = setInterval(
        () => {
          if (reduced || (++frame >= spec.frames && !spec.loop)) {
            clearInterval(timer)
            if (gesture) setGesture(undefined)
            if (state === 'failed') api.animationFinished()
            return
          }
          frame %= spec.frames
          draw()
        },
        1000 /
          (direction
            ? spec.fps
            : spec.fps * speed * moodRate(state, mood, skin)),
      )
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
    }
  }, [
    skin,
    state,
    mood,
    tucked,
    embedded,
    gesture,
    gestureKey,
    direction,
    reduced,
    forceState,
    speed,
  ])
  // Idle and awake: the shell may walk it a little way and back (docs/design.md §9). Never at
  // night, even when worry outranks sleepiness in the mood; re-sent each minute for the clock.
  useEffect(() => {
    if (embedded) return
    const send = () => {
      const hour = new Date().getHours()
      api.petRest(
        wander &&
          !reduced &&
          state === 'idle' &&
          mood !== 'sleepy' &&
          hour >= 6 &&
          hour < 23,
      )
    }
    send()
    const timer = setInterval(send, 60_000)
    return () => {
      clearInterval(timer)
      api.petRest(false)
    }
  }, [embedded, wander, reduced, state, mood])
  useEffect(() => {
    if (embedded) return
    let down: { x: number; y: number; moved: boolean } | undefined
    let capsuleOpen = false
    let clicks: number[] = []
    let clickTimer: ReturnType<typeof setTimeout> | undefined
    const off = [
      api.onCapsule((open) => {
        capsuleOpen = open
      }),
      subscribe<{ side: '' | 'left' | 'right'; tucked: boolean }>(
        IPC.petEdge,
        ({ side, tucked }) => setTucked(tucked && side ? side : undefined),
      ),
      subscribe<'left' | 'right' | 'none'>(IPC.petWalk, (value) =>
        setDirection(value === 'none' ? undefined : `running-${value}`),
      ),
      subscribe<'left' | 'right' | 'none'>(IPC.petDrag, (value) => {
        setDirection(value === 'none' ? undefined : `running-${value}`)
        if (value === 'none' && down?.moved) down = undefined
      }),
      subscribe<{ x: number; y: number; ignoring: boolean }>(
        IPC.petCursor,
        ({ x, y, ignoring }) => {
          const inside = overlayHit(
            hit.current(x, y),
            document.elementFromPoint(x, y),
          )
          // Correct the panel whenever it disagrees, not only when our verdict changes:
          // Rust resets click-through after drags and may resend while the cursor is still.
          if (inside === ignoring) api.hit(inside)
        },
      ),
    ]
    let stroking: Sweep = { x: 0, direction: 0, reversals: [] }
    let lastPetting = 0
    const move = (event: PointerEvent) => {
      if (down) {
        if (
          !down.moved &&
          Math.hypot(event.screenX - down.x, event.screenY - down.y) > 4
        ) {
          down.moved = true
          api.drag('start')
        }
        return
      }
      const inside = hit.current(event.clientX, event.clientY)
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
      if (
        event.button !== 0 ||
        event.target !== canvas.current ||
        !hit.current(event.clientX, event.clientY)
      )
        return
      canvas.current?.setPointerCapture(event.pointerId)
      down = {
        x: event.screenX,
        y: event.screenY,
        moved: false,
      }
    }
    const end = (event: PointerEvent) => {
      if (!down) return
      const moved = down.moved
      down = undefined
      if (canvas.current?.hasPointerCapture(event.pointerId))
        canvas.current.releasePointerCapture(event.pointerId)
      if (moved) return
      const result = clickSequence(clicks, Date.now())
      clicks = result.times
      clearTimeout(clickTimer)
      if (result.poked) {
        setGesture('poked')
        setGestureKey(++sequence.current)
      } else
        clickTimer = setTimeout(() => {
          clicks = []
          setGesture('wave')
          setGestureKey(++sequence.current)
          api.capsule(!capsuleOpen)
        }, 220)
    }
    const cancel = () => {
      down = undefined
      stroking.reversals = []
    }
    // Right-click on the pet itself opens the native menu; text fields keep their own menu.
    const menu = (event: MouseEvent) => {
      if (
        event.target !== canvas.current ||
        !hit.current(event.clientX, event.clientY)
      )
        return
      event.preventDefault()
      // Left of the body (menus are ~150px wide); the pet panel would cover one at the cursor.
      const left = (event.target as HTMLCanvasElement).getBoundingClientRect()
        .left
      api.petMenu(left - 160, event.clientY - 12)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerdown', start)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('blur', cancel)
    window.addEventListener('contextmenu', menu)
    return () => {
      window.removeEventListener('contextmenu', menu)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerdown', start)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('blur', cancel)
      off.forEach((f) => f())
      clearTimeout(clickTimer)
    }
  }, [embedded])
  return (
    <div className="pet">
      <canvas
        ref={canvas}
        width={192}
        height={208}
        style={{
          width: 192 * (scale ?? size),
          height: 208 * (scale ?? size),
        }}
        aria-label={`Familiar, ${state}`}
      />
      {!embedded && <PerceptionIndicator />}
    </div>
  )
}
