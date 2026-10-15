# API Upstream Monitoring

用于管理上游 API 中转站的管理台。当前版本是 Node 后端 + PostgreSQL + 静态前端：

- 新增站点：名称、URL、类型、登录账号、密码、Bearer Token、USD→CNY 换算倍率
- 数据库存储：站点配置元数据明文写入 PostgreSQL
- 明文展示：密码和 token 不脱敏
- 查看快照：余额、分组、分组倍率、API key、连通性状态
- 倍率变更：站点页三栏概览展示最近 24 小时变更，左侧“倍率变更”页面筛选和分页查看全部历史
- 分组模型：按站点分组保存“使用模型”和“测试模型”，可拉取 `/v1/models`，也可手动添加
- 模型测速：优先使用分组的“测试模型”发起真实模型请求并记录最近返回时间，列表只展示“使用模型”
- 真实接入：sub2api / new-api 均优先通过 HTTP API 同步，必要时降级 Playwright；配置代理和凭据流站点也遵守这个顺序
- 手动刷新：页面默认只读取数据库最新快照；点击刷新才拉上游并落库

## 运行

先准备 PostgreSQL，并设置 `DATABASE_URL`：

```bash
npm ci
npx playwright install chromium
export DATABASE_URL='postgres://user:password@localhost:5432/api_upstream_monitoring'
npm start
```

打开：

```text
http://localhost:5173/
```

## 分组倍率变更监控

- 新增站点入口在站点表格工具栏，与“刷新表格”“同步全部”并列；顶部三张概览卡等宽等高，变更列表在卡片内部滚动。
- 手动同步、定时拉取及其他已有快照刷新入口统一采集。首次成功观测仅建立基线，之后记录相同分组 ID 的实际生效倍率涨跌；新增/消失分组、未知占位倍率、失败同步不作为涨跌事件；上游确认完整空分组时清空基线，分组重现按首次观测处理。
- 事件保存站点、类型、分组、时间、原始旧/新倍率和事件时的展示倍率。展示倍率按同一当时站点汇率转换，修改换算配置本身不会生成“上游涨跌”；原始小数精度不会为显示提前舍入。
- `/rate-changes` 支持站点、站点/分组关键词、涨跌方向、最近 24 小时或全部时间筛选；每页 50 条。首页每批 50 条，滚动或“加载更多”可继续查看当前 24 小时窗口的记录。
- 浏览历史和刷新表格只读本地数据库，不请求上游。站点页在前台每 45 秒重读看板；切换到后台停止轮询，返回时刷新；手动同步完成也会重读。
- PostgreSQL 自动创建 `group_rate_baselines` / `group_rate_changes`，与快照在同一事务中更新。新功能不回填过去未采集的事件，不自动删除历史；删除站点后保留已发生的历史名称/倍率，删除对应基线。
- 只读接口：`GET /api/group-rate-changes?window=24h&page=1&pageSize=50`。省略 `window` 查询全部历史；可选 `siteId`、`q`、`direction=up|down`；响应包含 `items,total,page,pageSize,pages,asOf,windowStart,snapshot`。后续分页同时回传 `asOf` 与 `snapshot`，固定时间上界与已提交事件集合，防止同步迟到提交造成翻页重复或漏项。

新增页面发布到 `/upstream/` 前缀时，需在现有 nginx location 的路由改写规则中追加：

```nginx
sub_filter "'/rate-changes'" "'/upstream/rate-changes'";
```

仅在采用上述子路径部署方式时需要这项配置；本地根路径无需配置。

## Docker 部署

使用 Docker Compose 可同时启动应用和 PostgreSQL，并用 Docker volume 保存数据库。

首次启动：

```bash
cp .env.docker.example .env
docker compose up -d --build
```

打开：

```text
http://localhost:5173/
```

检查状态：

```bash
docker compose ps
curl -fsS http://localhost:5173/api/health
```

查看日志：

```bash
docker compose logs -f app
```

停止服务：

```bash
docker compose down
```

`compose.yml` 默认只把页面绑定到宿主机 `127.0.0.1:5173`，不会暴露到局域网。数据库数据保存在 `postgres_data` volume；不要用 `docker compose down -v`，除非明确要删除本地数据。

