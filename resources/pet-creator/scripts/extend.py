# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow>=10"]
# ///
"""Pack only Familiar extensions, without touching the base atlas or pet metadata.

uv run extend.py FRAMES PET_DIR --preview previews/PET.png [--keep-rows 6]

FRAMES/idle contains a generated calibration strip cut at the same scale as the
new actions. All frames in a state must have identical canvas dimensions.
Existing rows are copied as decoded RGBA pixels and encoded losslessly, including
invisible RGB. --keep-rows refuses to overwrite those states.
"""

import argparse
import json
from pathlib import Path
from statistics import median

from PIL import Image, ImageDraw

from pack import CELL_H, CELL_W, COLS, EXTRA, PAD, fail, frames, union_box


def checked_frames(folder, count):
    images = frames(folder)
    if len(images) != count:
        fail(f"{folder}: needs {count} frames, got {len(images)}")
    if len({im.size for im in images}) != 1:
        fail(f"{folder}: frame canvases must have identical dimensions")
    union_box(images)
    return images


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("frames", type=Path)
    ap.add_argument("pet", type=Path)
    ap.add_argument("--keep-rows", type=int, default=0)
    ap.add_argument("--preview", type=Path, required=True)
    a = ap.parse_args()
    if not 0 <= a.keep_rows <= len(EXTRA):
        fail("keep-rows is outside the extension layout")
    base = Image.open(a.pet / "spritesheet.webp").convert("RGBA")
    if base.width != CELL_W * COLS or base.height < CELL_H:
        fail("invalid base atlas dimensions")
    heights = []
    for c in range(6):
        box = base.crop((c * CELL_W, 0, (c + 1) * CELL_W, CELL_H)).getbbox()
        if box is None:
            fail("base idle contains an empty frame")
        heights.append(box[3] - box[1])
    ruler = checked_frames(a.frames / "idle", 6)
    box = union_box(ruler)
    scale = median(heights) / (box[3] - box[1])

    sheet = Image.new("RGBA", (CELL_W * COLS, CELL_H * len(EXTRA)))
    old = None
    if a.keep_rows:
        meta = json.loads((a.pet / "familiar.json").read_text())
        old = Image.open(a.pet / meta["sheet"]).convert("RGBA")
        if meta.get("version") != 1 or old.size != (sheet.width, a.keep_rows * CELL_H):
            fail("existing atlas does not match keep-rows")
        for row, (state, count, loop) in enumerate(EXTRA[:a.keep_rows]):
            if meta["rows"].get(state) != {"row": row, "frames": count, "loop": loop}:
                fail(f"existing {state} metadata differs from the expected layout")
            if (a.frames / state).exists():
                fail(f"{state} is preserved; remove its replacement frames")
        sheet.paste(old, (0, 0))

    for row, (state, count, _) in enumerate(EXTRA[a.keep_rows:], a.keep_rows):
        images = checked_frames(a.frames / state, count)
        box = union_box(images)
        size = (max(1, round((box[2] - box[0]) * scale)),
                max(1, round((box[3] - box[1]) * scale)))
        if size[0] > CELL_W or size[1] > CELL_H - PAD:
            fail(f"{state}: calibrated size {size} would clip; regenerate the row")
        for c, im in enumerate(images):
            sprite = im.crop(box).resize(size, Image.Resampling.LANCZOS)
            sheet.alpha_composite(sprite, (c * CELL_W + (CELL_W - size[0]) // 2,
                                           (row + 1) * CELL_H - PAD - size[1]))

    dest = a.pet / "familiar-extra.webp"
    sheet.save(dest, lossless=True, exact=True)
    saved = Image.open(dest).convert("RGBA")
    if old is not None and saved.crop((0, 0, old.width, old.height)).tobytes() != old.tobytes():
        fail("lossless preservation check failed")
    (a.pet / "familiar.json").write_text(json.dumps({
        "version": 1, "sheet": dest.name,
        "rows": {s: {"row": r, "frames": n, "loop": loop}
                 for r, (s, n, loop) in enumerate(EXTRA)}}, indent=2) + "\n")
    preview = Image.new("RGB", (sheet.width + 112, sheet.height), (236, 236, 236))
    preview.paste(saved, (112, 0), saved)
    draw = ImageDraw.Draw(preview)
    for row, (state, _, _) in enumerate(EXTRA):
        draw.text((8, row * CELL_H + 12), state, fill=(35, 35, 35))
    a.preview.parent.mkdir(parents=True, exist_ok=True)
    preview.save(a.preview)
    print(f"{a.pet.name}: {saved.size}, scale={scale:.5f}, idle height={median(heights)}, "
          f"preserved rows={a.keep_rows}; preview={a.preview}")


if __name__ == "__main__":
    main()
