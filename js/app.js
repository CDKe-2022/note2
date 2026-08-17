/* ============================================================
 * TextVault — js/app.js
 * DOM 引用 + 编辑器 + 文件列表 + 搜索 + 快捷键 + 初始化
 *
 * 依赖：js/sync.js、js/store.js（最后加载，负责启动）
 * ============================================================ */
'use strict';

// ═══════════════════════════════════════════
// 1. 工具函数与常量
// ═══════════════════════════════════════════
// 限制 style 属性中的危险 CSS
const DANGEROUS_CSS = /position\s*:\s*(?:fixed|absolute|sticky)|behavior\s*:|expression\s*\(|javascript\s*:/gi;
const PURIFY_CFG = {
  ALLOWED_TAGS: ['br','b','strong','u','i','em','span','div','p'],
  ALLOWED_ATTR: ['style'],
  ALLOW_DATA_ATTR: false
};
function safeSanitize(html) {
  let cleaned = html;
  if (window.DOMPurify) cleaned = DOMPurify.sanitize(html, PURIFY_CFG);
  // 后处理：移除 style 中的危险 CSS
  const tmp = document.createElement('div');
  tmp.innerHTML = cleaned;
  tmp.querySelectorAll('[style]').forEach(el => {
    const s = el.getAttribute('style') || '';
    if (DANGEROUS_CSS.test(s)) {
      el.removeAttribute('style');
    }
  });
  return tmp.innerHTML;
}
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function timeAgo(ts) {
  if (!ts) return '';
  const d = Date.now() - ts, m = Math.floor(d / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return m + '分钟前';
  const h = Math.floor(m / 60);
  if (h < 24) return h + '小时前';
  const day = Math.floor(h / 24);
  if (day < 30) return day + '天前';
  const dt = new Date(ts);
  const y = dt.getFullYear(), mo = String(dt.getMonth() + 1).padStart(2, '0'), da = String(dt.getDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}
function stripHtml(html) {
  if (!html) return '';
  const d = document.createElement('div');
  d.innerHTML = html;
  return (d.textContent || d.innerText || '');
}
function highlightSnippet(text, query, maxLen) {
  if (!query || !text) return esc((text || '').slice(0, maxLen || 120));
  const lower = text.toLowerCase(), lq = query.toLowerCase();
  let idx = lower.indexOf(lq);
  if (idx === -1) return esc(text.slice(0, maxLen || 120));
  const half = Math.floor((maxLen || 120) / 2);
  let start = Math.max(0, idx - half), end = Math.min(text.length, idx + query.length + half);
  let snippet = text.slice(start, end);
  if (start > 0) snippet = '...' + snippet;
  if (end < text.length) snippet = snippet + '...';
  const escSnippet = esc(snippet);
  const re = new RegExp('(' + escapeRegExp(query) + ')', 'gi');
  return escSnippet.replace(re, '<mark>$1</mark>');
}
function saveSelection() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!editor.contains(range.commonAncestorContainer)) return null;
  return range.cloneRange();
}
function restoreSelection(savedRange) {
  if (!savedRange) return;
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(savedRange);
}

const IC = {
  file: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 1.5h6.5L13 5v9.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1z"/><path d="M9.5 1.5V5H13"/></svg>',
  edit: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 2.5l2 2-8 8-3 1 1-3z"/><path d="M10 4l2 2"/></svg>',
  trash: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5h10"/><path d="M5.5 4.5V3h5v1.5"/><path d="M4.5 4.5l.8 9h5.4l.8-9"/></svg>',
  pin: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 11V2"/><path d="M4.5 5.5L8 2l3.5 3.5"/><line x1="3" y1="14" x2="13" y2="14"/></svg>'
};

// ═══════════════════════════════════════════
// 2. DOM 引用
// ═══════════════════════════════════════════
const editor = document.getElementById('editor');
const emptyState = document.getElementById('emptyState');
const fileListEl = document.getElementById('fileList');
const sidebar = document.getElementById('sidebar');
const fsVal = document.getElementById('fsVal');
const stChars = document.getElementById('stChars');
const stWords = document.getElementById('stWords');
const stLines = document.getElementById('stLines');
const saveInd = document.getElementById('saveInd');
const toastBox = document.getElementById('toastBox');
const dropOv = document.getElementById('dropOv');
const fileInput = document.getElementById('fileInput');
const btnBold = document.getElementById('btnBold');
const btnULine = document.getElementById('btnULine');
const helpOverlay = document.getElementById('helpOverlay');

// ═══════════════════════════════════════════
// 3. 编辑器辅助
// ═══════════════════════════════════════════
function getEditorText() { return editor.innerText.replace(/\u00A0/g, ' ').trimEnd(); }
function countWords(t) {
  if (!t) return 0;
  const c = t.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/g);
  const cc = c ? c.length : 0;
  const r = t.replace(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/g, ' ');
  return cc + r.trim().split(/\s+/).filter(w => w.length > 0).length;
}
function updateStats() {
  const t = getEditorText();
  stChars.textContent = '字符: ' + t.replace(/\n/g, '').length;
  stWords.textContent = '字数: ' + countWords(t);
  stLines.textContent = '行数: ' + (t ? t.split('\n').length : 0);
}
function updateEmpty() { emptyState.classList.toggle('hide', getEditorText().length > 0); }
let statsRaf = null;
function scheduleStats() {
  if (statsRaf) return;
  statsRaf = requestAnimationFrame(() => { updateStats(); updateEmpty(); statsRaf = null; });
}