## 服务器部署

在自己的服务器安装 Docker Compose，复制项目并按上面的步骤启动。首次运行前在 `.env` 中设置独立的数据库密码；不要使用示例密码部署共享实例。

应用默认只监听宿主机的 `127.0.0.1:5173`。需要远程访问时，通过自己的反向代理配置 HTTPS 和访问控制。此应用用于受信任的管理环境，页面会展示上游账号密码与 Token；不要将其直接开放给未授权用户。

新实例使用独立数据库，按需添加自己的站点和代理。不要复制他人的 `.env`、数据库备份、浏览器会话或凭据加密密钥。

如果本机已有进程占用 5173，改 `.env` 里的 `APP_PORT` 后重新启动：

```bash
APP_PORT=5174 docker compose up -d
```

## 验证

```bash
npm test
npm run check
```

## 真实数据接入

站点配置元数据已经从 PostgreSQL 读取和写入，不再使用浏览器 `localStorage`。

sub2api / new-api 优先通过 HTTP API 读取数据、续期和登录。直连接口收到明确的 Cloudflare challenge 响应后，先尝试原生 HTTP/2，后续请求在本轮同步内复用该连接；HTTP/2 仍失败才降级浏览器。new-api 接口不添加硬编码页面 Referer。配置代理时使用独立 HTTP 请求上下文（支持 HTTP / SOCKS5 及认证），不启动浏览器、不绕过代理直连；代理 API 传输失败才降级到 Playwright 同源页面请求。普通类型的明确 JSON 认证错误直接返回。`[snapshot-sync]` 日志记录 API / browser 阶段、直连 / 代理路径和脱敏失败原因，`[upstream-transport]` 标记 HTTP/2 重试及操作类型；两阶段都失败时，返回错误同时保留 API 和 Playwright 原因。

拉取模型和测试模型使用站点 API 地址及对应分组 Key，并复用上述 API/HTTP2 传输。模型请求默认发送 `User-Agent: api-upstream-monitoring/0.1`，可由调用方覆盖。测速等到首包后记录耗时并取消后续流；HTTP2 不缓冲完整生成结果才返回，超时覆盖响应体读取。代理请求直接使用 HTTP 请求上下文，错误信息不回显请求头中的 Key。

经过修改的 sub2api fork（会话绑定网络指纹、登录凭据 RSA 加密、图形验证码）用"同步方式 = 凭据流"接入：先尝试标准 API 读取、续期和密码登录；失败后才使用 Playwright 完成原来的登录流程（等待 flow cookie → ddddocr 识别验证码 → 提交表单由页面 JS 加密凭据），建立属于监控平台自己指纹的会话后按标准接口拉取。浏览器完整重登需要配置登录账号和密码，Bearer Token 可留空。OCR 依赖容器内 `/opt/ocr-venv` 的 ddddocr，本地开发用项目根目录 `.venv-ocr`（或 `OCR_PYTHON` 环境变量指定）。

刷新成功后会同时保存：

- 原始接口返回：写入 `sub2api_snapshots.raw_payload`
- 页面展示快照：写入 `sub2api_snapshots.normalized_snapshot`

`new-api` 使用独立表 `new_api_snapshots`，避免和 sub2api 字段混在一起；对应 adapter 后续补齐后也按同样方式保存 raw JSON。

`new-api` 的站点字段分为"登录账号"（`username`，正常填邮箱）和"用户 ID"（`new_api_user_id`，数字 ID）：数据拉取用用户 ID 作为 `new-api-user` 请求头，会话 Cookie 过期后则用登录账号 + 密码自动调用 `/api/user/login` 重登（登录名失败时再用最近一次快照 profile 里的用户名兜底），成功后把新会话 Cookie 写回 `upstream_sites.auth_token` 并重试本次拉取。站点开了 Turnstile 时密码登录可能无法自动通过，仍需手动更新 Cookie。

登录账号和密码继续明文保存，但如果站点开启 Turnstile，账号密码登录接口可能无法自动通过校验。此时需要在站点配置里填 Bearer Token。

