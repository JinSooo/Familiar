/** Map window CSS pixels to the current canvas frame's alpha channel. */
export function alphaHit(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  rect: { left: number; top: number; width: number; height: number },
  x: number,
  y: number,
): boolean {
  if (rect.width <= 0 || rect.height <= 0) return false
  const px = Math.floor(((x - rect.left) * width) / rect.width)
  const py = Math.floor(((y - rect.top) * height) / rect.height)
  return (
    px >= 0 &&
    px < width &&
    py >= 0 &&
    py < height &&
    (pixels[(py * width + px) * 4 + 3] ?? 0) > 32
  )
}

export function overlayHit(
  alpha: boolean,
  element: Pick<Element, 'closest'> | null,
): boolean {
  return alpha || Boolean(element?.closest('[data-hit]'))
}
