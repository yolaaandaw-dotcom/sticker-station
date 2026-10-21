#!/usr/bin/env python3
"""Sticker library: collect -> cut -> fingerprint -> review -> publish.

No pictures are stored on this computer. The sheets stay on Pinterest; each
run downloads a sheet into memory, cuts it, fingerprints the stickers and
forgets the picture. Locally only a small index is kept in library/ (private,
not in git): where each sticker sits on its sheet, a tiny outline mask and its
fingerprint (a few KB per sticker). The review page shows the stickers
straight from Pinterest. Publishing re-cuts only the stickers you kept and
saves them (small WebP) into the site.

    .venv-lib/bin/python tools/stickerlib.py update     # pull new pins from your board + process them
    .venv-lib/bin/python tools/stickerlib.py review     # judge whole sheets: keep / skip (http://localhost:8790)
    .venv-lib/bin/python tools/stickerlib.py discover   # find more sheets like the ones you kept, scored by your taste
    .venv-lib/bin/python tools/stickerlib.py publish    # copy kept stickers into the site (add --push to go live)
    .venv-lib/bin/python tools/stickerlib.py status

Other ways in: put your own sheet photos in library/own/ and run `ingest` (those files stay where you put them).
The board is set in library/config.json (default: yolaaadaw/sticker).
"""
import argparse, datetime, hashlib, html, io, json, os, re, shutil, subprocess, sys, threading, time
import urllib.parse, urllib.request, xml.etree.ElementTree as ET
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
LIB = os.path.join(ROOT, "library")
sys.path.insert(0, HERE)
import autocut, taste  # noqa: E402

DB_PATH = os.path.join(LIB, "db.json")
EMB_PATH = os.path.join(LIB, "emb.npy")
EMB_IDS = os.path.join(LIB, "emb_ids.json")
SHEET_EMB = os.path.join(LIB, "sheet_emb.npy")
SHEET_EMB_IDS = os.path.join(LIB, "sheet_emb_ids.json")
CONFIG = os.path.join(LIB, "config.json")
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36"
now = lambda: datetime.datetime.now().isoformat(timespec="seconds")
_lock = threading.RLock()


# ---------------------------------------------------------------- storage
def config():
    c = {"boards": ["yolaaadaw/sticker"], "auto_keep": .85, "auto_skip": .15, "publish_max_side": 400}
    if os.path.exists(CONFIG):
        c.update(json.load(open(CONFIG)))
    else:
        os.makedirs(LIB, exist_ok=True); json.dump(c, open(CONFIG, "w"), indent=1)
    return c


def load_db():
    if os.path.exists(DB_PATH):
        return json.load(open(DB_PATH))
    return {"version": 1, "sheets": {}, "stickers": {}, "model": {}}


def save_db(db):
    with _lock:
        tmp = DB_PATH + ".tmp"
        json.dump(db, open(tmp, "w"), ensure_ascii=False, indent=0)
        os.replace(tmp, DB_PATH)


def load_emb():
    if os.path.exists(EMB_PATH) and os.path.exists(EMB_IDS):
        return np.load(EMB_PATH).astype(np.float32), json.load(open(EMB_IDS))
    return np.zeros((0, 512), np.float32), []


def save_emb(E, ids):
    np.save(EMB_PATH, E.astype(np.float16)); json.dump(ids, open(EMB_IDS, "w"))


def load_sheet_emb():
    if os.path.exists(SHEET_EMB) and os.path.exists(SHEET_EMB_IDS):
        return np.load(SHEET_EMB).astype(np.float32), json.load(open(SHEET_EMB_IDS))
    return np.zeros((0, 512), np.float32), []


def save_sheet_emb(E, ids):
    np.save(SHEET_EMB, E.astype(np.float16)); json.dump(ids, open(SHEET_EMB_IDS, "w"))


def dhash(img, n=8):
    g = np.asarray(img.convert("L").resize((n + 1, n), Image.LANCZOS), np.int16)
    bits = (g[:, 1:] > g[:, :-1]).ravel()
    return int("".join("1" if b else "0" for b in bits), 2)


