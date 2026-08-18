# TextVault — 多端共享备忘录

TextVault 是一款简洁、纯粹、专注的本地化优先文本编辑器。前端采用原生 HTML/CSS/JS 构建，无需任何构建步骤；后端基于 Cloudflare Workers + D1 数据库，实现轻量级的多端数据同步与离线容灾。

![Cloudflare Workers](https://img.shields.io/badge/Backend-Cloudflare%20Workers-F38020?logo=cloudflare&logoColor=white)
![Cloudflare D1](https://img.shields.io/badge/Database-Cloudflare%20D1-F38020?logo=cloudflare&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-blue.svg)

## 特性

- **零依赖前端**：原生 HTML/CSS/JS，无 Node.js、无打包工具，双击 `index.html` 即可运行。
- **多文件管理**：支持新建、重命名、删除，支持文件拖拽排序与置顶。
- **多端数据安全**：
  - 基于 `version` 字段的乐观并发控制，服务端检测到版本不一致时返回 409。
  - 冲突时**本地内容优先**：自动采用服务端最新版本号重试写入，编辑器内容永不被自动覆盖，正在编辑的输入不会丢失。
  - 所有写操作支持离线队列，联网后自动重放；同一文件的多次更新自动合并，删除操作会抵消未同步的更新。
  - 队列重放采用**强制写入**语义（不带版本号），重放永不因版本过期被拒绝，保证离线内容最终落盘。
  - 基于 `Idempotency-Key` 的请求去重覆盖 POST / PUT / DELETE，防止弱网重放导致数据重复。
- **安全的富文本编辑**：
  - 使用 `DOMPurify` 进行严格的 HTML 过滤。
  - 禁用危险 CSS 属性（如 `position: fixed`），防止界面被篡改。
  - 修复了小写字母 `p`、`g`、`y` 等下伸笔画遮挡下划线的排版问题。
  - 键盘快捷键与搜索导航均做了 IME 组合输入保护（`isComposing`），中文输入法下不会误触。
- **TreeWalker 搜索引擎**：
  - 彻底废弃非标准的 `window.find()` API。
  - 全局搜索、当前文件搜索、高亮与替换均基于 `TreeWalker` 与 `Range` 实现，绝不破坏 DOM 结构。
- **撤销栈隔离**：每个文件维护独立的撤销/重做历史，切换文件不污染编辑状态；快照上限 30 份，控制大文件内存占用。
- **专注体验**：支持深色模式、专注模式、字体缩放，完善的键盘快捷键。

## 技术栈

- **前端**：原生 HTML5, CSS3, JavaScript (ES6+), DOMPurify
- **后端**：Cloudflare Workers (Serverless API)
- **数据库**：Cloudflare D1 (SQLite)

## 项目结构

```
textvault/
├── index.html        # 页面骨架 + 全部 CSS + 引入脚本
├── js/
│   ├── sync.js       # API 客户端 + 离线队列合并 + 幂等键 + 版本冲突
│   ├── store.js      # 状态管理 + 撤销栈 + 文件 CRUD + 冲突处理
│   └── app.js        # 编辑器 + 文件列表 + 搜索 + 快捷键 + 初始化
└── worker/
    ├── worker.js     # 后端 Worker（单文件，粘贴即部署）
    └── schema.sql    # D1 建表 SQL
```

前端脚本按 `sync.js → store.js → app.js` 顺序加载，使用普通 `<script>` 标签（非 ES module），保留双击即用的能力。

## 部署指南

本项目分为前端（静态页面）和后端（Workers API）两部分，推荐均部署到 Cloudflare。

### 第一步：创建 D1 数据库

1. 登录 Cloudflare Dashboard，进入 **Workers & Pages** -> **D1**。
2. 创建一个新的 D1 数据库（例如命名为 `textvault`）。
3. 在数据库控制台的 **Console** 中，执行 `worker/schema.sql` 中的 SQL 语句创建数据表。

```sql
-- 笔记主表（含 version 乐观并发控制字段）
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '未命名',
  content TEXT DEFAULT '',
  userId TEXT NOT NULL DEFAULT 'default-user',
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  pinned INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  version INTEGER DEFAULT 1
);

-- 幂等去重表（覆盖 POST / PUT / DELETE）
CREATE TABLE IF NOT EXISTS idempotency (
  key TEXT PRIMARY KEY,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_body TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_idempotency_created ON idempotency(created_at);
```

### 第二步：部署 Worker 后端

1. 在 **Workers & Pages** 中创建一个新的 Worker（例如命名为 `textvault-api`）。
2. 将 `worker/worker.js` 的完整内容粘贴到 Worker 的在线编辑器中并部署。
3. **绑定 D1 数据库**：在 Worker 的 **设置 -> 绑定** 中，添加 D1 绑定，变量名设为 `DB`，选择刚才创建的数据库。
4. **修改 CORS 域名**：将 `worker.js` 中 `Access-Control-Allow-Origin` 的值改为你的前端域名（如 `https://textvault.pages.dev`）。

### 第三步：部署前端

1. 将 `index.html` 与 `js/` 目录下载到本地。
2. 打开 `js/sync.js`，将 `API_BASE` 常量改为你的 Worker 域名（例如 `https://textvault-api.your-name.workers.dev/api/notes`）。
3. 登录 Cloudflare Dashboard，进入 **Workers & Pages** -> **创建应用程序** -> **Pages** -> **上传资产**。
4. 将 `index.html` 与 `js/` 目录打包上传，或直接上传文件部署。
5. 部署完成后，你会获得一个 `xxx.pages.dev` 的域名。

### 第四步：配置鉴权 Token

1. 打开你的前端页面。
2. 在浏览器的开发者工具（F12）的 **Console** 中，运行以下命令设置你的专属访问 Token：

```javascript
localStorage.setItem('token', '你的自定义密码');
```

3. 刷新页面，应用将自动使用该 Token 进行身份验证与数据隔离。

## 快捷键

| 快捷键 | 功能 |
| :--- | :--- |
| `Ctrl` + `N` | 新建文件 |
| `Ctrl` + `O` | 导入本地文件 |
| `Ctrl` + `S` | 强制保存当前文件 |
| `Ctrl` + `F` | 打开搜索面板 |
| `Enter` | 跳转到下一个搜索匹配 |
| `Shift` + `Enter` | 跳转到上一个搜索匹配 |
| `Esc` | 关闭面板 / 退出专注模式 |
| `Ctrl` + `Z` / `Y` | 撤销 / 重做 |
| `Ctrl` + `B` | 加粗 |
| `Ctrl` + `U` | 下划线 |
| `Tab` | 插入缩进 |
| `F11` | 切换专注模式 |

## 许可证

本项目采用 [MIT License](LICENSE) 开源。
