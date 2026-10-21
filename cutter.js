/* ===========================================================
   StickerCutter — drop a photo of a sticker sheet, get stickers.
   Runs entirely in the browser (a Web Worker), no server, no AI.

   How it finds the stickers:
   1. Background colour = median of the photo's outer ring, or the
      spot(s) you click with the "click the background" picker.
   2. Otsu's method picks the colour distance that best splits
      background from stickers; "sensitivity" scales it.
   3. Background is flood-filled from the edge (or your clicks),
      so white inside a sticker on a white sheet stays sticker.
      The threshold is capped by how noisy the background itself is.
   4. A blurred model of the background is built from that fill
      (handles uneven lighting / gradients) and the fill is redone.
   4b. If one huge piece is left over (a sheet lying on a table, or
      inside its packaging), its most common colour becomes a second
      background layer and the fill is repeated inside it.
   5. Pieces closer than "merge" px become one sticker; specks
      are dropped; pieces touching the photo edge start excluded.
   6. Each sticker is cropped with a soft edge, and the background
      colour is removed from its edge pixels (no halo).
   If the image already has transparency, the alpha is used as is.
   =========================================================== */
(() => {
'use strict';

function workerMain() {
  let last = null;      // state of the latest cut, kept for export
  self.onmessage = e => {
    const m = e.data;
    try {
      if (m.type === 'cut') {
        last = cut(m);
        const labels = last.labels.slice();
        self.postMessage({ id: m.id, comps: last.comps, labels, w: m.w, h: m.h, mode: last.mode, bg: last.bg, info: last.info }, [labels.buffer]);
      } else if (m.type === 'export') {
        const out = m.ids.map(i => crop(last, i));
        self.postMessage({ id: m.id, crops: out }, out.map(o => o.rgba.buffer));
      }
    } catch (err) { self.postMessage({ id: m.id, error: String(err && err.stack || err) }); }
  };

  const clampi = (v, a, b) => v < a ? a : v > b ? b : v;
  function boxBlur(src, w, h, r) {
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h), n = 2 * r + 1;
    for (let y = 0; y < h; y++) {
      const o = y * w; let acc = 0;
      for (let x = -r; x <= r; x++) acc += src[o + clampi(x, 0, w - 1)];
      for (let x = 0; x < w; x++) { tmp[o + x] = acc / n; acc += src[o + Math.min(w - 1, x + r + 1)] - src[o + Math.max(0, x - r)]; }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += tmp[clampi(y, 0, h - 1) * w + x];
      for (let y = 0; y < h; y++) { out[y * w + x] = acc / n; acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x]; }
    }
    return out;
  }
  function otsu(D, mask) {
    const hist = new Float64Array(256); let n = 0;
    for (let i = 0; i < D.length; i++) { if (mask && !mask[i]) continue; hist[Math.min(255, D[i] | 0)]++; n++; }
    let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sB = 0, wB = 0, best = 0, thr = 40;
    for (let t = 0; t < 256; t++) {
      wB += hist[t]; if (!wB) continue; const wF = n - wB; if (!wF) break;
      sB += t * hist[t]; const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) * (mB - mF);
      if (v > best) { best = v; thr = t; }
    }
    return thr;
  }
  // flood the background from the seeds
  function grow(R, G, B, D, w, h, seeds, thr, allowed) {
    const N = w * h, bgm = new Uint8Array(N), q = new Int32Array(N); let qh = 0, qt = 0;
    for (const s of seeds) if (!bgm[s] && D[s] < thr * 1.6 && (!allowed || allowed[s])) { bgm[s] = 1; q[qt++] = s; }
    while (qh < qt) {
      const p = q[qh++], x = p % w, y = (p - x) / w;
      const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
      for (const k of nb) {
        if (k < 0 || bgm[k] || (allowed && !allowed[k])) continue;
        if (D[k] < thr) { bgm[k] = 1; q[qt++] = k; }
      }
    }
    return bgm;
  }
  function erode(m, w, h) {
    const o = new Uint8Array(m.length);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x;
      o[i] = m[i] && m[i - 1] && m[i + 1] && m[i - w] && m[i + w] ? 1 : 0; }
    return o;
  }
  function dilate(m, w, h, r) {
    if (r <= 0) return m;
    const b = boxBlur(Float32Array.from(m), w, h, r), o = new Uint8Array(m.length);
    for (let i = 0; i < m.length; i++) o[i] = b[i] > 1e-4 ? 1 : 0;
    return o;
  }

  function cut({ rgba, w, h, sens = 1, gap = -1, seeds = [], bg: bgPick = null }) {
    const N = w * h, R = new Float32Array(N), G = new Float32Array(N), B = new Float32Array(N);
    let transparent = 0;
    for (let i = 0; i < N; i++) { R[i] = rgba[i * 4]; G[i] = rgba[i * 4 + 1]; B[i] = rgba[i * 4 + 2]; if (rgba[i * 4 + 3] < 200) transparent++; }
    let fg, mode, bg = [0, 0, 0], MR = null, MG = null, MB = null;

    if (transparent > N * .03) {                 // already cut out: use the alpha
      mode = 'alpha';
      fg = new Uint8Array(N); for (let i = 0; i < N; i++) fg[i] = rgba[i * 4 + 3] > 40 ? 1 : 0;
    } else {
      mode = 'colour';
      var info = [];
      MR = new Float32Array(N); MG = new Float32Array(N); MB = new Float32Array(N);
      // when you click a background colour, compare colour more than brightness (printed patterns,
      // folds and glare change brightness, not hue); automatic mode uses plain RGB distance
      let chroma = !!bgPick;
      const distC = (i, c) => { const y1 = .299 * R[i] + .587 * G[i] + .114 * B[i], y2 = .299 * c[0] + .587 * c[1] + .114 * c[2];
                      const dy = (y1 - y2) * .35, db = (B[i] - y1) - (c[2] - y2), dr = (R[i] - y1) - (c[0] - y2);
                      return Math.sqrt(dy * dy + db * db + dr * dr); };
      const distRGB = (i, c) => { const dr = R[i] - c[0], dg = G[i] - c[1], db = B[i] - c[2]; return Math.sqrt(dr * dr + dg * dg + db * db); };
      const dist = (i, c) => chroma ? distC(i, c) : distRGB(i, c);
      const distTo = (i, r, g, b) => dist(i, [r, g, b]);
      const med = idx => { const m = a => { const v = idx.map(i => a[i]).sort((p, q) => p - q); return v[v.length >> 1]; }; return [m(R), m(G), m(B)]; };
      const pct = (arr, p) => { if (!arr.length) return 0; const v = Float32Array.from(arr).sort(); return v[Math.min(v.length - 1, Math.floor(v.length * p))]; };
      // one background layer: flood from the seeds inside `allowed`, then redo it against a
      // blurred model of that background so lighting gradients and printed patterns cancel out
      const layer = (seedIdx, col, allowed) => {
        const D = new Float32Array(N);
        for (let i = 0; i < N; i++) D[i] = allowed && !allowed[i] ? 999 : dist(i, col);
        const noise = pct(seedIdx.map(i => D[i]).filter(v => v < 90), .75);
        let thr = clampi(chroma ? otsu(D, allowed) : Math.min(otsu(D, allowed), Math.max(noise * 2.5, 20)), 12, 110) * sens;
        let bgm = grow(R, G, B, D, w, h, seedIdx, thr, allowed);
        const rad = Math.max(4, Math.round(Math.max(w, h) * .025));
        const M = Float32Array.from(bgm), Mb = boxBlur(boxBlur(M, w, h, rad), w, h, rad);
        const blurC = C => { const t = new Float32Array(N); for (let i = 0; i < N; i++) t[i] = C[i] * M[i]; return boxBlur(boxBlur(t, w, h, rad), w, h, rad); };
        const BR = blurC(R), BG = blurC(G), BB = blurC(B);
        const mr = new Float32Array(N), mg = new Float32Array(N), mb = new Float32Array(N);
        for (let i = 0; i < N; i++) {
          const k = Mb[i] > .02 ? 1 / Mb[i] : 0;
          mr[i] = k ? BR[i] * k : col[0]; mg[i] = k ? BG[i] * k : col[1]; mb[i] = k ? BB[i] * k : col[2];
          if (allowed && !allowed[i]) { D[i] = 999; continue; }
          D[i] = distTo(i, mr[i], mg[i], mb[i]);
        }
        // noise is measured on the seeds only: they are background by construction
        const noise2 = pct(seedIdx.map(i => D[i]).filter(v => v < 90), .75);
        const thr2 = clampi(chroma ? otsu(D, allowed) : Math.min(otsu(D, allowed), Math.max(noise2 * 2.5, 20)), 10, 90) * sens;
        bgm = grow(R, G, B, D, w, h, seedIdx, thr2, allowed);
        let cnt = 0; for (let i = 0; i < N; i++) cnt += bgm[i];
        info.push({ col: col.map(Math.round), noise: +noise.toFixed(1), thr: +thr.toFixed(1), noise2: +noise2.toFixed(1), thr2: +thr2.toFixed(1), frac: +(cnt / N).toFixed(3) });
        for (let i = 0; i < N; i++) if (!allowed || allowed[i]) { MR[i] = mr[i]; MG[i] = mg[i]; MB[i] = mb[i]; }
        return bgm;
      };
      // only big connected stretches count as background (drops sticker-coloured patches inside stickers)
      const keepLarge = bgm => {
        const lab = new Int32Array(N), q = new Int32Array(N), min = N * .01; let nl = 0;
        for (let s0 = 0; s0 < N; s0++) {
          if (!bgm[s0] || lab[s0]) continue;
          nl++; let qh = 0, qt = 0; q[qt++] = s0; lab[s0] = nl;
          while (qh < qt) { const p = q[qh++], x = p % w;
            for (const k of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) if (k >= 0 && k < N && bgm[k] && !lab[k]) { lab[k] = nl; q[qt++] = k; } }
          if (qt < min) for (let j = 0; j < qt; j++) bgm[q[j]] = 0;
        }
        return bgm;
      };
      const ring = [];
      for (let x = 0; x < w; x++) for (const y of [0, 1, 2, h - 3, h - 2, h - 1]) ring.push(y * w + x);
      for (let y = 3; y < h - 3; y++) for (const x of [0, 1, 2, w - 3, w - 2, w - 1]) ring.push(y * w + x);
      let bgAll;
      if (bgPick) {
        bg = bgPick;
        // a click stands for the background around it: take a small disc so a printed pattern sets the tolerance
        const rad = Math.max(6, Math.round(Math.max(w, h) * .015)), disc = [];
        for (const sd of seeds) { const sx = sd % w, sy = (sd - sx) / w;
          for (let dy = -rad; dy <= rad; dy += 2) for (let dx = -rad; dx <= rad; dx += 2) {
            const x = sx + dx, y = sy + dy; if (x < 0 || y < 0 || x >= w || y >= h || dx * dx + dy * dy > rad * rad) continue;
            const i = y * w + x; if (dist(i, bg) < 70) disc.push(i); } }
        bg = med(disc.length ? disc : seeds);
        bgAll = keepLarge(layer(disc.concat(seeds, ring.filter(i => dist(i, bg) < 40)), bg, null));
      } else {
        bg = med(ring);
        bgAll = layer(ring, bg, null);
        const layersCol = [bg];
        // sheets photographed on a table / inside packaging: if one huge piece is left, it is
        // probably the sheet itself, so its most common colour becomes the next background layer
        for (let pass = 0; pass < 2; pass++) {
          const lab = new Int32Array(N), q = new Int32Array(N); let best = 0, bestN = 0, nl = 0;
          for (let s0 = 0; s0 < N; s0++) {
            if (bgAll[s0] || lab[s0]) continue;
            nl++; let qh = 0, qt = 0; q[qt++] = s0; lab[s0] = nl;
            while (qh < qt) { const p = q[qh++], x = p % w;
              for (const k of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) if (k >= 0 && k < N && !bgAll[k] && !lab[k]) { lab[k] = nl; q[qt++] = k; } }
            if (qt > bestN) { bestN = qt; best = nl; }
          }
          if (bestN < N * .4) break;
          const inside = new Uint8Array(N); let insideN = 0;
          for (let i = 0; i < N; i++) if (lab[i] === best) { inside[i] = 1; insideN++; }
          // the sheet's own colour = the most common colour in that piece (stickers are many different colours)
          const bin = i => ((R[i] >> 5) << 6) | ((G[i] >> 5) << 3) | (B[i] >> 5);     // 8 levels per channel
          const hist = new Uint32Array(512);
          for (let i = 0; i < N; i++) if (inside[i]) hist[bin(i)]++;
          // skip colours that are just the previous layer again (e.g. glare on the plastic sleeve)
          const binCol = b => [((b >> 6) & 7) * 32 + 16, ((b >> 3) & 7) * 32 + 16, (b & 7) * 32 + 16];
          const seen = b => layersCol.some(c => Math.hypot(binCol(b)[0] - c[0], binCol(b)[1] - c[1], binCol(b)[2] - c[2]) < 45);
          let mb = -1; for (let b = 0; b < 512; b++) if (!seen(b) && (mb < 0 || hist[b] > hist[mb])) mb = b;
          if (mb < 0) break;
          if (hist[mb] < insideN * .06) break;           // no dominant colour: it is one big sticker, not a sheet
          const inBin = []; for (let i = 0; i < N; i += 2) if (inside[i] && bin(i) === mb) inBin.push(i);
          const col = med(inBin);
          const seeds2 = []; for (let i = 0; i < N; i += 3) if (inside[i] && dist(i, col) < 22) seeds2.push(i);
          let more = keepLarge(layer(seeds2, col, inside));
          let got = 0; for (let i = 0; i < N; i++) got += more[i];
          if (got < insideN * .25) {                 // a printed / patterned backing: compare hue instead of brightness
            chroma = true; more = keepLarge(layer(seeds2, col, inside)); chroma = false;
          }
          let added = 0; for (let i = 0; i < N; i++) if (more[i]) { bgAll[i] = 1; added++; }
          if (added < N * .05) break;
          bg = col; layersCol.push(col);
        }
      }
      fg = new Uint8Array(N); for (let i = 0; i < N; i++) fg[i] = bgAll[i] ? 0 : 1;
      fg = dilate(erode(fg, w, h), w, h, 1);     // drop 1-px noise
    }

    // group pieces that sit within `gap` px of each other
    const g = gap >= 0 ? gap : Math.max(1, Math.round(Math.hypot(w, h) * .0008));
    const grp = dilate(fg, w, h, g);
    const lab = new Int32Array(N), q = new Int32Array(N); let nl = 0;
    for (let s = 0; s < N; s++) {
      if (!grp[s] || lab[s]) continue;
      nl++; let qh = 0, qt = 0; q[qt++] = s; lab[s] = nl;
      while (qh < qt) {
        const p = q[qh++], x = p % w, y = (p - x) / w;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const k = yy * w + xx; if (grp[k] && !lab[k]) { lab[k] = nl; q[qt++] = k; }
        }
      }
    }
    const st = [];
    for (let i = 0; i <= nl; i++) st.push({ area: 0, x0: w, y0: h, x1: -1, y1: -1 });
    for (let i = 0; i < N; i++) {
      if (!fg[i]) continue; const s = st[lab[i]], x = i % w, y = (i - x) / w;
      s.area++; if (x < s.x0) s.x0 = x; if (x > s.x1) s.x1 = x; if (y < s.y0) s.y0 = y; if (y > s.y1) s.y1 = y;
    }
    const minArea = Math.max(120, N * .0006);
    const remap = new Int32Array(nl + 1), comps = [];
    for (let i = 1; i <= nl; i++) {
      const s = st[i]; if (s.area < minArea) continue;
      const edge = s.x0 <= 1 || s.y0 <= 1 || s.x1 >= w - 2 || s.y1 >= h - 2;
      comps.push({ x0: s.x0, y0: s.y0, x1: s.x1, y1: s.y1, area: s.area, excluded: mode === 'colour' && (edge || s.area > N * .5) });
      remap[i] = comps.length;
    }
    // reading order: rows, then left to right
    const rowH = Math.max(20, h / 10);
    const order = comps.map((c, i) => i).sort((a, b) => {
      const A = comps[a], B2 = comps[b];
      const ra = Math.floor((A.y0 + A.y1) / 2 / rowH), rb = Math.floor((B2.y0 + B2.y1) / 2 / rowH);
      return ra - rb || (A.x0 + A.x1) - (B2.x0 + B2.x1);
    });
    const rank = new Int32Array(comps.length); order.forEach((ci, r) => { rank[ci] = r; });
    const sorted = order.map(i => comps[i]);
    const labels = new Uint16Array(N);
    for (let i = 0; i < N; i++) { const c = fg[i] ? remap[lab[i]] : 0; labels[i] = c ? rank[c - 1] + 1 : 0; }
    return { comps: sorted, labels, fg, rgba, w, h, mode, bg, MR, MG, MB, info: typeof info !== 'undefined' ? info : [] };
  }

  // one sticker: soft alpha edge, background colour taken out of the edge pixels
  function crop(st, ci) {
    const { labels, rgba, w, mode, MR, MG, MB } = st, c = st.comps[ci], pad = 2, id = ci + 1;
    const cw = c.x1 - c.x0 + 1 + pad * 2, chh = c.y1 - c.y0 + 1 + pad * 2;
    const m = new Float32Array(cw * chh);
    for (let y = 0; y < chh; y++) for (let x = 0; x < cw; x++) {
      const sx = c.x0 - pad + x, sy = c.y0 - pad + y;
      if (sx < 0 || sy < 0 || sx >= st.w || sy >= st.h) continue;
      const i = sy * w + sx;
      if (labels[i] === id) m[y * cw + x] = mode === 'alpha' ? rgba[i * 4 + 3] / 255 : 1;
    }
    let a = m;
    if (mode === 'colour') {
      const e = new Float32Array(cw * chh);           // pull the edge in by 1 px, then soften it
      for (let y = 1; y < chh - 1; y++) for (let x = 1; x < cw - 1; x++) { const i = y * cw + x;
        e[i] = Math.min(m[i], m[i - 1], m[i + 1], m[i - cw], m[i + cw]); }
      a = boxBlur(e, cw, chh, 1);
      for (let i = 0; i < a.length; i++) a[i] = Math.max(e[i] * .6, a[i]);
    }
    const out = new Uint8ClampedArray(cw * chh * 4);
    for (let y = 0; y < chh; y++) for (let x = 0; x < cw; x++) {
      const k = y * cw + x, al = Math.min(1, a[k]); if (al <= .01) continue;
      const sx = c.x0 - pad + x, sy = c.y0 - pad + y, i = sy * w + sx;
      let r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
      if (mode === 'colour' && al < .98) {
        const ae = Math.max(al, .25);
        r = (r - (1 - ae) * MR[i]) / ae; g = (g - (1 - ae) * MG[i]) / ae; b = (b - (1 - ae) * MB[i]) / ae;
      }
      out[k * 4] = r; out[k * 4 + 1] = g; out[k * 4 + 2] = b; out[k * 4 + 3] = al * 255;
    }
    return { w: cw, h: chh, rgba: out };
  }
}

