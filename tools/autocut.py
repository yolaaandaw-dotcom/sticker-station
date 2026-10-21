#!/usr/bin/env python3
"""Automatic sticker-sheet cutter (no parameters needed).

A Python port of the in-browser cutter in cutter.js, so batch jobs and the
site cut the same way:
  1. background = median colour of the photo's outer ring
  2. Otsu threshold on colour distance, capped by how noisy the background is
  3. flood the background from the edge, then redo it against a blurred model
     of the background (handles lighting gradients)
  4. if one huge piece is left (sheet on a table / in packaging), its most
     common colour becomes a second background layer; a patterned backing
     that barely floods is retried comparing hue rather than brightness
  5. pieces within a few px are merged; specks dropped; pieces touching the
     photo edge are marked `edge` (usually cut off by the photo frame)
  6. each sticker is cropped with a soft edge and the background colour is
     removed from its edge pixels

    from autocut import cut_image
    stickers, info = cut_image(PIL.Image)   # list of dicts: rgba (PIL), bbox, area, edge
"""
import numpy as np
from PIL import Image
from scipy import ndimage as ndi

MAX_SIDE = 1600
CROSS = ndi.generate_binary_structure(2, 1)      # 4-connected
SQUARE = ndi.generate_binary_structure(2, 2)     # 8-connected


def _box(a, r):
    return ndi.uniform_filter(a, size=2 * r + 1, mode="nearest")


def _otsu(D, mask=None):
    v = D[mask] if mask is not None else D.ravel()
    if v.size == 0:
        return 40
    hist = np.bincount(np.clip(v, 0, 255).astype(np.int32), minlength=256).astype(np.float64)
    n = hist.sum(); idx = np.arange(256)
    wB = np.cumsum(hist); wF = n - wB
    sB = np.cumsum(idx * hist); total = sB[-1]
    with np.errstate(divide="ignore", invalid="ignore"):
        mB = sB / wB; mF = (total - sB) / wF
        var = wB * wF * (mB - mF) ** 2
    var[(wB == 0) | (wF == 0)] = -1
    return int(np.argmax(var))


def _pct(v, p):
    return float(np.percentile(v, p * 100)) if v.size else 0.0


