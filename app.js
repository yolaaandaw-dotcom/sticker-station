/* ===========================================================
   Sticker Station — peel, drag, stick. Materials react to a
   light that follows the pointer (or drifts when idle).
   =========================================================== */
(() => {
'use strict';

const $ = s => document.querySelector(s);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (a, b) => a + Math.random() * (b - a);
const pick = arr => arr[Math.floor(Math.random() * arr.length)];

const t = (k, v) => I18N.t(k, v);
const MATERIAL_KEYS = ['crystal', 'glitter', 'holo', 'foil', 'puffy', 'felt', 'paper', 'vinyl'];
const materialList = () => MATERIAL_KEYS.map(k => [k, t('m_' + k)]);
const PAPERS = ['paper-white', 'paper-grid', 'paper-lined', 'paper-kraft', 'paper-pink', 'paper-black'];
const MAX_TRAY = 104, MAX_CANVAS = 190, K_TRAY = .42, K_CANVAS = .66;
const STORE_KEY = 'sticker-station-v1';

const sheets = (window.STICKER_SHEETS || []).map(s => ({ ...s }));
const mine = { id: 'mine', label: { en: 'Mine', zh: '我的' }, material: 'vinyl', items: [] };
sheets.push(mine);

// ---------- state ----------
let state = { placed: [], paper: 0, sound: true, customs: [], total: 0, zTop: 1, material: 'auto', sheet: sheets[0].id, lang: I18N.lang };
try { Object.assign(state, JSON.parse(localStorage.getItem(STORE_KEY) || '{}')); } catch (e) {}
mine.items = state.customs;
let saveTimer;
const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { console.warn('storage full', e); }
}, 200); };