// ---------- worker plumbing ----------
let worker = null, seq = 0; const pending = new Map();
function call(msg, transfer) {
  if (!worker) {
    worker = new Worker(URL.createObjectURL(new Blob([`(${workerMain.toString()})()`], { type: 'text/javascript' })));
    worker.onmessage = e => { const p = pending.get(e.data.id); if (!p) return; pending.delete(e.data.id); e.data.error ? p.rej(new Error(e.data.error)) : p.res(e.data); };
  }
  const id = ++seq;
  return new Promise((res, rej) => { pending.set(id, { res, rej }); worker.postMessage({ ...msg, id }, transfer || []); });
}

const MAX_SIDE = 1600;
function toImageData(img) {
  const k = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height));
  const w = Math.max(1, Math.round((img.naturalWidth || img.width) * k)), h = Math.max(1, Math.round((img.naturalHeight || img.height) * k));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0, w, h);
  return { data: g.getImageData(0, 0, w, h), canvas: c };
}
async function runCut(id, opts) {
  return call({ type: 'cut', rgba: id.data, w: id.width, h: id.height, ...opts });
}
async function exportCrops(ids) {
  const r = await call({ type: 'export', ids });
  return Promise.all(r.crops.map(cr => new Promise(res => {
    const c = document.createElement('canvas'); c.width = cr.w; c.height = cr.h;
    c.getContext('2d').putImageData(new ImageData(cr.rgba, cr.w, cr.h), 0, 0);
    c.toBlob(b => res({ blob: b, w: cr.w, h: cr.h }), 'image/png');
  })));
}