// ═══════════════════════════════════════════
// 4. 文件列表渲染（差异化更新，避免重命名时丢焦点）
// ═══════════════════════════════════════════
function renderList() {
  // 检查是否有正在重命名的输入框，若有则跳过全量重建
  const renamingInput = fileListEl.querySelector('.rename-input');
  if (renamingInput) {
    // 仅更新非重命名项的 meta 文本，不重建 DOM
    store.files.forEach(f => {
      const item = fileListEl.querySelector('[data-id="' + CSS.escape(f.id) + '"]');
      if (!item || item.querySelector('.rename-input')) return;
      // 更新 active/pinned 类
      const isActive = String(f.id) === String(store.activeId);
      item.classList.toggle('active', isActive);
      item.classList.toggle('pinned', !!f.pinned);
      // 更新图标
      const iconEl = item.querySelector('.fi-icon');
      if (iconEl) iconEl.innerHTML = f.pinned ? IC.pin : IC.file;
      const pinBtn = item.querySelector('.act-pin');
      if (pinBtn) pinBtn.classList.toggle('pin-on', !!f.pinned);
      // 更新 meta
      const meta = item.querySelector('.fi-meta');
      if (meta) meta.innerHTML = (f.charCount || 0) + ' 字 &middot; ' + timeAgo(f.updatedAt);
    });
    return;
  }
  let h = '', lp = false;
  store.files.forEach((f, i) => {
    if (i > 0 && lp && !f.pinned) h += '<div class="pin-sep"></div>';
    lp = f.pinned;
    const a = String(f.id) === String(store.activeId), c = f.charCount || 0;
    h += '<div class="file-item' + (a ? ' active' : '') + (f.pinned ? ' pinned' : '') + '" data-id="' + esc(f.id) + '" draggable="true"><span class="fi-icon">' + (f.pinned ? IC.pin : IC.file) + '</span><span class="fi-info"><span class="fi-name">' + esc(f.name) + '</span><span class="fi-meta">' + c + ' 字 &middot; ' + timeAgo(f.updatedAt) + '</span></span><span class="fi-acts"><button class="fa-btn act-pin' + (f.pinned ? ' pin-on' : '') + '" title="' + (f.pinned ? '取消置顶' : '置顶') + '">' + IC.pin + '</button><button class="fa-btn act-rename" title="重命名">' + IC.edit + '</button><button class="fa-btn del act-del" title="删除">' + IC.trash + '</button></span></div>';
  });
  fileListEl.innerHTML = h;
}

// execCommand 守卫（防止未来浏览器移除时崩溃）
function execCmd(cmd, val) {
  if (typeof document.execCommand !== 'function') return false;
  try { return document.execCommand(cmd, false, val); } catch (e) { return false; }
}
try { execCmd('defaultParagraphSeparator', 'br'); } catch (e) {}

// loadEditor 防竞态
let loadingNote = false;
let loadToken = 0;
async function loadEditor() {
  const f = store.active;
  const myToken = ++loadToken;
  if (!f) { editor.innerHTML = ''; scheduleStats(); return; }
  if (!f._loaded) {
    loadingNote = true;
    try {
      const n = await fetchNote(f.id);
      if (myToken !== loadToken) return; // 已被新切换覆盖
      f.content = n.content || '';
      f.charCount = stripHtml(n.content || '').length;
      f.pinned = n.pinned || 0;
      f.sort_order = n.sort_order || 0;
      f.version = n.version || 1;
      f._loaded = true;
      renderList();
    } catch (e) {
      if (myToken !== loadToken) return;
      toast('加载笔记失败: ' + e.message);
      editor.innerHTML = '';
      loadingNote = false;
      scheduleStats();
      return;
    }
    loadingNote = false;
  }
  if (myToken !== loadToken) return;
  editor.innerHTML = safeSanitize(f.content || '');
  store._lastSavedSnapshot.set(f.id, editor.innerHTML);
  scheduleStats();
}

// ═══════════════════════════════════════════
// 5. 字体与换行
// ═══════════════════════════════════════════
function applyFontSize(s) {
  store.fontSize = Math.max(12, Math.min(30, s));
  fsVal.textContent = store.fontSize;
  editor.style.fontSize = store.fontSize + 'px';
}
applyFontSize(store.fontSize);
document.getElementById('fsMinus').addEventListener('click', () => applyFontSize(store.fontSize - 1));
document.getElementById('fsPlus').addEventListener('click', () => applyFontSize(store.fontSize + 1));
function applyWrap(w) {
  store.wordWrap = w;
  editor.style.whiteSpace = w ? 'pre-wrap' : 'pre';
  document.getElementById('btnWrap').classList.toggle('on', w);
}
applyWrap(store.wordWrap);
document.getElementById('btnWrap').addEventListener('click', () => applyWrap(!store.wordWrap));