// ---------- imported sheets live in IndexedDB (localStorage is too small for images) ----------
const DB = (() => {
  let p = null;
  const open = () => p || (p = new Promise((res, rej) => {
    const r = indexedDB.open('sticker-station', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const tx = async (mode, fn) => { const db = await open(); return new Promise((res, rej) => {
    const t = db.transaction('kv', mode), req = fn(t.objectStore('kv'));
    t.oncomplete = () => res(req && req.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  }); };
  return { get: k => tx('readonly', s => s.get(k)), set: (k, v) => tx('readwrite', s => s.put(v, k)), del: k => tx('readwrite', s => s.delete(k)) };
})();
const FILES = new Map();                     // "idb:..." key -> object URL for this session
const fileURL = key => FILES.get(key) || key;

// ---------- DOM ----------
const canvasEl = $('#canvas'), trayEl = $('#tray'), floatLayer = $('#float-layer'),
      trayWindow = $('#tray-window'), ctxMenu = $('#ctx-menu'), matSelect = $('#material-select'),
      tabsEl = $('#tray-tabs'), countEl = $('#count'), odoEl = $('#odometer');

// ---------- procedural textures (set once as CSS vars) ----------
function makeGlitter(size, count, colors, minS, maxS) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d');
  for (let i = 0; i < count; i++) {
    g.fillStyle = pick(colors); g.globalAlpha = rand(.35, 1);
    const s = rand(minS, maxS);
    g.save(); g.translate(rand(0, size), rand(0, size)); g.rotate(rand(0, Math.PI));
    g.fillRect(-s / 2, -s / 2, s, s); g.restore();
  }
  return `url(${c.toDataURL()})`;
}
function makeNoise(size) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d'); const d = g.createImageData(size, size);
  for (let i = 0; i < d.data.length; i += 4) { const v = 128 + (Math.random() - .5) * 150; d.data[i] = d.data[i + 1] = d.data[i + 2] = v; d.data[i + 3] = 255; }
  g.putImageData(d, 0, 0);
  return `url(${c.toDataURL()})`;
}
const SPARKLE = 'url("data:image/svg+xml;utf8,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><path d="M20 0 C21 12 28 19 40 20 C28 21 21 28 20 40 C19 28 12 21 0 20 C12 19 19 12 20 0Z" fill="white"/></svg>`) + '")';
const root = document.documentElement.style;
root.setProperty('--glitter',  makeGlitter(128, 900, ['#fff', '#fff', '#ffe9f7', '#c8f6ff', '#fff6b0', '#ffc2e9', '#b4ffe0'], 1.2, 3.2));
root.setProperty('--glitter2', makeGlitter(96, 160, ['#fff', '#fff', '#ff9ad5', '#8ef0ff', '#fff28a'], 2, 4.5));
root.setProperty('--noise', makeNoise(128));
root.setProperty('--sparkle', SPARKLE);

// ---------- sound (synthesised, no files) ----------
let actx;
const ac = () => { if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); return actx; };
function noise(ctx, dur) {
  const b = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate); const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; return b;
}
// one cached second of white noise, played from random offsets
let NZ = null;
const noiseBuf = c => NZ || (NZ = noise(c, 1));
function envTo(c, node, t, peak, dur, attack = .002) {
  const g = c.createGain(); g.gain.setValueAtTime(.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(.0002, peak), t + attack); g.gain.exponentialRampToValueAtTime(.0001, t + dur);
  node.connect(g).connect(c.destination); return g;
}
function nz(c, t, dur, type, f, q, peak, attack) {
  const s = c.createBufferSource(); s.buffer = noiseBuf(c);
  const fl = c.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q || 1;
  s.connect(fl); envTo(c, fl, t, peak, dur, attack); s.start(t, Math.random() * .9); s.stop(t + dur + .02); return fl;
}
function tone(c, t, type, f0, f1, dur, peak) {
  const o = c.createOscillator(); o.type = type; o.frequency.setValueAtTime(f0, t);
  if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  envTo(c, o, t, peak, dur); o.start(t); o.stop(t + dur + .02); return o;
}

// ---- how each material peels ----
//  gain   pointer travel -> fold travel (lower = you have to pull further)
//  hold   px of tension the glue holds before it gives way
//  creep  how fast the glue yields while held under tension (per frame)
//  slip   share of the tension released when it gives way
//  detach share of the sticker that must be lifted before it comes off
//  back   damping of the spring-back when you let go early
const PEEL = {
  paper:   { gain: 1.0,  hold: 2,  creep: .5,  slip: .95, detach: .42, back: .62 },
  felt:    { gain: .95,  hold: 2,  creep: .45, slip: .9,  detach: .38, back: .72 },
  glitter: { gain: .85,  hold: 6,  creep: .2,  slip: .65, detach: .5,  back: .64 },
  holo:    { gain: .85,  hold: 7,  creep: .18, slip: .6,  detach: .5,  back: .6 },
  crystal: { gain: .8,   hold: 10, creep: .12, slip: .55, detach: .5,  back: .55 },
  foil:    { gain: .75,  hold: 12, creep: .1,  slip: .45, detach: .55, back: .5 },
  puffy:   { gain: .7,   hold: 9,  creep: .14, slip: .5,  detach: .55, back: .78 },
  vinyl:   { gain: .65,  hold: 15, creep: .06, slip: .4,  detach: .6,  back: .45 },
};
// ---- how each material sounds while peeling: a filtered hiss plus its own grain ----
const PSND = {
  paper:   { ft: 'bandpass', f0: 1800, f1: 5200, q: .9,  g: .30, kind: 'click',   rate: 1.0 },
  felt:    { ft: 'lowpass',  f0: 600,  f1: 1700, q: .5,  g: .24, kind: 'scratch', rate: .35 },
  glitter: { ft: 'highpass', f0: 3200, f1: 6500, q: .7,  g: .16, kind: 'grain',   rate: 2.6 },
  holo:    { ft: 'bandpass', f0: 2400, f1: 6000, q: 1.6, g: .22, kind: 'crinkle', rate: 1.2 },
  crystal: { ft: 'bandpass', f0: 1200, f1: 3200, q: 1,   g: .20, kind: 'tick',    rate: .5 },
  foil:    { ft: 'bandpass', f0: 3000, f1: 8000, q: 2.5, g: .20, kind: 'crinkle', rate: 1.6 },
  puffy:   { ft: 'lowpass',  f0: 450,  f1: 1100, q: .7,  g: .28, kind: 'squish',  rate: .45 },
  vinyl:   { ft: 'bandpass', f0: 380,  f1: 1500, q: 1.1, g: .36, kind: 'suck',    rate: .55 },
};
const GRAIN = {
  click:   (c, t, v) => nz(c, t, .012, 'highpass', rand(2500, 6500), .7, .05 + v * .3),
  scratch: (c, t, v) => nz(c, t, .035, 'bandpass', rand(900, 2000), 2, .03 + v * .12, .006),
  grain:   (c, t, v) => { for (let i = 0; i < 3; i++) nz(c, t + i * rand(.003, .012), .004, 'highpass', rand(5000, 9500), .7, .02 + v * .14); },
  crinkle: (c, t, v) => nz(c, t, .03, 'bandpass', rand(2200, 9000), 14, .1 + v * .55),
  tick:    (c, t, v) => { tone(c, t, 'sine', rand(2800, 4600), 0, .018, .03 + v * .12); nz(c, t, .004, 'highpass', 4000, .7, .04 + v * .15); },
  squish:  (c, t, v) => { tone(c, t, 'triangle', rand(180, 260), rand(100, 140), .06, .04 + v * .14); nz(c, t, .05, 'lowpass', 700, .7, .03 + v * .1, .01); },
  suck:    (c, t, v) => { tone(c, t, 'sine', rand(140, 240), 70, .05, .06 + v * .2); nz(c, t, .04, 'lowpass', 1100, .9, .04 + v * .16, .004); },
};
const DETACH = {     // the last bit of glue letting go
  paper:   (c, t) => { const f = nz(c, t, .09, 'bandpass', 5000, 1.2, .38); f.frequency.exponentialRampToValueAtTime(1300, t + .08); },
  felt:    (c, t) => nz(c, t, .12, 'lowpass', 1300, .6, .22, .02),
  glitter: (c, t) => { nz(c, t, .12, 'highpass', 6000, .7, .12, .005); for (let i = 0; i < 6; i++) tone(c, t + i * .022 + rand(0, .01), 'sine', rand(4200, 8200), 0, .09, .05); },
  holo:    (c, t) => { for (let i = 0; i < 4; i++) GRAIN.crinkle(c, t + i * .015, .9); nz(c, t, .05, 'bandpass', 3500, 1, .2); },
  crystal: (c, t) => { tone(c, t, 'sine', 2630, 0, .45, .12); tone(c, t, 'sine', 4120, 0, .3, .07); tone(c, t, 'sine', 6900, 0, .15, .03); nz(c, t, .006, 'highpass', 5000, .7, .25); },
  foil:    (c, t) => { for (let i = 0; i < 5; i++) GRAIN.crinkle(c, t + i * .012, 1); tone(c, t, 'sine', 1870, 0, .22, .05); tone(c, t, 'sine', 2950, 0, .18, .04); },
  puffy:   (c, t) => { tone(c, t, 'sine', 320, 110, .11, .3); nz(c, t, .08, 'lowpass', 900, .7, .12, .01); },
  vinyl:   (c, t) => { tone(c, t, 'sine', 190, 55, .09, .4); const f = nz(c, t, .12, 'lowpass', 2600, .9, .3, .003); f.frequency.exponentialRampToValueAtTime(300, t + .11); },
};
const FLAPBACK = {   // let go early: the corner falls back onto the sheet
  paper:   (c, t) => nz(c, t, .06, 'lowpass', 1800, .7, .18),
  felt:    (c, t) => nz(c, t, .07, 'lowpass', 900, .6, .12, .01),
  glitter: (c, t) => { nz(c, t, .05, 'lowpass', 1600, .7, .14); GRAIN.grain(c, t, .6); },
  holo:    (c, t) => { nz(c, t, .05, 'lowpass', 1700, .7, .14); GRAIN.crinkle(c, t, .4); },
  crystal: (c, t) => { GRAIN.tick(c, t, .8); GRAIN.tick(c, t + .03, .4); },
  foil:    (c, t) => { GRAIN.crinkle(c, t, .7); GRAIN.crinkle(c, t + .02, .5); nz(c, t, .05, 'lowpass', 1500, .7, .12); },
  puffy:   (c, t) => GRAIN.squish(c, t, 1),
  vinyl:   (c, t) => { tone(c, t, 'sine', 130, 60, .07, .3); nz(c, t, .06, 'lowpass', 900, .8, .16); },
};
const STICKX = {     // a material's own accent on top of the shared lay-down sound
  crystal: (c, t) => { GRAIN.tick(c, t, .7); tone(c, t + .02, 'sine', 3400, 0, .2, .04); },
  glitter: (c, t) => { for (let i = 0; i < 4; i++) GRAIN.grain(c, t + .04 + i * .03, .5); },
  holo:    (c, t) => { GRAIN.crinkle(c, t + .03, .4); GRAIN.crinkle(c, t + .07, .3); },
  foil:    (c, t) => { GRAIN.crinkle(c, t + .02, .6); GRAIN.crinkle(c, t + .06, .4); },
  puffy:   (c, t) => GRAIN.squish(c, t + .02, 1),
  vinyl:   (c, t) => GRAIN.suck(c, t + .1, .6),
};
const ps = m => PSND[m] || PSND.paper;

function sStick(mat = 'paper', big = 1) {
  if (!state.sound) return; const c = ac(), t = c.currentTime;
  const soft = mat === 'felt' ? .6 : 1, low = mat === 'vinyl' || mat === 'puffy' ? .7 : 1;
  tone(c, t, 'sine', 170 * big * low, 55, .08, .18 * soft);                        // soft contact tap
  const f = nz(c, t, .32, 'lowpass', 5200 * low, .7, .16 * soft, .05);              // film smoothed down
  f.frequency.setValueAtTime(5200 * low, t + .02); f.frequency.exponentialRampToValueAtTime(500, t + .3);
  if (STICKX[mat]) STICKX[mat](c, t);
}
let peelSnd = null;
function peelSoundStart(mat) {
  if (!state.sound) return; const c = ac(), p = ps(mat);
  const src = c.createBufferSource(); src.buffer = noiseBuf(c); src.loop = true;
  const f = c.createBiquadFilter(); f.type = p.ft; f.Q.value = p.q; f.frequency.value = p.f0;
  const g = c.createGain(); g.gain.value = 0;
  src.connect(f).connect(g).connect(c.destination); src.start();
  peelSnd = { c, src, f, g, p };
}
function peelSoundUpdate(speed) {          // speed: px of fold per frame
  if (!peelSnd) return; const { c, f, g, p } = peelSnd, t = c.currentTime;
  const v = clamp(speed / 6, 0, 1);
  g.gain.setTargetAtTime(v * p.g, t, .03);
  f.frequency.setTargetAtTime(p.f0 + (p.f1 - p.f0) * v, t, .05);
  if (v > .04 && Math.random() < v * p.rate) GRAIN[p.kind](c, t, v);
}
function peelSlip(amount) {                // the glue gives way in a jump
  if (!peelSnd) return; const { c, p } = peelSnd, t = c.currentTime;
  const v = clamp(amount / 14, .3, 1), n = 1 + Math.min(3, Math.floor(amount / 6));
  for (let i = 0; i < n; i++) GRAIN[p.kind](c, t + i * rand(.006, .02), v);
}
function peelSoundStop() {
  if (!peelSnd) return; const { c, g, src } = peelSnd;
  g.gain.setTargetAtTime(0, c.currentTime, .03); setTimeout(() => { try { src.stop(); } catch (e) {} }, 160); peelSnd = null;
}
function sDetach(mat) { if (!state.sound) return; const c = ac(); (DETACH[mat] || DETACH.paper)(c, c.currentTime); }
function sFlapBack(mat) { if (!state.sound) return; const c = ac(); (FLAPBACK[mat] || FLAPBACK.paper)(c, c.currentTime); }
function sPop() {
  if (!state.sound) return; const c = ac(), t = c.currentTime;
  const o = c.createOscillator(); o.type = 'triangle';
  o.frequency.setValueAtTime(420, t); o.frequency.exponentialRampToValueAtTime(1300, t + .09);
  const g = c.createGain(); g.gain.setValueAtTime(.25, t); g.gain.exponentialRampToValueAtTime(.0001, t + .12);
  o.connect(g).connect(c.destination); o.start(t); o.stop(t + .13);
}
function sTick() {
  if (!state.sound) return; const c = ac(), t = c.currentTime;
  const o = c.createOscillator(); o.type = 'square'; o.frequency.value = 1800;
  const g = c.createGain(); g.gain.setValueAtTime(.05, t); g.gain.exponentialRampToValueAtTime(.0001, t + .03);
  o.connect(g).connect(c.destination); o.start(t); o.stop(t + .035);
}

// ---------- sticker elements ----------
function dims(item, k, max) {
  const kk = Math.min(k, max / Math.max(item.w, item.h));
  return { dw: item.w * kk, dh: item.h * kk };
}
function sheetOf(id) { return sheets.find(s => s.id === id); }
function materialFor(item, sheet) {
  if (state.material !== 'auto') return state.material;
  return (sheet && sheet.material) || 'paper';
}
function makeSticker(item, mat, dw, dh) {
  const el = document.createElement('div');
  el.className = `sticker mat-${mat}`;
  const src = fileURL(item.file);
  el.style.setProperty('--img', `url("${src}")`);
  el.style.setProperty('--dw', dw + 'px'); el.style.setProperty('--dh', dh + 'px');
  el.style.setProperty('--seed', Math.random().toFixed(3));
  el.innerHTML = `<div class="st-body"><img alt="" draggable="false"><div class="fx fx-1"></div><div class="fx fx-2"></div><div class="fx fx-press"></div></div>`;
  el.querySelector('img').src = src;
  if (window.StickerFX) StickerFX.attach(el, src, mat, dw, dh);
  return el;
}
function setMaterial(el, mat) {
  el.className = el.className.replace(/\bmat-\w+/, '') + ` mat-${mat}`;
  if (window.StickerFX) StickerFX.setMaterial(el, mat);
}
function setGrab(el, gx, gy) { el.style.setProperty('--gx', gx.toFixed(1) + '%'); el.style.setProperty('--gy', gy.toFixed(1) + '%'); }
function layDown(el) {
  el.classList.remove('stick', 'lifted', 'dragging'); void el.offsetWidth;   // restart the animation
  el.classList.add('stick'); setTimeout(() => { el.classList.remove('stick'); el.style.setProperty('--vx', 0); el.style.setProperty('--vy', 0); }, 650);
}

// ---------- tray ----------
function renderTabs() {
  tabsEl.innerHTML = '';
  for (const s of sheets) {
    const b = document.createElement('button'); b.className = 'tab' + (s.id === state.sheet ? ' active' : '') + (s.imported ? ' imported' : '');
    b.textContent = I18N.label(s.label); b.onclick = () => { state.sheet = s.id; save(); renderTabs(); renderTray(); sTick(); };
    if (s.imported) {
      const x = document.createElement('span'); x.className = 'tab-x'; x.textContent = '×'; x.title = t('tabDelete');
      x.onclick = ev => { ev.stopPropagation(); deleteSheet(s); };
      b.append(x);
    }
    tabsEl.append(b);
  }
}
function renderTray() {
  trayEl.innerHTML = '';
  const sheet = sheetOf(state.sheet) || sheets[0];
  if (!sheet.items.length) {
    const p = document.createElement('p'); p.style.cssText = 'font-size:11px;color:#6b5fa0;text-align:center;padding:30px 10px';
    p.innerHTML = sheet.id === 'mine' ? t('emptyMine') : t('emptySheet');
    trayEl.append(p); return;
  }
  for (const item of sheet.items) {
    const { dw, dh } = dims(item, K_TRAY, MAX_TRAY);
    const el = makeSticker(item, materialFor(item, sheet), dw, dh);
    el.dataset.sheet = sheet.id; el._clip = trayEl.parentElement;
    const flap = document.createElement('div'); flap.className = 'flap';
    flap.innerHTML = `<div class="flap-in"><img alt="" draggable="false"><div class="shade"></div></div>`;
    flap.querySelector('img').src = fileURL(item.file); el.append(flap);
    el.addEventListener('pointerdown', e => startPeel(e, el, item, sheet));
    el.addEventListener('pointermove', e => hoverLift(e, el));
    el.addEventListener('pointerleave', () => { if (!peel || peel.srcEl !== el) clearPeel(el); });
    trayEl.append(el);
  }
}
function fillMaterialSelect() {
  matSelect.innerHTML = `<option value="auto">${t('matAuto')}</option>` + materialList().map(([k, l]) => `<option value="${k}">${l}</option>`).join('');
  matSelect.value = state.material;
  matSelect.onchange = () => { state.material = matSelect.value; save(); renderTray(); sTick(); };
}

// ---------- undo / redo: snapshots of what is on the canvas ----------
const undoStack = [], redoStack = []; let coalesceTag = null, coalesceT = 0;
const snapshot = () => JSON.stringify(state.placed);
function pushUndo(json) { undoStack.push(json); if (undoStack.length > 80) undoStack.shift(); redoStack.length = 0; updateUndoBtn(); }
function checkpoint(tag) {                 // call BEFORE changing the canvas
  const now = performance.now();
  if (tag && tag === coalesceTag && now - coalesceT < 900) { coalesceT = now; return; }   // a burst of wheel / key nudges = one step
  coalesceTag = tag || null; coalesceT = now; pushUndo(snapshot());
}
function restore(json) {
  for (const el of placedEls.values()) el.remove(); placedEls.clear();
  state.placed = JSON.parse(json).filter(p => !String(p.file).startsWith('idb:') || FILES.has(p.file));
  for (const it of state.placed) addPlacedEl(it, false);
  select(null); updateCount(); save();
}
function undo() {
  if (!undoStack.length) { toast(t('t_nothing'), 1400); return; }
  redoStack.push(snapshot()); restore(undoStack.pop()); coalesceTag = null; sTick(); updateUndoBtn();
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot()); restore(redoStack.pop()); coalesceTag = null; sTick(); updateUndoBtn();
}
function updateUndoBtn() { const b = document.getElementById('btn-undo'); if (b) b.disabled = !undoStack.length; }