// ---------- the modal ----------
const T = (k, v) => (window.I18N ? I18N.t(k, v) : k);
const PALETTE = [[255, 64, 160], [40, 170, 255], [255, 170, 0], [60, 210, 120], [170, 90, 255], [255, 90, 60]];
function buildModal(materials) {
  const el = document.createElement('div'); el.className = 'modal'; el.hidden = true;
  el.innerHTML = `
  <section class="window cut-window" role="dialog" aria-label="sticker cutter">
    <div class="titlebar"><span class="tb-lines"></span><span class="tb-title">${T('cutTitle')}</span><span class="tb-lines"></span></div>
    <div class="cut-body">
      <div class="cut-stage"><canvas class="cut-canvas"></canvas><div class="cut-busy" hidden>${T('cutBusy')}</div></div>
      <aside class="cut-side">
        <label class="cut-row">${T('cutName')} <input class="cut-name" maxlength="16"></label>
        <label class="cut-row">${T('material')} <select class="cut-mat">${materials.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
        <label class="cut-row col">${T('cutSens')} <span class="cut-hint">${T('cutSensHint')}</span>
          <input type="range" class="cut-sens" min="0.4" max="2.2" step="0.05" value="1"></label>
        <label class="cut-row col">${T('cutGap')} <span class="cut-hint">${T('cutGapHint')}</span>
          <input type="range" class="cut-gap" min="0" max="10" step="1" value="2"></label>
        <button type="button" class="pill cut-pick" aria-pressed="false">${T('cutPick')}</button>
        <button type="button" class="pill cut-reset">${T('cutReset')}</button>
        <p class="cut-info"></p>
        <div class="cut-actions">
          <button type="button" class="pill cut-cancel">${T('cutCancel')}</button>
          <button type="button" class="pill cut-ok">${T('cutOk')}</button>
        </div>
      </aside>
    </div>
  </section>`;
  document.body.append(el);
  return el;
}

