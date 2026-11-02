# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow>=10"]
# ///
"""
Packs per-state frames into a Familiar pet folder: pet.json, spritesheet.webp (ChatGPT v1
layout) and, when extra states are present, familiar.json + familiar-extra.webp.

    uv run pack.py FRAMES_DIR OUT_DIR --id mochi --name 麻薯 --description "..."

FRAMES_DIR has one folder per state (idle, running-right, ...), each holding that state's
frames as transparent PNGs, sorted by file name. Frames of one state should come from one
strip cut into equal slices, so their canvases share a size: the script crops a state by the
union of its frames, which keeps motion inside the row (a jump still rises).
"""

import argparse
import json
import re
import sys
from pathlib import Path

from PIL import Image, ImageOps

CELL_W, CELL_H, COLS = 192, 208, 8
PAD = 8
# ChatGPT pet rows 0-8 and their frame counts.
BASE = [
    ("idle", 6),
    ("running-right", 8),
    ("running-left", 8),
    ("waving", 4),
    ("jumping", 5),
    ("failed", 8),
    ("waiting", 6),
    ("running", 6),
    ("review", 6),
]
# Familiar's own rows, in familiar-extra.webp; each is optional.
EXTRA = [
    ("listening", 6, True),
    ("talking", 6, True),
    ("sleeping", 6, True),
    ("petted", 6, False),
    ("poked", 4, False),
    ("worried", 6, True),
]
BUNDLED = {"xiaohei-q", "dango", "matsuko", "momo"}


def frames(folder: Path) -> list[Image.Image]:
    files = sorted(p for p in folder.iterdir() if p.suffix.lower() in (".png", ".webp"))
    return [Image.open(p).convert("RGBA") for p in files]


def union_box(images: list[Image.Image]) -> tuple[int, int, int, int]:
    boxes = [im.getbbox() for im in images]
    if any(b is None for b in boxes):
        raise SystemExit("a frame is fully transparent")
    return (
        min(b[0] for b in boxes),
        min(b[1] for b in boxes),
        max(b[2] for b in boxes),
        max(b[3] for b in boxes),
    )


def fail(message: str):
    print(f"error: {message}", file=sys.stderr)
    sys.exit(1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("frames", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument("--id", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--description", required=True)
    ap.add_argument("--force", action="store_true", help="replace an existing OUT_DIR")
    a = ap.parse_args()

    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", a.id):
        fail("id: lowercase letters, digits, - and _ only")
    if a.id in BUNDLED:
        fail(f"id {a.id} is a bundled pet; pick another")
    if a.out.exists() and any(a.out.iterdir()) and not a.force:
        fail(f"{a.out} exists; pass --force to replace it")

    rows: dict[str, list[Image.Image]] = {}
    for state, count in BASE:
        folder = a.frames / state
        if not folder.is_dir():
            if state == "running-left" and "running-right" in rows:
                rows[state] = [ImageOps.mirror(im) for im in rows["running-right"]]
                continue
            fail(f"missing {folder}")
        rows[state] = frames(folder)
        if len(rows[state]) != count:
            fail(f"{state}: {len(rows[state])} frames, needs {count}")
    extra = []
    for state, count, loop in EXTRA:
        folder = a.frames / state
        if not folder.is_dir():
            continue
        rows[state] = frames(folder)
        if len(rows[state]) != count:
            fail(f"{state}: {len(rows[state])} frames, needs {count}")
        extra.append((state, count, loop))

    # One scale for every row, so the pet keeps its size from state to state.
    crops = {}
    scale = float("inf")
    for state, images in rows.items():
        box = union_box(images)
        crops[state] = [im.crop(box) for im in images]
        w, h = box[2] - box[0], box[3] - box[1]
        scale = min(scale, (CELL_W - 2 * PAD) / w, (CELL_H - 2 * PAD) / h)

    def sheet(states: list[str]) -> Image.Image:
        out = Image.new("RGBA", (CELL_W * COLS, CELL_H * len(states)), (0, 0, 0, 0))
        for r, state in enumerate(states):
            for c, im in enumerate(crops[state]):
                im = im.resize(
                    (max(1, round(im.width * scale)), max(1, round(im.height * scale))),
                    Image.LANCZOS,
                )
                # Centered, standing on the cell's bottom padding.
                x = c * CELL_W + (CELL_W - im.width) // 2
                y = r * CELL_H + CELL_H - PAD - im.height
                out.alpha_composite(im, (x, y))
        return out

    a.out.mkdir(parents=True, exist_ok=True)
    base = sheet([s for s, _ in BASE])
    assert base.size == (1536, 1872)
    base.save(a.out / "spritesheet.webp", lossless=True)
    (a.out / "pet.json").write_text(
        json.dumps(
            {
                "id": a.id,
                "displayName": a.name,
                "description": a.description,
                "spritesheetPath": "spritesheet.webp",
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n"
    )
    for stale in ("familiar.json", "familiar-extra.webp"):
        (a.out / stale).unlink(missing_ok=True)
    if extra:
        sheet([s for s, _, _ in extra]).save(a.out / "familiar-extra.webp", lossless=True)
        (a.out / "familiar.json").write_text(
            json.dumps(
                {
                    "version": 1,
                    "sheet": "familiar-extra.webp",
                    "rows": {
                        s: {"row": i, "frames": n, "loop": loop}
                        for i, (s, n, loop) in enumerate(extra)
                    },
                },
                indent=2,
            )
            + "\n"
        )

    # A contact sheet to look at before calling it done.
    preview = Image.new("RGBA", base.size, (236, 236, 236, 255))
    preview.alpha_composite(base)
    preview.convert("RGB").save(a.frames / "preview.png")
    idle_height = crops["idle"][0].height * scale
    print(f"packed {a.out}  (base rows 9, extra rows {len(extra)})")
    print(f"preview {a.frames / 'preview.png'}")
    if idle_height < CELL_H * 0.55:
        print(
            "warning: the idle pet is small in its cell; some state's frames are much"
            " larger than the rest (crop that state tighter or regenerate it)"
        )


if __name__ == "__main__":
    main()