// ---------- canvas ----------
const placedEls = new Map(); // id -> el
function applyTransform(item, el, extraTilt = 0) {
  const { dw, dh } = dims(item, K_CANVAS, MAX_CANVAS);
  el.style.transform = `translate(${item.cx - dw / 2}px, ${item.cy - dh / 2}px) rotate(${item.rot + extraTilt}deg) scale(${item.flip ? -item.scale : item.scale}, ${item.scale})`;
  el.style.zIndex = item.z;
  el._rot = item.rot + extraTilt; el._flip = item.flip; el._scale = item.scale;
  el.style.setProperty('--s', item.scale);
}
function addPlacedEl(item, animate) {
  const { dw, dh } = dims(item, K_CANVAS, MAX_CANVAS);
  const el = makeSticker(item, item.mat, dw, dh);
  el.dataset.id = item.id;
  applyTransform(item, el);
  el.addEventListener('pointerdown', e => grabPlaced(e, el, item));
  // selection handles: × peels it off, the corner knob rotates + resizes (for trackpads without a wheel)
  const hDel = document.createElement('button'); hDel.className = 'handle h-del'; hDel.textContent = '×'; hDel.title = t('h_del');
  const hRot = document.createElement('span'); hRot.className = 'handle h-rot'; hRot.textContent = '⟳'; hRot.title = t('h_rot');
  el.append(hDel, hRot);
  hDel.addEventListener('pointerdown', e => { e.stopPropagation(); e.preventDefault(); peelOffWithUndo(item, el); });
  hRot.addEventListener('pointerdown', e => {
    e.stopPropagation(); e.preventDefault(); ac(); checkpoint();
    const r = el.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const a0 = Math.atan2(e.clientY - cy, e.clientX - cx), d0 = Math.max(10, Math.hypot(e.clientX - cx, e.clientY - cy));
    const rot0 = item.rot, sc0 = item.scale;
    try { hRot.setPointerCapture(e.pointerId); } catch (err) {}
    const mv = ev => {
      item.rot = rot0 + (Math.atan2(ev.clientY - cy, ev.clientX - cx) - a0) * 180 / Math.PI;
      item.scale = clamp(sc0 * Math.hypot(ev.clientX - cx, ev.clientY - cy) / d0, .3, 3);
      el.style.transition = 'none'; applyTransform(item, el);
    };
    const up = () => { hRot.removeEventListener('pointermove', mv); hRot.removeEventListener('pointerup', up); hRot.removeEventListener('pointercancel', up); save(); sTick(); };
    hRot.addEventListener('pointermove', mv); hRot.addEventListener('pointerup', up); hRot.addEventListener('pointercancel', up);
  });
  el.addEventListener('wheel', e => {
    e.preventDefault(); checkpoint('wheel');
    if (e.shiftKey) item.scale = clamp(item.scale * (e.deltaY < 0 ? 1.06 : .94), .3, 3);
    else item.rot = (item.rot + (e.deltaY > 0 ? 4 : -4));
    el.style.transition = 'transform .08s'; applyTransform(item, el); save();
  }, { passive: false });
  el.addEventListener('dblclick', () => { checkpoint(); item.flip = !item.flip; applyTransform(item, el); sTick(); save(); });
  el.addEventListener('contextmenu', e => { e.preventDefault(); openMenu(e.clientX, e.clientY, item, el); });
  canvasEl.append(el); placedEls.set(item.id, el);
  if (animate) { el.classList.add('stick'); setTimeout(() => el.classList.remove('stick'), 500); }
  canvasEl.classList.add('has-items');
  return el;
}
function removePlaced(item, el, animate = true) {
  state.placed = state.placed.filter(p => p !== item); placedEls.delete(item.id);
  if (animate) { el.classList.add('peeloff'); sDetach(item.mat); setTimeout(() => el.remove(), 400); } else el.remove();
  updateCount(); save();
}
function peelOffWithUndo(item, el) {
  checkpoint(); removePlaced(item, el); if (selected === item.id) selected = null;
  toast(t('t_peeled'), 3000, { label: t('t_undo'), fn: undo });
}
function updateCount() {
  countEl.textContent = state.placed.length;
  odoEl.textContent = String(state.total).padStart(6, '0');
  canvasEl.classList.toggle('has-items', state.placed.length > 0);
}
let selected = null;
function select(el) {
  document.querySelectorAll('.sticker.selected').forEach(x => x.classList.remove('selected'));
  if (el) el.classList.add('selected');
  selected = el ? el.dataset.id : null;
}

