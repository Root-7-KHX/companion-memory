<p align="center">
  <img src="https://raw.githubusercontent.com/Root-7-KHX/companion-memory/main/icon.svg" width="96" height="96" alt="companion-memory icon" />
</p>

<h1 align="center">伴侣记忆 · companion-memory</h1>

<p align="center">
  给 DeepSeek Harness 的角色扮演 / 伴侣型对话加一套常驻记忆与人格配置系统。<br/>
  每个对话独立一套数据，互不干扰；新对话默认关闭，想用时一键开启。
</p>

<p align="center">
  <a href="https://github.com/Root-7-KHX/companion-memory/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Root-7-KHX/companion-memory?color=blue" alt="license" /></a>
  <a href="https://github.com/Root-7-KHX/companion-memory/stargazers"><img src="https://img.shields.io/github/stars/Root-7-KHX/companion-memory?color=yellow" alt="stars" /></a>
  <img src="https://img.shields.io/badge/DSH-plugin-6f42c1" alt="DSH plugin" />
  <img src="https://img.shields.io/badge/Node-%E2%89%A522-339933" alt="node" />
</p>

---

## 这个插件解决什么

角色扮演聊久了，模型会忘设定、忘剧情、忘你说过的话；而普通聊天窗口既放不下长篇人设，也不该让 AI 每轮都翻旧账。这个插件在本地给每个对话配一套「人格文档 + 好感度 + 记忆 + 知识库」：

- **人设随时改、立即生效**：侧边栏里填写的三份文档，每次对话前现读，改完下一轮立刻按新设定说话。
- **重点原文一字不改**：判定为重信息的原文只做「保存 / 调取」，系统不会改写或脑补。
- **聊天周期自动管理**：按真实对话累计交互日，满 30 天自动归档；48 小时小归纳、每 30 个交互日月度打包、可自定义轮数的自动打包，全部写进可检索的本地知识库。
- **两段式检索**：48 小时内的事直接检索原始对话（热缓存），更早的事从知识库归档 / 归纳里查。
- **按对话隔离**：每个对话各自一套人设、好感度、记忆与知识库；关闭只停止注入，数据保留不删。

## 界面预览

