# Sticker Station ✦ 贴纸站

drawing++ 作业：一个复古风的贴纸画布。从网上扒来的贴纸纸样 → 切成单张透明 PNG →
在网页里「撕下来 → 拖 → 贴上去」，每种贴纸有自己的材质（宝石切面 / 闪粉 / 镭射 /
烫金 / 泡泡立体 / 毛毡 / 亚光纸 / 亮面胶），会跟着鼠标（手机上跟着陀螺仪）的光反射。

## 跑起来

纯静态，没有构建步骤。直接双击 `index.html` 就能用（贴纸清单在 `stickers/index.js`，不需要 fetch）。
想用本地服务器也行：

```bash
python3 -m http.server 8788 --directory /Users/yaowang/Desktop/drawing-plus-plus-stickers
```

## 自己导入贴纸纸（网页里，不用写代码）

直接把图片拖进页面（或粘贴；手机上点贴纸纸窗口里的虚线框选文件）：

- **一整张贴纸纸的照片或截图** → 弹出「切贴纸」窗口，自动找背景、切成一张张贴纸。
  - 贴纸被切掉一块 → 灵敏度往左；背景没去干净 → 往右
  - 一张贴纸被切成好几块 → 合并碎片往右
  - 背景是花纹 / 照片里有桌子、包装袋 → 点「💧 点一下背景」，再点一下贴纸纸的底色
  - 点某张贴纸可以排除它（变红），再点一下加回来；碰到照片边缘的会默认排除
  - 起名字、选材质，点「放进贴纸册」→ 出现一个新的贴纸纸标签
- **透明背景的单张 PNG** → 直接放进「我的」。

全部在浏览器里算（`cutter.js`，一个 Web Worker），不联网、不用 AI。
导入的贴纸存在这个浏览器的 IndexedDB 里，刷新还在；换浏览器 / 清缓存会没有。
标签上的 × 删除这张纸（画布上用到它的贴纸也会撕掉）。

## 把贴纸纸永久加进网站文件（Python，可选）

想让贴纸纸跟着网站一起发布（别人打开也有），用下面的脚本切进 `stickers/`：

1. 把扫描/扒来的整张贴纸纸放进 `sheets/`（jpg / png / webp 都行）。
2. 切图：

```bash
python3 -I tools/cut_sheet.py sheets/xxx.jpg stickers/xxx --tol 45 --gap 3 --min-area 2000
```

   - `--tol` 背景颜色容差（白底 40–50；底色和贴纸颜色接近时调小，如 42）
   - `--gap` 几像素以内的碎片合并成一张（花瓣分开的花用 3–6）
   - `--min-area` 小于这个面积的碎屑丢掉
   - `--bg r,g,b` 手动指定底色（默认从图片边缘采样）；`--crop x0,y0,x1,y1` 只切一部分
   - `--bg-expr "b - np.maximum(r,g) > 15"` 底色不均匀但色相统一时，用表达式判断背景
   - `--fg-expr "~((b - np.maximum(r,g) > 6) | (np.minimum(np.minimum(r,g),b) > 185))" --close 3 --grow 1`
     底色是花纹时的兜底方案：表达式判断"贴纸墨色"，闭运算+填洞得到贴纸形状，再长 `--grow` 像素把贴纸自己的白边收回来
   - 结果会写到 `stickers/xxx/*.png` + `manifest.json`

3. 在 `stickers/sheets.json` 里给这张纸起名字（英文 / 中文）、选默认材质：

```json
"xxx": {"label": {"en": "Tigers", "zh": "老虎"}, "material": "foil"}
```

4. 重新生成清单：

```bash
python3 -I tools/build_index.py
```

材质可选：`crystal` `glitter` `holo` `foil` `puffy` `felt` `paper` `vinyl`。

## 材质是怎么做的

`materials.js` 用一个共享的 WebGL 着色器给每张贴纸打光，光源跟着鼠标（手机上跟陀螺仪），不动时自己慢慢扫。
每张贴纸图片会先算一张高度图：透明度做出鼓起的形状和边缘倒角，亮度的细节做出切面 / 压纹，所以光真的会打在"斜面"上。