// put a copy of a sheet sticker on the canvas, centred at viewport point (vx, vy)
function placeOnCanvas(src, sheetId, mat, vx, vy, rot = rand(-6, 6)) {
  checkpoint();
  const cr = canvasEl.getBoundingClientRect();
  const item = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), file: src.file, w: src.w, h: src.h,
    mat, cx: vx - cr.left, cy: vy - cr.top, rot, scale: 1, flip: false, z: ++state.zTop, sheet: sheetId };
  state.placed.push(item); state.total++;
  const el = addPlacedEl(item, false); select(el);
  sStick(mat); updateCount(); save();
  return { item, el };
}
function burst(x, y, mat) {
  const b = document.createElement('div'); b.className = 'burst'; b.style.left = x + 'px'; b.style.top = y + 'px';
  const colors = mat === 'holo' ? ['#ff0080', '#ffcf00', '#35ff9e', '#00c8ff'] : mat === 'foil' ? ['#ffe27a', '#fff', '#c9a227'] : ['#fff', '#fff6b0', '#ffc2e9', '#c8f6ff'];
  for (let i = 0; i < 6; i++) {
    const p = document.createElement('i'); if (i % 3 === 0) p.className = 'star';
    p.style.setProperty('--a', (i * 60 + rand(-18, 18)) + 'deg'); p.style.setProperty('--d', rand(18, 40) + 'px'); p.style.setProperty('--c', pick(colors));
    b.append(p);
  }
  floatLayer.append(b); setTimeout(() => b.remove(), 650);
}

