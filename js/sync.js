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
const API_BASE = 'https://note3.kehuang.eu.org/api/notes';

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
  if (op.type === 'update') {
    const idx = syncQueue.findIndex(q => q.type === 'update' && q.noteId === op.noteId);
    if (idx !== -1) {
      // 合并：用最新操作覆盖，但保留最早的 createdAt（服务端版本未变，version 一致）
      syncQueue[idx] = { ...op, createdAt: syncQueue[idx].createdAt };
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

function executeOp(op) {
  const headers = getAuthHeaders();
  headers['Idempotency-Key'] = op.idempotencyKey || genIdempotencyKey();
  let url = API_BASE;
  const method = op.type === 'create' ? 'POST' : op.type === 'delete' ? 'DELETE' : 'PUT';
  // local_ 临时 id 不入队（服务端还没创建），防御性跳过
  if (op.noteId && !String(op.noteId).startsWith('local_')) url += '/' + op.noteId;
  const opt = { method, headers };
  if (op.type !== 'delete' && op.payload) opt.body = JSON.stringify(op.payload);
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
        // 冲突：丢弃该操作，通知 UI 刷新该文件
        window.dispatchEvent(new CustomEvent('tv:conflict', { detail: { noteId: op.noteId } }));
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
      throw new Error(msg);
    }
    if (res.status === 204) return null;
    return res.json();
  } catch (e) {
    // 版本冲突不入队（重放只会再次冲突）
    if (e instanceof ConflictError) throw e;
    // 写操作失败时入队，避免数据丢失
    if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
      // local_ 临时 id 不入队（服务端还没创建）
      if (id === undefined || id === null || !String(id).startsWith('local_')) {
        enqueueOp({
          type: method === 'POST' ? 'create' : method === 'DELETE' ? 'delete' : 'update',
          noteId: method === 'POST' ? null : String(id),
          payload: data || null,
          idempotencyKey: genIdempotencyKey(),
          createdAt: Date.now()
        });
      }
    }
    throw e;
  }
}

async function fetchNotes() { return apiRequest('GET'); }
async function fetchNote(id) { return apiRequest('GET', null, id); }
async function createNote(n, c) { return apiRequest('POST', { name: n, content: c }); }
async function updateNote(id, d) { return apiRequest('PUT', d, id); }
async function deleteNote(id) { return apiRequest('DELETE', null, id); }