// ═══════════════════════════════════════════
// 6. 自动保存
// ═══════════════════════════════════════════
let saveTimer = null, inputTimer = null;
let lastSavePromise = Promise.resolve();
editor.addEventListener('input', () => {
  pushUndo(false);
  clearTimeout(inputTimer);
  inputTimer = setTimeout(() => { scheduleStats(); autoSave(); }, 200);
});
function autoSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const f = store.active;
    if (!f || !f._loaded || loadingNote) return;
    const c = editor.innerHTML;
    const lastSnap = store._lastSavedSnapshot.get(f.id);
    if (c === lastSnap) return;
    // 串行化保存，避免与 beforeunload 并发覆盖
    lastSavePromise = lastSavePromise.then(() => store.saveCurrent()).then(() => {
      saveInd.classList.add('on');
      setTimeout(() => saveInd.classList.remove('on'), 1400);
    }).catch(e => console.warn('自动保存失败:', e.message));
  }, 3000);
}

// 粘贴：纯文本
editor.addEventListener('paste', e => {
  e.preventDefault();
  const t = e.clipboardData.getData('text/plain');
  if (!t) return;
  pushUndo(true);
  execCmd('insertText', t);
  requestAnimationFrame(() => { scheduleStats(); autoSave(); });
});

// ═══════════════════════════════════════════
// 7. 编辑器键盘事件（含 IME 组合输入保护）
// ═══════════════════════════════════════════
editor.addEventListener('keydown', e => {
  if (e.isComposing) return; // IME 组合输入中不触发快捷键
  if (e.key === 'Tab') {
    e.preventDefault();
    pushUndo(true);
    execCmd('insertText', '    '); // 4 空格缩进
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
    e.preventDefault();
    if (e.shiftKey) doRedo(); else doUndo();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
    e.preventDefault(); doRedo(); return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'd' && !e.shiftKey) {
    e.preventDefault(); duplicateLine(); return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
    e.preventDefault(); openSearchPanel('current'); return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
    e.preventDefault(); store.createFile(false); return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'o') {
    e.preventDefault(); fileInput.click(); return;
  }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
    e.preventDefault(); applyTheme(!document.body.classList.contains('dark')); return;
  }
});

// duplicateLine 边界检查
function duplicateLine() {
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  pushUndo(true);
  const node = sel.anchorNode;
  let block = node.nodeType === 3 ? node.parentElement : node;
  while (block && block.parentElement !== editor) block = block.parentElement;
  if (!block || !editor.contains(block)) return;
  if (block.parentElement === editor) {
    const clone = block.cloneNode(true);
    editor.insertBefore(clone, block.nextSibling);
    const r = document.createRange();
    r.selectNodeContents(clone);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  }
}

// span 清理改为 blur 时执行 + 光标保护
let cleanupScheduled = false;
function scheduleCleanup() {
  if (cleanupScheduled) return;
  cleanupScheduled = true;
  setTimeout(() => {
    cleanupScheduled = false;
    if (loadingNote) return;
    const saved = saveSelection();
    editor.querySelectorAll('span').forEach(s => {
      if (!s.attributes.length) {
        try { s.replaceWith(...s.childNodes); } catch (e) {}
      }
    });
    if (saved) restoreSelection(saved);
  }, 0);
}
editor.addEventListener('blur', scheduleCleanup);

// 格式化按钮
function updateFmt() {
  btnBold.classList.toggle('on', document.queryCommandState('bold'));
  btnULine.classList.toggle('on', document.queryCommandState('underline'));
}
btnBold.addEventListener('mousedown', e => { e.preventDefault(); pushUndo(true); execCmd('bold'); updateFmt(); });
btnULine.addEventListener('mousedown', e => { e.preventDefault(); pushUndo(true); execCmd('underline'); updateFmt(); });
document.addEventListener('selectionchange', () => { if (document.activeElement === editor) updateFmt(); });
editor.addEventListener('keyup', updateFmt);
editor.addEventListener('mouseup', updateFmt);

// ═══════════════════════════════════════════
// 8. 文件列表交互
// ═══════════════════════════════════════════
fileListEl.addEventListener('click', e => {
  const item = e.target.closest('.file-item');
  if (!item) return;
  const id = item.dataset.id;
  if (e.target.closest('.act-pin')) { store.togglePin(id); return; }
  if (e.target.closest('.act-rename')) { startRename(id); return; }
  if (e.target.closest('.act-del')) { store.deleteFile(id); return; }
  store.switchFile(id);
});
fileListEl.addEventListener('dblclick', e => {
  const n = e.target.closest('.fi-name');
  if (!n) return;
  const item = n.closest('.file-item');
  if (item) startRename(item.dataset.id);
});