new-api 和 other 类型目前只保存配置；手动刷新接口会返回不支持类型错误，后续需要补对应 adapter。

## API

```text
GET  /api/health
GET  /api/sites
POST /api/sites
GET  /api/sites/:id/snapshot
POST /api/sites/:id/snapshot/refresh
GET  /api/sites/:id/group-model-settings
PUT  /api/sites/:id/group-model-settings
GET  /api/sites/:id/models
POST /api/sites/:id/group-model-test
GET  /api/group-filter-presets
PUT  /api/group-filter-presets
DELETE  /api/group-filter-presets
```

`GET /api/sites/:id/snapshot` 只读数据库最新快照，不访问上游。`POST /api/sites/:id/snapshot/refresh` 才访问上游并写入快照表。

分组筛选预设独立存放在 `group_filter_presets` 表，按名粒度读写：`PUT /api/group-filter-presets` 请求体带 `name` 和各筛选字段，改名时额外带 `originalName`（同一个事务里删旧名、插新名）；`DELETE /api/group-filter-presets` 请求体带 `name`。预设名可能含任意字符，一律放请求体不进 URL 路径。日常筛选/排序只覆写 `ui-preferences/group-management` blob，不再触碰预设列表。

`POST /api/sites` 请求体：

```json
{
  "name": "示例站点",
  "url": "https://relay.example.com",
  "type": "new-api",
  "username": "admin",
  "password": "plain-password",
  "auth_token": "plain-bearer-token",
  "refresh_token": "rt_refresh-token-for-sub2api",
  "usd_to_cny_rate": 7
}
```

`usd_to_cny_rate` 表示 `1 USD = X CNY`，默认值为 `1`。当上游余额币种为 USD 时，余额和分组倍率按该值换算成 CNY 展示。new-api 站点自身声明为 CNY/CUSTOM 时，同步会先按上游返回的 `usd_exchange_rate` / `custom_currency_exchange_rate` 转成对应展示币种，因此不会再套用本地 `usd_to_cny_rate`，避免二次换算。

`refresh_token` 主要用于 Lucis/sub2api 站点。Bearer 过期并返回 401 时，后端会调用 `/api/v1/auth/refresh` 换取新的 Bearer 和 refresh token，随后回写 `upstream_sites` 并重试本次拉取。

模型列表和模型测速使用已保存快照里的分组 API key token。模型列表按 cc-switch 的候选规则尝试 `/v1/models`、版本路径下的 `/models`，以及常见兼容子路径剥离后的 `/v1/models` / `/models`；测速会优先对分组保存的 `testModel` 发起真实流式模型请求，未配置时回退到展示用 `selectedModel`。

## 已有 OpenAI 账号授权入池

入口：**账号入池**（`/oauth-accounts`）；进度与历史在左侧独立 **入池任务**（`/oauth-tasks`）。在“我的站点”配置 HTTPS Sub2API 和管理员 API Key 后，粘贴账号资料、选择代理、分组及导入参数提交。

