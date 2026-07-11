# miz

基于 Bun、NapLink 与 NapCat 的 QQ 机器人。项目采用插件化命令，并提供新闻、每日壁纸、视频、VTB 订阅、FF14 市场、占卜、复读和米哈游笑话功能。

## 前置条件

- Bun
- NapCat / OneBot 网关
- PostgreSQL（VTB 功能使用 Prisma）
- `tools/yt-dlp`、`tools/yt-dlp.exe`
- `tools/ffmpeg`、`tools/ffmpeg.exe`

Linux/Docker 使用无扩展名的工具文件；Windows 使用 `.exe` 文件。

## 配置

复制 `config/example/app.toml` 为 `config/app.toml`，然后填写网关、数据库和接口地址。需要 FF14 价格提醒或 VTB 订阅时，分别复制 `config/example/ff14.toml` 与 `config/example/vtb.toml`。这些本地配置文件均不应提交到 Git。

常用配置段：

- `[miz.gateway]`：NapCat WebSocket 地址与访问令牌。
- `[miz.postgresql]`：数据库地址、数据库名、用户名和密码。
- `[miz.network]`：可供插件复用的代理地址 `proxyUrl`。
- `[miz.bilibili]`：B 站登录凭据 `cookie`，供 B 站视频和 VTB 功能复用。
- `[miz.plugins]`：命令前缀与插件目录，默认前缀为 `miz`。
- `[miz.video]`：下载目录、NapCat 媒体目录及不同系统的工具路径。
- `[miz.vtb]`：B 站用户、卡片、直播和动态接口，以及群订阅列表。
- `[miz.news]`、`[miz.wallpaper]`、`[miz.ff14]`：各功能的定时任务和接口配置。

除视频白名单、群列表和 VTB/FF14 订阅外，接口地址为空时对应定时任务会自动禁用并记录原因。

## 普通模式

安装依赖并执行数据库迁移：

```bash
bun install
bun run prisma:migrate
```

启动：

```bash
bun run start
```

开发模式：

```bash
bun run dev
```

普通模式读取 `config/app.toml`。视频会由 NapLink 直接传输给 NapCat；发送前会转为 QQ 兼容的 H.264/AAC MP4。

## Docker 模式

使用：

```bash
docker compose up -d
```

Compose 使用 Bun 容器 `bot-miz`、自动重启策略和外部 Docker 网络 `diana`。项目根目录映射到容器的 `/app`。

Docker 启动命令为：

```bash
bun run start:docker
```

Docker 模式会读取普通配置 `config/app.toml`，再将 `config/app.docker.toml` 的内容按层级覆盖合并。任意配置均可覆盖：表中仅指定的字段覆盖，数组则整体替换。

首次 Docker 启动会自动生成最小的 `app.docker.toml` 覆盖文件，其中默认包含网关、PostgreSQL、代理和 RSSHub 动态地址。之后可按需要修改该文件；它不会覆盖普通配置，也不会被后续启动覆盖。

若 Docker 中的视频需要由 NapCat 通过文件路径读取，两个容器必须能访问同一份视频目录：miz 的下载目录与 NapCat 的 `/app/media` 应映射到同一宿主机目录。

## 命令

默认命令前缀为 `miz`。

| 命令 | 说明 |
| --- | --- |
| `miz help` / `miz 帮助` | 显示可用命令。 |
| `miz 占卜 [主题]` / `miz fortune [主题]` | 占卜；可在后面附加主题。 |
| `miz news` | 查询财经新闻，使用合并转发。 |
| `miz wallpaper` | 获取并发送每日壁纸。 |
| `miz video <URL>` | 下载并发送小于 10 分钟的视频。普通用户仅支持 B 站链接，白名单用户可使用其他站点。 |
| `miz schedule add YYYY-MM-DD HH:mm 内容` | 创建群日程；仅群主、管理员或日程管理白名单可用。 |
| `miz schedule list` | 查看本群即将开始的日程。 |
| `miz schedule cancel <编号>` | 取消群日程；仅群主、管理员或日程管理白名单可用。 |
| `miz vtb live <主播名>` | 查询主播直播信息。 |
| `miz vtb dynamic <主播名>` | 查询主播最新动态。 |
| `miz ff14 <区域> <物品名>` | 查询 FF14 市场信息。 |
| `miz joke` | 随机选择 10 张不重复的米哈游笑话图片，以合并转发发送到当前群。 |

复读是内置功能，不是命令：同一群连续第 3 次出现相同文本或图片时，机器人复读一次。以命令前缀开头的消息不参与复读判定。

## 定时任务

- 每日壁纸：默认每天 07:00 向所有群发送。
- 新闻：默认每 5 分钟检查配置群的新财经新闻。
- VTB：默认每 3 分钟检查订阅主播的直播与动态。
- FF14：按配置的 Cron 表达式检查价格提醒。
- yt-dlp：默认每天检查更新。
- 群日程：默认每分钟检查，到活动前 30 分钟自动提醒一次；可在 `[miz.schedule]` 调整。

相同任务不会并发执行；前一次尚未结束时，下一次会跳过并记录日志。

## 验证与维护

```bash
bun run typecheck
bun run prisma:generate
bun run prisma:migrate
```

日志默认输出到控制台。遇到外部接口失败时，优先检查配置地址、代理、Cookie、容器网络连通性和 NapCat 网关状态。