// 拖拽排序
let dragId = null;
fileListEl.addEventListener('dragstart', e => {
  const item = e.target.closest('.file-item');
  if (!item) return;
  dragId = item.dataset.id;
  item.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragId);
});
fileListEl.addEventListener('dragover', e => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  fileListEl.querySelectorAll('.drag-over-top,.drag-over-bot').forEach(el => el.classList.remove('drag-over-top', 'drag-over-bot'));
  const item = e.target.closest('.file-item');
  if (!item || item.dataset.id === dragId) return;
  const rect = item.getBoundingClientRect();
  item.classList.add(e.clientY < rect.top + rect.height / 2 ? 'drag-over-top' : 'drag-over-bot');
});
fileListEl.addEventListener('dragleave', e => {
  const item = e.target.closest('.file-item');
  if (item) item.classList.remove('drag-over-top', 'drag-over-bot');
});
fileListEl.addEventListener('drop', e => {
  e.preventDefault();
  fileListEl.querySelectorAll('.drag-over-top,.drag-over-bot').forEach(el => el.classList.remove('drag-over-top', 'drag-over-bot'));
  const ti = e.target.closest('.file-item');
  if (!ti || !dragId) return;
  const tid = ti.dataset.id;
  if (tid === dragId) { dragId = null; return; }
  const ff = store.files.find(f => f.id === String(dragId)), tf = store.files.find(f => f.id === String(tid));
  if (ff.pinned !== tf.pinned) { toast('不能跨组拖拽'); dragId = null; return; }
  const rect = ti.getBoundingClientRect();
  store.moveFile(dragId, tid, e.clientY < rect.top + rect.height / 2 ? 'before' : 'after');
  dragId = null;
});
fileListEl.addEventListener('dragend', () => {
  fileListEl.querySelectorAll('.dragging,.drag-over-top,.drag-over-bot').forEach(el => el.classList.remove('dragging', 'drag-over-top', 'drag-over-bot'));
  dragId = null;
});

function startRename(id) {
  const f = store.files.find(x => x.id === String(id));
  if (!f) return;
  const item = fileListEl.querySelector('[data-id="' + CSS.escape(id) + '"]');
  if (!item) return;
  const ne = item.querySelector('.fi-name');
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.value = f.name;
  inp.className = 'rename-input';
  ne.replaceWith(inp);
  inp.focus();
  inp.select();
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    inp.remove(); // 先移除输入框，让后续 renderList 全量重建（否则 guard 分支会残留输入框）
    store.renameFile(id, inp.value);
  };
  inp.addEventListener('blur', finish);
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); finish(); }
    if (e.key === 'Escape') { done = true; inp.remove(); renderList(); }
  });
}

// ═══════════════════════════════════════════
// 9. 文件导入/导出
// ═══════════════════════════════════════════
document.getElementById('btnNew').addEventListener('click', () => store.createFile(false));
document.getElementById('btnOpen').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', e => {
  const files = Array.from(e.target.files);
  if (files.length) files.forEach(readFile);
  fileInput.value = '';
});
// readFile 统一处理，避免双重 sanitize
function readFile(file) {
  const r = new FileReader();
  r.onload = e => {
    const text = e.target.result;
    // 转换为纯文本 HTML：转义后换行转 <br>
    const html = esc(text).replace(/\n/g, '<br>');
    const sanitized = safeSanitize(html);
    store.createFile(false, file.name.replace(/\.[^.]+$/, ''), sanitized);
  };
  r.onerror = () => toast('文件读取失败: ' + file.name);
  r.readAsText(file, 'UTF-8');
}
document.getElementById('btnDown').addEventListener('click', () => store.downloadCurrent());
document.getElementById('btnClear').addEventListener('click', () => store.clearCurrent());

// 侧栏收起
const btnOpenSide = document.getElementById('btnOpenSide'), sepOpenSide = document.getElementById('sepOpenSide'), btnCloseSide = document.getElementById('btnCloseSide');
function updateSidebarButtons() {
  const c = sidebar.classList.contains('collapsed');
  btnOpenSide.style.display = c ? '' : 'none';
  sepOpenSide.style.display = c ? '' : 'none';
}
btnOpenSide.addEventListener('click', () => { sidebar.classList.remove('collapsed'); updateSidebarButtons(); });
btnCloseSide.addEventListener('click', () => { sidebar.classList.add('collapsed'); updateSidebarButtons(); });
updateSidebarButtons();

// 拖拽导入（支持多文件）
let dragN = 0;
document.addEventListener('dragenter', e => {
  if (e.dataTransfer && e.dataTransfer.types.includes('Files')) { e.preventDefault(); dragN++; dropOv.classList.add('on'); }
});
document.addEventListener('dragleave', e => { e.preventDefault(); dragN--; if (dragN <= 0) { dragN = 0; dropOv.classList.remove('on'); } });
document.addEventListener('dragover', e => { if (e.dataTransfer && e.dataTransfer.types.includes('Files')) e.preventDefault(); });
document.addEventListener('drop', e => {
  if (!e.dataTransfer || !e.dataTransfer.types.includes('Files')) return;
  e.preventDefault();
  dragN = 0;
  dropOv.classList.remove('on');
  const files = Array.from(e.dataTransfer.files);
  if (files.length) files.forEach(readFile);
});

