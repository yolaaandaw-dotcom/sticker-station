/* ===========================================================
   I18N — English (default) / 中文.
   Static text in index.html uses data-i18n="key" (text, may hold
   simple HTML) and data-i18n-title="key" (tooltip). Scripts call
   I18N.t('key', { vars }). Add a language by adding a column.
   =========================================================== */
(() => {
'use strict';
const D = {
  title:        { en: 'Sticker Station', zh: '贴纸站 Sticker Station' },
  logoSub:      { en: 'an interactive sticker sheet · est. 2000', zh: '贴纸站 · 一本会反光的贴纸册 · est. 2000' },
  lang:         { en: '中文', zh: 'EN' },
  langTip:      { en: '切换到中文', zh: 'Switch to English' },
  sound:        { en: '♪ Sound', zh: '♪ 音效' },
  soundTip:     { en: 'Sound on / off', zh: '音效开关' },
  paper:        { en: '▦ Paper', zh: '▦ 换纸' },
  paperTip:     { en: 'Change the canvas paper', zh: '换画布纸张' },
  undo:         { en: '↶ Undo', zh: '↶ 撤销' },
  undoTip:      { en: 'Undo (⌘Z / Ctrl+Z)', zh: '撤销（⌘Z / Ctrl+Z）' },
  export:       { en: '⤓ Save PNG', zh: '⤓ 导出' },
  exportTip:    { en: 'Save the canvas as a PNG', zh: '把画布存成 PNG' },
  clear:        { en: '✕ Clear', zh: '✕ 清空' },
  clearTip:     { en: 'Peel everything off the canvas (you can undo)', zh: '把画布上的贴纸全部撕掉（可以撤销）' },
  sheetsTitle:  { en: 'sticker sheets', zh: '贴纸纸' },
  material:     { en: 'Material', zh: '材质' },
  matAuto:      { en: 'Auto (per sheet)', zh: '自动（按贴纸纸）' },
  m_crystal:    { en: 'Gem facets', zh: '宝石切面' },
  m_glitter:    { en: 'Glitter', zh: '闪粉' },
  m_holo:       { en: 'Holographic', zh: '镭射' },
  m_foil:       { en: 'Gold foil', zh: '烫金' },
  m_puffy:      { en: 'Puffy', zh: '泡泡立体' },
  m_felt:       { en: 'Fuzzy felt', zh: '毛毡' },
  m_paper:      { en: 'Matte paper', zh: '亚光纸' },
  m_vinyl:      { en: 'Glossy vinyl', zh: '亮面胶' },
  mine:         { en: 'Mine', zh: '我的' },
  dropZone:     { en: '<b>Drop pictures here</b><small>a whole sticker sheet gets cut up for you · a transparent PNG becomes one sticker · images dragged straight from other web pages work too</small>',
                  zh: '<b>把图片拖到这里</b><small>整张贴纸纸会自动切好 · 透明背景的 PNG 直接变成一张贴纸 · 也可以直接从别的网页把图片拖过来</small>' },
  dropZoneTip:  { en: 'Or click to choose files', zh: '也可以点这里选文件' },
  canvasHint:   { en: "stick 'em here ✦<small>grab a sticker by its corner, peel it off, drop it here<br>drop any picture on the page to make new stickers</small>",
                  zh: '把贴纸贴到这里 ✦<small>按住贴纸的一个角撕下来，拖到这里松手<br>把任何图片拖进页面就能变成新贴纸</small>' },
  statusTip:    { en: 'peel from a corner · wheel rotates · ⌘Z undo', zh: '从角上撕 · 滚轮旋转 · ⌘Z 撤销' },
  placed:       { en: 'placed:', zh: '已贴：' },
  dropAll:      { en: 'Drop to make stickers', zh: '放开 → 变成贴纸' },
  dropCanvas:   { en: 'Drop to stick it right here', zh: '放开 → 直接贴在这里' },
  trash:        { en: '🗑 drop here to peel off', zh: '🗑 拖到这里撕掉' },
  tabDelete:    { en: 'Delete this sheet', zh: '删除这张贴纸纸' },
  emptyMine:    { en: 'No stickers of your own yet.<br>Drop pictures anywhere on the page.', zh: '还没有自己的贴纸。<br>把图片拖进页面任何地方就行。' },
  emptySheet:   { en: 'This sheet is empty.', zh: '这张纸是空的。' },
  c_flip:       { en: 'Flip', zh: '翻面' },
  c_front:      { en: 'Bring to front', zh: '置顶' },
  c_dup:        { en: 'Duplicate', zh: '复制' },
  c_del:        { en: 'Peel off', zh: '撕掉' },
  h_del:        { en: 'Peel off (Delete)', zh: '撕掉（Delete）' },
  h_rot:        { en: 'Drag to rotate and resize', zh: '拖动旋转、缩放' },
  t_unreadable: { en: 'Couldn’t read {name}', zh: '这张图读不了：{name}' },
  t_cut:        { en: '“{label}” is ready: {n} stickers', zh: '「{label}」切好了：{n} 张贴纸' },
  t_cleared:    { en: 'Canvas cleared', zh: '画布清空了' },
  t_peeled:     { en: 'Peeled off', zh: '撕掉了' },
  t_undo:       { en: 'Undo', zh: '撤销' },
  t_nothing:    { en: 'Nothing to undo', zh: '没有可以撤销的了' },
  t_fetching:   { en: 'Fetching the image…', zh: '正在取图片…' },
  t_webBlocked: { en: 'That site won’t let other pages read its images. Save the picture first, then drop the file.', zh: '这个网站不让别的网页读它的图片。先把图片存下来，再把文件拖进来。' },
  t_notImage:   { en: 'That wasn’t a picture.', zh: '拖进来的不是图片。' },
  confirmSheet: { en: 'Delete the sheet “{label}”?', zh: '删除贴纸纸「{label}」？' },
  confirmUsed:  { en: '\n{n} stickers on the canvas come from it and will be peeled off too.', zh: '\n画布上用到它的 {n} 张贴纸也会被撕掉。' },
  // cutter
  cutTitle:     { en: 'sticker cutter', zh: '切贴纸' },
  cutBusy:      { en: 'cutting…', zh: '切割中…' },
  cutPacking:   { en: 'packing…', zh: '打包中…' },
  cutName:      { en: 'Name', zh: '名字' },
  cutSens:      { en: 'Sensitivity', zh: '灵敏度' },
  cutSensHint:  { en: 'part of a sticker missing → left · background left over → right', zh: '贴纸被切掉一块 → 往左；背景没去干净 → 往右' },
  cutGap:       { en: 'Merge pieces', zh: '合并碎片' },
  cutGapHint:   { en: 'one sticker split into pieces → right', zh: '一张贴纸被切成几块 → 往右' },
  cutPick:      { en: '💧 Click the background', zh: '💧 点一下背景' },
  cutReset:     { en: '↺ Start over', zh: '↺ 重来' },
  cutCancel:    { en: 'Cancel', zh: '取消' },
  cutOk:        { en: 'Add to my sheets', zh: '放进贴纸册' },
  cutFound:     { en: 'Found <b>{n}</b> stickers.', zh: '找到 <b>{n}</b> 张贴纸。' },
  cutExcluded:  { en: ' {ex} more are excluded (red); click one to add it back.', zh: '另有 {ex} 块已排除（红色），点一下可以加回来。' },
  cutClickTip:  { en: '<br>Click a sticker to exclude it or add it back.', zh: '<br>点贴纸可以排除 / 加回。' },
  cutErr:       { en: 'Cutting failed: ', zh: '切割出错：' },
  cutPackErr:   { en: 'Packing failed: ', zh: '打包出错：' },
  cutNewSheet:  { en: 'New sheet', zh: '新贴纸纸' },
};

let lang = 'en';
try { const s = JSON.parse(localStorage.getItem('sticker-station-v1') || '{}'); if (s.lang) lang = s.lang; } catch (e) {}

function t(key, vars) {
  const e = D[key]; let s = e ? (e[lang] ?? e.en) : key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
  return s;
}
// a sheet label may be a plain string or { en, zh }
const label = l => (l && typeof l === 'object') ? (l[lang] || l.en || Object.values(l)[0]) : l;
function apply(root = document) {
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  root.querySelectorAll('[data-i18n]').forEach(el => { el.innerHTML = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.dataset.i18nTitle); });
  document.title = t('title');
}
window.I18N = { t, label, apply, get lang() { return lang; }, set(l) { lang = l; apply(); } };
})();
