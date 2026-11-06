# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow>=10"]
# ///
"""Validate bundled extension assets and optionally compare preserved original rows.

uv run verify_extensions.py --original-extra ORIGINAL.webp
The original can also be a decoded PNG snapshot. Pixel comparison includes RGB
under transparent pixels. Visual direction/identity still require preview review.
"""

import argparse
import json
from pathlib import Path

from PIL import Image

from pack import CELL_H, CELL_W, COLS, EXTRA


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--pets", type=Path, default=Path(__file__).resolve().parents[2] / "pets")
    ap.add_argument("--previews", type=Path, default=Path("previews"))
    ap.add_argument("--original-extra", type=Path)
    ap.add_argument("--originals", type=Path,
                    help="directory of PET.png RGBA snapshots taken before appending mood rows")
    a = ap.parse_args()
    expected = {s: {"row": r, "frames": n, "loop": loop}
                for r, (s, n, loop) in enumerate(EXTRA)}
    for pet in ("dango", "matsuko", "momo", "xiaohei-q"):
        folder = a.pets / pet
        meta = json.loads((folder / "familiar.json").read_text())
        assert meta == {"version": 1, "sheet": "familiar-extra.webp", "rows": expected}, pet
        sheet = Image.open(folder / meta["sheet"]).convert("RGBA")
        assert sheet.size == (CELL_W * COLS, CELL_H * len(EXTRA)), (pet, sheet.size)
        occupied = empty = 0
        for row, (state, count, _) in enumerate(EXTRA):
            for c in range(COLS):
                cell = sheet.crop((c * CELL_W, row * CELL_H,
                                   (c + 1) * CELL_W, (row + 1) * CELL_H))
                box = cell.getbbox()
                if c >= count:
                    assert box is None, (pet, state, c, "unused cell is not transparent")
                    empty += 1
                    continue
                assert box is not None, (pet, state, c, "empty frame")
                assert 0 < box[0] < box[2] < CELL_W, (pet, state, c, "horizontal clipping")
                assert 0 < box[1] < box[3] <= CELL_H - 8, (pet, state, c, "vertical clipping")
                # Old Xiaohei rows are immutable; inspect newly generated pixels only.
                if pet != "xiaohei-q" or row >= 6:
                    # Xiaohei's cyan nose is legitimate: only exempt its small
                    # anatomical region, still checking the silhouette/background.
                    for y in range(CELL_H):
                        for x in range(CELL_W):
                            r, g, b, alpha = cell.getpixel((x, y))
                            nose = (pet == "xiaohei-q" and row >= 7
                                    and box[0] + .35 * (box[2] - box[0]) <= x <= box[0] + .65 * (box[2] - box[0])
                                    and box[1] + .48 * (box[3] - box[1]) <= y <= box[1] + .60 * (box[3] - box[1]))
                            assert nose or not (r < 70 and g > 200 and b > 200 and alpha > 100), (pet, state, c, x, y, "cyan residue")
                occupied += 1
        preview = Image.open(a.previews / f"{pet}.png")
        assert preview.size == (sheet.width + 112, sheet.height), pet
        print(f"{pet}: JSON/layout OK; {sheet.width}x{sheet.height}; "
              f"{occupied} occupied / {empty} transparent cells; bounds/background/preview OK")
        if a.originals:
            original = Image.open(a.originals / f"{pet}.png").convert("RGBA")
            assert original.size == (CELL_W * COLS, 7 * CELL_H), (pet, original.size)
            preserved = sheet.crop((0, 0, original.width, original.height))
            changed = sum(x != y for x, y in zip(original.getdata(), preserved.getdata()))
            assert changed == 0, (pet, "preserved rows changed", changed)
            print(f"{pet} rows 0-6: {original.width * original.height:,} RGBA pixels "
                  f"compared (including invisible RGB); changed pixels = {changed}")

    if a.original_extra:
        original = Image.open(a.original_extra).convert("RGBA")
        assert original.size == (1536, 1248), original.size
        current = Image.open(a.pets / "xiaohei-q/familiar-extra.webp").convert("RGBA")
        crop = current.crop((0, 0, 1536, 1248))
        changed = sum(x != y for x, y in zip(original.getdata(), crop.getdata()))
        assert changed == 0, f"Xiaohei preserved area has {changed} changed pixels"
        print("xiaohei-q first 6 rows: 1,916,928 RGBA pixels compared; changed pixels = 0")


if __name__ == "__main__":
    main()
