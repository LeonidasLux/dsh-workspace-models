# dsh-workspace-models

[![npm version](https://img.shields.io/npm/v/dsh-workspace-models)](https://www.npmjs.com/package/dsh-workspace-models)
[![license](https://img.shields.io/npm/l/dsh-workspace-models)](LICENSE)

为 DeepSeek Harness Web GUI 提供「按工作区指定模型」和「按工作区汇总模型 Token 用量」的插件。
npm 包名 `dsh-workspace-models`，bundle 名同为 `dsh-workspace-models`，Loader 行 id `workspace-models`。

## 安装

```bash
npm install dsh-workspace-models
```

也可以直接在 DSH 的插件管理（设置 → 插件）里按包名 `dsh-workspace-models` 安装；本地开发时把插件管理指向包目录安装即可（装的是同一个 `dsh.bundle`）。装好后左侧侧边栏会出现「工作区模型」入口。

- GitHub：<https://github.com/LeonidasLux/dsh-workspace-models>
- npm：<https://www.npmjs.com/package/dsh-workspace-models>

## 功能入口

| 位置 | 内容 |
|---|---|
| 左侧侧边栏 | 一个「工作区模型」入口（`sidebar.panellist`，id `workspace-models`），点击打开汇总面板。 |
| 主区域 | 面板本体（`main` 槽，key `workspace-models`）：列出每个工作区固定的模型、会话数、运行中标记、Token 总量，以及按服务商/模型拆分的用量表。每张卡片可展开内联编辑器（模型、推理强度，或「跟随默认」）。 |
| 工作区「更多」菜单 | 一条「模型配置…」，通过 `workspace` 这一右键菜单目标注入，点击后打开面板并定位到该工作区。 |

## 支持其他厂商

模型选择器不绑定任何厂商：它直接读 `sessionController.modelCatalog()`，把宿主当前可路由的**每个**服务商分组列出——DeepSeek、DeepSeek 账号，以及你在 **设置 → 模型** 里配置的任何第三方服务商（含 OpenAI 兼容网关）。分组用 `optgroup` 呈现，名称取服务商自己的显示名。

还没进入目录的厂商也能固定：选择 **其他厂商 / 手动填写…** 后会展开「服务商 id」和「模型 id」两个输入框，宿主按原样保存这条路由。这类固定会在卡片和编辑器里标出 **目录中未列出**，因为在该服务商配置好之前请求会失败——插件不会悄悄改写或丢弃你填的路由。

服务商凭据和端点的所有权仍属于 DSH 自己的模型设置；工作区固定只是从那份设置提供的路由里挑一条。

## 行为

- **默认模型。** 没有固定模型的工作区继续使用 `@deepseek-ai/dsh-agent-default-model` 提供的部署默认值（也就是你当前配置的 DeepSeek 模型）。面板上显示为「跟随默认」。
- **固定模型。** 已配置的工作区模型会在该工作区会话的 Agent 创建或恢复时、首个模型请求之前，通过 `agent.model.select(...)` 生效。部署默认值从不被修改，所以其他工作区不受影响。
- **用户的手动选择优先。** 插件会记住自己写过的每次选择。恢复会话时，如果会话当前的选择与该记忆值不同，说明这是用户在输入框里手动改的，插件不覆盖；如果仍是插件写的值，则继续跟随工作区的最新设置。
- **运行中的会话。** 修改工作区模型时，该工作区正在运行的会话也会通过同一个 `select` 调用切过去。
- **子 agent。** 以子 agent 身份创建的会话（`origin: 'subagent'` 或带 `parentSession`）不会被改写。
- **Token 用量。** 按 `assistant/message` 事件折叠，键取消息来源里记录的 provider/model；fork 继承来的前缀会被跳过。运行中的会话通过 `session/event` 保持增量更新；冷日志用 `sessionQuery.readSession` 读一次（回退到 `sessionPersistence`）并缓存。插件挂载 5 秒后会在后台预热，让面板首次打开就足够快。

## 状态文件

`<harness home>/workspace-models/state.json`

```json
{
  "version": 1,
  "workspaces": { "<workspaceId>": { "provider": "deepseek", "model": "deepseek-reasoner", "reasoningEffort": "high" } },
  "sessions": { "<sessionId>": { "provider": "deepseek", "model": "deepseek-reasoner" } }
}
```

写入是原子的（临时文件 + rename）且串行化。文件在首次使用时创建；删除它等于清空全部固定。

## HTTP 路由（宿主侧，经 `connection.requestRejection` 闸门）

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/workspace-models/overview` | 工作区列表、已配置/生效模型、模型目录、按模型统计的用量。`?refresh=1` 跳过 30 秒的目录缓存。 |
| `POST` | `/workspace-models/config` | `{ workspaceId, model: { provider, model, reasoningEffort? } \| null }`。`null` 表示清除固定。接受任意 provider/model 路由；返回里的 `listed` 表示当前目录是否认识它。 |

所有路由都做浏览器信任校验，不被信任的请求返回 `403`。

## 多语言

所有用户可见文案都由客户端 locale 命名空间 `workspaceModels` 提供（`en` + `zh` 两个基线字典，键集一致）。当前语言取自 `locale` 服务快照，其 id 字段是 **`active`**；带地区标签的 id（`zh-CN`、`zh-Hant` 等）按主语言解析，未注册的语言回退到英文基线。槽位渲染的文案会在语言切换时即时重渲染：面板用 `useSyncExternalStore` 订阅，侧边栏入口的 `label` 是个 thunk，宿主每次投影都会重新取值。

包自身的展示元数据（`locale/en.json`、`locale/zh.json` 里的 `meta.title`、`meta.description`）是插件管理与设置页对这一行显示的内容，因此也跟随同一个当前语言。

## 验证

`node --check`，加上放在包外的两套用例：`host-smoke.mjs`（路由、目录校验、目录外路由的接受与标记、持久化、用量折叠、闸门、模型选择语义）和 `client-smoke.mjs`（模块注册、槽位与菜单贡献、用假 React 渲染、语言解析含 `zh-CN` 与不支持的语言 id）。在真实 profile 里，宿主行与客户端三处注册（`main` key `workspace-models`、`sidebar.panellist` id `workspace-models`、工作区菜单动作）都已通过 inspection 确认；像素级外观未在本次会话中观察。