class _Cutter:
    def __init__(self, rgb, sens=1.0):
        self.R, self.G, self.B = (rgb[..., i].astype(np.float32) for i in range(3))
        self.H, self.W = self.R.shape
        self.N = self.H * self.W
        self.sens = sens
        self.chroma = False
        self.MR = np.zeros_like(self.R); self.MG = np.zeros_like(self.R); self.MB = np.zeros_like(self.R)

    def dist(self, c, R=None, G=None, B=None):
        R = self.R if R is None else R; G = self.G if G is None else G; B = self.B if B is None else B
        if self.chroma:
            y1 = .299 * R + .587 * G + .114 * B
            if np.ndim(c[0]) == 0:
                y2 = .299 * c[0] + .587 * c[1] + .114 * c[2]
            else:
                y2 = .299 * c[0] + .587 * c[1] + .114 * c[2]
            dy = (y1 - y2) * .35; db = (B - y1) - (c[2] - y2); dr = (R - y1) - (c[0] - y2)
            return np.sqrt(dy * dy + db * db + dr * dr)
        return np.sqrt((R - c[0]) ** 2 + (G - c[1]) ** 2 + (B - c[2]) ** 2)

    def grow(self, D, seeds, thr, allowed=None):
        cand = D < thr
        sv = seeds & (D < thr * 1.6)
        if allowed is not None:
            cand &= allowed; sv &= allowed
        lab, n = ndi.label(cand | sv, structure=CROSS)
        keep = np.unique(lab[sv]); keep = keep[keep > 0]
        return np.isin(lab, keep)

    def keep_large(self, bgm):
        lab, n = ndi.label(bgm, structure=CROSS)
        if n == 0:
            return bgm
        sizes = np.bincount(lab.ravel())
        big = sizes >= self.N * .01; big[0] = False
        return big[lab]

    def layer(self, seeds, col, allowed=None):
        D = self.dist(col)
        if allowed is not None:
            D = np.where(allowed, D, 999)
        sd = D[seeds]; noise = _pct(sd[sd < 90], .75)
        o = _otsu(D, allowed)
        thr = np.clip(o if self.chroma else min(o, max(noise * 2.5, 20)), 12, 110) * self.sens
        bgm = self.grow(D, seeds, thr, allowed)
        rad = max(4, round(max(self.W, self.H) * .025))
        M = bgm.astype(np.float32); Mb = _box(_box(M, rad), rad)
        with np.errstate(divide="ignore", invalid="ignore"):
            k = np.where(Mb > .02, 1 / Mb, 0)
            mr = np.where(k > 0, _box(_box(self.R * M, rad), rad) * k, col[0])
            mg = np.where(k > 0, _box(_box(self.G * M, rad), rad) * k, col[1])
            mb = np.where(k > 0, _box(_box(self.B * M, rad), rad) * k, col[2])
        D2 = self.dist((mr, mg, mb))
        if allowed is not None:
            D2 = np.where(allowed, D2, 999)
        sd2 = D2[seeds]; noise2 = _pct(sd2[sd2 < 90], .75)
        o2 = _otsu(D2, allowed)
        thr2 = np.clip(o2 if self.chroma else min(o2, max(noise2 * 2.5, 20)), 10, 90) * self.sens
        bgm = self.grow(D2, seeds, thr2, allowed)
        sel = allowed if allowed is not None else np.ones_like(bgm)
        self.MR[sel] = mr[sel]; self.MG[sel] = mg[sel]; self.MB[sel] = mb[sel]
        return bgm

    def background(self):
        H, W = self.H, self.W
        ring = np.zeros((H, W), bool); ring[:3] = ring[-3:] = True; ring[:, :3] = ring[:, -3:] = True
        bg = [float(np.median(c[ring])) for c in (self.R, self.G, self.B)]
        bgAll = self.layer(ring, bg)
        seen = [bg]
        for _ in range(2):
            lab, n = ndi.label(~bgAll, structure=CROSS)
            if n == 0:
                break
            sizes = np.bincount(lab.ravel()); sizes[0] = 0
            best = int(np.argmax(sizes))
            if sizes[best] < self.N * .4:
                break
            inside = lab == best; insideN = int(sizes[best])
            q = ((self.R.astype(np.int32) >> 5) << 6) | ((self.G.astype(np.int32) >> 5) << 3) | (self.B.astype(np.int32) >> 5)
            hist = np.bincount(q[inside], minlength=512)
            centers = np.stack([((np.arange(512) >> 6) & 7) * 32 + 16, ((np.arange(512) >> 3) & 7) * 32 + 16, (np.arange(512) & 7) * 32 + 16], 1)
            for c in seen:
                hist[np.hypot(np.hypot(centers[:, 0] - c[0], centers[:, 1] - c[1]), centers[:, 2] - c[2]) < 45] = -1
            mb = int(np.argmax(hist))
            if hist[mb] < insideN * .06:
                break
            inBin = inside & (q == mb)
            col = [float(np.median(c[inBin])) for c in (self.R, self.G, self.B)]
            seeds2 = inside & (self.dist(col) < 22)
            more = self.keep_large(self.layer(seeds2, col, inside))
            if more.sum() < insideN * .25:              # printed / patterned backing: compare hue instead
                self.chroma = True
                more = self.keep_large(self.layer(seeds2, col, inside))
                self.chroma = False
            added = int((more & ~bgAll).sum())
            bgAll |= more
            if added < self.N * .05:
                break
            seen.append(col)
        return bgAll, seen