| 配置：固定说明 + 分字段填空 | 按对话开启 / 关闭 |
| --- | --- |
| ![配置](https://raw.githubusercontent.com/Root-7-KHX/companion-memory/main/docs/screenshots/01-panel-config.jpg) | ![关闭引导](https://raw.githubusercontent.com/Root-7-KHX/companion-memory/main/docs/screenshots/02-panel-off.jpg) |

| 记忆：好感度与活跃记忆 | 知识库：48h 热上下文 / 自动打包 |
| --- | --- |
| ![记忆](https://raw.githubusercontent.com/Root-7-KHX/companion-memory/main/docs/screenshots/03-panel-memory.jpg) | ![知识库](https://raw.githubusercontent.com/Root-7-KHX/companion-memory/main/docs/screenshots/04-panel-knowledge.jpg) |

<details>
<summary>总览页（只读）：核对 AI 到底看到了什么</summary>

![总览](https://raw.githubusercontent.com/Root-7-KHX/companion-memory/main/docs/screenshots/05-panel-overview.jpg)

</details>

## 功能

### 五个页面

1. **配置**：三份角色文档 —— `角色性格.md`、`允许&禁止行为.md`、`预设发言例句.md`。说明文字固定只读，按固定字段逐项填空（基础性格 / 三观 / 说话语调 / 思考方式 / 喜好 / 雷区；允许 / 禁止 / 行为边界；日常问候 / 表达关心 / 表达不满 / 口头禅），每份末尾另有「其他补充」自由填写框。保存后下一轮对话立刻生效，优先级高于一切记忆。
2. **记忆**：全局活跃记忆（重要原文不改、上限 30 个聊天交互日）、好感度（-100 ~ 100，变更必须写理由并归档）。
3. **知识库**：按日期归档的本地文档 + 每 30 个交互日自动生成的月度打包文档 + 可自定义间隔的自动打包文档，支持关键词检索与原文查看；页面顶部显示「最近 48 小时上下文」状态与「自动打包」设置（每 N 轮一次，0 = 关闭）。
4. **状态**：交互日计数、48 小时归纳到期状态、对话月周期进度、数据目录与统计。
5. **总览**：只读。把注入给 AI 的每一块内容分别列成独立框，末尾给出「整体」完整系统提示词，可展开 / 复制全文，方便核对 AI 到底看到了什么。

### Host 侧自动行为

- 只对**已开启**的对话注入系统提示词；未开启的对话完全不受影响；
- 自动缓存该对话最近 48 小时的原始对话（用户与角色原话），供模型 `search_recent` / `read_recent` 检索；超过 48 小时自动清理，只保留知识库归档与归纳；
- 按「当天是否产生有效对话」累计该对话的聊天交互日（不聊天的日子不计数）；
- 活跃记忆满 30 个交互日自动移入知识库（原文不变）；
- 每满 30 个聊天交互日自动生成 `对话月度归档_第N周期_起始YYYY-MM-DD.md`；
- 按面板设置的轮数（默认 5，可设 0 关闭）：每累计 N 轮真实对话，自动把区间内的重点原文（原样）、次要摘要、48 小时归纳、好感度变更整理成 `packs/对话自动打包_第N次_起始…_截止….md`，并写入知识库供检索；不修改任何原有归档；
- 通过 `companion_memory` 工具让模型记录每轮对话、保存重点原文、更新好感度、检索上下文与知识库、提交 48 小时归纳；未开启的对话调用会被拒绝；
- 记住最近活跃的对话，面板打开时自动跟随，也可手动下拉切换。

### 两段式检索

| 时间范围 | 数据位置 | 工具动作 | 内容 |
| --- | --- | --- | --- |
| 最近 48 小时 | `recent.json`（自动缓存） | `search_recent` / `read_recent` | 对话原话，可直接引用 |
| 超过 48 小时 | `archive/`、`monthly/`、`packs/` | `search_kb` / `read_archive` | 归档记录、48 小时归纳、月度打包、自动打包 |

## 安装

### 方式一：从 GitHub 安装（推荐分享）

在 DSH 插件市场选择「从链接安装」，填入 Release 资产直链：

```text
https://github.com/Root-7-KHX/companion-memory/releases/download/v0.1.0/companion-memory-0.1.0.tgz
```

或命令行：

```bash
dsh plugin add https://github.com/Root-7-KHX/companion-memory/releases/download/v0.1.0/companion-memory-0.1.0.tgz
```

### 方式二：本地目录安装

1. 下载本仓库（Code → Download ZIP 并解压，或 `git clone`）；
2. 在 DSH 中让插件管理器安装该目录（`plugin_manager` → `install_bundle` → 指向解压出来的 `companion-memory/` 目录）；
3. 刷新 Web GUI 页面，侧边栏出现「伴侣记忆」图标。

### 方式三：解压即用

把 `companion-memory-0.1.0.zip` 解压到固定目录，指向该目录安装即可（无需构建、无第三方依赖、纯 ESM）。

## 使用

1. 打开左侧「伴侣记忆」面板 —— 顶部「当前对话」栏会显示当前对话与开启状态；
2. 点击「开启本对话」：这个对话从此拥有独立的一套数据；
3. 到「配置」页填写角色性格、允许与禁止的行为、常用例句（自动保存，下一轮生效）；
4. 正常聊天即可：AI 每轮结束会记录重点原文、次要摘要并评估好感度；
5. 想核实时去「总览」页看 AI 收到的完整内容；想回忆旧事时直接问，AI 会先查 48 小时热缓存，再查知识库。

> 新对话默认关闭 —— 每个对话单独点一下开启即可；关掉只停止注入，已有数据不会删除。

## 数据位置

默认根目录 `$DSH_HOME/companion-memory`（回退 `~/.dsh/companion-memory`）：

```text
companion-memory/
├── sessions.json                     # 哪些对话已开启、最近活跃对话
├── sessions/<对话 id>/               # 每个对话独立一套
│   ├── 角色性格.md
│   ├── 允许&禁止行为.md
│   ├── 预设发言例句.md
│   ├── state.json                    # 好感度、活跃记忆、交互日、周期与打包设置
│   ├── recent.json                   # 最近 48 小时原始对话
│   ├── archive/YYYY-MM-DD.md         # 按日期归档
│   ├── monthly/对话月度归档_第N周期_起始YYYY-MM-DD.md
│   └── packs/对话自动打包_第N次_起始YYYY-MM-DD_截止YYYY-MM-DD.md
└── （旧版单套数据：首次启用某个对话时自动迁入该对话目录）
```

所有归档条目以 `归档日期：YYYY-MM-DD HH:MM` 开头，按日期分组；数据全部保存在本地，不上传任何服务器。

## 开发与结构

```text
companion-memory/
├── index.js              # Host 入口：注册提示词段、工具、事件追踪、HTTP API
├── client.js             # Client 半：侧边栏图标 + 主面板（五个页面，轮询状态）
├── lib/
│   ├── manager.js        # 按会话管理数据目录、开启注册表、会话列表、旧数据迁移
│   ├── store.js          # 单会话数据层：文档、记忆、好感度、归档、周期、打包
│   ├── recent.js         # 48 小时热上下文缓存与检索
│   ├── prompt.js         # 系统提示词分段渲染（按对话隔离注入）
│   ├── tool.js           # companion_memory 工具（转发到对应会话的 store）
│   ├── tracking.js       # 会话事件 → 交互日计数 / 热缓存 / 自动打包
│   └── api.js            # 同源 HTTP API（/companion/api/*）
├── locale/               # 中英双语文案
├── cordis.patch.yml      # 插件加载补丁
└── docs/screenshots/     # README 图片
```

插件通过 Host HTTP 路由与 Client 面板通信，数据与状态全部落在本地文件；Host 侧在 `agent/created` 时按对话注册系统提示词段，关闭的对话不注入任何内容。

### 在 GitHub Codespaces 里改代码（免装 Git）

仓库自带 `.devcontainer` 配置，所以可以直接在浏览器里改代码：

1. 仓库页点绿色的 **Code** 按钮 → **Codespaces** 标签 → **Create codespace on main**；
2. 等几十秒，浏览器里打开一个 VS Code（已装好 Node 22）；
3. 改完文件，在左侧 **Source Control**（`Ctrl+Shift+G`）填写提交信息 → **Commit & Push**；
4. 也可以在终端跑校验：`node --check index.js && node --check client.js`。

> 限制：Codespaces 只是云端编辑器/终端，跑不了 DSH 本体。插件的实际界面与数据验证仍需在本地 DSH 里做；它适合改代码、改文档、打包和发版。

### 本地校验

```bash
# 语法检查（Node ≥ 22；纯 ESM，无需安装依赖）
node --check index.js
node --check client.js
node --check lib/manager.js
```

## 参与贡献

这个项目是公开的，欢迎任何人一起完善（改代码、提建议、修文档都可以）：

- 📋 **提 Bug / 建议**：[Issues](https://github.com/Root-7-KHX/companion-memory/issues)（有对应模板）
- 🔧 **帮忙改代码**：Fork 本仓库 → 新建分支 → 提交 PR（流程与自检清单见 [CONTRIBUTING.md](CONTRIBUTING.md)）
- 🌐 **参与方式不限身份**：公开仓库下，任何 GitHub 用户都可以 fork、提 Issue、提 PR；如果你希望某个朋友直接改仓库，可以把他加成 Collaborator（仓库 **Settings → Collaborators → Add people**）
- 🧩 **本地开发**：`node --check` 自检 + 安装到 DSH 后按 [CONTRIBUTING.md](CONTRIBUTING.md) 的冒烟清单走一遍

> 不接收任何用户对话数据；Issue 里请勿粘贴真实聊天隐私。

## License

[MIT](LICENSE) © 2026 [Root-7-KHX](https://github.com/Root-7-KHX)
