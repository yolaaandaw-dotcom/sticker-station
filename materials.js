/* ===========================================================
   StickerFX — real lighting for sticker materials.

   One shared WebGL context renders every sticker into its own
   small 2D canvas. Each sticker image gets a height map built
   from its alpha (a dome + a bevelled rim) and its luminance
   (facets / embossing), so light from the pointer can hit
   actual slopes:
     crystal  faceted gem: facet shading, dispersion fire, star glints
     glitter  hex sequins, each with its own tilt, flashing one by one
     holo     rainbow diffraction that sweeps with the angle
     foil     gold metal: environment reflection bands, gold specular
     puffy    domed vinyl bubble with soft highlight + edge occlusion
     felt     fibre grain, velvet sheen, fuzzy edge
     paper    matte with a hint of grain
     vinyl    flat glossy clear-coat
   If WebGL is unavailable, window.StickerFX stays null and the
   CSS shimmer layers in style.css are used instead.
   =========================================================== */
(() => {
'use strict';

const MAT_ID = { crystal: 0, glitter: 1, holo: 2, foil: 3, puffy: 4, felt: 5, paper: 6, vinyl: 7 };
const ANIMATED = { crystal: 1, glitter: 1, holo: 1 };   // twinkle over time even with a still light
const COLOR_MAX = 768, HEIGHT_MAX = 320, CANVAS_MAX = 760;

const VERT = `
attribute vec2 p; varying vec2 vUv;
void main(){ vUv = vec2(p.x * .5 + .5, .5 - p.y * .5); gl_Position = vec4(p, 0., 1.); }`;

const FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uCol, uHt;
uniform vec2 uHres, uSize, uFlex;
uniform vec3 uLight;
uniform float uMat, uTime, uSeed, uK;

float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21) + uSeed * .137); p += dot(p, p + 45.32); return fract(p.x * p.y); }
vec2 hash2(vec2 p){ float n = hash(p); return vec2(n, hash(p + n * 19.19 + 3.1)); }
float luma(vec3 c){ return dot(c, vec3(.299, .587, .114)); }
vec3 hsv(float h, float s, float v){ vec3 q = abs(fract(vec3(h) + vec3(0., 2. / 3., 1. / 3.)) * 6. - 3.); return v * mix(vec3(1.), clamp(q - 1., 0., 1.), s); }

// four-point star with faint diagonals, d in px, r = radius
float star(vec2 d, float r){
  vec2 a = abs(d) / r;
  float core = exp(-dot(a, a) * 28.);
  float rays = exp(-a.x * 38.) * exp(-a.y * 2.6) + exp(-a.y * 38.) * exp(-a.x * 2.6);
  vec2 dr = abs(vec2(d.x + d.y, d.x - d.y)) * .7071 / r;
  float diag = .3 * (exp(-dr.x * 38.) * exp(-dr.y * 5.) + exp(-dr.y * 38.) * exp(-dr.x * 5.));
  return core * 1.6 + rays + diag;
}
// sparse glints: a few random points per cell, each with its own facet normal;
// one only lights when that facet mirrors the pointer into the eye
float glints(vec2 px, float cs, float sharp, float minDome){
  vec2 cell = floor(px / cs); float acc = 0.;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 c = cell + vec2(float(i), float(j));
    vec2 r = hash2(c);
    vec2 ctr = (c + .2 + .6 * r) * cs;
    vec4 hc = texture2D(uHt, ctr / uSize);
    if (hc.a < .6 || hc.r < minDome) continue;
    vec2 rn = hash2(c + 11.3) - .5;
    vec3 nf = normalize(vec3(rn * .9 + uFlex, 1.));
    vec3 Lc = normalize(uLight - vec3(ctr, 0.));
    float I = pow(max(dot(nf, normalize(Lc + vec3(0., 0., 1.))), 0.), sharp);
    I *= .6 + .4 * sin(uTime * (1.5 + r.x * 3.) + r.y * 40.);
    if (I < .02) continue;
    acc += star(px - ctr, cs * (.35 + .9 * I)) * I;
  }
  return acc;
}