# ---------------------------------------------------------------- sync (Pinterest board RSS)
def fetch(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(), r.headers.get("Content-Type", "")


def board_pins(board):
    """Latest pins of a board from its public RSS feed (Pinterest lists about the newest 25)."""
    raw, _ = fetch(f"https://www.pinterest.com/{board.strip('/')}.rss")
    root = ET.fromstring(raw)
    pins = []
    for it in root.iter("item"):
        link = (it.findtext("link") or "").strip()
        desc = it.findtext("description") or ""
        m = re.search(r'src="([^"]+)"', html.unescape(desc))
        if link and m:
            pins.append({"pin": link, "thumb": m.group(1), "title": (it.findtext("title") or "").strip(), "date": it.findtext("pubDate")})
    return pins


def download_original(thumb):
    """Thumbnail URL -> the largest version Pinterest serves (originals first, 736px as fallback)."""
    m = re.match(r"(https://i\.pinimg\.com)/[^/]+/(.+)\.(\w+)$", thumb)
    tries = []
    if m:
        base, path = m.group(1), m.group(2)
        tries = [f"{base}/originals/{path}.{e}" for e in ("jpg", "png", "webp", "gif")] + [f"{base}/736x/{path}.jpg"]
    tries.append(thumb)
    for u in tries:
        try:
            data, ctype = fetch(u)
            if ctype.startswith("image/") and len(data) > 2000:
                return data, u
        except Exception:
            pass
    raise RuntimeError("no image for " + thumb)


def sync(db, log=print):
    """Note new pins on the boards. Nothing is downloaded here."""
    cfg = config()
    known = {sh.get("pin") for sh in db["sheets"].values()}
    total = 0
    for board in cfg["boards"]:
        try:
            pins = board_pins(board)
        except Exception as e:
            log(f"  ! could not read board {board}: {e}"); continue
        new = 0
        for p in pins:
            if p["pin"] in known:
                continue
            sid = "p" + hashlib.sha1(p["pin"].encode()).hexdigest()[:10]
            db["sheets"][sid] = {"source": "pinterest", "board": board, "pin": p["pin"], "thumb": p["thumb"],
                                 "title": p["title"], "added": now(), "status": "pending"}
            known.add(p["pin"]); new += 1
        total += new
        log(f"  board {board}: {len(pins)} pins in feed, {new} new")
    return total


# ---------------------------------------------------------------- ingest: cut, filter, fingerprint, tag
def good_sticker(s, img_size):
    x0, y0, x1, y1 = s["bbox"]; w, h = x1 - x0, y1 - y0
    if min(w, h) < 28 or max(w, h) / max(1, min(w, h)) > 6:
        return False
    return s["area"] / float(w * h) >= .2            # thin fragments / slivers out


def sheet_image(sh):
    """The sheet picture, in memory. Pinterest sheets are downloaded each time; own files are read from library/own/."""
    if sh.get("source") == "pinterest":
        if sh.get("image_url"):
            try:
                data, _ = fetch(sh["image_url"]); return Image.open(io.BytesIO(data))
            except Exception:
                pass
        data, url = download_original(sh["thumb"]); sh["image_url"] = url
        return Image.open(io.BytesIO(data))
    return Image.open(os.path.join(LIB, sh["image"]))


def ingest(db, log=print):
    own = os.path.join(LIB, "own"); os.makedirs(own, exist_ok=True)
    for f in sorted(os.listdir(own)):                     # your own photos: indexed in place, never copied
        if f.lower().endswith((".jpg", ".jpeg", ".png", ".webp", ".gif")):
            sid = "f" + hashlib.sha1(f.encode()).hexdigest()[:10]
            if sid not in db["sheets"]:
                db["sheets"][sid] = {"source": "folder", "image": f"own/{f}", "added": now(), "status": "pending"}
    pending = [sid for sid, sh in db["sheets"].items() if sh.get("status") == "pending"]
    SE, sids = load_sheet_emb()
    missing = [sid for sid, sh in db["sheets"].items() if sh.get("status") == "cut" and sid not in sids]
    if missing:                                           # sheets cut before sheet fingerprints existed
        log(f"  fingerprinting {len(missing)} earlier sheets…")
        for sid in missing:
            try:
                im = sheet_image(db["sheets"][sid]); im.load()
            except Exception as e:
                log(f"  ! {sid}: {e}"); continue
            SE = np.concatenate([SE, taste.embed_images([im])]); sids.append(sid)
        save_sheet_emb(SE, sids)
    if not pending:
        log("  nothing new"); retrain(db); return 0
    ctx = Ctx(db)
    added = 0
    for sid in pending:
        sh = db["sheets"][sid]
        try:
            img = sheet_image(sh); img.load()
        except Exception as e:
            log(f"  ! {sid}: could not load ({e}); will retry next time"); continue
        n = add_sheet(db, sid, img, ctx, log)
        added += n is not None
        if added and added % 10 == 0:
            ctx.save(db)                                  # progress survives an interruption
    ctx.save(db)
    sheet_materials(db)
    retrain(db)
    return added


class Ctx:
    """Fingerprints and hashes kept in memory while a batch of sheets is added."""
    def __init__(self, db):
        self.E, self.ids = load_emb(); self.SE, self.sids = load_sheet_emb()
        self.hashes = {sid: int(sh["dhash"], 16) for sid, sh in db["sheets"].items() if sh.get("dhash")}

    def save(self, db):
        save_emb(self.E, self.ids); save_sheet_emb(self.SE, self.sids); save_db(db)


def add_sheet(db, sid, img, ctx, log=print, min_stickers=1):
    """Cut one sheet (already in memory), store outlines + fingerprints, forget the picture.
    Returns the number of stickers, or None if it was a duplicate / could not be cut."""
    sh = db["sheets"][sid]
    dh = dhash(img); sh.update(dhash=f"{dh:016x}", size=list(img.size))
    dup = next((o for o, h in ctx.hashes.items() if o != sid and bin(h ^ dh).count("1") <= 5), None)
    if dup:
        sh.update(status="dup", dup_of=dup); log(f"  = {sid}: same sheet as {dup}, skipped"); return None
    stickers, info = autocut.cut_image(img)
    keep = [x for x in stickers if good_sticker(x, info["size"])]
    if sum(1 for x in keep if not x["edge"]) < min_stickers:     # whole stickers only; cut-off pieces do not count
        sh.update(status="failed", count=len(keep)); log(f"  - {sid}: could not cut it into stickers"); return None
    sh.update(status="cut", count=len(keep), work_size=info["size"], decision=None, auto=False, score=None)
    ctx.hashes[sid] = dh
    ctx.SE = np.concatenate([ctx.SE, taste.embed_images([img])]); ctx.sids.append(sid)   # the whole sheet: what you judge
    os.makedirs(os.path.join(LIB, "masks", sid), exist_ok=True)
    new_imgs, new_ids = [], []
    for n, x in enumerate(keep):
        stid = f"{sid}_{n:03d}"; rel = f"masks/{sid}/{n:03d}.png"
        x["rgba"].getchannel("A").save(os.path.join(LIB, rel), optimize=True)    # outline only, a few KB
        db["stickers"][stid] = {"sheet": sid, "mask": rel, "w": x["rgba"].width, "h": x["rgba"].height,
                                "bbox": x["bbox"], "edge": x["edge"], "excluded": False,
                                "material": None, "theme": None, "dup_of": None, "added": now()}
        new_imgs.append(x["rgba"]); new_ids.append(stid)
    NE = taste.embed_images(new_imgs)
    if len(ctx.E):                                        # near-identical stickers already in the library are hidden
        S = NE @ ctx.E.T; best = S.argmax(1)
        for i, stid in enumerate(new_ids):
            if S[i, best[i]] >= .985:
                db["stickers"][stid]["dup_of"] = ctx.ids[best[i]]
    for stid, (m, t) in zip(new_ids, taste.auto_tags(NE)):
        db["stickers"][stid]["material_guess"] = m; db["stickers"][stid]["theme"] = t
    ctx.E = np.concatenate([ctx.E, NE]); ctx.ids = ctx.ids + new_ids
    edge = sum(x["edge"] for x in keep)
    log(f"  + {sid}: {len(keep)} stickers" + (f" ({edge} cut off by the photo edge)" if edge else ""))
    return len(keep)


def sheet_materials(db):
    """One material per source sheet: majority vote of its stickers (a sheet is printed one way)."""
    from collections import Counter
    by = {}
    for st in db["stickers"].values():
        if st.get("material_guess"):
            by.setdefault(st["sheet"], []).append(st["material_guess"])
    for sid, ms in by.items():
        sh = db["sheets"][sid]
        if not sh.get("material_set"):                  # a material chosen by hand wins
            sh["material"] = Counter(ms).most_common(1)[0][0]
    for st in db["stickers"].values():
        st["material"] = db["sheets"][st["sheet"]].get("material", "paper")


# ---------------------------------------------------------------- taste model (whole sheets)
_model = {"clf": None}
def retrain(db):
    """Learn from the sheets you kept / skipped; score every other sheet."""
    SE, sids = load_sheet_emb()
    if not len(sids):
        return
    pos = {s: i for i, s in enumerate(sids)}
    judged = [(sid, sh["decision"]) for sid, sh in db["sheets"].items()
              if sh.get("decision") in ("keep", "skip") and not sh.get("auto") and sid in pos]
    X = SE[[pos[s] for s, _ in judged]] if judged else np.zeros((0, 512))
    y = [1 if d == "keep" else 0 for _, d in judged]
    clf, acc = taste.train_taste(X, y)
    _model["clf"] = clf
    scores = taste.score(clf, SE)
    for i, sid in enumerate(sids):
        if sid in db["sheets"]:
            v = scores[i]; db["sheets"][sid]["score"] = None if np.isnan(v) else round(float(v), 4)
    db["model"] = {"trained": now(), "n": len(y), "keeps": int(sum(y)), "acc": None if acc is None else round(acc, 3)}


def apply_model(db):
    """Let the model decide the sheets it is sure about (marked auto; you can still change them)."""
    cfg = config(); k = s = 0
    for sh in db["sheets"].values():
        if sh.get("status") == "cut" and sh.get("decision") is None and sh.get("score") is not None:
            if sh["score"] >= cfg["auto_keep"]:
                sh.update(decision="keep", auto=True); k += 1
            elif sh["score"] <= cfg["auto_skip"]:
                sh.update(decision="skip", auto=True); s += 1
    return k, s


def kept_stickers(db):
    """Stickers that go to the site: from kept sheets, minus pieces you clicked out, cut-off pieces and duplicates."""
    return [(sid, st) for sid, st in sorted(db["stickers"].items())
            if db["sheets"].get(st["sheet"], {}).get("decision") == "keep"
            and not st.get("excluded") and not st["edge"] and not st.get("dup_of")]


# ---------------------------------------------------------------- discover: find more sheets like the ones you keep
# Openverse (openverse.org) searches openly licensed photos (mostly Flickr / Wikimedia). Its API is public and
# meant for this. "No derivatives" licences are skipped, because cutting a photo into stickers changes it.
DISCOVER_QUERIES = ["vintage stickers", "80s stickers", "90s stickers", "prism stickers", "sticker sheet", "sticker collection",
                    "holographic stickers", "glitter stickers", "puffy stickers", "fuzzy stickers", "lisa frank stickers",
                    "sandylion stickers", "scratch and sniff stickers", "sticker album"]
OK_LICENSES = "by,by-sa,by-nc,by-nc-sa,cc0,pdm"


def openverse(q, page):
    url = ("https://api.openverse.org/v1/images/?" +
           urllib.parse.urlencode({"q": q, "page": page, "page_size": 20, "license": OK_LICENSES}))
    raw, _ = fetch(url)
    return json.loads(raw).get("results", [])


def discover(db, max_new=40, pages=2, log=print):
    cfg = config()
    retrain(db)
    clf = _model["clf"]
    SE, sids = load_sheet_emb(); pos = {s: i for i, s in enumerate(sids)}
    kept = [pos[s] for s, sh in db["sheets"].items() if sh.get("decision") == "keep" and not sh.get("auto") and s in pos]
    if clf is None and not kept:
        log("  judge some sheets first (keep at least a few), so it knows what to look for"); return 0
    K = SE[kept] if kept else None
    minp = cfg.get("discover_min", .5)
    seen = {sh.get("source_id") for sh in db["sheets"].values() if sh.get("source_id")}
    seen |= set(db.get("discover_seen", []))
    ctx = Ctx(db); added = looked = 0
    for q in cfg.get("discover_queries", DISCOVER_QUERIES):
        for page in range(1, pages + 1):
            try:
                results = openverse(q, page)
            except Exception as e:
                log(f"  ! search '{q}' failed: {e}"); break
            time.sleep(3.2)                               # stay well inside Openverse's anonymous rate limit
            for r in results:
                rid = r.get("id")
                if not rid or rid in seen:
                    continue
                seen.add(rid); looked += 1
                try:
                    data, _ = fetch(r["url"]); img = Image.open(io.BytesIO(data)); img.load()
                except Exception:
                    continue
                e = taste.embed_images([img])
                # how much it looks like what you keep: the taste model if it has learnt, otherwise nearness to kept sheets
                p = float(clf.predict_proba(e)[0, 1]) if clf is not None else float((e @ K.T).max() - .25) / .6
                if p < minp:
                    continue
                sid = "o" + hashlib.sha1(rid.encode()).hexdigest()[:10]
                db["sheets"][sid] = {"source": "openverse", "source_id": rid, "pin": r.get("foreign_landing_url"),
                                     "image_url": r["url"], "title": r.get("title"), "creator": r.get("creator"),
                                     "license": r.get("license"), "license_version": r.get("license_version"),
                                     "provider": r.get("provider"), "added": now(), "status": "pending", "query": q}
                n = add_sheet(db, sid, img, ctx, log, min_stickers=3)   # a real sheet has several stickers
                if n is None:
                    continue
                db["sheets"][sid]["score"] = round(p, 4); added += 1
                if added >= max_new:
                    break
            if added >= max_new:
                break
        if added >= max_new:
            break
    db["discover_seen"] = sorted(seen)
    ctx.save(db); sheet_materials(db); retrain(db); save_db(db)
    log(f"  looked at {looked} new pictures, added {added} sheets that look like your taste (tab: Found for you)")
    return added


# ---------------------------------------------------------------- publish to the site
def publish(db, push=False, log=print):
    cfg = config()
    sheets_json = os.path.join(ROOT, "stickers", "sheets.json")
    site = json.load(open(sheets_json))
    for key in [k for k in site if k.startswith("lib-")]:
        del site[key]
    for d in os.listdir(os.path.join(ROOT, "stickers")):
        if d.startswith("lib-"):
            shutil.rmtree(os.path.join(ROOT, "stickers", d))
    kept = kept_stickers(db)
    # re-cut the kept stickers from their sheets: each sheet is downloaded into memory once
    def match(cut, bb):
        best, iou = None, 0
        for x in cut:
            a = x["bbox"]
            ix = max(0, min(a[2], bb[2]) - max(a[0], bb[0])); iy = max(0, min(a[3], bb[3]) - max(a[1], bb[1]))
            u = (a[2] - a[0]) * (a[3] - a[1]) + (bb[2] - bb[0]) * (bb[3] - bb[1]) - ix * iy
            if u and ix * iy / u > iou:
                best, iou = x, ix * iy / u
        return best["rgba"] if best is not None and iou > .8 else None
    images, by_sheet = {}, {}
    for sid, st in kept:
        by_sheet.setdefault(st["sheet"], []).append((sid, st))
    for sheet_id, lst in by_sheet.items():
        try:
            cut = autocut.cut_image(sheet_image(db["sheets"][sheet_id]))[0]
        except Exception as e:
            log(f"  ! sheet {sheet_id} unavailable ({e}); its {len(lst)} stickers are left out"); continue
        for sid, st in lst:
            im = match(cut, st["bbox"])
            if im is None:
                log(f"  ! {sid}: could not find it on its sheet any more")
            else:
                k = min(1.0, cfg["publish_max_side"] / max(im.size))
                images[sid] = im if k >= 1 else im.resize((round(im.width * k), round(im.height * k)), Image.LANCZOS)
    groups = {}
    for sid, st in kept:
        if sid in images:
            groups.setdefault(st.get("theme") or "things", []).append((sid, st))
    small = [t for t, v in groups.items() if len(v) < cfg.get("min_sheet", 6)]
    if len(small) > 1:                                    # tiny themes share one "More stickers" sheet
        groups["mixed"] = [x for t in small for x in groups.pop(t)]
    credits = []
    order = list(taste.THEMES)
    for theme in sorted(groups, key=lambda t: order.index(t) if t in order else 99):
        items = groups[theme]; key = f"lib-{theme}"; out_dir = os.path.join(ROOT, "stickers", key)
        os.makedirs(out_dir, exist_ok=True)
        manifest = []
        n = -1
        for sid, st in items:
            im = images.get(sid)
            if im is None:
                continue
            n += 1
            fn = f"{n:03d}.webp"; im.save(os.path.join(out_dir, fn), "WEBP", quality=88, method=6)
            sh = db["sheets"][st["sheet"]]
            src = sh.get("pin") or ""
            credit = (f'{sh.get("creator") or "unknown"}, {(sh.get("license") or "").upper()} {sh.get("license_version") or ""}'.strip()
                      if sh.get("source") == "openverse" else "Pinterest")
            manifest.append({"name": sid, "file": fn, "w": im.width, "h": im.height, "mat": st.get("material") or "paper", "src": src})
            credits.append({"theme": theme, "file": f"stickers/{key}/{fn}", "src": src, "credit": credit})
            st["published"] = True
        json.dump(manifest, open(os.path.join(out_dir, "manifest.json"), "w"), indent=1)
        en, zh, _ = taste.THEMES.get(theme, ("More stickers", "更多贴纸", []) if theme == "mixed" else (theme.title(), theme, []))
        site[key] = {"label": {"en": en, "zh": zh}, "material": "paper"}
        log(f"  {key}: {n + 1} stickers")
    json.dump(site, open(sheets_json, "w"), ensure_ascii=False, indent=1)
    write_credits(credits)
    save_db(db)
    subprocess.run([sys.executable, "-I", os.path.join(HERE, "build_index.py")], check=True)
    log(f"  published {len(images)} stickers in {len(groups)} sheets")
    if push:
        subprocess.run(["git", "-C", ROOT, "add", "-A", "stickers", "credits.html"], check=True)
        r = subprocess.run(["git", "-C", ROOT, "commit", "-q", "-m", f"Sticker library: {len(images)} stickers"], capture_output=True, text=True)
        if r.returncode == 0:
            subprocess.run(["git", "-C", ROOT, "push", "-q"], check=True); log("  pushed: the live site updates in a minute or two")
        else:
            log("  nothing new to push")


def write_credits(credits):
    rows = "\n".join(
        f'<a class="c" href="{html.escape(c["src"] or "#")}" target="_blank" rel="noopener" title="{html.escape(c["credit"])}"><img loading="lazy" src="{c["file"]}" alt="{html.escape(c["credit"])}"></a>'
        for c in credits)
    open(os.path.join(ROOT, "credits.html"), "w").write(f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Sticker Station · sources</title>
<style>body{{margin:0;padding:16px;font:13px/1.5 Verdana,sans-serif;background:#d2d0cc;color:#111}}
.w{{max-width:960px;margin:0 auto}}h1{{font:italic 700 28px 'Times New Roman',serif}}
.g{{display:flex;flex-wrap:wrap;gap:8px}}.c{{display:grid;place-items:center;width:84px;height:84px;background:#f3eee2;border:1px solid #aaa;border-radius:4px}}
.c img{{max-width:72px;max-height:72px}}.c:hover{{outline:2px solid #d1227a}}</style></head><body><div class="w">
<h1>Sticker sources · 贴纸来源</h1>
<p>A non-commercial class project (drawing++). The sticker artwork belongs to its original makers. Each sticker links to the
Pinterest pin it was collected from. If you made one of these and want it removed, open an issue on
<a href="https://github.com/yolaaandaw-dotcom/sticker-station/issues">GitHub</a> and it will be taken down.</p>
<p>非商业课程作业。贴纸图案版权归原作者。每张贴纸都链接到它的 Pinterest 来源。如果你是作者并希望删除，请在 GitHub 提 issue。</p>
<div class="g">{rows}</div><p><a href="./">← back to Sticker Station</a></p></div></body></html>""")


# ---------------------------------------------------------------- review server
def serve(port=8790, open_browser=True):
    from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
    db = load_db(); state = {"since": 0, "mtime": os.path.getmtime(DB_PATH) if os.path.exists(DB_PATH) else 0, "job": None}

    def fresh():                                          # the command line may have changed the library meanwhile
        if os.path.exists(DB_PATH) and os.path.getmtime(DB_PATH) > state["mtime"] + .5 and not state["job"]:
            db.clear(); db.update(load_db()); state["mtime"] = os.path.getmtime(DB_PATH)

    def saved():
        save_db(db); state["mtime"] = os.path.getmtime(DB_PATH)

    def run_publish():
        log = []
        state["job"] = {"running": True, "log": log}
        try:
            publish(db, push=True, log=lambda m: log.append(m.strip()))
        except Exception as e:
            log.append(f"failed: {e}")
        finally:
            state["mtime"] = os.path.getmtime(DB_PATH); state["job"] = {"running": False, "log": log}

    def run_discover(n):
        log = []
        state["job"] = {"running": True, "log": log}
        try:
            discover(db, max_new=n, log=lambda m: log.append(m.strip()))
        except Exception as e:
            log.append(f"failed: {e}")
        finally:
            state["mtime"] = os.path.getmtime(DB_PATH); state["job"] = {"running": False, "log": log}

    def payload():
        by = {}
        for stid, st in db["stickers"].items():
            if not st.get("dup_of"):
                by.setdefault(st["sheet"], []).append({"id": stid, "k": st["mask"], "b": st["bbox"], "e": st["edge"], "x": bool(st.get("excluded")), "t": st.get("theme")})
        sheets = []
        for sid, s in db["sheets"].items():
            if s.get("status") != "cut":
                continue
            sheets.append({"id": sid, "img": s.get("image_url") or ("lib/" + s["image"] if s.get("image") else None),
                           "work": s.get("work_size"), "pin": s.get("pin"), "m": s.get("material"), "d": s.get("decision"),
                           "a": bool(s.get("auto")), "p": s.get("score"), "pub": any(db["stickers"][x["id"]].get("published") for x in by.get(sid, [])),
                           "disc": s.get("source") == "openverse",
                           "lic": f'{s.get("creator") or "unknown"} · {s.get("license", "").upper()} via {s.get("provider") or "Openverse"}' if s.get("source") == "openverse" else None,
                           "st": by.get(sid, [])})
        return {"sheets": sheets, "model": db.get("model", {}), "cfg": config(), "materials": list(taste.MATERIALS),
                "kept_stickers": len(kept_stickers(db)), "job": state["job"]}

    class H(SimpleHTTPRequestHandler):
        def log_message(self, *a): pass

        def translate_path(self, path):
            p = path.split("?")[0]
            if p in ("/", "/review", "/review.html"):
                return os.path.join(HERE, "review.html")
            if p.startswith("/lib/"):
                return os.path.join(LIB, p[5:])
            return os.path.join(LIB, "__nope__")

        def _json(self, obj, code=200):
            b = json.dumps(obj).encode(); self.send_response(code)
            self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b)))
            self.end_headers(); self.wfile.write(b)

        def do_GET(self):
            if self.path.startswith("/api/job"):
                return self._json(state["job"] or {})
            if self.path.startswith("/api/state"):
                with _lock:
                    fresh(); return self._json(payload())
            return super().do_GET()

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            if self.path == "/api/publish":
                if state["job"] and state["job"].get("running"):
                    return self._json({"ok": False, "msg": "busy, try again in a moment"})
                threading.Thread(target=run_publish, daemon=True).start()
                return self._json({"ok": True})
            if self.path == "/api/discover":
                if state["job"] and state["job"].get("running"):
                    return self._json({"ok": False, "msg": "already looking"})
                threading.Thread(target=run_discover, args=(int(body.get("max", 30)),), daemon=True).start()
                return self._json({"ok": True})
            if state["job"] and state["job"].get("running"):
                return self._json({"error": "busy finding sheets, try again in a moment"}, 409)
            with _lock:
                fresh()
                if self.path == "/api/decide":
                    for sid in body["sheets"]:
                        sh = db["sheets"].get(sid)
                        if sh:
                            sh["decision"] = body["decision"]; sh["auto"] = False; sh["decided"] = now()
                    state["since"] += len(body["sheets"])
                    retrained = False
                    if state["since"] >= 5:                  # learn again after every five sheets
                        retrain(db); state["since"] = 0; retrained = True
                    saved()
                    return self._json({"ok": True, "retrained": retrained, "model": db.get("model", {}),
                                       "scores": {sid: s.get("score") for sid, s in db["sheets"].items()} if retrained else None,
                                       "kept_stickers": len(kept_stickers(db))})
                if self.path == "/api/exclude":
                    st = db["stickers"].get(body["id"])
                    if st:
                        st["excluded"] = bool(body["excluded"])
                    saved(); return self._json({"ok": True, "kept_stickers": len(kept_stickers(db))})
                if self.path == "/api/retrain":
                    retrain(db); state["since"] = 0; saved(); return self._json(payload())
                if self.path == "/api/apply":
                    retrain(db); k, s = apply_model(db); saved()
                    return self._json({"kept": k, "skipped": s, **payload()})
                if self.path == "/api/material":
                    sh = db["sheets"].get(body["sheet"])
                    if sh:
                        sh["material"] = body["material"]; sh["material_set"] = True
                        for st in db["stickers"].values():
                            if st["sheet"] == body["sheet"]:
                                st["material"] = body["material"]
                    saved(); return self._json({"ok": True})
            self._json({"error": "unknown"}, 404)

    srv = ThreadingHTTPServer(("127.0.0.1", port), H)
    url = f"http://localhost:{port}/"
    print(f"review page: {url}   (Ctrl+C to stop)")
    if open_browser:
        threading.Timer(.6, lambda: subprocess.run(["open", url])).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


# ---------------------------------------------------------------- cli
def status(db):
    sh = [s for s in db["sheets"].values()]
    cut = [s for s in sh if s.get("status") == "cut"]
    c = lambda f: sum(1 for s in cut if f(s))
    m = db.get("model", {})
    used = sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk(LIB) if "models" not in d for f in fs)
    print(f"local index: {used / 1e6:.1f} MB (no pictures stored; the model files are separate)")
    print(f"sheets: {len(cut)} to judge  kept {c(lambda s: s.get('decision') == 'keep')}  skipped {c(lambda s: s.get('decision') == 'skip')}  "
          f"not judged yet {c(lambda s: s.get('decision') is None)}   "
          f"({sum(1 for s in sh if s.get('status') == 'dup')} duplicates, {sum(1 for s in sh if s.get('status') == 'failed')} could not be cut)")
    print(f"stickers from kept sheets (go to the site on publish): {len(kept_stickers(db))}")
    print(f"taste model: {m.get('n', 0)} sheets judged by you, accuracy {m.get('acc')}" if m.get("n") else "taste model: judge a few sheets to start it")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["update", "sync", "ingest", "discover", "review", "publish", "status", "retrain"])
    ap.add_argument("--max", type=int, default=40, help="discover: at most this many new sheets")
    ap.add_argument("--push", action="store_true", help="publish: commit and push so the live site updates")
    ap.add_argument("--port", type=int, default=8790)
    ap.add_argument("--no-open", action="store_true")
    a = ap.parse_args()
    db = load_db(); config()
    if a.cmd in ("update", "sync"):
        print("syncing boards…"); sync(db)
    if a.cmd in ("update", "ingest"):
        print("processing inbox…"); ingest(db); save_db(db); status(db)
    if a.cmd == "discover":
        print("looking for sheets like the ones you keep…"); discover(db, max_new=a.max); status(db)
    if a.cmd == "retrain":
        retrain(db); save_db(db); status(db)
    if a.cmd == "status":
        status(db)
    if a.cmd == "publish":
        publish(db, push=a.push)
    if a.cmd == "review":
        serve(a.port, not a.no_open)


if __name__ == "__main__":
    main()