// ---------- peel + drag: from the sheet ----------
// A sticker on the sheet is peeled like a real one: press near a corner, pull across,
// the film folds over along a line that follows your pull (you see its back),
// and only once the fold passes the middle does it come off into your hand.
let drag = null, peel = null;
const PEEL_HOVER = 10;          // px the corner lifts when you hover near it
const LBIG = 4000;              // "infinite" half-plane size for clip paths
function corners(w, h) { return [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }]; }
function nearestCorner(w, h, lx, ly) { let best = null, bd = 1e9; for (const c of corners(w, h)) { const d = Math.hypot(c.x - lx, c.y - ly); if (d < bd) { bd = d; best = c; } } return best; }
function diagDir(w, h, c) { const dx = c.x ? -w : w, dy = c.y ? -h : h; const L = Math.hypot(dx, dy); return [dx / L, dy / L]; }
function setPeel(el, c, s, ux, uy) {
  const body = el.querySelector('.st-body'), flap = el.querySelector('.flap');
  if (!flap) return;
  if (s <= .5) { body.style.clipPath = ''; flap.style.display = 'none'; return; }
  const px = c.x + ux * s / 2, py = c.y + uy * s / 2;          // the fold sits halfway to the fingertip
  const vx = -uy, vy = ux;
  const ax = px + vx * LBIG, ay = py + vy * LBIG, bx = px - vx * LBIG, by = py - vy * LBIG;
  body.style.clipPath = `polygon(${ax}px ${ay}px, ${bx}px ${by}px, ${bx + ux * LBIG}px ${by + uy * LBIG}px, ${ax + ux * LBIG}px ${ay + uy * LBIG}px)`;
  flap.style.display = 'block';
  flap.firstElementChild.style.clipPath = `polygon(${ax}px ${ay}px, ${bx}px ${by}px, ${bx - ux * LBIG}px ${by - uy * LBIG}px, ${ax - ux * LBIG}px ${ay - uy * LBIG}px)`;
  const th = Math.atan2(uy, ux) * 180 / Math.PI;
  flap.style.transform = `translate(${px}px, ${py}px) rotate(${th}deg) scaleX(-1) rotate(${-th}deg) translate(${-px}px, ${-py}px)`;
  el.style.setProperty('--peel-angle', (th + 180) + 'deg');
}
function clearPeel(el) { setPeel(el, { x: 0, y: 0 }, 0, 1, 0); }
function hoverLift(e, el) {
  if (drag || peel) return;
  const r = el.getBoundingClientRect();
  const c = nearestCorner(r.width, r.height, e.clientX - r.left, e.clientY - r.top);
  const [ux, uy] = diagDir(r.width, r.height, c);
  setPeel(el, c, PEEL_HOVER, ux, uy);
}
function startPeel(e, srcEl, item, sheet) {
  if (e.button && e.button !== 0) return;
  e.preventDefault(); ac();
  const r = srcEl.getBoundingClientRect();
  const c = nearestCorner(r.width, r.height, e.clientX - r.left, e.clientY - r.top);
  const [ux, uy] = diagDir(r.width, r.height, c);
  const mat = materialFor(item, sheet);
  peel = { srcEl, item, sheet, mat, P: PEEL[mat] || PEEL.paper, r, c, ux, uy, s: PEEL_HOVER, target: 0, pid: e.pointerId, ex: e.clientX, ey: e.clientY };
  srcEl.classList.add('peel-active');
  setPeel(srcEl, c, PEEL_HOVER + 2, ux, uy);
  peelSoundStart(mat);
  try { srcEl.setPointerCapture(e.pointerId); } catch (err) {}
  srcEl.addEventListener('pointermove', onPeelMove); srcEl.addEventListener('pointerup', onPeelEnd); srcEl.addEventListener('pointercancel', onPeelEnd);
  requestAnimationFrame(peelLoop);
}
function onPeelMove(e) {
  if (!peel || e.pointerId !== peel.pid) return;
  const p = peel; p.ex = e.clientX; p.ey = e.clientY;
  const wx = e.clientX - p.r.left - p.c.x, wy = e.clientY - p.r.top - p.c.y; const d = Math.hypot(wx, wy);
  if (d > 8) {                                          // the fold turns to follow the direction you pull
    const nx = wx / d, ny = wy / d; p.ux += (nx - p.ux) * .3; p.uy += (ny - p.uy) * .3;
    const L = Math.hypot(p.ux, p.uy); p.ux /= L; p.uy /= L;
  }
  p.target = Math.max(0, (wx * p.ux + wy * p.uy) * p.P.gain);
}
// The glue holds back: the fold creeps toward your finger, and when the tension
// passes what this material's glue can hold it lets go in a jump (stick-slip).
function peelLoop(now = performance.now()) {
  const p = peel; if (!p) return;
  const fr = clamp((now - (p.last || now - 16.7)) / 16.7, .25, 4);   // frames elapsed at 60fps, so feel is frame-rate independent
  p.last = now;
  const P = p.P, tension = p.target - p.s;
  let ds;
  if (tension > P.hold) { ds = tension * P.slip; peelSlip(ds); }
  else if (tension > 0) ds = tension * (1 - Math.pow(1 - P.creep, fr));
  else ds = tension;                                    // pushing back lays it down at once
  p.s = Math.max(0, p.s + ds);
  peelSoundUpdate(Math.max(0, ds) / fr);
  const tug = clamp(tension, 0, 40) * .12;              // the sheet itself gets tugged by the held tension
  p.srcEl.style.translate = `${(p.ux * tug).toFixed(2)}px ${(p.uy * tug).toFixed(2)}px`;
  setPeel(p.srcEl, p.c, p.s, p.ux, p.uy);
  const extent = p.r.width * Math.abs(p.ux) + p.r.height * Math.abs(p.uy);
  if (p.s / 2 >= extent * P.detach) { detachPeel({ clientX: p.ex, clientY: p.ey, pointerId: p.pid }); return; }
  requestAnimationFrame(peelLoop);
}
function endPeelListeners(el) { el.removeEventListener('pointermove', onPeelMove); el.removeEventListener('pointerup', onPeelEnd); el.removeEventListener('pointercancel', onPeelEnd); }
function onPeelEnd() {
  if (!peel) return;
  const p = peel; endPeelListeners(p.srcEl); peel = null; peelSoundStop();
  p.srcEl.style.translate = '';
  if (p.s > PEEL_HOVER + 3) sFlapBack(p.mat);
  let s = p.s;                                          // let go: the film springs back flat
  const tick = () => { s *= p.P.back; setPeel(p.srcEl, p.c, s, p.ux, p.uy); if (s > .8) requestAnimationFrame(tick); else { clearPeel(p.srcEl); p.srcEl.classList.remove('peel-active'); } };
  tick();
}
function detachPeel(e) {
  const p = peel; endPeelListeners(p.srcEl); peel = null; peelSoundStop(); sDetach(p.mat);
  clearPeel(p.srcEl); p.srcEl.classList.remove('peel-active'); p.srcEl.style.translate = '';
  const { dw, dh } = dims(p.item, K_CANVAS, MAX_CANVAS);
  const grow = dw / p.r.width;
  const ox = (p.c.x - p.r.width / 2) * grow, oy = (p.c.y - p.r.height / 2) * grow;   // it hangs from the corner you peeled
  beginDrag(p.srcEl, p.item, p.sheet, e, ox, oy, dw, dh, p.c.x ? 92 : 8, p.c.y ? 92 : 8);
}
function beginDrag(srcEl, item, sheet, e, ox, oy, dw, dh, gx, gy) {
  const mat = materialFor(item, sheet);
  const ghost = makeSticker(item, mat, dw, dh);
  ghost.classList.add('peeling'); setGrab(ghost, gx, gy);
  drag = { kind: 'tray', el: ghost, item, mat, srcEl, ox, oy, dw, dh, gx, gy,
           tx: e.clientX, ty: e.clientY, x: e.clientX, y: e.clientY, tilt: 0, vx: 0, vy: 0, start: performance.now(), pid: e.pointerId };
  const grow = dw / srcEl.getBoundingClientRect().width;
  ghost.style.transform = `translate(${e.clientX - dw / 2 - ox}px, ${e.clientY - dh / 2 - oy}px) scale(${1 / grow})`;
  floatLayer.append(ghost);
  requestAnimationFrame(() => { ghost.style.transition = 'transform .16s cubic-bezier(.3,1.2,.5,1)'; ghost.style.transform = `translate(${e.clientX - dw / 2 - ox}px, ${e.clientY - dh / 2 - oy}px)`; });
  srcEl.classList.add('taken');
  setTimeout(() => { if (drag && drag.el === ghost) { ghost.classList.remove('peeling'); ghost.classList.add('dragging'); ghost.style.transition = ''; } }, 170);
  srcEl.addEventListener('pointermove', onDragMove);
  srcEl.addEventListener('pointerup', onDragEnd); srcEl.addEventListener('pointercancel', onDragEnd);
  dragLoop();
}