void main(){
  vec4 base = texture2D(uCol, vUv);
  float a = base.a;
  if (a < .004) { gl_FragColor = vec4(0.); return; }
  vec3 col = base.rgb;
  vec2 px = vUv * uSize;

  // ---- surface normal from the height map (r dome, g facet detail, b rim bevel) ----
  vec2 e = max(1. / uHres, .8 / uSize);
  vec4 h0 = texture2D(uHt, vUv);
  vec4 hx = texture2D(uHt, vUv + vec2(e.x, 0.)) - texture2D(uHt, vUv - vec2(e.x, 0.));
  vec4 hy = texture2D(uHt, vUv + vec2(0., e.y)) - texture2D(uHt, vUv - vec2(0., e.y));
  float ms = min(uSize.x, uSize.y);
  hx /= 2. * e.x * (uSize.x / ms); hy /= 2. * e.y * (uSize.y / ms);
  float m = uMat;
  vec3 w;
  if (m < .5)      w = vec3(.06, .034, .008);   // crystal: flat table, facets carry the shape
  else if (m < 1.5) w = vec3(.06, .005, .010);  // glitter
  else if (m < 2.5) w = vec3(.05, .005, .008);  // holo
  else if (m < 3.5) w = vec3(.08, .030, .026);  // foil
  else if (m < 4.5) w = vec3(.30, .003, .020);  // puffy
  else if (m < 5.5) w = vec3(.04, .006, .012);  // felt
  else if (m < 6.5) w = vec3(.02, .004, .005);  // paper
  else              w = vec3(.10, .003, .015);  // vinyl
  vec2 g = vec2(dot(hx.rgb, w), dot(hy.rgb, w));
  vec3 N = normalize(vec3(-g + uFlex, 1.));
  vec3 V = vec3(0., 0., 1.);
  vec3 Lv = uLight - vec3(px, 0.);
  vec3 L = normalize(Lv);
  vec3 Hh = normalize(L + V);
  float ndh = max(dot(N, Hh), 0.);
  float rel = dot(N, L) - L.z;             // >0 where the surface turns toward the light

  if (m < .5) {                            // ---------- crystal ----------
    col = clamp((col - .5) * 1.25 + .5, 0., 1.);
    col *= 1. + .8 * rel;                                    // facets turned to the light brighten, others fall dark
    col *= mix(.8, 1.06, smoothstep(.3, .9, h0.r));          // a little depth toward the girdle
    vec3 o = vec3(30. * uK, 0., 0.);
    float sR = pow(max(dot(N, normalize(normalize(Lv + o) + V)), 0.), 55.);
    float sG = pow(ndh, 55.);
    float sB = pow(max(dot(N, normalize(normalize(Lv - o) + V)), 0.), 55.);
    col += vec3(sR, sG, sB) * 1.7 + pow(ndh, 10.) * .1;    // dispersion: rainbow fire on the facet edges
    col += glints(px, 22. * uK, 130., .3) * 1.1;             // stars where a facet mirrors the light
  } else if (m < 1.5) {                    // ---------- glitter ----------
    col *= 1. + .35 * rel;
    // sequins on a rotated, jittered grid so it never reads as a mosaic
    float fs = 4.4 * uK;
    vec2 q = mat2(.866, .5, -.5, .866) * px / fs;
    vec2 cell = floor(q);
    vec2 r = hash2(cell);
    vec2 lc = fract(q) - .5 - (r - .5) * .35;
    float inF = smoothstep(.62, .42, length(lc) * (.85 + .5 * r.x));
    vec2 rn = hash2(cell + 5.7) - .5;
    vec3 nf = normalize(vec3(rn * 1.6 + uFlex * 1.5, 1.));
    vec2 fc = mat2(.866, -.5, .5, .866) * (cell + .5) * fs;
    vec3 Lf = normalize(uLight - vec3(fc, 0.));
    float I = pow(max(dot(nf, normalize(Lf + V)), 0.), 90.);          // only a few flakes mirror the light
    float tw = sin(uTime * (1.5 + r.x * 7.) + r.y * 60.);
    I *= .35 + .65 * tw * tw;                                           // and they flicker on their own
    float hue = fract(r.y * .6 + dot(nf.xy, Lf.xy) * 1.6);
    vec3 tint = hsv(hue, .6, 1.);
    float tone = .72 + .56 * r.y;                                       // each flake catches a different amount
    col *= mix(1., tone, inF * .8);
    col = mix(col, col * mix(vec3(1.), tint, .35), inF * .5);            // faint coloured cast per flake
    col += (vec3(1.) * .55 + tint * .75) * I * inF * 3.2;
    col += tint * .12 * inF * pow(max(dot(nf, Hh), 0.), 5.);
    col += glints(px, 22. * uK, 160., 0.) * 1.2;
  } else if (m < 2.5) {                    // ---------- holographic ----------
    col *= 1. + .4 * rel;
    float ph = dot(px / uK, vec2(.006, .011)) + dot(L.xy, vec2(1.3, .9)) + dot(N.xy, vec2(2.5)) + uTime * .03;
    vec3 rb = hsv(fract(ph), .75, 1.);
    float grat = .6 + .4 * sin((px.x * .8 + px.y * .5) / uK * 1.7);
    float k = .35 + .65 * pow(ndh, 4.);
    col = mix(col, col * .55 + rb * .65, .5 * k * grat);
    col += rb * pow(ndh, 40.) * .7;
    col += glints(px, 34. * uK, 300., .3) * .4;
  } else if (m < 3.5) {                    // ---------- gold foil ----------
    vec3 R = reflect(-V, N);
    float env = .12 + 1.25 * pow(max(dot(R, L), 0.), 14.) + .35 * pow(max(dot(R, normalize(vec3(-L.xy, L.z))), 0.), 5.);
    env += .12 * sin((R.x * 2.3 + R.y * 1.1) * 9.);           // stamped / brushed banding
    float lu = luma(col);
    float t = env * (.45 + .8 * lu);
    vec3 gold = mix(vec3(.2, .12, .03), vec3(.93, .69, .22), smoothstep(0., .7, t));
    gold += vec3(1., .93, .7) * smoothstep(.75, 1.5, t);
    float gm = smoothstep(.12, .3, col.r - col.b) * smoothstep(.45, .7, lu) * step(col.b, col.g);   // gold already printed
    float rim = 1. - smoothstep(.55, .95, h0.b);
    float mm = clamp(max(max(gm, rim), .42), 0., 1.);
    col = mix(col * (1. + .6 * rel), gold, mm);
    col += vec3(1., .88, .55) * pow(ndh, 80.) * 1.4 * mm;
  } else if (m < 4.5) {                    // ---------- puffy ----------
    col *= 1. + .7 * rel;
    col *= mix(.72, 1., smoothstep(.1, .8, h0.r));
    col += pow(ndh, 22.) * .45 + pow(ndh, 140.) * .9;
  } else if (m < 5.5) {                    // ---------- felt ----------
    float n1 = hash(floor(px / uK)), n2 = hash(floor(px / (2.3 * uK)) + 3.);
    col *= .84 + .2 * n1 + .08 * n2;
    col = mix(vec3(luma(col)), col, 1.12);
    col *= .92 + .16 * max(dot(N, L), 0.);
    col += vec3(.14) * pow(1. - N.z, 1.4) + vec3(.06) * (1. - smoothstep(.5, .9, h0.b));
    a *= smoothstep(.22, .62, h0.b + (n1 - .5) * .45);      // fuzzy fibres at the edge
  } else if (m < 6.5) {                    // ---------- paper ----------
    col *= 1. + .25 * rel;
    col *= .97 + .06 * hash(floor(px / uK));
    col += pow(ndh, 8.) * .05;
  } else {                                 // ---------- vinyl ----------
    col *= 1. + .35 * rel;
    col += pow(ndh, 120.) * 1.3 + pow(ndh, 16.) * .15 + .15 * pow(1. - N.z, 3.);
  }
  col = clamp(col, 0., 1.);
  gl_FragColor = vec4(col * a, a);
}`;

let gl, glc, prog, U = {}, isGL2 = false;
try {
  glc = document.createElement('canvas'); glc.width = glc.height = 512;
  const opts = { alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: false };
  gl = glc.getContext('webgl2', opts); isGL2 = !!gl;
  if (!gl) gl = glc.getContext('webgl', opts);
  if (!gl) throw new Error('no webgl');
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  for (const n of ['uCol', 'uHt', 'uHres', 'uSize', 'uFlex', 'uLight', 'uMat', 'uTime', 'uSeed', 'uK']) U[n] = gl.getUniformLocation(prog, n);
  gl.uniform1i(U.uCol, 0); gl.uniform1i(U.uHt, 1);
  gl.disable(gl.BLEND);
} catch (err) {
  console.warn('StickerFX disabled, falling back to CSS materials:', err);
  window.StickerFX = null; return;
}

// ---------- height map: dome (r), facet detail (g), rim bevel (b), alpha (a) ----------
function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h), n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const o = y * w; let acc = 0;
    for (let x = -r; x <= r; x++) acc += src[o + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) { tmp[o + x] = acc / n; acc += src[o + Math.min(w - 1, x + r + 1)] - src[o + Math.max(0, x - r)]; }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) { out[y * w + x] = acc / n; acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x]; }
  }
  return out;
}
const blurN = (src, w, h, r, k) => { let o = src; for (let i = 0; i < k; i++) o = boxBlur(o, w, h, r); return o; };
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

function buildHeight(img) {
  const k = Math.min(1, HEIGHT_MAX / Math.max(img.width, img.height));
  const w = Math.max(4, Math.round(img.width * k)), h = Math.max(4, Math.round(img.height * k));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data, N = w * h;
  const A = new Float32Array(N), LA = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    A[i] = d[i * 4 + 3] / 255;
    LA[i] = (.299 * d[i * 4] + .587 * d[i * 4 + 1] + .114 * d[i * 4 + 2]) / 255 * A[i];
  }
  const r1 = Math.max(2, Math.round(.07 * Math.min(w, h)));
  const D = blurN(A, w, h, r1, 3);
  const B = blurN(A, w, h, 2, 2);
  // alpha-normalised blurs so the transparent outside does not leak into the detail
  const A1 = boxBlur(A, w, h, 1), L1 = boxBlur(LA, w, h, 1);
  const A6 = blurN(A, w, h, 5, 2), L6 = blurN(LA, w, h, 5, 2);
  const out = isGL2 ? new Float32Array(N * 4) : new Uint8Array(N * 4);
  const s = isGL2 ? 1 : 255;
  for (let i = 0; i < N; i++) {
    const hp = (L1[i] / Math.max(A1[i], 1e-3)) - (L6[i] / Math.max(A6[i], 1e-3));
    const G = Math.min(1, Math.max(0, .5 + hp * smooth(.8, 1, B[i]) * 1.6));
    const dith = isGL2 ? 0 : (Math.random() - .5);           // 8-bit fallback: dither instead of banding
    out[i * 4] = D[i] * s + dith; out[i * 4 + 1] = G * s + dith; out[i * 4 + 2] = B[i] * s + dith; out[i * 4 + 3] = A[i] * s;
  }
  return { data: out, w, h };
}

function texParams(mip) {
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
}
function makeColorTex(img) {
  const k = Math.min(1, COLOR_MAX / Math.max(img.width, img.height));
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
  const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, c.width, c.height);
  const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
  if (isGL2) gl.generateMipmap(gl.TEXTURE_2D);
  texParams(isGL2);
  return t;
}
function makeHeightTex(hm) {
  const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  if (isGL2) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, hm.w, hm.h, 0, gl.RGBA, gl.FLOAT, hm.data);
  else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, hm.w, hm.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, hm.data);
  texParams(false);
  return t;
}

// ---------- texture cache, built a few per frame so the page never stalls ----------
const tex = new Map(), queue = [];
function loadTex(file) {
  if (tex.has(file)) return;
  const ent = { ready: false, img: null }; tex.set(file, ent);
  const img = new Image(); img.decoding = 'async';
  img.onload = () => { ent.img = img; queue.push(ent); };
  img.src = file;
}
function buildQueued(budgetEnd) {
  while (queue.length && performance.now() < budgetEnd) {
    const ent = queue.shift();
    ent.col = makeColorTex(ent.img);
    const hm = buildHeight(ent.img); ent.ht = makeHeightTex(hm); ent.hres = [hm.w, hm.h];
    ent.img = null; ent.ready = true;
  }
}

// ---------- per-sticker canvases ----------
const els = new Set(); let rr = 0;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

function attach(el, file, mat, dw, dh, clipEl) {
  const body = el.querySelector('.st-body'); if (!body) return;
  const cv = document.createElement('canvas'); cv.className = 'glfx';
  body.insertBefore(cv, body.querySelector('.fx') || null);
  Object.assign(el, { _cv: cv, _cx: cv.getContext('2d'), _file: file, _mat: mat, _dw: dw, _dh: dh, _clip: clipEl || null,
                      _seed: Math.random() * 100, _fxKey: '', _fxT: 0, _glOn: false });
  els.add(el); loadTex(file);
}
function setMaterial(el, mat) { el._mat = mat; el._fxKey = ''; }

function draw(el, ent, W, H, light, flex, t, k) {
  if (glc.width < W || glc.height < H) { glc.width = Math.max(glc.width, W); glc.height = Math.max(glc.height, H); }
  gl.viewport(0, 0, W, H);
  gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, ent.col);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, ent.ht);
  gl.uniform2f(U.uHres, ent.hres[0], ent.hres[1]);
  gl.uniform2f(U.uSize, W, H);
  gl.uniform3f(U.uLight, light[0], light[1], light[2]);
  gl.uniform2f(U.uFlex, flex[0], flex[1]);
  gl.uniform1f(U.uMat, MAT_ID[el._mat] ?? 6);
  gl.uniform1f(U.uTime, reduceMotion ? 0 : t / 1000);
  gl.uniform1f(U.uSeed, el._seed);
  gl.uniform1f(U.uK, k);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  const cx = el._cx; cx.clearRect(0, 0, W, H);
  cx.drawImage(glc, 0, glc.height - H, W, H, 0, 0, W, H);
}

// lx, ly: light position in viewport px; called once per animation frame
function frame(lx, ly, t) {
  const t0 = performance.now();
  buildQueued(t0 + 6);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const list = [...els], n = list.length; if (!n) return;
  rr = (rr + 1) % n;
  for (let i = 0; i < n; i++) {
    const el = list[(rr + i) % n];
    if (!el.isConnected) { els.delete(el); continue; }
    const ent = tex.get(el._file); if (!ent || !ent.ready) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
    if (el._clip) { const c = el._clip.getBoundingClientRect(); if (r.bottom < c.top || r.top > c.bottom) continue; }
    const sc = el._scale || 1;
    const k = Math.min(dpr * Math.max(1, sc), CANVAS_MAX / Math.max(el._dw, el._dh));
    const W = Math.max(4, Math.round(el._dw * k)), H = Math.max(4, Math.round(el._dh * k));
    if (el._cv.width !== W || el._cv.height !== H) { el._cv.width = W; el._cv.height = H; el._fxKey = ''; }
    // light into the sticker's own frame (undo its rotation, scale, mirror)
    const dx = lx - (r.left + r.width / 2), dy = ly - (r.top + r.height / 2);
    const ang = -(el._rot || 0) * Math.PI / 180, ca = Math.cos(ang), sa = Math.sin(ang);
    let ux = (dx * ca - dy * sa) / sc, uy = (dx * sa + dy * ca) / sc;
    if (el._flip) ux = -ux;
    const L = [(ux + el._dw / 2) * k, (uy + el._dh / 2) * k, 230 * k];
    const f = el._flex || [0, 0], flex = [f[0] * .012, f[1] * .012];
    const key = `${W}|${el._mat}|${(L[0] / (2 * k)) | 0}|${(L[1] / (2 * k)) | 0}|${flex[0].toFixed(2)}|${flex[1].toFixed(2)}`;
    const anim = ANIMATED[el._mat] && !reduceMotion && t - el._fxT > 40;
    if (key === el._fxKey && !anim) continue;
    if (performance.now() - t0 > 11) break;           // leave the rest for the next frame
    el._fxKey = key; el._fxT = t;
    draw(el, ent, W, H, L, flex, t, k);
    if (!el._glOn) { el._glOn = true; el.classList.add('gl-on'); }
  }
}

window.StickerFX = { attach, setMaterial, frame, isGL2 };
})();
