# 观猹社群数据分析面板

面向社群运营的本地数据看板。粘贴一段群发文案后，自动提取其中的观猹链接，并通过 ClickHouse 观察转发后的访问变化。

## 主要能力

- 一次转发可监控多个 `watcha.cn` 链接
- 跨链接去重统计独立访客、访问会话、真实页面浏览和登录访客
- 展示每个链接的浏览表现排行
- 记录社群画像、运营场景、群类型、转发群数和预计覆盖人数
- 每 20 秒自动刷新，支持手动刷新
- 可通过本机 CC Switch 当前模型生成 AI 复盘建议
- PostgreSQL 镜像可补充同期全站注册数据（不作为单链接归因）

## 本地运行

需要 Node.js 22 或更高版本。

```bash
npm install
cp .env.example .env.local
npm run dashboard
```

然后访问 [http://127.0.0.1:4317](http://127.0.0.1:4317)。

macOS 也可以双击 `local-workbench/启动社群数据工作台.command`。

## 数据配置

将 `.env.example` 复制为 `.env.local`，再填写自己的只读数据库连接。`.env.local` 已被 Git 忽略，不会上传。

ClickHouse 用于实时页面行为；PostgreSQL 为可选的每日镜像数据源。建议两个账号都只授予查询权限。

## 数据口径

- 独立访客：按 ClickHouse `session_id` 去重
- 访问会话：按 `visit_id` 去重
- 页面浏览：仅统计真实 pageview，排除曝光与心跳事件
- 登录访客：访问目标链接后发生登录行为的访客
- 全站注册：来自 PostgreSQL 同时间窗口，仅供趋势对照，不表示由该链接带来

数据库密码、API Key 和本地 CC Switch 配置都不应提交到仓库。