// ---------- drag: placed sticker ----------
const pointers = new Map(); // multi-touch on a placed sticker
function grabPlaced(e, el, item) {
  if (e.button && e.button !== 0) return;
  e.preventDefault(); ac();
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (drag && drag.kind === 'placed' && drag.el === el && pointers.size === 2) {   // second finger: rotate / scale
    const [a, b] = [...pointers.values()];
    drag.pinch = { d0: Math.hypot(b.x - a.x, b.y - a.y), a0: Math.atan2(b.y - a.y, b.x - a.x), rot0: item.rot, scale0: item.scale };
    el.setPointerCapture(e.pointerId); return;
  }
  item.z = ++state.zTop; el.style.zIndex = item.z; select(el);
  const cr = canvasEl.getBoundingClientRect();
  const pox = e.clientX - cr.left - item.cx, poy = e.clientY - cr.top - item.cy;
  { const { dw, dh } = dims(item, K_CANVAS, MAX_CANVAS); setGrab(el, clamp(50 + pox / (dw * item.scale) * 100, 8, 92), clamp(50 + poy / (dh * item.scale) * 100, 8, 92)); }
  drag = { kind: 'placed', el, item, ox: pox, oy: poy, before: snapshot(),
           tx: e.clientX, ty: e.clientY, x: e.clientX, y: e.clientY, tilt: 0, vx: 0, vy: 0, moved: false, start: performance.now(), pid: e.pointerId,
           pressTimer: e.pointerType === 'touch' ? setTimeout(() => { if (drag && !drag.moved) { openMenu(e.clientX, e.clientY, item, el); cancelDrag(); } }, 550) : null };
  el.classList.add('lifted');
  try { el.setPointerCapture(e.pointerId); } catch (err) {}
  el.addEventListener('pointermove', onDragMove);
  el.addEventListener('pointerup', onDragEnd); el.addEventListener('pointercancel', onDragEnd);
  dragLoop();
}
function cancelDrag() {
  if (!drag) return;
  const { el } = drag; el.classList.remove('lifted', 'dragging'); el.style.setProperty('--tilt', 0); el.style.setProperty('--vx', 0); el.style.setProperty('--vy', 0);
  if (drag.kind === 'placed') applyTransform(drag.item, el);
  cleanupDrag();
}
function cleanupDrag() {
  drag.el._flex = null;
  const target = drag.kind === 'tray' ? drag.srcEl : drag.el;
  target.removeEventListener('pointermove', onDragMove); target.removeEventListener('pointerup', onDragEnd); target.removeEventListener('pointercancel', onDragEnd);
  clearTimeout(drag.pressTimer); pointers.clear(); drag = null;
}
function onDragMove(e) {
  if (!drag) return;
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (drag.pinch && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(b.x - a.x, b.y - a.y), ang = Math.atan2(b.y - a.y, b.x - a.x);
    drag.item.scale = clamp(drag.pinch.scale0 * d / drag.pinch.d0, .3, 3);
    drag.item.rot = drag.pinch.rot0 + (ang - drag.pinch.a0) * 180 / Math.PI;
    return;
  }
  if (e.pointerId !== drag.pid) return;
  if (Math.hypot(e.clientX - drag.tx, e.clientY - drag.ty) > 3) drag.moved = true;
  drag.tx = e.clientX; drag.ty = e.clientY;
  if (drag.kind === 'placed') {
    trayWindow.classList.toggle('drop-target', overTray(e.clientX, e.clientY));
    if (drag.moved) { trashEl.hidden = false; trashEl.classList.toggle('hot', overTrash(e.clientX, e.clientY)); }
  }
}
function overTray(x, y) { const r = trayWindow.getBoundingClientRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; }
const trashEl = $('#trash');
function overTrash(x, y) { if (trashEl.hidden) return false; const r = trashEl.getBoundingClientRect(); return x >= r.left - 12 && x <= r.right + 12 && y >= r.top - 12 && y <= r.bottom + 12; }
function overCanvas(x, y) { const r = canvasEl.getBoundingClientRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; }

function dragLoop() {
  if (!drag) return;
  const d = drag;
  // springy follow + tilt from velocity
  const dx = d.tx - d.x, dy = d.ty - d.y;
  d.x += dx * .42; d.y += dy * .42;
  d.tilt += ((clamp(dx * .55, -22, 22)) - d.tilt) * .3;
  d.vx += (clamp(dx * .7, -28, 28) - d.vx) * .35; d.vy += (clamp(dy * .7, -28, 28) - d.vy) * .35;
  d.el.style.setProperty('--tilt', d.tilt.toFixed(2));
  d.el.style.setProperty('--vx', d.vx.toFixed(2)); d.el.style.setProperty('--vy', d.vy.toFixed(2));
  d.el._flex = [d.vx, d.vy];
  if (d.kind === 'tray') {
    d.el.style.transform = `translate(${d.x - d.dw / 2 - d.ox}px, ${d.y - d.dh / 2 - d.oy}px)`;
  } else if (d.moved || d.pinch) {
    const cr = canvasEl.getBoundingClientRect();
    if (!d.pinch) { d.item.cx = d.x - cr.left - d.ox; d.item.cy = d.y - cr.top - d.oy; }
    applyTransform(d.item, d.el, 0);
  }
  requestAnimationFrame(dragLoop);
}
function onDragEnd(e) {
  if (!drag) return;
  if (drag.pinch && e.pointerId !== drag.pid) { pointers.delete(e.pointerId); drag.pinch = null; save(); return; }
  const d = drag; const x = e.clientX, y = e.clientY;
  const cr = canvasEl.getBoundingClientRect();
  if (d.kind === 'tray') {
    if (overCanvas(x, y)) {
      d.el.remove();
      const { el } = placeOnCanvas(d.item, d.srcEl.dataset.sheet, d.mat, x - d.ox, y - d.oy, clamp(d.tilt * .4, -9, 9) + rand(-5, 5));
      setGrab(el, d.gx, d.gy); el.style.setProperty('--vx', d.vx.toFixed(2)); el.style.setProperty('--vy', d.vy.toFixed(2));
      layDown(el); burst(x, y, d.mat);
      const src = d.srcEl; setTimeout(() => { src.classList.remove('taken'); src.classList.add('refill'); setTimeout(() => src.classList.remove('refill'), 500); }, 420);
    } else {
      // fly back onto the sheet
      const r = d.srcEl.getBoundingClientRect(); const ghost = d.el; const src = d.srcEl;
      ghost.classList.remove('dragging', 'peeling'); ghost.style.transition = 'transform .32s cubic-bezier(.3,1.3,.5,1), opacity .3s';
      ghost.style.transform = `translate(${r.left + r.width / 2 - d.dw / 2}px, ${r.top + r.height / 2 - d.dh / 2}px) scale(${r.width / d.dw})`;
      ghost.style.opacity = '0';
      setTimeout(() => { ghost.remove(); src.classList.remove('taken'); }, 330);
    }
  } else {
    const el = d.el, item = d.item;
    trayWindow.classList.remove('drop-target');
    const inTrash = overTrash(x, y); trashEl.hidden = true; trashEl.classList.remove('hot');
    el.classList.remove('lifted'); el.style.setProperty('--tilt', 0);
    if (d.moved && (inTrash || overTray(x, y))) {
      pushUndo(d.before); removePlaced(item, el); if (selected === item.id) selected = null;
      toast(t('t_peeled'), 3000, { label: t('t_undo'), fn: undo });
    }
    else {
      if (d.moved) pushUndo(d.before);
      if (d.moved) { item.rot += clamp(d.tilt * .25, -5, 5); layDown(el); sStick(item.mat, 1.3); burst(x, y, item.mat); }
      applyTransform(item, el); save();
    }
  }
  cleanupDrag();
}

// ---------- context menu ----------
function openMenu(x, y, item, el) {
  select(el);
  ctxMenu.innerHTML = materialList().map(([k, l]) => `<button data-mat="${k}" class="${item.mat === k ? 'on' : ''}">${l}</button>`).join('') +
    `<hr><button data-act="flip">${t('c_flip')}</button><button data-act="front">${t('c_front')}</button><button data-act="dup">${t('c_dup')}</button><button data-act="del">${t('c_del')}</button>`;
  ctxMenu.hidden = false;
  const mw = 170, mh = ctxMenu.offsetHeight || 300;
  ctxMenu.style.left = Math.min(x, innerWidth - mw - 8) + 'px'; ctxMenu.style.top = Math.min(y, innerHeight - mh - 8) + 'px';
  ctxMenu.onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.act === 'del') { closeMenu(); peelOffWithUndo(item, el); return; }
    checkpoint();
    if (b.dataset.mat) { item.mat = b.dataset.mat; setMaterial(el, item.mat); layDown(el); sTick(); }
    else if (b.dataset.act === 'flip') { item.flip = !item.flip; applyTransform(item, el); sTick(); }
    else if (b.dataset.act === 'front') { item.z = ++state.zTop; applyTransform(item, el); sTick(); }
    else if (b.dataset.act === 'dup') { const c = { ...item, id: Date.now().toString(36), cx: item.cx + 24, cy: item.cy + 18, z: ++state.zTop }; state.placed.push(c); state.total++; select(addPlacedEl(c, true)); sStick(c.mat); updateCount(); }
    save(); closeMenu();
  };
}
function closeMenu() { ctxMenu.hidden = true; }
document.addEventListener('pointerdown', e => { if (!ctxMenu.contains(e.target)) closeMenu(); }, true);
document.addEventListener('keydown', e => {
  if (e.target.closest && e.target.closest('input, textarea, select')) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (e.key === 'Escape') { closeMenu(); select(null); return; }
  const item = state.placed.find(p => p.id === selected); const el = placedEls.get(selected); if (!item || !el) return;
  if (e.key === 'Delete' || e.key === 'Backspace') { peelOffWithUndo(item, el); }
  else if (e.key === '[' || e.key === ']') { checkpoint('key'); item.rot += e.key === '[' ? -5 : 5; applyTransform(item, el); save(); }
  else if (e.key === '+' || e.key === '=' || e.key === '-') { checkpoint('key'); item.scale = clamp(item.scale * (e.key === '-' ? .92 : 1.08), .3, 3); applyTransform(item, el); save(); }
  else if (e.key.toLowerCase() === 'f') { checkpoint(); item.flip = !item.flip; applyTransform(item, el); save(); }
  else return;
  e.preventDefault();
});
canvasEl.addEventListener('pointerdown', e => { if (e.target === canvasEl || e.target.id === 'canvas-hint') select(null); });

