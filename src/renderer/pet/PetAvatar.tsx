import { useEffect, useState } from 'react'
import type { PetSkin } from '../../shared'
import { api } from '../api'

/**
 * Static first idle frame for small headers. A canvas animation in a webview that starts hidden
 * sometimes never painted, and a 24px avatar does not need to move.
 */
export function PetAvatar({ size = 24 }: { size?: number }) {
  const [skin, setSkin] = useState<PetSkin>()
  useEffect(() => {
    void api.getPetSkin().then(setSkin).catch(console.error)
    return api.onSkin(setSkin)
  }, [])
  const scale = size / 208
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-block',
        flexShrink: 0,
        width: 192 * scale,
        height: size,
        backgroundImage: skin ? `url("${skin.spritesheetUrl}")` : undefined,
        backgroundRepeat: 'no-repeat',
        backgroundPosition: '0 0',
        backgroundSize: `${1536 * scale}px ${(skin?.version === 2 ? 2288 : 1872) * scale}px`,
      }}
    />
  )
}
