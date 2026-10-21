#!/usr/bin/env python3
"""Fingerprints, auto tags and the taste model for the sticker library.

- fingerprint: CLIP (ViT-B/32, quantised ONNX) turns a sticker into 512 numbers;
  stickers that look alike get similar numbers. Runs locally, no network.
- auto tags: the same model compares each sticker with short descriptions
  ("a glittery prism sticker", "a sticker of an animal" ...) to guess the
  site material and a theme.
- taste: a small logistic-regression model learns from the sheets you keep /
  skip and scores every other sheet (0..1 = how likely you'd keep it).
"""
import os
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.path.join(HERE, "..", "library", "models", "clip")
MEAN = np.array([0.48145466, 0.4578275, 0.40821073], np.float32)
STD = np.array([0.26862954, 0.26130258, 0.27577711], np.float32)

# site material  <-  descriptions the model compares against (several per material, averaged)
MATERIALS = {
    "glitter": ["a glittery prism sticker with sparkles", "a holographic glitter sticker", "a sparkly prismatic sticker"],
    "holo":    ["a rainbow holographic foil sticker", "an iridescent laser sticker"],
    "felt":    ["a fuzzy flocked sticker", "a soft velvet fuzzy sticker", "a furry fuzzy sticker with soft fibers",
                "a fuzzy felt cat sticker"],
    "puffy":   ["a puffy 3d foam sticker", "a raised puffy bubble sticker"],
    "foil":    ["a shiny gold foil sticker", "a metallic gold embossed sticker"],
    "crystal": ["a gemstone sticker", "a jewel rhinestone sticker", "a faceted gem"],
    "paper":   ["a flat printed paper sticker", "a matte paper sticker", "a photo sticker"],
    "vinyl":   ["a glossy vinyl sticker", "a shiny plastic sticker"],
}
# theme -> (label en, label zh, descriptions)
THEMES = {
    "sky":       ("Sky & weather", "天空天气", ["a sticker of clouds, rain or a rainbow", "a sticker of the sun, moon or stars", "a weather sticker"]),
    "animals":   ("Animals", "动物", ["a sticker of an animal", "a sticker of a cat or a dog", "a sticker of a bird or a bear"]),
    "sea":       ("Sea", "海洋", ["a sticker of fish, dolphins or sea creatures", "an ocean sticker"]),
    "bugs":      ("Bugs & butterflies", "虫虫蝴蝶", ["a sticker of a butterfly", "a sticker of a bee, ladybug or insect"]),
    "flowers":   ("Flowers", "花草", ["a sticker of flowers", "a sticker of plants and leaves"]),
    "food":      ("Food & sweets", "食物甜点", ["a sticker of fruit", "a sticker of ice cream, cake or candy", "a food sticker"]),
    "hearts":    ("Hearts", "爱心", ["a heart shaped sticker", "a love valentine sticker"]),
    "fantasy":   ("Fantasy", "奇幻", ["a sticker of a unicorn, dragon or fairy", "a magical fantasy sticker"]),
    "characters":("Characters", "卡通角色", ["a cartoon character sticker", "a kawaii character sticker"]),
    "spooky":    ("Spooky", "万圣节", ["a halloween sticker", "a skeleton or ghost sticker"]),
    "gems":      ("Gems", "宝石", ["a gemstone sticker", "a jewel sticker"]),
    "things":    ("Things", "小物件", ["a sticker of an everyday object", "a sticker of a toy"]),
}

_sess = {}


def _session(kind):
    if kind not in _sess:
        import onnxruntime as ort
        o = ort.SessionOptions(); o.log_severity_level = 3
        _sess[kind] = ort.InferenceSession(os.path.join(MODEL_DIR, "onnx", f"{kind}_model_quantized.onnx"), o,
                                           providers=["CPUExecutionProvider"])
    return _sess[kind]


def _prep(img):
    """Sticker -> 224x224 tensor. Transparent stickers sit on light grey, padded to a square (nothing cropped)."""
    im = img.convert("RGBA")
    s = max(im.size)
    canvas = Image.new("RGBA", (s, s), (240, 240, 240, 255))
    canvas.alpha_composite(im, ((s - im.width) // 2, (s - im.height) // 2))
    x = np.asarray(canvas.convert("RGB").resize((224, 224), Image.BICUBIC), np.float32) / 255.0
    return ((x - MEAN) / STD).transpose(2, 0, 1)


def embed_images(imgs, batch=16):
    out = []
    s = _session("vision")
    for i in range(0, len(imgs), batch):
        x = np.stack([_prep(im) for im in imgs[i:i + batch]])
        out.append(s.run(None, {"pixel_values": x})[0])
    e = np.concatenate(out) if out else np.zeros((0, 512), np.float32)
    return e / np.linalg.norm(e, axis=1, keepdims=True).clip(1e-8)


_text_cache = {}


def embed_texts(texts):
    import tokenizers
    key = tuple(texts)
    if key in _text_cache:
        return _text_cache[key]
    tok = tokenizers.Tokenizer.from_file(os.path.join(MODEL_DIR, "tokenizer.json"))
    s = _session("text"); out = []
    for t in texts:                                     # one at a time: no padding needed
        ids = np.array([tok.encode(t).ids[:77]], np.int64)
        out.append(s.run(None, {"input_ids": ids})[0][0])
    e = np.array(out, np.float32); e /= np.linalg.norm(e, axis=1, keepdims=True).clip(1e-8)
    _text_cache[key] = e
    return e


def _classes(table, pick):
    names, vecs = [], []
    for name, v in table.items():
        descs = pick(v); e = embed_texts(descs).mean(0); e /= np.linalg.norm(e)
        names.append(name); vecs.append(e)
    return names, np.array(vecs)


def auto_tags(E):
    """For each fingerprint: (material, theme) best guesses."""
    if len(E) == 0:
        return []
    mn, mv = _classes(MATERIALS, lambda v: v)
    tn, tv = _classes(THEMES, lambda v: v[2])
    m = (E @ mv.T).argmax(1); t = (E @ tv.T).argmax(1)
    return [(mn[a], tn[b]) for a, b in zip(m, t)]


# ---------- taste model ----------
def train_taste(E, labels):
    """E: fingerprints of judged stickers, labels: 1 keep / 0 skip.
    Returns (model or None, cross-validated accuracy or None)."""
    y = np.asarray(labels)
    if len(y) < 8 or y.sum() < 3 or (len(y) - y.sum()) < 3:
        return None, None
    from sklearn.linear_model import LogisticRegression
    from sklearn.model_selection import cross_val_score
    clf = LogisticRegression(C=2.0, class_weight="balanced", max_iter=2000)
    folds = int(min(5, y.sum(), len(y) - y.sum()))
    acc = float(cross_val_score(clf, E, y, cv=folds).mean()) if folds >= 2 else None
    clf.fit(E, y)
    return clf, acc


def score(clf, E):
    if clf is None or len(E) == 0:
        return np.full(len(E), np.nan)
    return clf.predict_proba(E)[:, 1]
