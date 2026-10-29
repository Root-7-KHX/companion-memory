# 参与贡献 / Contributing

感谢你愿意一起完善 **伴侣记忆（companion-memory）**！这是一个公开项目，任何建议、问题反馈、代码改动都 welcome。

> English speakers: see the short [English guide](#english-guide) at the bottom. You can open issues and pull requests in English.

---

## 适合贡献什么

| 类型 | 例子 | 入口 |
| --- | --- | --- |
| 🐛 问题反馈 | 面板某个按钮点了没反应、提示词注入不对、跨对话数据串了 | [新建 Bug 报告](https://github.com/Root-7-KHX/companion-memory/issues/new?template=bug_report.md) |
| ✨ 功能建议 | 新检索方式、新的周期打包规则、新的面板交互 | [新建功能建议](https://github.com/Root-7-KHX/companion-memory/issues/new?template=feature_request.md) |
| 🌐 翻译纠错 | 中英文案不通顺、术语不一致 | 直接改 `locale/*.json` 或 README 后提 PR |
| 📝 文档 | 安装步骤、使用说明、FAQ | 直接改 README / 本文件后提 PR |
| 💻 代码 | 修 bug、加功能、性能与兼容性改进 | Fork 后提 PR（见下方流程） |

**不涉及**：本项目纯本地运行，不接收任何用户对话数据；请勿在 Issue 里粘贴真实聊天隐私。

---

## 系统要求

- Windows / macOS / Linux 均可运行
- Node.js ≥ 22（仅用于语法检查，插件本身无第三方依赖）
- 一个可用的 DeepSeek Harness（DSH）桌面端或 Web GUI，用于实际测试

## 本地开发

### 1. 获取代码

```bash
git clone https://github.com/Root-7-KHX/companion-memory.git
cd companion-memory
```

或者直接下载仓库 ZIP 解压。

### 1.5 用 GitHub Codespaces（可选，浏览器里就能改）

不想在本机装 Git/Node 时，可以点仓库页 **Code → Codespaces → Create codespace on main**，在浏览器的 VS Code 里开发：

- 仓库自带 `.devcontainer/devcontainer.json`（Node 22 镜像），打开即可用；
- 改完在 **Source Control** 里 Commit & Push，或终端 `git add -A && git commit -m "..." && git push`；
- 只适合改代码、`node --check`、`npm pack`；插件 UI 与本地数据仍要在本机 DSH 里验证。

### 2. 安装到 DSH

用 DSH 的插件管理器安装本地目录（**推荐**）：

1. 让 Agent 调用 `plugin_manager` → `action: install_bundle` → `target` 填此目录的绝对路径；
2. 安装后刷新 Web GUI 页面，左侧侧边栏出现「伴侣记忆」图标；
3. 打开面板 →「开启本对话」即可开始测试。

> 也可以把仓库目录放进 DSH profile 的 `node_modules` 并做 link（高级用法，参考 DSH 自身文档）。

### 3. 改代码后的生效方式

| 改动文件 | 生效方式 |
| --- | --- |
| `index.js`、`lib/*.js`（Host 半） | 禁用再启用一次插件（`plugin_manager` → `set_plugin` false → true），或重启 DSH |
| `client.js`（Client 半） | 刷新 Web GUI 页面（`Ctrl + R`） |
| `locale/*.json`、README | 无需重载，刷新页面即可 |
| `cordis.patch.yml`、`package.json` | 需要重新安装插件后重启 |

### 4. 提交前自检（必做）

```bash
# 语法检查：所有 JS 文件都要通过
node --check index.js
node --check client.js
for f in lib/*.js; do node --check "$f"; done
```

手动冒烟清单（在本地 DSH 里操作一遍）：

- [ ] 侧边栏出现「伴侣记忆」，面板能打开
- [ ] 「当前对话」栏正确显示对话名与开启状态
- [ ] 开启 / 关闭本对话后，系统提示词注入随之出现 / 消失（用「总览」页核对）
- [ ] 配置页填写字段后下一轮对话生效
- [ ] 记忆页能改好感度并产生一条带时间戳的归档
- [ ] 知识库页能检索到刚产生的归档
- [ ] 新对话默认关闭，且两个对话的数据互不干扰

---

## 提交流程

1. **Fork** 本仓库到你的账号；
2. 新建分支，分支名建议：`feat/xxx`、`fix/xxx`、`docs/xxx`；
3. 小步提交，提交信息用 [Conventional Commits](https://www.conventionalcommits.org/)：
   - `feat: 支持按对话导出记忆`
   - `fix: 关闭的对话仍被注入提示词`
   - `docs: 补充 macOS 安装说明`
   - `refactor: 拆分 store.js 的归档逻辑`
4. 推送分支后向 `main` 提 **Pull Request**，按 PR 模板填写：
   - 改了什么、为什么改；
   - 自检清单结果（见上）；
   - 涉及界面改动的附截图（最好前后对比）。
5. 等待 Review；小改动通常很快合并，大改动建议先开 Issue 讨论方案。

### PR 合并后

- 合并进 `main` 的改动会随下一个版本发布；
- 打进 `v*` tag 时，GitHub Actions 会自动做语法检查、`npm pack` 并把 tgz 挂到 Release；
- 想出现在贡献者名单：合并后 GitHub 会自动把你列在仓库 Contributors 里。

---

## 代码结构速览

```text
index.js          Host 入口：提示词注册 / 工具 / 事件追踪 / HTTP API
client.js         Client 半：侧边栏图标 + 五页主面板
lib/manager.js    按会话管理数据目录、开启注册表、会话列表、旧数据迁移
lib/store.js      单会话数据层：人格文档、好感度、记忆、归档、周期、打包
lib/recent.js     48 小时热上下文缓存与关键词检索
lib/prompt.js     系统提示词分段渲染（按对话隔离注入）
lib/tool.js       companion_memory 工具，转发到对应会话的 store
lib/tracking.js   会话事件 → 交互日 / 热缓存 / 自动打包
lib/api.js        同源 HTTP API（/companion/api/*，供面板调用）
locale/           中英文案
```

数据目录（开发时可用测试数据，**请勿提交到仓库**）：`$DSH_HOME/companion-memory/`。

---

## 行为准则（简版）

- 对人友好，对事直接；讨论代码与方案，不针对个人；
- 尊重原作者与贡献者的劳动；
- 不提交隐私数据、密钥、`node_modules`、构建产物；
- 有争议时以「对用户是否有用、是否破坏现有行为」为准。

## 许可

你提交的贡献默认以本项目的 [MIT License](LICENSE) 授权。

---

## English guide

Thanks for helping improve **companion-memory**, a roleplay memory plugin for DeepSeek Harness (DSH). Everyone is welcome to open issues and pull requests.

- **Bug / feature**: use the issue templates (English is fine).
- **Workflow**: fork → branch (`feat/xxx`, `fix/xxx`) → commit (Conventional Commits) → PR to `main`.
- **Before PR**: run `node --check` on `index.js`, `client.js` and every file in `lib/`; then do a manual smoke test (open panel, enable a conversation, check the Overview page, edit a doc, change favorability, search the knowledge base).
- **Reload rules**: Host files (`index.js`, `lib/*.js`) need the plugin disabled/enabled again; `client.js` needs a page refresh (`Ctrl+R`).
- **Code layout**: `lib/manager.js` (per-session data dirs), `lib/store.js` (single session data), `lib/prompt.js` (system prompt injection), `lib/recent.js` (48h hot context), `lib/api.js` (HTTP API for the panel).
- Keep PRs focused, describe the "why", and attach screenshots for UI changes.
- By contributing you agree your work is licensed under the project's MIT License.