// 专注模式
document.getElementById('btnFocus').addEventListener('click', () => { store.isFocus = true; document.body.classList.add('focus'); editor.focus(); });
document.getElementById('focusExit').addEventListener('click', exitFocus);
function exitFocus() { store.isFocus = false; document.body.classList.remove('focus'); }

// 主题
const btnTheme = document.getElementById('btnTheme');
function applyTheme(dark) {
  document.body.classList.toggle('dark', dark);
  try { localStorage.setItem('theme', dark ? 'dark' : 'light'); } catch (e) {}
}
const savedTheme = localStorage.getItem('theme');
if (savedTheme === 'dark' || (!savedTheme && window.matchMedia('(prefers-color-scheme:dark)').matches)) applyTheme(true);
btnTheme.addEventListener('click', () => applyTheme(!document.body.classList.contains('dark')));

// ═══════════════════════════════════════════
// 10. 搜索面板（TreeWalker + Range 替代 window.find）
// ═══════════════════════════════════════════
const searchPanel = document.getElementById('searchPanel');
const tabGlobal = document.getElementById('tabGlobal');
const tabCurrent = document.getElementById('tabCurrent');
const globalSearchView = document.getElementById('globalSearchView');
const currentSearchView = document.getElementById('currentSearchView');
const globalSearchInput = document.getElementById('globalSearchInput');
const currentSearchInput = document.getElementById('currentSearchInput');
const replaceInputEl = document.getElementById('replaceInput');
const globalResultsEl = document.getElementById('globalResults');
const spMatchCount = document.getElementById('spMatchCount');
const gMatchCount = document.getElementById('gMatchCount');
const spFooterLeft = document.getElementById('spFooterLeft');
let searchMode = 'global', globalSearchTimer = null;
let globalAllMatches = [], globalNavIdx = -1, globalResultItems = [];
let currentMatchRanges = [], currentMatchIdx = -1;
let globalSearchToken = 0; // 防并发
let currentHighlightMarks = []; // 当前高亮的 mark 节点

function openSearchPanel(mode) {
  searchPanel.classList.add('open');
  if (mode) switchSearchMode(mode);
  setTimeout(() => {
    if (searchMode === 'global') globalSearchInput.focus();
    else currentSearchInput.focus();
  }, 80);
}
function closeSearchPanel() {
  searchPanel.classList.remove('open');
  clearCurrentHighlights();
}
function switchSearchMode(mode) {
  searchMode = mode;
  tabGlobal.classList.toggle('active', mode === 'global');
  tabCurrent.classList.toggle('active', mode === 'current');
  globalSearchView.style.display = mode === 'global' ? '' : 'none';
  currentSearchView.style.display = mode === 'current' ? '' : 'none';
  if (mode === 'global') setTimeout(() => globalSearchInput.focus(), 50);
  else setTimeout(() => currentSearchInput.focus(), 50);
}
tabGlobal.addEventListener('click', () => switchSearchMode('global'));
tabCurrent.addEventListener('click', () => switchSearchMode('current'));
document.getElementById('spClose').addEventListener('click', closeSearchPanel);
document.getElementById('btnSearch').addEventListener('click', () => openSearchPanel('global'));
// 仅点击非编辑器、非面板、非搜索按钮区域时关闭
document.addEventListener('mousedown', e => {
  if (searchPanel.classList.contains('open') && !searchPanel.contains(e.target) && !e.target.closest('#btnSearch') && e.target !== editor && !editor.contains(e.target)) {
    closeSearchPanel();
  }
  if (helpOverlay.classList.contains('open') && !helpOverlay.querySelector('.help-panel').contains(e.target)) {
    closeHelp();
  }
});

// TreeWalker 收集编辑器内所有匹配的 Range
function collectMatchRanges(root, query) {
  const ranges = [];
  if (!query) return ranges;
  const lq = query.toLowerCase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const textNodes = [];
  let n;
  while (n = walker.nextNode()) textNodes.push(n);
  for (const tn of textNodes) {
    const text = tn.nodeValue;
    const lower = text.toLowerCase();
    let pos = 0, idx;
    while ((idx = lower.indexOf(lq, pos)) !== -1) {
      const r = document.createRange();
      r.setStart(tn, idx);
      r.setEnd(tn, idx + query.length);
      ranges.push(r);
      pos = idx + query.length;
    }
  }
  return ranges;
}

function clearCurrentHighlights() {
  currentHighlightMarks.forEach(m => {
    const parent = m.parentNode;
    if (!parent) return;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
    parent.normalize();
  });
  currentHighlightMarks = [];
}