| 材质 | 看起来 | 撕起来 |
|---|---|---|
| 宝石 crystal | 平顶切面，朝光的面亮、背光的面暗，切面边缘有彩虹火彩，偶尔闪十字星 | 中等偏硬，"嗒嗒"的硬塑料声，脱离时一声玻璃"叮" |
| 闪粉 glitter | 一片片亮片各有角度，光扫过时一颗颗轮流闪，自己也会微微闪烁 | 中等，沙沙的细颗粒声，脱离时一串高音碎闪 |
| 镭射 holo | 彩虹随角度流动，有细光栅纹 | 中等，塑料膜的窸窣声 |
| 烫金 foil | 金属反射带随光移动，金色高光，边缘一圈金 | 硬，金属箔的皱响，脱离时"铮"一声 |
| 泡泡 puffy | 鼓起的软胶，大块柔光加边缘暗角 | 偏硬，软软的"噗叽"声，脱离时"啵" |
| 毛毡 felt | 纤维颗粒、绒面的边缘光、毛边 | 最轻，闷闷的"嘶" |
| 亚光纸 paper | 纸纹，几乎不反光 | 轻，干脆的纸声，脱离时"嘶啦" |
| 亮面胶 vinyl | 清漆一样的尖锐高光 | 最难撕，胶会粘住，拉一下停一下（stick-slip），低沉的粘胶声，脱离时"啪" |

撕的手感参数在 `app.js` 的 `PEEL` 表里（要拉多远、胶能扛住多大拉力、松手弹回多快），声音在 `PSND` / `DETACH` / `FLAPBACK` / `STICKX` 里，全是 Web Audio 合成的，没有音频文件。
浏览器不支持 WebGL 时会自动退回 CSS 闪光层。

## 操作 / How to use

- 撕 Peel：鼠标靠近贴纸的一个角，按住往对角方向拉；拉过一半脱离，拖到画布上松手。
- 选中画布上的贴纸：右上角 × 撕掉，右下角 ⟳ 拖动旋转 + 缩放；滚轮旋转，Shift+滚轮缩放，双击翻面，右键 / 长按换材质。
- 删除：选中按 Delete、点 ×、拖到左下角垃圾桶、或拖回贴纸纸。「✕ Clear」清空画布。
- 撤销：「↶ Undo」或 ⌘Z / Ctrl+Z，重做 ⌘⇧Z / Ctrl+Y。删除和清空都能撤销，所以不再弹确认框。
- 加贴纸：把图片直接拖进页面（不用点上传）。
  - 拖到画布上：透明 PNG 直接贴在松手的位置；整张贴纸纸照片会打开切贴纸窗口，只切出一张时也直接贴上去。
  - 拖到别处：变成新贴纸（单张进「Mine / 我的」，整张纸变成新标签）。
  - 可以直接从别的网页把图片拖过来。有些网站不允许别的网页读取它的图片，这时会提示你先把图片存下来再拖文件。
  - 粘贴（⌘V）也可以；手机上点虚线框选文件。
- 语言：右上角「中文 / EN」切换，默认英文。文字都在 `i18n.js`，加语言就是多加一列。
- 「▦ Paper」换画布纸，「⤓ Save PNG」导出。

## 结构

```
index.html / style.css / app.js   站点本体
materials.js                      WebGL 材质着色器
cutter.js                         网页里的自动切贴纸（Web Worker + 切贴纸窗口）
i18n.js                           英文 / 中文界面文字
sheets/                           原始贴纸纸（gems 宝石 / cats 猫咪 / hellokitty / zoo / feltcats / holy）
stickers/<sheet>/*.png            切好的贴纸 + manifest.json
stickers/sheets.json              每张纸的名字和默认材质
stickers/index.js                 自动生成的贴纸清单
tools/cut_sheet.py                切图
tools/build_index.py              生成清单
```

## 各张纸用的切图参数

```bash
python3 -I tools/cut_sheet.py sheets/gems.webp stickers/gems --tol 45 --gap 3 --min-area 2500
python3 -I tools/cut_sheet.py sheets/cats.webp stickers/cats --bg 236,224,50 --tol 42 --gap 2 --min-area 900 --crop 18,18,552,1049
python3 -I tools/cut_sheet.py sheets/hellokitty.webp stickers/hellokitty --tol 70 --gap 3 --min-area 900
python3 -I tools/cut_sheet.py sheets/zoo.webp stickers/zoo --tol 42 --gap 4 --min-area 6000
python3 -I tools/cut_sheet.py sheets/feltcats.png stickers/feltcats --tol 40 --gap 3 --min-area 2500
python3 -I tools/cut_sheet.py sheets/holy.webp stickers/holy --fg-expr "~((b - np.maximum(r,g) > 6) | (np.minimum(np.minimum(r,g),b) > 185))" --close 3 --grow 1 --gap 1 --min-area 1200 --crop 12,104,552,812
python3 -I tools/build_index.py
```
