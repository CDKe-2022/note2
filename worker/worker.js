/* ============================================================
 * TextVault — worker/worker.js
 * Cloudflare Worker 后端（单文件，粘贴即部署）
 *
 * 改进点：
 *   1. 乐观并发控制：PUT 携带 version，不一致返回 409
 *   2. 幂等键覆盖所有写操作（POST / PUT / DELETE）
 *   3. 旧客户端不传 version → 跳过冲突检查（向后兼容）
 *
 * 部署：新建 Worker → 粘贴本文件 → 绑定 D1（变量名 DB）→ 部署
 * ============================================================ */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const token = request.headers.get('Authorization')?.replace('Bearer ', '');
    const userId = token || 'default-user'; // 单用户模式下，token 仅作为简单鉴权
    const db = env.DB;
    // 注意：将此处 Origin 换成你自己的前端域名
    const corsHeaders = {
      'Access-Control-Allow-Origin': 'https://your-frontend.pages.dev',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Idempotency-Key',
      'Access-Control-Max-Age': '86400',
    };
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    const pathParts = url.pathname.replace(/^\/+|\/+$/g, '').split('/');
    if (pathParts[0] !== 'api' || pathParts[1] !== 'notes') {
      return new Response('Not found', { status: 404, headers: corsHeaders });
    }
    const noteId = pathParts[2] || null;

    // 幂等键检查：覆盖所有写操作（POST / PUT / DELETE）
    const idemKey = request.headers.get('Idempotency-Key');
    if (idemKey && ['POST', 'PUT', 'DELETE'].includes(request.method)) {
      const cached = await db.prepare('SELECT response_status, response_body FROM idempotency WHERE key = ?').bind(idemKey).first();
      if (cached) {
        return new Response(cached.response_body, { status: cached.response_status, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }
    }
    if (idemKey) ctx.waitUntil(cleanupIdempotency(db));

    try {
      // GET 列表
      if (request.method === 'GET' && !noteId) {
        const { results } = await db.prepare(
          `SELECT id, name, LENGTH(content) as charCount, createdAt, updatedAt, pinned, sort_order, version FROM notes WHERE userId = ? ORDER BY pinned DESC, sort_order ASC, updatedAt DESC`
        ).bind(userId).run();
        return new Response(JSON.stringify(results), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }
      // GET 详情
      if (request.method === 'GET' && noteId) {
        const { results } = await db.prepare(`SELECT * FROM notes WHERE id = ? AND userId = ?`).bind(noteId, userId).run();
        if (!results.length) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        return new Response(JSON.stringify(results[0]), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }
      // POST 创建
      if (request.method === 'POST' && !noteId) {
        const body = await request.json();
        const { name, content, pinned, sort_order } = body;
        const now = Date.now();
        const { results } = await db.prepare(
          `INSERT INTO notes (name, content, userId, createdAt, updatedAt, pinned, sort_order, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1) RETURNING *`
        ).bind(name || '未命名', content || '', userId, now, now, pinned || 0, sort_order || 0).run();

        const responseBody = JSON.stringify(results[0]);
        if (idemKey) {
          await db.prepare(`INSERT OR IGNORE INTO idempotency (key, method, path, response_status, response_body, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
            .bind(idemKey, 'POST', '/api/notes', 201, responseBody, Math.floor(now / 1000)).run();
        }
        return new Response(responseBody, { status: 201, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }
      // PUT 更新（乐观并发控制）
      if (request.method === 'PUT' && noteId) {
        const body = await request.json();
        const { name, content, pinned, sort_order, version } = body;
        const now = Date.now();

        // 版本冲突检测：客户端 version 与服务端不一致 → 409
        const current = await db.prepare('SELECT version FROM notes WHERE id = ? AND userId = ?').bind(noteId, userId).first();
        if (!current) {
          return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        }
        // 旧客户端不传 version → 跳过冲突检查（向后兼容）
        if (version !== undefined && version !== null && Number(version) !== Number(current.version)) {
          return new Response(JSON.stringify({ error: 'Conflict', message: '该文件已被其他设备修改', serverVersion: current.version }), { status: 409, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        }

        const fields = []; const params = [];
        if (name !== undefined) { fields.push('name = ?'); params.push(name); }
        if (content !== undefined) { fields.push('content = ?'); params.push(content); }
        if (pinned !== undefined) { fields.push('pinned = ?'); params.push(pinned); }
        if (sort_order !== undefined) { fields.push('sort_order = ?'); params.push(sort_order); }
        if (!fields.length) return new Response(JSON.stringify({ error: 'No fields' }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } });

        fields.push('version = version + 1');
        fields.push('updatedAt = ?'); params.push(now); params.push(noteId); params.push(userId);
        const { results } = await db.prepare(`UPDATE notes SET ${fields.join(', ')} WHERE id = ? AND userId = ? RETURNING *`).bind(...params).run();
        if (!results.length) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders } });

        const responseBody = JSON.stringify(results[0]);
        if (idemKey) {
          await db.prepare(`INSERT OR IGNORE INTO idempotency (key, method, path, response_status, response_body, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
            .bind(idemKey, 'PUT', '/api/notes/' + noteId, 200, responseBody, Math.floor(now / 1000)).run();
        }
        return new Response(responseBody, { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }
      // DELETE 删除
      if (request.method === 'DELETE' && noteId) {
        const now = Date.now();
        await db.prepare('DELETE FROM notes WHERE id = ? AND userId = ?').bind(noteId, userId).run();
        const responseBody = JSON.stringify({ success: true });
        if (idemKey) {
          await db.prepare(`INSERT OR IGNORE INTO idempotency (key, method, path, response_status, response_body, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
            .bind(idemKey, 'DELETE', '/api/notes/' + noteId, 200, responseBody, Math.floor(now / 1000)).run();
        }
        return new Response(responseBody, { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }
      return new Response('Method not allowed', { status: 405, headers: corsHeaders });
    } catch (err) {
      return new Response(JSON.stringify({ error: 'Internal Server Error' }), { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }
  }
};
async function cleanupIdempotency(db) {
  const cutoff = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;
  await db.prepare('DELETE FROM idempotency WHERE created_at < ?').bind(cutoff).run();
}
