export function Icon({
  name,
}: {
  name: 'expand' | 'collapse' | 'new' | 'settings' | 'history' | 'window'
}) {
  const paths = {
    expand: 'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7',
    // A window with a title bar: "open in the big window".
    window: 'M3 5h18v14H3zM3 9h18M6 7h.01M8.5 7h.01',
    collapse: 'M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7',
    new: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
    // Slider-style "adjust" glyph; reads at 16px better than a gear.
    settings: 'M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M6 14v6',
    // Clock with a counter-clockwise arrow: "earlier conversations".
    history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2',
  }
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  )
}