// ---------- light that materials react to ----------
const mouse = { x: innerWidth * .5, y: innerHeight * .4 }; let lastMove = 0, tiltX = 0, tiltY = 0;
addEventListener('pointermove', e => { mouse.x = e.clientX; mouse.y = e.clientY; lastMove = performance.now(); }, { passive: true });
addEventListener('deviceorientation', e => { if (e.gamma == null) return; tiltX = clamp(e.gamma / 30, -1, 1); tiltY = clamp((e.beta - 40) / 30, -1, 1); lastMove = performance.now(); }, { passive: true });
function lightTick(t) {
  const idle = t - lastMove > 1800;
  let lx, ly;
  if (idle) { lx = innerWidth * (.5 + .55 * Math.sin(t / 2100)); ly = innerHeight * (.45 + .45 * Math.cos(t / 2900)); }
  else { lx = mouse.x + tiltX * innerWidth * .4; ly = mouse.y + tiltY * innerHeight * .4; }
  const els = document.querySelectorAll('.sticker');
  const R = 380;
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.bottom < -50 || r.top > innerHeight + 50) continue;
    const px = clamp((lx - (r.left + r.width / 2)) / R, -1, 1), py = clamp((ly - (r.top + r.height / 2)) / R, -1, 1);
    const prev = el._px;
    if (prev !== undefined && Math.abs(prev - px) < .004 && Math.abs(el._py - py) < .004) continue;
    el._px = px; el._py = py;
    el.style.setProperty('--px', px.toFixed(3)); el.style.setProperty('--py', py.toFixed(3));
    const hov = !idle && el.parentElement === canvasEl && Math.abs(lx - (r.left + r.width / 2)) < r.width / 2 && Math.abs(ly - (r.top + r.height / 2)) < r.height / 2;
    el.classList.toggle('hover', hov && !drag);
  }
  if (window.StickerFX) StickerFX.frame(lx, ly, t);
  requestAnimationFrame(lightTick);
}
requestAnimationFrame(lightTick);

