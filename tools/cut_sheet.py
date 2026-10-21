#!/usr/bin/env python3
"""Cut a scanned sticker sheet into individual transparent PNG stickers.

Usage:
  python3 -I tools/cut_sheet.py sheets/gems.webp stickers/gems --tol 40 --gap 8 --min-area 1500

How it works:
  1. The background colour is estimated from the image border.
  2. Pixels close to that colour (within --tol) are "background candidates";
     only candidates connected to the image border count as real background,
     so white highlights inside a gem are kept.
  3. Foreground blobs are grouped if they are within --gap px of each other
     (so flower petals become one sticker), then every blob above --min-area
     is cropped, given a soft alpha edge and saved as PNG.
  4. A manifest.json (name, file, w, h) is written next to the PNGs.
"""
import argparse, json, os, sys
import numpy as np
from PIL import Image
from scipy import ndimage as ndi


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("sheet")
    ap.add_argument("outdir")
    ap.add_argument("--tol", type=float, default=40, help="colour distance to background")
    ap.add_argument("--gap", type=int, default=6, help="px gap to merge nearby pieces")
    ap.add_argument("--min-area", type=int, default=1200)
    ap.add_argument("--border", type=int, default=6, help="border width sampled for bg colour")
    ap.add_argument("--feather", type=float, default=0.8)
    ap.add_argument("--prefix", default=None)
    ap.add_argument("--bg", default=None, help="background colour r,g,b (default: sampled from border)")
    ap.add_argument("--crop", default=None, help="x0,y0,x1,y1 region of the sheet to use")
    ap.add_argument("--fg-expr", default=None,
                    help="numpy expression over r,g,b that is True on sticker ink; used for sheets whose background "
                         "is patterned: the ink is closed (--close px), holes are filled, and the mask grown (--grow px) "
                         "to take the sticker's own border back in")
    ap.add_argument("--close", type=int, default=5)
    ap.add_argument("--grow", type=int, default=2)
    ap.add_argument("--bg-expr", default=None,
                    help="numpy expression over r,g,b that is True on background, e.g. 'b - np.maximum(r,g) > 15' "
                         "for a patterned blue sheet (replaces the colour-distance test)")
    a = ap.parse_args()

    im = Image.open(a.sheet).convert("RGB")
    if a.crop:
        im = im.crop(tuple(int(v) for v in a.crop.split(",")))
    rgb = np.asarray(im).astype(np.float32)
    H, W, _ = rgb.shape
    b = a.border
    border = np.concatenate([rgb[:b].reshape(-1, 3), rgb[-b:].reshape(-1, 3),
                             rgb[:, :b].reshape(-1, 3), rgb[:, -b:].reshape(-1, 3)])
    bg = np.array([float(v) for v in a.bg.split(",")], dtype=np.float32) if a.bg else np.median(border, axis=0)
    dist = np.sqrt(((rgb - bg) ** 2).sum(-1))
    if a.bg_expr:
        r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
        cand = eval(a.bg_expr, {"np": np, "r": r, "g": g, "b": b})
        bg = np.median(rgb[cand], axis=0) if cand.any() else bg
    else:
        cand = dist < a.tol

    if a.fg_expr:
        r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
        ink = eval(a.fg_expr, {"np": np, "r": r, "g": g, "b": b})
        fg = ndi.binary_closing(ink, iterations=a.close, border_value=0)
        fg = ndi.binary_fill_holes(fg)
        fg = ndi.binary_opening(fg, iterations=2)
        fg = ndi.binary_dilation(fg, iterations=a.grow)
        bg = np.median(rgb[~fg], axis=0) if (~fg).any() else bg
    else:
        # background = candidate pixels connected to the border
        lab, n = ndi.label(cand)
        edge_labels = np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))
        edge_labels = edge_labels[edge_labels > 0]
        background = np.isin(lab, edge_labels)
        fg = ~background
        # drop tiny specks
        fg = ndi.binary_opening(fg, iterations=1)

    # group nearby pieces
    grouped = ndi.binary_dilation(fg, iterations=a.gap) if a.gap > 0 else fg
    glab, gn = ndi.label(grouped)
    objs = ndi.find_objects(glab)

    os.makedirs(a.outdir, exist_ok=True)
    prefix = a.prefix or os.path.splitext(os.path.basename(a.sheet))[0]
    manifest = []
    k = 0
    for i, sl in enumerate(objs, start=1):
        if sl is None:
            continue
        piece = (glab[sl] == i) & fg[sl]
        area = int(piece.sum())
        if area < a.min_area:
            continue
        ys, xs = np.where(piece)
        y0, y1 = ys.min(), ys.max() + 1
        x0, x1 = xs.min(), xs.max() + 1
        oy, ox = sl[0].start, sl[1].start
        crop_rgb = rgb[oy + y0:oy + y1, ox + x0:ox + x1]
        mask = piece[y0:y1, x0:x1].astype(np.float32)
        # soft edge: grow 1px then blur slightly
        # pull the edge in 1px (kills the pale fringe) then soften it
        mask = ndi.binary_erosion(mask > 0, iterations=1).astype(np.float32)
        if a.feather > 0:
            mask = ndi.gaussian_filter(mask, a.feather)
        alpha01 = np.clip(mask, 0, 1)
        # de-fringe: remove the share of the background colour from semi-transparent edge pixels
        rgbf = crop_rgb.copy()
        edge = (alpha01 > 0.02) & (alpha01 < 0.98)
        a_e = alpha01[edge][:, None]
        rgbf[edge] = np.clip((rgbf[edge] - (1 - a_e) * bg) / np.maximum(a_e, 0.2), 0, 255)
        alpha = (alpha01 * 255).astype(np.uint8)
        out = np.dstack([rgbf.astype(np.uint8), alpha])
        # pad 2px transparent margin
        out = np.pad(out, ((2, 2), (2, 2), (0, 0)))
        k += 1
        name = f"{prefix}_{k:02d}"
        fn = f"{name}.png"
        Image.fromarray(out, "RGBA").save(os.path.join(a.outdir, fn), optimize=True)
        manifest.append({"name": name, "file": fn, "w": int(out.shape[1]), "h": int(out.shape[0]),
                         "cx": int(ox + x0 + (x1 - x0) / 2), "cy": int(oy + y0 + (y1 - y0) / 2)})
    # sort reading order (rows of ~ sheet height/8)
    rowh = max(40, H // 10)
    manifest.sort(key=lambda m: (m["cy"] // rowh, m["cx"]))
    for j, m in enumerate(manifest, 1):
        m.pop("cx"); m.pop("cy")
    with open(os.path.join(a.outdir, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1)
    print(f"{a.sheet}: bg={bg.round().tolist()} -> {len(manifest)} stickers in {a.outdir}")


if __name__ == "__main__":
    main()
