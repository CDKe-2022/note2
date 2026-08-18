/* ============================================================
 * TextVault — js/store.js
 * 状态管理 + 撤销栈 + 文件 CRUD（含版本冲突处理）
 *
 * 依赖：js/sync.js（updateNote / createNote / deleteNote / fetchNotes / fetchNote / ConflictError）
 * 注意：renderList / loadEditor / toast / scheduleStats / editor / safeSanitize / stripHtml
 *       定义在 js/app.js，仅在运行时调用，加载顺序无影响。
 * ============================================================ */
'use strict';

// ── 撤销栈（按文件隔离，内存存储）────────────────────
// 瘦身：每文件快照上限 50 → 30，降低大文件内存占用
const UNDO_LIMIT = 30;
const undoMap = new Map(); // fileId -> {undo:[], redo:[]}
let undoTimer = null;

function getStacks(fid) {
  if (!undoMap.has(fid)) undoMap.set(fid, { undo: [], redo: [] });
  return undoMap.get(fid);
}

function pushUndo(immediate) {
  const f = store.active;
  if (!f) return;
  const stacks = getStacks(f.id);
  const snapshot = editor.innerHTML;
  if (immediate) {
    stacks.undo.push(snapshot);
    if (stacks.undo.length > UNDO_LIMIT) stacks.undo.shift();
    stacks.redo = [];
    return;
  }
  // 防抖：500ms 内合并一次入栈，避免高频输入内存压力
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => {
    stacks.undo.push(editor.innerHTML);
    if (stacks.undo.length > UNDO_LIMIT) stacks.undo.shift();
    stacks.redo = [];
  }, 500);
}

function doUndo() {
  const f = store.active; if (!f) return;
  const stacks = getStacks(f.id);
  if (!stacks.undo.length) return;
  stacks.redo.push(editor.innerHTML);
  editor.innerHTML = stacks.undo.pop();
  scheduleStats(); autoSave();
}

function doRedo() {
  const f = store.active; if (!f) return;
  const stacks = getStacks(f.id);
  if (!stacks.redo.length) return;
  stacks.undo.push(editor.innerHTML);
  editor.innerHTML = stacks.redo.pop();
  scheduleStats(); autoSave();
}