function highlightAllMatches(query) {
  clearCurrentHighlights();
  if (!query) return [];
  const ranges = collectMatchRanges(editor, query);
  // 倒序包裹，避免 range 偏移失效
  for (let i = ranges.length - 1; i >= 0; i--) {
    const r = ranges[i];
    const mark = document.createElement('mark');
    mark.className = 'tv-hl';
    try {
      r.surroundContents(mark);
      currentHighlightMarks.push(mark);
    } catch (e) {
      // 跨节点边界，跳过
    }
  }
  return currentHighlightMarks;
}

async function performGlobalSearch(query) {
  const myToken = ++globalSearchToken;
  if (!query.trim()) {
    globalResultsEl.innerHTML = '<div class="sp-empty"><svg width="28" height="28" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="6.5" cy="6.5" r="4.5"/><line x1="10" y1="10" x2="14" y2="14"/></svg>输入关键词搜索所有文件</div>';
    spFooterLeft.textContent = '输入关键词开始搜索';
    globalAllMatches = []; globalResultItems = []; globalNavIdx = -1;
    gMatchCount.innerHTML = '';
    return;
  }
  globalResultsEl.innerHTML = '<div class="sp-loading"><div class="spinner"></div>正在搜索...</div>';
  globalResultItems = []; globalNavIdx = -1;
  const lq = query.toLowerCase(), perFile = [];
  // 并发拉取未加载文件
  const notePromises = [];
  for (const file of store.files) {
    let plainText;
    if (String(file.id) === String(store.activeId)) {
      plainText = stripHtml(editor.innerHTML);
      notePromises.push(Promise.resolve({ file, plainText }));
    } else if (file._loaded && file.content) {
      plainText = stripHtml(file.content);
      notePromises.push(Promise.resolve({ file, plainText }));
    } else {
      notePromises.push(fetchNote(file.id).then(n => {
        file.content = n.content || '';
        file._loaded = true;
        file.charCount = stripHtml(n.content || '').length;
        return { file, plainText: stripHtml(n.content || '') };
      }).catch(() => ({ file, plainText: '' })));
    }
  }
  const results = await Promise.all(notePromises);
  if (myToken !== globalSearchToken) return; // 已被新搜索取代
  for (const { file, plainText } of results) {
    const lower = plainText.toLowerCase();
    if (lower.includes(lq)) {
      let count = 0, pos = 0;
      while ((pos = lower.indexOf(lq, pos)) !== -1) { count++; pos += lq.length; }
      const lines = plainText.split('\n'), matchLines = [];
      for (const line of lines) {
        if (line.toLowerCase().includes(lq)) {
          matchLines.push(line.trim());
          if (matchLines.length >= 3) break;
        }
      }
      perFile.push({ fileId: file.id, fileName: file.name, matchCount: count, preview: matchLines.join('\n'), isCurrent: String(file.id) === String(store.activeId) });
    }
  }
  globalAllMatches = [];
  let gIdx = 0;
  for (const r of perFile) {
    for (let i = 0; i < r.matchCount; i++) {
      globalAllMatches.push({ fileId: r.fileId, fileName: r.fileName, matchIdxInFile: i, totalInFile: r.matchCount, globalIdx: gIdx++ });
    }
  }
  if (globalAllMatches.length === 0) {
    globalResultsEl.innerHTML = '<div class="sp-empty"><svg width="28" height="28" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="6.5" cy="6.5" r="4.5"/><line x1="10" y1="10" x2="14" y2="14"/></svg>未找到匹配的文件</div>';
    spFooterLeft.textContent = '无结果';
    gMatchCount.innerHTML = '';
    return;
  }
  let html = '';
  perFile.forEach(r => {
    html += '<div class="sr-item' + (r.isCurrent ? ' current' : '') + '" data-fid="' + esc(r.fileId) + '"><span class="sr-icon">' + IC.file + '</span><div class="sr-body"><div class="sr-name">' + esc(r.fileName) + '</div><div class="sr-preview">' + highlightSnippet(r.preview, query, 100) + '</div></div><span class="sr-count">' + r.matchCount + '</span></div>';
  });
  globalResultsEl.innerHTML = html;
  spFooterLeft.textContent = perFile.length + ' 个文件，共 ' + globalAllMatches.length + ' 处匹配';
  gMatchCount.innerHTML = '<span class="cur">0</span>/' + globalAllMatches.length;
  globalResultItems = Array.from(globalResultsEl.querySelectorAll('.sr-item'));
  globalResultItems.forEach(item => {
    item.addEventListener('click', async () => {
      const fid = item.dataset.fid;
      const first = globalAllMatches.findIndex(m => m.fileId === fid);
      globalNavIdx = first >= 0 ? first : 0;
      await navigateGlobalResult();
      closeSearchPanel();
      editor.focus();
    });
  });
}

function updateGlobalNavUI() {
  gMatchCount.innerHTML = globalAllMatches.length > 0 ? '<span class="cur">' + (globalNavIdx + 1) + '</span>/' + globalAllMatches.length : '';
  const cur = globalAllMatches[globalNavIdx];
  globalResultItems.forEach(el => {
    el.classList.remove('selected');
    if (cur && el.dataset.fid === cur.fileId) el.classList.add('selected');
  });
}

