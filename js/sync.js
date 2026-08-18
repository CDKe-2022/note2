/* ============================================================
 * TextVault — js/sync.js
 * API 客户端 + 离线同步队列 + 幂等键 + 版本冲突
 *
 * 依赖：无（最先加载）
 * 加载顺序：sync.js → store.js → app.js
 * ============================================================ */
'use strict';

// ── 配置 ──────────────────────────────────────────────
// 部署时改成你自己的 Worker 域名
const API_BASE = 'https://note2.kehuang.eu.org/api/notes';

// ── 鉴权 ──────────────────────────────────────────────
function getAuthHeaders() {
  const token = localStorage.getItem('token') || '';
  return {
    Authorization: 'Bearer ' + token,
    'Content-Type': 'application/json'
  };
}

// ── 幂等键 ────────────────────────────────────────────
function genIdempotencyKey() {
  return 'tv_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

// ── 工具 ──────────────────────────────────────────────
function isQuotaExceeded(e) {
  return e && (e.code === 22 || e.code === 1014 || e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED');
}

// 版本冲突错误（服务端返回 409 时抛出）
class ConflictError extends Error {
  constructor(serverVersion) {
    super('版本冲突：该文件已被其他设备修改');
    this.name = 'ConflictError';
    this.serverVersion = serverVersion;
  }
}

// ── 离线同步队列 ──────────────────────────────────────
// 队列元素：{ type:'create'|'update'|'delete', noteId, payload, idempotencyKey, createdAt }
// 合并策略：
//   1. 同一 noteId 的多个 update → 只保留最后一个（payload 取最新，createdAt 保留最早）
//   2. delete → 移除该文件所有 pending update；若存在 pending create 则两者都移除（净操作 = 无）
let syncQueue = [];
try { syncQueue = JSON.parse(localStorage.getItem('syncQueue') || '[]'); } catch (e) { syncQueue = []; }
const SYNC_MAX = 200;

function persistQueue() {
  try {
    localStorage.setItem('syncQueue', JSON.stringify(syncQueue));
  } catch (e) {
    if (isQuotaExceeded(e)) {
      // LRU 淘汰：保留最新的一半
      syncQueue = syncQueue.slice(-Math.floor(SYNC_MAX / 2));
      try { localStorage.setItem('syncQueue', JSON.stringify(syncQueue)); } catch (_) { /* 放弃持久化 */ }
    }
  }
}

function enqueueOp(op) {
  // 队列重放语义 = 强制写入：剥离 version。
  // 入队时的版本号在重放时几乎必然过期，携带它会导致 409 被丢弃，造成内容丢失。
  if (op.payload && op.payload.version !== undefined) {
    const { version, ...rest } = op.payload;
    op.payload = rest;
  }
  if (op.type === 'update') {
    const idx = syncQueue.findIndex(q => q.type === 'update' && q.noteId === op.noteId);
    if (idx !== -1) {
      // 按字段合并：内容保存 {content} 和重命名 {name} 入队时互补覆盖，
      // 整体替换会丢掉先前排队但尚未同步的字段。
      const prev = syncQueue[idx];
      syncQueue[idx] = {
        ...op,
        payload: { ...(prev.payload || {}), ...(op.payload || {}) },
        createdAt: prev.createdAt
      };
      persistQueue();
      return;
    }
  }
  if (op.type === 'delete') {
    // 移除该文件的所有待处理 update 操作
    syncQueue = syncQueue.filter(q => !(q.type === 'update' && q.noteId === op.noteId));
    // 如果有 pending create，移除两者（净操作 = 无）
    const createIdx = syncQueue.findIndex(q => q.type === 'create' && q.noteId === op.noteId);
    if (createIdx !== -1) {
      syncQueue.splice(createIdx, 1);
      persistQueue();
      return;
    }
  }
  syncQueue.push(op);
  if (syncQueue.length > SYNC_MAX) syncQueue = syncQueue.slice(-SYNC_MAX);
  persistQueue();
}

// 直接保存成功后，作废该笔记排队中的旧内容（防止离线旧内容重放覆盖新内容）
function purgeQueuedContent(noteId) {
  if (!noteId) return;
  let changed = false;
  syncQueue = syncQueue.filter(q => {
    if (q.type === 'update' && String(q.noteId) === String(noteId) && q.payload && q.payload.content !== undefined) {
      const { content, ...rest } = q.payload;
      if (Object.keys(rest).length === 0) { changed = true; return false; } // 无剩余字段，删除该操作
      q.payload = rest; changed = true; // 仍有待同步的元数据（如重命名），保留
    }
    return true;
  });
  if (changed) persistQueue();
}

// 删除成功后，清掉该笔记所有排队操作
function purgeQueuedForDeleted(noteId) {
  const before = syncQueue.length;
  syncQueue = syncQueue.filter(q => String(q.noteId) !== String(noteId));
  if (syncQueue.length !== before) persistQueue();
}

function executeOp(op) {
  const headers = getAuthHeaders();
  headers['Idempotency-Key'] = op.idempotencyKey || genIdempotencyKey();
  let url = API_BASE;
  const method = op.type === 'create' ? 'POST' : op.type === 'delete' ? 'DELETE' : 'PUT';
  // local_ 临时 id 不入队（服务端还没创建），防御性跳过
  if (op.noteId && !String(op.noteId).startsWith('local_')) url += '/' + op.noteId;
  const opt = { method, headers };
  if (op.type !== 'delete' && op.payload) {
    // 双保险：执行时再剥一次 version，确保重放永不因版本冲突被拒
    const { version, ...rest } = op.payload;
    opt.body = JSON.stringify(rest);
  }
  return fetch(url, opt).then(async res => {
    if (res.status === 409) {
      let serverVersion;
      try { serverVersion = (await res.json()).serverVersion; } catch (e) { /* ignore */ }
      throw new ConflictError(serverVersion);
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.status === 204 ? null : res.json();
  });
}

async function flushQueue() {
  if (!navigator.onLine || !syncQueue.length) return;
  const q = [...syncQueue];
  syncQueue = [];
  persistQueue();
  for (let i = 0; i < q.length; i++) {
    const op = q[i];
    try {
      await executeOp(op);
    } catch (e) {
      if (e instanceof ConflictError) {
        // 防御分支：队列负载已剥离 version，正常不应发生 409。
        // 绝不丢弃操作——放回队尾下次重试，宁可重试也不丢数据。
        syncQueue.push(op);
        persistQueue();
        continue;
      }
      if (e && e.status === 404) {
        // 笔记已在其他设备删除（或从未创建成功）：丢弃该操作，避免死循环重试
        continue;
      }
      // 网络等错误：把剩余的放回队列，下次重试
      syncQueue = q.slice(i).concat(syncQueue);
      persistQueue();
      break;
    }
  }
}
// online 事件即时触发，不再依赖固定 30s 轮询
window.addEventListener('online', flushQueue);
setInterval(flushQueue, 30000); // 兜底轮询

// ── API 客户端 ────────────────────────────────────────
async function apiRequest(method, data, id) {
  const headers = getAuthHeaders();
  let url = API_BASE;
  if (id !== undefined && id !== null) url += '/' + id;
  // 写操作生成幂等键：请求时携带，失败入队时复用同一个键。
  // 若请求实际已到达服务端但响应丢失，重放会命中幂等缓存，不会重复创建。
  const idemKey = genIdempotencyKey();
  if (method !== 'GET') headers['Idempotency-Key'] = idemKey;
  const opt = { method, headers };
  if (data && method !== 'GET' && method !== 'DELETE') opt.body = JSON.stringify(data);
  try {
    const res = await fetch(url, opt);
    if (res.status === 409) {
      let serverVersion;
      try { serverVersion = (await res.json()).serverVersion; } catch (e) { /* ignore */ }
      throw new ConflictError(serverVersion);
    }
    if (!res.ok) {
      let msg;
      try { msg = (await res.json()).error || res.statusText; } catch { msg = res.statusText; }
      const err = new Error(msg);
      err.status = res.status; // 供 flushQueue 识别 404（笔记已删除）
      throw err;
    }
    // 成功的直接写入：作废该笔记排队中的过期操作
    if (method === 'PUT' && id !== undefined && id !== null && data && data.content !== undefined) purgeQueuedContent(id);
    if (method === 'DELETE' && id !== undefined && id !== null) purgeQueuedForDeleted(id);
    if (res.status === 204) return null;
    return res.json();
  } catch (e) {
    // 版本冲突不入队（重放只会再次冲突）
    if (e instanceof ConflictError) throw e;
    // 写操作失败时入队，避免数据丢失（注意：断网时 fetch 也抛 TypeError，必须先入队）
    if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
      // local_ 临时 id 不入队（服务端还没创建）
      if (id === undefined || id === null || !String(id).startsWith('local_')) {
        enqueueOp({
          type: method === 'POST' ? 'create' : method === 'DELETE' ? 'delete' : 'update',
          noteId: method === 'POST' ? null : String(id),
          payload: data || null,
          idempotencyKey: idemKey, // 复用请求时的键，防重复创建
          createdAt: Date.now()
        });
      }
    }
    // fetch 网络层失败（CORS 拦截/断网/域名错误）抛 TypeError，明确标注帮助定位部署问题
    if (e instanceof TypeError) {
      throw new Error('网络或 CORS 错误：请检查 API_BASE 是否正确、Worker 的 Access-Control-Allow-Origin 是否包含当前页面域名');
    }
    throw e;
  }
}

async function fetchNotes() { return apiRequest('GET'); }
async function fetchNote(id) { return apiRequest('GET', null, id); }
async function createNote(n, c) { return apiRequest('POST', { name: n, content: c }); }
async function updateNote(id, d) { return apiRequest('PUT', d, id); }
async function deleteNote(id) { return apiRequest('DELETE', null, id); }