- 支持多行粘贴，每行一个 `账号----密码----2FA密钥` 或 `账号|密码|2FA密钥`；也支持全角 `｜`。横线分隔要求两段等长且至少两个连续横线；密码首尾带横线请改用竖线格式。每批最多30个账号，解析后仅显示成功/失败数量，原文保留在输入框供核对；提交、离页、销毁时清空秘密，不写入浏览器存储。
- 导入参数支持模型、并发、负载、优先级、倍率、指纹、WebSocket、订阅类型、到期自动暂停、分组和调度。默认并发50、优先级1、倍率1、指纹仅设备、账号保护关闭；每次新导入将选项保存为该目标站点的下次默认值，不保存代理偏好。关闭调度/保护要求目标具备首次创建原子设置能力，不以创建后再修改代替。
- 登录、换码、创建账号使用同一代理；支持直连或 HTTP/HTTPS/SOCKS5/SOCKS5H（含认证），不静默换为直连。优先使用完全匹配的有效远端代理或映射，不覆盖不匹配的已有代理。
- 允许显式重复导入已存在的邮箱或 workspace/user 身份，每个新任务新建账号，不覆盖原账号。同 requestId 重试仍幂等；同邮箱或同席位正在执行时互斥。
- 从此版本接收的新任务起，密码、TOTP 和代理快照使用独立密钥 AES-256-GCM 加密入库，与任务同事务；公开接口/日志不返回秘密或密文。旧任务没有保存凭据，仅支持查看/对账，不补录、不重跑。OAuth token 只按目的写入目标 Sub2API，不进入本地任务凭据表。
- **必须配置 `OAUTH_ONBOARDING_CREDENTIAL_KEY` 为独立、严格32字节的Base64密钥**。请通过安全秘密管理保存，与数据库分开备份，不提交Git或输出日志。缺失/格式不正确时仍可查看历史，但新接收/重跑返回503；不得在每次启动时生成新密钥。直接换密钥会使已有密文不可解密，此版本不提供在线轮换。
- 入池任务按批次分页，可展开账号，按邮箱字面子串搜索；展示账号名称、邮箱、入池结果及创建/开始/结束时间。新任务终态后可整批或单账号显式重跑：读取当时凭据和参数，创建新批次/新任务/新远端账号，保留来源关系和原记录，不依赖原账号是否仍在Sub2。
- 重跑时使用当前管理授权，但目标URL、代理定义或分组已失效时拒绝，不静默换用现配置。重跑不改变上次导入偏好。重启不会自动恢复或重跑历史任务；中断的新任务可在确认终止后显式重跑。
- 首次登录走 HTTP 邮箱/密码/TOTP；邮箱验证码、手机验证、无法唯一判定的 workspace、访问挑战或未知协议状态会明确停止，不会报成功或继续推送。离线测试不能保证任意账号都能仅凭三项资料登录。
- 推送结果不明时可先只读对账；普通再次导入仍被阻止。新任务允许用户确认“再次入池”后显式重跑，原uncertain记录不被覆盖，可能再次产生远端账号。丢失重跑响应时只能用原requestId查询/重试，不能换ID盲发。
- 本功能沿用监控后台外层访问控制，仅向受信管理员开放；`/api/oauth-onboarding/*` 全部响应 `Cache-Control: no-store`，写请求要求同源JSON。

源码适配关系和上游使用声明见 `THIRD_PARTY_NOTICES.md`。离线测试覆盖流程和接口合同，但不能保证外部网络环境或任意账号的登录结果。

本地 HTTP worker 需要 Python 3.10+、支持 `--permission` 的 Node 22.13+（推荐 Node 24）和独立依赖环境：

```bash
python3 -m venv .venv-oauth
.venv-oauth/bin/pip install -r tools/oauth_login/requirements.txt
export OAUTH_LOGIN_PYTHON="$PWD/.venv-oauth/bin/python"
npm start
```

验证 HTTP 登录协议与 IPC：`OAUTH_LOGIN_PYTHON="$PWD/.venv-oauth/bin/python" node --test tests/oauth-login.test.mjs tests/oauth-http-flow.test.mjs tests/oauth-python.test.mjs`。测试使用本地模拟端点，不提交真实账号。

Docker 镜像安装专用 `/opt/oauth-login-venv`，不与 OCR 依赖混用。HTTP传输固定同一 curl_cffi 配置；SDK辅助计算在无账号凭据、无环境秘密、禁止文件/网络/子进程访问的受限Node进程执行，只有父HTTP会话能访问限定上游端点。取消/超时回收整组worker进程。

### 子路径部署注意

与其他独立页面一样，在 `/upstream/` 反向代理挂载时，发布配置需要同步加入
`/upstream/oauth-accounts` 和 `/upstream/oauth-tasks` 到 SPA 页面路由的改写，并确保 `/upstream/src/oauth-onboarding.css`
及 `/upstream/api/oauth-onboarding/*` 按既有规则转发。本地开发不需要修改代理配置。

## 静态资源边界

HTTP 服务只发布 `src/public-assets.mjs` 中明确列出的前端资源及页面路由。添加新的浏览器模块或样式时同步更新该列表；配置、数据库、Git 元数据、服务端源码和内部工作记录不作为静态文件提供。