async function navigateGlobalResult() {
  if (globalNavIdx < 0 || globalNavIdx >= globalAllMatches.length) return;
  const m = globalAllMatches[globalNavIdx];
  if (String(store.activeId) !== String(m.fileId)) await store.switchFile(m.fileId);
  // 用 TreeWalker 高亮并跳转到第 matchIdxInFile 个匹配
  const q = globalSearchInput.value;
  const marks = highlightAllMatches(q);
  // 跳转到对应索引
  const target = marks[m.matchIdxInFile];
  if (target) {
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const r = document.createRange();
    r.selectNodeContents(target);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }
  updateGlobalNavUI();
}

document.getElementById('gNext').addEventListener('click', () => {
  if (!globalAllMatches.length) return;
  globalNavIdx = (globalNavIdx + 1) % globalAllMatches.length;
  navigateGlobalResult();
});
document.getElementById('gPrev').addEventListener('click', () => {
  if (!globalAllMatches.length) return;
  globalNavIdx = globalNavIdx <= 0 ? globalAllMatches.length - 1 : globalNavIdx - 1;
  navigateGlobalResult();
});
globalSearchInput.addEventListener('input', () => {
  clearTimeout(globalSearchTimer);
  globalSearchTimer = setTimeout(() => performGlobalSearch(globalSearchInput.value), 350);
});
globalSearchInput.addEventListener('keydown', e => {
  if (e.isComposing) return; // IME 组合输入中不触发导航
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (globalResultItems.length) {
      let ci = globalResultItems.findIndex(el => el.classList.contains('selected'));
      if (ci < 0) ci = -1;
      ci = (ci + 1) % globalResultItems.length;
      globalResultItems.forEach(el => el.classList.remove('selected'));
      globalResultItems[ci].classList.add('selected');
      globalResultItems[ci].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (globalResultItems.length) {
      let ci = globalResultItems.findIndex(el => el.classList.contains('selected'));
      if (ci < 0) ci = 0;
      ci = ci <= 0 ? globalResultItems.length - 1 : ci - 1;
      globalResultItems.forEach(el => el.classList.remove('selected'));
      globalResultItems[ci].classList.add('selected');
      globalResultItems[ci].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (globalNavIdx >= 0) {
      if (e.shiftKey) globalNavIdx = globalNavIdx <= 0 ? globalAllMatches.length - 1 : globalNavIdx - 1;
      else globalNavIdx = (globalNavIdx + 1) % globalAllMatches.length;
      navigateGlobalResult();
    } else {
      performGlobalSearch(globalSearchInput.value);
    }
  }
});

// 当前文件搜索：用 TreeWalker 实现
function computeCurrentMatches() {
  const q = currentSearchInput.value;
  clearCurrentHighlights();
  if (!q) {
    currentMatchRanges = [];
    currentMatchIdx = -1;
    updateMatchCountUI();
    return;
  }
  const marks = highlightAllMatches(q);
  currentMatchRanges = marks;
  if (marks.length === 0) {
    currentMatchIdx = -1;
  } else {
    currentMatchIdx = 0;
    scrollToCurrentMatch();
  }
  updateMatchCountUI();
}
function updateMatchCountUI() {
  spMatchCount.innerHTML = currentMatchRanges.length > 0
    ? '<span class="cur">' + (currentMatchIdx + 1) + '</span>/' + currentMatchRanges.length
    : (currentSearchInput.value ? '<span class="cur">0</span>/0' : '');
}
function scrollToCurrentMatch() {
  const m = currentMatchRanges[currentMatchIdx];
  if (!m) return;
  m.scrollIntoView({ block: 'center', behavior: 'smooth' });
  const r = document.createRange();
  r.selectNodeContents(m);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}
function findCurrentMatch(dir) {
  if (!currentMatchRanges.length) return;
  if (dir === 'next') currentMatchIdx = (currentMatchIdx + 1) % currentMatchRanges.length;
  else currentMatchIdx = currentMatchIdx <= 0 ? currentMatchRanges.length - 1 : currentMatchIdx - 1;
  updateMatchCountUI();
  scrollToCurrentMatch();
}

currentSearchInput.addEventListener('input', () => { computeCurrentMatches(); });
currentSearchInput.addEventListener('keydown', e => {
  if (e.isComposing) return; // IME 组合输入中不触发导航
  if (e.key === 'Enter') { e.preventDefault(); findCurrentMatch(e.shiftKey ? 'prev' : 'next'); }
});
document.getElementById('spFindNext').addEventListener('click', () => findCurrentMatch('next'));
document.getElementById('spFindPrev').addEventListener('click', () => findCurrentMatch('prev'));

// 替换 - 用 TreeWalker 操作文本节点，不碰 innerHTML
document.getElementById('spReplace').addEventListener('click', () => {
  const q = currentSearchInput.value;
  if (!q) return;
  const replacement = replaceInputEl.value;
  if (currentMatchIdx < 0 || currentMatchIdx >= currentMatchRanges.length) return;
  const mark = currentMatchRanges[currentMatchIdx];
  pushUndo(true);
  const textNode = document.createTextNode(replacement);
  mark.parentNode.replaceChild(textNode, mark);
  // 重新计算匹配
  computeCurrentMatches();
  autoSave();
});
// 全部替换 - 用 TreeWalker 遍历文本节点
document.getElementById('spReplaceAll').addEventListener('click', () => {
  const q = currentSearchInput.value;
  if (!q) return;
  const replacement = replaceInputEl.value;
  pushUndo(true);
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let n;
  while (n = walker.nextNode()) nodes.push(n);
  let count = 0;
  const re = new RegExp(escapeRegExp(q), 'g');
  for (const node of nodes) {
    const text = node.nodeValue;
    if (!text || !text.toLowerCase().includes(q.toLowerCase())) continue;
    const matches = text.match(re);
    if (matches) {
      count += matches.length;
      node.nodeValue = text.replace(re, replacement);
    }
  }
  if (count > 0) {
    toast('已替换 ' + count + ' 处');
    scheduleStats();
    autoSave();
  } else {
    toast('未找到匹配');
  }
  computeCurrentMatches();
});

// 帮助面板
function openHelp() { helpOverlay.classList.add('open'); }
function closeHelp() { helpOverlay.classList.remove('open'); }
document.getElementById('hpClose').addEventListener('click', closeHelp);
document.getElementById('btnHelp').addEventListener('click', openHelp);

// ═══════════════════════════════════════════
// 11. 全局键盘事件（含 IME 组合输入保护）
// ═══════════════════════════════════════════
document.addEventListener('keydown', e => {
  if (e.isComposing) return; // IME 组合输入中不触发快捷键
  if (e.key === '?' && !e.ctrlKey && !e.metaKey && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA' && document.activeElement !== editor) {
    e.preventDefault();
    if (helpOverlay.classList.contains('open')) closeHelp(); else openHelp();
    return;
  }
  if (e.key === 'Escape') {
    if (helpOverlay.classList.contains('open')) { closeHelp(); return; }
    if (searchPanel.classList.contains('open')) { closeSearchPanel(); return; }
    if (store.isFocus) { exitFocus(); return; }
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    const f = store.active;
    if (f && f._loaded && !loadingNote) {
      const c = editor.innerHTML;
      const lastSnap = store._lastSavedSnapshot.get(f.id);
      if (c !== lastSnap) {
        store.saveCurrent(true).then(() => {
          saveInd.classList.add('on');
          setTimeout(() => saveInd.classList.remove('on'), 1400);
          toast('已保存');
        }).catch(e => toast('保存失败: ' + e.message));
      } else {
        toast('内容未变化');
      }
    } else {
      toast('内容未变化');
    }
  }
  if (e.key === 'F11') {
    e.preventDefault();
    if (store.isFocus) exitFocus();
    else { store.isFocus = true; document.body.classList.add('focus'); editor.focus(); }
  }
});

// ═══════════════════════════════════════════
// 12. beforeunload（只入队，不再 keepalive 双写）
// ═══════════════════════════════════════════
window.addEventListener('beforeunload', () => {
  const f = store.active;
  if (!f || !f._loaded || f.id.startsWith('local_')) return;
  const c = editor.innerHTML;
  const lastSnap = store._lastSavedSnapshot.get(f.id);
  if (c === lastSnap) return;
  // 入队持久化，下次打开页面时自动重放，避免 keepalive 双写竞态
  enqueueOp({
    type: 'update',
    noteId: f.id,
    payload: { content: c, version: f.version },
    idempotencyKey: genIdempotencyKey(),
    createdAt: Date.now()
  });
});

// 队列重放遇到版本冲突时，刷新对应文件
window.addEventListener('tv:conflict', e => {
  const fid = e.detail && e.detail.noteId;
  const f = store.files.find(x => x.id === String(fid));
  if (f) store.handleConflict(f);
  else toast('同步冲突：该文件已被其他设备修改');
});

// ═══════════════════════════════════════════
// 13. Toast
// ═══════════════════════════════════════════
function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8l3.5 3.5L13 5"/></svg>' + esc(msg);
  toastBox.appendChild(el);
  requestAnimationFrame(() => el.classList.add('in'));
  setTimeout(() => {
    el.classList.remove('in');
    el.classList.add('out');
    setTimeout(() => el.remove(), 250);
  }, 2000);
}

// ═══════════════════════════════════════════
// 14. 初始化
// ═══════════════════════════════════════════
// 启动时尝试 flush 一次（若在线）
flushQueue();
store.restore().then(async () => {
  if (store.files.length === 0) await store.createFile(true);
  renderList();
  await loadEditor();
  applyFontSize(store.fontSize);
  editor.focus();
}).catch(e => toast('初始化失败: ' + e.message));
