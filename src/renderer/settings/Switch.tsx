/** A macOS-style on/off switch. */
export function Switch(props: {
  on: boolean
  label: string
  onChange: (on: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.on}
      aria-label={props.label}
      className="switch"
      onClick={() => props.onChange(!props.on)}
    />
  )
}