// ── 状态管理 ──────────────────────────────────────────
const store = {
  files: [], activeId: null, counter: 1, fontSize: 17, wordWrap: true, isFocus: false, _creating: false,
  _lastSavedSnapshot: new Map(), // 记录上次保存的 innerHTML 快照，避免误判
  _saveChain: Promise.resolve(), // 串行化所有保存，避免并发 PUT 的版本竞态
  get active() { return this.files.find(f => f.id === this.activeId) || null; },

  _norm(n, w) {
    return {
      id: String(n.id), name: n.name || '未命名',
      content: w ? (n.content || '') : null,
      charCount: n.charCount || 0, _loaded: !!w,
      createdAt: n.createdAt || Date.now(), updatedAt: n.updatedAt || Date.now(),
      pinned: n.pinned || 0, sort_order: n.sort_order || 0,
      version: n.version || 1
    };
  },

  async restore() {
    try {
      const ns = await fetchNotes();
      this.files = ns.map(n => this._norm(n, false));
      // counter 取所有"未命名 N"中的最大 N + 1
      let maxN = 0;
      this.files.forEach(f => {
        const m = /^未命名\s*(\d+)$/.exec(f.name);
        if (m) maxN = Math.max(maxN, parseInt(m[1]));
      });
      this.counter = maxN + 1;
      if (this.files.length > 0) this.activeId = this.files[0].id;
      return true;
    } catch (e) {
      toast('获取笔记失败: ' + e.message);
      return false;
    }
  },

  async createFile(silent, name, content) {
    if (this._creating) return null;
    this._creating = true;
    const fn = name || ('未命名 ' + this.counter++);
    const tempId = 'local_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const nr = this._norm({
      id: tempId, name: fn, content: content || '',
      charCount: content ? stripHtml(content).length : 0,
      createdAt: Date.now(), updatedAt: Date.now(), pinned: 0, sort_order: 0, version: 1
    }, true);
    this.files.unshift(nr);
    this.activeId = tempId;
    undoMap.set(tempId, { undo: [], redo: [] }); // 初始化隔离栈
    renderList();
    editor.innerHTML = content ? safeSanitize(content) : '';
    this._lastSavedSnapshot.set(tempId, editor.innerHTML);
    scheduleStats();
    if (!silent) toast('已新建: ' + fn);
    try {
      const n = await createNote(fn, content || '');
      const realId = String(n.id);
      if (realId !== tempId) {
        nr.id = realId;
        nr.updatedAt = n.updatedAt || Date.now();
        nr.version = n.version || 1;
        // 迁移隔离栈与快照
        if (undoMap.has(tempId)) { undoMap.set(realId, undoMap.get(tempId)); undoMap.delete(tempId); }
        const snap = this._lastSavedSnapshot.get(tempId);
        if (snap !== undefined) { this._lastSavedSnapshot.set(realId, snap); this._lastSavedSnapshot.delete(tempId); }
        if (this.activeId === tempId) this.activeId = realId;
        renderList();
      }
    } catch (e) {
      console.warn('同步创建失败:', e.message);
    }
    this._creating = false;
    return nr;
  },

  async switchFile(id) {
    if (String(id) === String(this.activeId)) return;
    await this.saveCurrent();
    this.activeId = String(id);
    renderList();
    await loadEditor();
  },

  async deleteFile(id) {
    const f = this.files.find(x => x.id === String(id));
    try {
      await deleteNote(id);
      const i = this.files.findIndex(f => f.id === String(id));
      if (i === -1) return;
      const nm = this.files[i].name;
      this.files.splice(i, 1);
      undoMap.delete(String(id));
      this._lastSavedSnapshot.delete(String(id));
      if (String(this.activeId) === String(id)) this.activeId = this.files.length ? this.files[0].id : null;
      renderList();
      await loadEditor();
      toast('已删除: ' + nm);
    } catch (e) {
      // 已入队，提示用户
      if (f) {
        const i = this.files.findIndex(x => x.id === String(id));
        const nm = this.files[i].name;
        this.files.splice(i, 1);
        undoMap.delete(String(id));
        this._lastSavedSnapshot.delete(String(id));
        if (String(this.activeId) === String(id)) this.activeId = this.files.length ? this.files[0].id : null;
        renderList();
        await loadEditor();
        toast('离线已删除: ' + nm + ' (将同步)');
      } else {
        toast('删除笔记失败: ' + e.message);
      }
    }
  },

  async renameFile(id, nm) {
    const f = this.files.find(x => x.id === String(id));
    if (f && nm.trim()) {
      const newName = nm.trim();
      const oldName = f.name;
      f.name = newName; // 乐观更新
      renderList();
      try {
        // 元数据更新不携带 version：重命名不该因内容版本过期而失败
        const u = await updateNote(id, { name: newName });
        f.name = u.name || newName;
        f.updatedAt = u.updatedAt || Date.now();
        f.version = u.version || f.version;
      } catch (e) {
        toast('离线已重命名 (将同步)');
      }
      renderList();
    }
  },

  async saveCurrent(force) {
    // 串行化：所有保存请求排队执行，杜绝并发 PUT 导致的版本竞态 409
    const run = this._saveChain.then(() => this._saveNow(force));
    this._saveChain = run.then(() => {}, () => {});
    return run;
  },

  async _saveNow(force) {
    if (!this.activeId || loadingNote) return;
    const f = this.active;
    if (!f || !f._loaded) return;
    if (f.id.startsWith('local_')) return;
    const c = editor.innerHTML;
    // 用快照比较，避免 DOM 规范化误判
    const lastSnap = this._lastSavedSnapshot.get(f.id);
    if (!force && c === lastSnap) return;
    try {
      // 携带 version 实现乐观并发控制
      const u = await updateNote(f.id, { content: c, version: f.version });
      f.content = u.content || c;
      f.updatedAt = u.updatedAt || Date.now();
      f.version = u.version || f.version;
      f.charCount = stripHtml(c).length;
      this._lastSavedSnapshot.set(f.id, c);
      renderList();
      return;
    } catch (e) {
      if (e instanceof ConflictError) {
        // 版本冲突：绝不丢本地内容。采用服务端最新版本号重试一次（本地内容优先），
        // 若再冲突则退化为无版本强制写入——与旧版 last-write-wins 语义一致。
        try {
          const retryVer = e.serverVersion !== undefined ? e.serverVersion : f.version;
          let u;
          try {
            u = await updateNote(f.id, { content: c, version: retryVer });
          } catch (e2) {
            u = await updateNote(f.id, { content: c });
          }
          f.content = u.content || c;
          f.updatedAt = u.updatedAt || Date.now();
          f.version = u.version || f.version;
          f.charCount = stripHtml(c).length;
          this._lastSavedSnapshot.set(f.id, c);
          renderList();
          return;
        } catch (e3) {
          // 网络问题：apiRequest 已入队，内容不会丢
          console.warn('保存失败(已入队):', e3.message);
          return;
        }
      }
      // 已入队，不弹错误 toast，避免干扰 autoSave
      console.warn('保存失败(已入队):', e.message);
    }
  },

  // 版本冲突处理：只更新版本号与元数据，绝不自动覆盖编辑器内容。
  // 仅当编辑器没有未保存的本地修改时，才用服务端内容刷新。
  handleConflict(f) {
    fetchNote(f.id).then(n => {
      f.version = n.version || f.version;
      f.updatedAt = n.updatedAt || f.updatedAt;
      const isEditing = String(this.activeId) === String(f.id);
      const hasUnsaved = isEditing && editor.innerHTML !== this._lastSavedSnapshot.get(f.id);
      if (!hasUnsaved) {
        // 无未保存修改，安全刷新为服务端版本
        f.content = n.content || '';
        f.charCount = stripHtml(n.content || '').length;
        f._loaded = true;
        if (isEditing) {
          editor.innerHTML = safeSanitize(f.content || '');
          this._lastSavedSnapshot.set(f.id, editor.innerHTML);
          scheduleStats();
        }
        renderList();
        toast('已加载其他设备的最新版本');
      }
      // 有未保存修改：保留本地内容，版本号已对齐，下次保存自动收敛
    }).catch(() => toast('版本号更新失败，保存时会自动重试'));
  },

  async clearCurrent() {
    const f = this.active;
    if (!f || !f._loaded) return;
    if (!getEditorText().trim()) return;
    pushUndo(true);
    editor.innerHTML = '';
    this._lastSavedSnapshot.set(f.id, '');
    try {
      const u = await updateNote(f.id, { content: '' });
      f.content = '';
      f.charCount = 0;
      f.updatedAt = u.updatedAt || Date.now();
      f.version = u.version || f.version;
    } catch (e) {
      toast('清空失败(已入队)');
    }
    scheduleStats(); renderList();
    toast('已清空: ' + f.name);
  },

  downloadCurrent() {
    const f = this.active, t = getEditorText().trim();
    if (!t) { toast('当前文件为空'); return; }
    const b = new Blob([t], { type: 'text/plain;charset=utf-8' }), u = URL.createObjectURL(b), a = document.createElement('a');
    a.href = u; a.download = (f ? f.name : 'textvault') + '.txt'; a.click();
    URL.revokeObjectURL(u);
    toast('已下载: ' + a.download);
  },

  async togglePin(id) {
    const f = this.files.find(x => x.id === String(id));
    if (!f) return;
    const oldPinned = f.pinned;
    const np = f.pinned ? 0 : 1;
    f.pinned = np; // 乐观更新
    this.files.sort((a, b) => b.pinned - a.pinned || a.sort_order - b.sort_order || b.updatedAt - a.updatedAt);
    renderList();
    try {
      const u = await updateNote(id, { pinned: np });
      f.version = u.version || f.version;
      toast(np ? '已置顶: ' + f.name : '已取消置顶: ' + f.name);
    } catch (e) {
      // 失败（含离线已入队）：回滚显示，重放时会再次生效
      f.pinned = oldPinned;
      this.files.sort((a, b) => b.pinned - a.pinned || a.sort_order - b.sort_order || b.updatedAt - a.updatedAt);
      renderList();
      toast('操作失败(已入队)');
    }
  },

  async moveFile(fid, tid, pos) {
    const fi = this.files.findIndex(f => f.id === String(fid));
    if (fi === -1) return;
    const [mf] = this.files.splice(fi, 1);
    const ti = this.files.findIndex(f => f.id === String(tid));
    this.files.splice(pos === 'before' ? ti : ti + 1, 0, mf);
    const grp = this.files.filter(f => f.pinned === mf.pinned), ups = [];
    const step = 1000;
    for (let i = 0; i < grp.length; i++) {
      const no = (i + 1) * step;
      if (grp[i].sort_order !== no) {
        grp[i].sort_order = no;
        ups.push({ id: grp[i].id, sort_order: no });
      }
    }
    renderList();
    // 串行更新排序（元数据不带 version，失败自动入队）
    try {
      for (const u of ups) {
        const f2 = this.files.find(x => x.id === String(u.id));
        const r = await updateNote(u.id, { sort_order: u.sort_order });
        if (f2) f2.version = r.version || f2.version;
      }
    } catch (e) {
      toast('排序保存失败(已入队)');
    }
  }
};