// ---------- custom stickers (drop / import / paste) ----------
function loadImage(src) { return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; }); }
function toast(msg, ms = 2600, action = null) {
  let el = document.getElementById('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; document.body.append(el); }
  el.textContent = msg;
  if (action) {
    const b = document.createElement('button'); b.className = 'toast-btn'; b.textContent = action.label;
    b.onclick = () => { el.classList.remove('show'); action.fn(); }; el.append(b);
  }
  el.classList.add('show'); clearTimeout(el._h); el._h = setTimeout(() => el.classList.remove('show'), ms);
}
function addSingle(img, name, at) {
  const max = 520, k = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  const it = { file: c.toDataURL('image/png'), w: c.width, h: c.height, name };
  mine.items.push(it);
  state.sheet = 'mine'; save(); renderTabs(); renderTray();
  if (at) { const { el } = placeOnCanvas(it, 'mine', mine.material, at.x, at.y); layDown(el); burst(at.x, at.y, mine.material); }
  else sPop();
}
let importing = Promise.resolve();
function addCustomFiles(files, at) {
  [...files].filter(f => f.type.startsWith('image/')).forEach((f, i) => {
    const p = at ? { x: at.x + i * 34, y: at.y + i * 26 } : null;   // several dropped at once fan out
    importing = importing.then(() => importOne(f, p)).catch(err => { console.error(err); toast(t('t_unreadable', { name: f.name })); });
  });
}
async function importOne(f, at) {
  const url = URL.createObjectURL(f);
  try {
    const img = await loadImage(url);
    const name = f.name.replace(/\.[^.]+$/, '').slice(0, 16);
    // a transparent PNG with one shape is a single sticker; anything else goes through the cutter
    if (window.StickerCutter) {
      const q = await StickerCutter.quickCut(img);
      if (q.mode === 'alpha' && q.count <= 1) { addSingle(img, name, at); return; }
      const out = await StickerCutter.open(img, { name, material: 'vinyl', materials: materialList() });
      if (out && out.stickers.length) {
        const meta = await saveSheet(out);
        if (at && meta.items.length === 1) { const { el } = placeOnCanvas(meta.items[0], meta.id, meta.material, at.x, at.y); layDown(el); burst(at.x, at.y, meta.material); }
      }
    } else addSingle(img, name, at);
  } finally { URL.revokeObjectURL(url); }
}
// an image dragged from another web page arrives as a URL, not a file
function urlFromDrop(dt) {
  const list = (dt.getData('text/uri-list') || '').split(/\r?\n/).find(l => l && !l.startsWith('#'));
  const html = dt.getData('text/html'), m = html && html.match(/<img[^>]+src=["']([^"']+)["']/i);
  const plain = (dt.getData('text/plain') || '').trim();
  const u = (m && m[1]) || list || (/^(https?:|data:image)/.test(plain) ? plain : '');
  return u ? u.replace(/&amp;/g, '&') : '';
}
async function importUrl(u, at) {
  toast(t('t_fetching'), 1800);
  try {
    const r = await fetch(u, { mode: 'cors' }); if (!r.ok) throw new Error(r.status);
    const b = await r.blob(); if (!b.type.startsWith('image/')) { toast(t('t_notImage')); return; }
    const name = decodeURIComponent((u.split(/[?#]/)[0].split('/').pop() || 'web').replace(/\.[^.]+$/, '')).slice(0, 16) || 'web';
    addCustomFiles([new File([b], name, { type: b.type })], at);
  } catch (err) { console.warn(err); toast(t('t_webBlocked'), 5000); }
}
async function saveSheet({ label, material, stickers }) {
  const id = 'imp' + Date.now().toString(36);
  const items = [];
  for (let n = 0; n < stickers.length; n++) {
    const s = stickers[n], key = `idb:${id}/${n}`;
    await DB.set('img:' + key, s.blob);
    FILES.set(key, URL.createObjectURL(s.blob));
    items.push({ file: key, w: s.w, h: s.h });
  }
  const meta = { id, label, material, items, imported: true };
  const list = (await DB.get('sheets')) || []; list.push(meta); await DB.set('sheets', list);
  sheets.splice(sheets.indexOf(mine), 0, meta);
  state.sheet = id; save(); renderTabs(); renderTray(); sPop();
  toast(t('t_cut', { label, n: items.length }));
  return meta;
}
async function deleteSheet(s) {
  const used = state.placed.filter(p => p.sheet === s.id);
  if (!confirm(t('confirmSheet', { label: I18N.label(s.label) }) + (used.length ? t('confirmUsed', { n: used.length }) : ''))) return;
  used.forEach(p => { const el = placedEls.get(p.id); if (el) removePlaced(p, el); });
  for (const it of s.items) { await DB.del('img:' + it.file); const u = FILES.get(it.file); if (u) URL.revokeObjectURL(u); FILES.delete(it.file); }
  const list = ((await DB.get('sheets')) || []).filter(m => m.id !== s.id); await DB.set('sheets', list);
  sheets.splice(sheets.indexOf(s), 1);
  if (state.sheet === s.id) state.sheet = sheets[0].id;
  save(); renderTabs(); renderTray(); sTick();
}
async function loadImportedSheets() {
  let list = [];
  try { list = (await DB.get('sheets')) || []; } catch (e) { console.warn('IndexedDB unavailable', e); return; }
  for (const meta of list) {
    for (const it of meta.items) {
      const blob = await DB.get('img:' + it.file).catch(() => null);
      if (blob) FILES.set(it.file, URL.createObjectURL(blob));
    }
    meta.items = meta.items.filter(it => FILES.has(it.file));
    sheets.splice(sheets.indexOf(mine), 0, meta);
  }
}
$('#file-input').addEventListener('change', e => { addCustomFiles(e.target.files); e.target.value = ''; });
// drag pictures in from the desktop or another web page: anywhere = new stickers, onto the canvas = stuck right there
const dropHint = $('#drop-hint'), dropText = $('#drop-hint-text'); let dragDepth = 0;
const isImportDrag = e => { const ty = [...((e.dataTransfer && e.dataTransfer.types) || [])]; return ty.includes('Files') || ty.includes('text/uri-list') || ty.includes('text/html'); };
const hideDrop = () => { dropHint.hidden = true; canvasEl.classList.remove('drop-here'); $('#dropzone').classList.remove('hot'); };
addEventListener('dragenter', e => { if (!isImportDrag(e)) return; dragDepth++; dropHint.hidden = false; });
addEventListener('dragleave', e => { if (!isImportDrag(e)) return; if (--dragDepth <= 0) { dragDepth = 0; hideDrop(); } });
addEventListener('dragover', e => {
  if (!isImportDrag(e)) return; e.preventDefault();
  const onCanvas = overCanvas(e.clientX, e.clientY);
  canvasEl.classList.toggle('drop-here', onCanvas); dropHint.classList.toggle('on-canvas', onCanvas);
  canvasEl.dataset.drop = t('dropCanvas');
  $('#dropzone').classList.toggle('hot', !onCanvas);
  dropText.textContent = t(onCanvas ? 'dropCanvas' : 'dropAll');
});
addEventListener('drop', e => {
  if (!isImportDrag(e)) return; e.preventDefault(); dragDepth = 0; hideDrop(); ac();
  const at = overCanvas(e.clientX, e.clientY) ? { x: e.clientX, y: e.clientY } : null;
  const files = [...e.dataTransfer.files].filter(f => f.type.startsWith('image/'));
  if (files.length) { addCustomFiles(files, at); return; }
  const u = urlFromDrop(e.dataTransfer);
  if (u) importUrl(u, at); else toast(t('t_notImage'));
});
addEventListener('paste', e => { const fs = [...(e.clipboardData.items || [])].filter(i => i.kind === 'file').map(i => i.getAsFile()); if (fs.length) addCustomFiles(fs); });

// ---------- toolbar ----------
const soundBtn = $('#btn-sound');
soundBtn.setAttribute('aria-pressed', String(state.sound));
soundBtn.onclick = () => { state.sound = !state.sound; soundBtn.setAttribute('aria-pressed', String(state.sound)); save(); sTick(); };
$('#btn-paper').onclick = () => { state.paper = (state.paper + 1) % PAPERS.length; applyPaper(); save(); sTick(); };
function applyPaper() { canvasEl.className = 'canvas ' + PAPERS[state.paper] + (state.placed.length ? ' has-items' : ''); }
$('#btn-clear').onclick = () => {
  if (!state.placed.length) return;
  checkpoint(); select(null);
  [...state.placed].sort((a, b) => b.z - a.z).forEach((p, i) => { const el = placedEls.get(p.id); setTimeout(() => removePlaced(p, el), i * 45); });
  toast(t('t_cleared'), 4000, { label: t('t_undo'), fn: undo });
};
$('#btn-undo').onclick = undo;
$('#btn-lang').onclick = () => {
  state.lang = I18N.lang === 'en' ? 'zh' : 'en'; I18N.set(state.lang); save();
  fillMaterialSelect(); renderTabs(); renderTray();
  for (const el of placedEls.values()) { el.querySelector('.h-del').title = t('h_del'); el.querySelector('.h-rot').title = t('h_rot'); }
  if (window.StickerCutter && StickerCutter.relang) StickerCutter.relang();
  sTick();
};
$('#btn-export').onclick = exportPNG;

// ---------- export (lit sticker canvases + rims, frozen at the current light) ----------
const imgCache = new Map();
const loadImg = src => imgCache.get(src) || (imgCache.set(src, new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; })), imgCache.get(src));
function tinted(img, color) {
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d');
  g.drawImage(img, 0, 0); g.globalCompositeOperation = 'source-in'; g.fillStyle = color; g.fillRect(0, 0, c.width, c.height); return c;
}
const RIM = { paper: ['#fff', 1.5], vinyl: ['#fff', 1.5], puffy: ['#fff', 2.2], foil: ['#c9a227', 1.3] };
async function exportPNG() {
  const R = 2, cr = canvasEl.getBoundingClientRect();
  const c = document.createElement('canvas'); c.width = Math.round(cr.width * R); c.height = Math.round(cr.height * R);
  const g = c.getContext('2d'); g.scale(R, R);
  const bg = getComputedStyle(canvasEl).backgroundColor; g.fillStyle = bg; g.fillRect(0, 0, cr.width, cr.height);
  const paper = PAPERS[state.paper];
  if (paper === 'paper-grid' || paper === 'paper-lined') {
    g.strokeStyle = 'rgba(60,120,255,.2)'; g.lineWidth = 1;
    const step = paper === 'paper-grid' ? 22 : 26;
    for (let y = step; y < cr.height; y += step) { g.beginPath(); g.moveTo(0, y + .5); g.lineTo(cr.width, y + .5); g.stroke(); }
    if (paper === 'paper-grid') for (let x = step; x < cr.width; x += step) { g.beginPath(); g.moveTo(x + .5, 0); g.lineTo(x + .5, cr.height); g.stroke(); }
  }
  for (const item of [...state.placed].sort((a, b) => a.z - b.z)) {
    let img; try { img = await loadImg(fileURL(item.file)); } catch (e) { continue; }
    const pel = placedEls.get(item.id), lit = pel && pel._glOn ? pel._cv : null;
    const { dw, dh } = dims(item, K_CANVAS, MAX_CANVAS);
    g.save(); g.translate(item.cx, item.cy); g.rotate(item.rot * Math.PI / 180); g.scale(item.flip ? -item.scale : item.scale, item.scale);
    g.shadowColor = 'rgba(0,0,0,.28)'; g.shadowBlur = 3; g.shadowOffsetY = 2;
    const rim = RIM[item.mat];
    if (rim) { const t = tinted(img, rim[0]); const o = rim[1]; for (const [ox, oy] of [[o, 0], [-o, 0], [0, o], [0, -o], [o, o], [-o, -o], [o, -o], [-o, o]]) g.drawImage(t, -dw / 2 + ox, -dh / 2 + oy, dw, dh); }
    g.shadowColor = 'transparent';
    if (!lit && item.mat === 'foil') g.filter = 'sepia(.45) saturate(1.5) contrast(1.15)';
    g.drawImage(lit || img, -dw / 2, -dh / 2, dw, dh); g.restore();
  }
  c.toBlob(b => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'sticker-station.png'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }, 'image/png');
  sPop();
}

// ---------- boot ----------
I18N.apply(); updateUndoBtn();
(async () => {
  await loadImportedSheets();
  // placed stickers whose imported sheet is gone cannot be drawn any more
  state.placed = state.placed.filter(p => !String(p.file).startsWith('idb:') || FILES.has(p.file));
  fillMaterialSelect(); renderTabs(); renderTray(); applyPaper();
  for (const item of state.placed) addPlacedEl(item, false);
  updateCount();
})();
window.stickerStation = { state, sheets };
})();