def cut_image(img, sens=1.0, gap=-1, min_edge_excluded=True):
    """Cut a sheet photo. Returns (stickers, info)."""
    im = img.convert("RGBA")
    k = min(1.0, MAX_SIDE / max(im.size))
    if k < 1:
        im = im.resize((max(1, round(im.width * k)), max(1, round(im.height * k))), Image.LANCZOS)
    a = np.asarray(im)
    rgb, alpha = a[..., :3], a[..., 3]
    H, W = alpha.shape; N = H * W
    info = {"size": [W, H]}
    if (alpha < 200).mean() > .03:                     # already cut out: use the alpha
        mode = "alpha"; fg = alpha > 40
        cutter = None
    else:
        mode = "colour"
        cutter = _Cutter(rgb, sens)
        bgAll, layers = cutter.background()
        info["layers"] = [[round(v) for v in c] for c in layers]
        fg = ~bgAll
        fg = ndi.binary_dilation(ndi.binary_erosion(fg, CROSS), SQUARE)
    info["mode"] = mode
    g = gap if gap >= 0 else max(1, round(np.hypot(W, H) * .0008))
    grp = ndi.binary_dilation(fg, np.ones((2 * g + 1, 2 * g + 1), bool)) if g > 0 else fg
    lab, n = ndi.label(grp, structure=SQUARE)
    lab = np.where(fg, lab, 0)
    if n == 0:
        return [], info
    areas = np.bincount(lab.ravel(), minlength=n + 1)
    objs = ndi.find_objects(lab)
    minArea = max(120, N * .0006)
    out = []
    for i, sl in enumerate(objs, start=1):
        if sl is None or areas[i] < minArea:
            continue
        y0, y1, x0, x1 = sl[0].start, sl[0].stop - 1, sl[1].start, sl[1].stop - 1
        edge = x0 <= 1 or y0 <= 1 or x1 >= W - 2 or y1 >= H - 2
        if mode == "colour" and areas[i] > N * .5:
            continue
        out.append(_crop(i, lab, rgb, alpha, mode, cutter, (x0, y0, x1, y1), int(areas[i]), edge))
    rowH = max(20, H / 10)
    out.sort(key=lambda s: (int(((s["bbox"][1] + s["bbox"][3]) / 2) // rowH), s["bbox"][0] + s["bbox"][2]))
    info["count"] = len(out); info["edge"] = sum(s["edge"] for s in out)
    return out, info


def _crop(i, lab, rgb, alpha, mode, cutter, bbox, area, edge):
    x0, y0, x1, y1 = bbox; pad = 2
    H, W = lab.shape
    ys = slice(max(0, y0 - pad), min(H, y1 + pad + 1)); xs = slice(max(0, x0 - pad), min(W, x1 + pad + 1))
    m = (lab[ys, xs] == i).astype(np.float32)
    if mode == "alpha":
        a = m * alpha[ys, xs] / 255.0
    else:
        e = ndi.minimum_filter(m, footprint=CROSS, mode="constant")
        a = np.maximum(e * .6, _box(e, 1))
    a = np.clip(a, 0, 1)
    c = rgb[ys, xs].astype(np.float32)
    if mode == "colour":
        edge_px = (a > .01) & (a < .98)
        ae = np.maximum(a, .25)[..., None]
        M = np.stack([cutter.MR[ys, xs], cutter.MG[ys, xs], cutter.MB[ys, xs]], -1)
        fixed = (c - (1 - ae) * M) / ae
        c = np.where(edge_px[..., None], fixed, c)
    rgba = np.dstack([np.clip(c, 0, 255), a * 255]).astype(np.uint8)
    rgba[a <= .01] = 0
    return {"rgba": Image.fromarray(rgba, "RGBA"), "bbox": [int(xs.start), int(ys.start), int(xs.stop), int(ys.stop)],
            "area": area, "edge": bool(edge)}


if __name__ == "__main__":
    import sys, json
    for path in sys.argv[1:]:
        st, info = cut_image(Image.open(path))
        print(path, json.dumps({k: v for k, v in info.items()}))
