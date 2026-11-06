import { useEffect, useState } from 'react'
import type { PublicSettings, ShortcutFailure } from '../../shared'
import { api } from '../api'

type Bindings = PublicSettings['shortcuts']
const labels: Record<keyof Bindings, string> = {
  summon: '打开输入框',
  main: '打开大窗口',
  togglePet: '显示 / 隐藏宠物',
  newChat: '新对话',
  quick: '快捷问答条',
}
const symbols: Record<string, string> = {
  Control: '⌃',
  Alt: '⌥',
  Shift: '⇧',
  Super: '⌘',
  CommandOrControl: '⌘',
  Space: '空格',
}
/** "Alt+Shift+Space" → "⌥⇧空格". */
export function prettyShortcut(accelerator: string): string {
  return accelerator
    .split('+')
    .map((part) => symbols[part] ?? part)
    .join('')
}

/** The Tauri accelerator for a key press, or '' while only modifiers are down. */
function accelerator(e: KeyboardEvent): string {
  const code = e.code
  const key = /^Key[A-Z]$/.test(code)
    ? code.slice(3)
    : /^Digit\d$/.test(code)
      ? code.slice(5)
      : /^(F\d{1,2}|Space|Enter|Tab|Backquote|Minus|Equal|Comma|Period|Slash|Semicolon|Quote|BracketLeft|BracketRight|Backslash|Arrow(Up|Down|Left|Right))$/.test(
            code,
          )
        ? code
        : ''
  if (!key) return ''
  const mods = [
    e.ctrlKey && 'Control',
    e.altKey && 'Alt',
    e.shiftKey && 'Shift',
    e.metaKey && 'Super',
  ].filter(Boolean)
  // A bare key would fire while typing anywhere; require a modifier (F-keys excepted).
  if (!mods.length && !/^F\d/.test(key)) return ''
  return [...mods, key].join('+')
}

function Recorder({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  const [recording, setRecording] = useState(false)
  useEffect(() => {
    if (!recording) return
    const key = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') return setRecording(false)
      if (e.key === 'Backspace' || e.key === 'Delete') {
        onChange('')
        return setRecording(false)
      }
      const next = accelerator(e)
      if (next) {
        onChange(next)
        setRecording(false)
      }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [recording, onChange])
  return (
    <button
      type="button"
      className={`shortcut ${recording ? 'recording' : ''}`}
      onClick={() => setRecording(!recording)}
      onBlur={() => setRecording(false)}
      title="点一下，再按新的组合键；Esc 取消，Delete 清除"
    >
      {recording ? '按下新的组合键…' : value ? prettyShortcut(value) : '未设置'}
    </button>
  )
}

export function ShortcutsSection({
  value,
  onChange,
}: {
  value: Bindings
  onChange: (next: Bindings) => void
}) {
  const [failed, setFailed] = useState<ShortcutFailure[]>([])
  useEffect(() => {
    const load = () =>
      void api
        .shortcutStatus()
        .then(setFailed)
        .catch(() => {})
    load()
    window.addEventListener('focus', load)
    const timer = setInterval(load, 3000)
    return () => {
      window.removeEventListener('focus', load)
      clearInterval(timer)
    }
  }, [])
  return (
    <>
      <div className="group">
        {(Object.keys(labels) as (keyof Bindings)[]).map((action) => {
          const fail = failed.find((f) => f.action === action)
          return (
            <div className="setting-row" key={action}>
              <span>
                {labels[action]}
                {fail && (
                  <small className="shortcut-error">
                    和其他应用冲突，没有生效
                  </small>
                )}
              </span>
              <Recorder
                value={value[action]}
                onChange={(v) => onChange({ ...value, [action]: v })}
              />
            </div>
          )
        })}
      </div>
    </>
  )
}