let modal = null;
function open(img, { name = '', material = 'vinyl', materials }) {
  if (!modal) modal = buildModal(materials);
  const $ = s => modal.querySelector(s);
  const cv = $('.cut-canvas'), cx = cv.getContext('2d');
  const { data } = toImageData(img);
  const W = data.width, H = data.height;
  cv.width = W; cv.height = H;
  $('.cut-name').value = name; $('.cut-mat').value = material;
  $('.cut-sens').value = 1; $('.cut-gap').value = Math.max(1, Math.round(Math.hypot(W, H) * .0008));
  let res = null, seeds = [], bgPick = null, picking = false, busy = false, again = false;
  const pickBtn = $('.cut-pick');
  const setPicking = v => { picking = v; pickBtn.setAttribute('aria-pressed', String(v)); cv.style.cursor = v ? 'crosshair' : 'pointer'; };
  setPicking(false);

  function draw() {
    if (!res) { cx.putImageData(data, 0, 0); return; }              // first frame: the plain photo while it cuts
    const out = cx.createImageData(W, H), d = out.data, src = data.data;
    const L = res.labels;
    for (let i = 0; i < W * H; i++) {
      const j = i * 4; let r = src[j], g = src[j + 1], b = src[j + 2];
      const id = L[i];
      if (!id) { r = r * .25 + 30; g = g * .25 + 30; b = b * .25 + 34; }            // background dimmed
      else if (res.comps[id - 1].excluded) { const v = (r + g + b) / 3 * .45; r = v + 90; g = v * .7; b = v * .7; }
      else {
        const x = i % W, y = (i - x) / W;
        const edge = x === 0 || y === 0 || x === W - 1 || y === H - 1 || L[i - 1] !== id || L[i + 1] !== id || L[i - W] !== id || L[i + W] !== id;
        if (edge) { const c = PALETTE[(id - 1) % PALETTE.length]; r = c[0]; g = c[1]; b = c[2]; }
      }
      d[j] = r; d[j + 1] = g; d[j + 2] = b; d[j + 3] = 255;
    }
    cx.putImageData(out, 0, 0);
    {
      const n = res.comps.filter(c => !c.excluded).length, ex = res.comps.length - n;
      $('.cut-info').innerHTML = T('cutFound', { n }) + (ex ? T('cutExcluded', { ex }) : '') + T('cutClickTip');
      $('.cut-ok').disabled = !n;
    }
  }
  async function recut() {
    if (busy) { again = true; return; }
    busy = true; $('.cut-busy').hidden = false;
    try {
      const keep = res ? res.comps.map(c => [c, c.excluded]) : [];
      res = await runCut(data, { sens: +$('.cut-sens').value, gap: +$('.cut-gap').value, seeds, bg: bgPick });
      // keep manual include/exclude choices for pieces that survive the recut
      for (const c of res.comps) { const o = keep.find(([k]) => Math.abs(k.x0 - c.x0) + Math.abs(k.y0 - c.y0) + Math.abs(k.x1 - c.x1) + Math.abs(k.y1 - c.y1) < 8); if (o) c.excluded = o[1]; }
      draw();
    } catch (err) { $('.cut-info').textContent = T('cutErr') + err.message; console.error(err); }
    busy = false; $('.cut-busy').hidden = true;
    if (again) { again = false; recut(); }
  }
  let deb; const recutSoon = () => { clearTimeout(deb); deb = setTimeout(recut, 140); };

  const ptAt = e => { const r = cv.getBoundingClientRect(); return [Math.floor((e.clientX - r.left) / r.width * W), Math.floor((e.clientY - r.top) / r.height * H)]; };
  cv.onclick = e => {
    const [x, y] = ptAt(e); if (x < 0 || y < 0 || x >= W || y >= H) return;
    if (picking) {
      const i = y * W + x, s = data.data;
      bgPick = [s[i * 4], s[i * 4 + 1], s[i * 4 + 2]]; seeds.push(i); setPicking(false); recut(); return;
    }
    if (!res) return;
    let id = res.labels[y * W + x];
    if (!id) {                                     // forgive near misses on thin stickers
      for (let r = 1; r <= 6 && !id; r++) for (const [dx, dy] of [[r, 0], [-r, 0], [0, r], [0, -r]]) {
        const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < W && yy < H && res.labels[yy * W + xx]) { id = res.labels[yy * W + xx]; break; }
      }
    }
    if (id) { res.comps[id - 1].excluded = !res.comps[id - 1].excluded; draw(); }
  };
  pickBtn.onclick = () => setPicking(!picking);
  $('.cut-reset').onclick = () => { seeds = []; bgPick = null; $('.cut-sens').value = 1; res = null; recut(); };
  $('.cut-sens').oninput = recutSoon; $('.cut-gap').oninput = recutSoon;

  modal.hidden = false;
  draw(); recut();
  return new Promise(resolve => {
    const close = v => { modal.hidden = true; cv.onclick = null; $('.cut-busy').hidden = true; $('.cut-busy').textContent = T('cutBusy'); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = e => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKey);
    $('.cut-cancel').onclick = () => close(null);
    $('.cut-ok').onclick = async () => {
      if (!res) return;
      $('.cut-busy').hidden = false; $('.cut-busy').textContent = T('cutPacking');
      const ids = res.comps.map((c, i) => c.excluded ? -1 : i).filter(i => i >= 0);
      let stickers;
      try { stickers = await exportCrops(ids); }
      catch (err) { console.error(err); $('.cut-info').textContent = T('cutPackErr') + err.message; $('.cut-busy').hidden = true; return; }
      close({ label: $('.cut-name').value.trim() || name || T('cutNewSheet'), material: $('.cut-mat').value, stickers });
    };
  });
}

// cut without the modal: used to decide whether an import is one sticker or a whole sheet
async function quickCut(img) {
  const { data } = toImageData(img);
  const r = await runCut(data, {});
  return { mode: r.mode, count: r.comps.filter(c => !c.excluded).length };
}

// language changed: rebuild the window next time it opens
function relang() { if (modal && modal.hidden) { modal.remove(); modal = null; } }
window.StickerCutter = { open, quickCut, runCut, toImageData, relang };
})();
