# miz

基于 Bun、TypeScript、NapLink 与 NapCat 的插件化 QQ 机器人。

miz 面向群聊协作和内容订阅场景，内置提醒、日程、活动报名、群待办、群问答、B 站主播订阅、财经新闻、每日壁纸、视频搬运、二维码、FF14 市场查询等功能。需要持久化的数据通过 Prisma 保存到 PostgreSQL，定时任务在重复触发时会自动避免并发执行。

## 功能概览

| 分类 | 功能 |
| --- | --- |
| 群聊协作 | 单次或循环提醒、群日程、活动报名、群待办、群问答、全群广播 |
| 内容订阅 | B 站主播开播、下播与动态推送，财经新闻推送，每日 Bing 壁纸 |
| 实用工具 | 视频下载与 QQ 兼容转码、二维码生成与识别、FF14 国服市场查询与低价提醒 |
| 娱乐功能 | 占卜、米哈游笑话图、文字和图片复读 |
| 运行能力 | 插件自动发现、TOML 分层配置、配置热重载、请求限流与缓存、优雅停机 |

## 技术栈

- [Bun](https://bun.sh/)：运行时、包管理与测试。
- TypeScript：机器人、插件和脚本的实现语言。
- [NapLink](https://www.npmjs.com/package/@naplink/naplink)：连接 NapCat OneBot WebSocket 网关。
- PostgreSQL + Prisma：保存订阅状态、提醒、日程、活动、FAQ、待办和消息投递记录。
- yt-dlp + FFmpeg：视频下载、合并和 H.264/AAC 转码。

## 快速开始

### 前置条件

- Bun
- 已启用 OneBot WebSocket 的 NapCat
- PostgreSQL
- 视频功能需要 `yt-dlp` 和 `ffmpeg`

建议先确认 NapCat WebSocket、访问令牌和 PostgreSQL 均可从 miz 的运行环境访问。

### 1. 获取项目并安装依赖

```bash
git clone https://github.com/PullAndRun/miz-ai-base.git miz
cd miz
bun install
```

### 2. 创建配置

最小可运行配置只需要网关和 PostgreSQL。创建 `config/app.toml`：

```toml
[miz.gateway]
url = "ws://127.0.0.1:3000"
accessToken = "replace-with-your-token"

[miz.postgresql]
url = "http://127.0.0.1:5432"
database = "miz"
username = "postgres"
password = "replace-with-your-password"
```

完整字段可参考 [`config/example/app.toml`](config/example/app.toml)。示例中的空字符串和 `0` 是待填写占位值；复制完整示例后，请填写需要的字段，并删除不使用的可选占位项，否则配置校验可能失败。

FF14 低价提醒和 VTB 群订阅分别参考：

- [`config/example/ff14.toml`](config/example/ff14.toml) → `config/ff14.toml`
- [`config/example/vtb.toml`](config/example/vtb.toml) → `config/vtb.toml`

这些本地配置均已加入 `.gitignore`，不要提交访问令牌、数据库密码、Cookie 等敏感信息。

### 3. 准备视频工具（可选）

如果启用视频功能，将工具放到以下默认位置，或在 `[miz.video]` 中改为实际路径：

| 系统 | yt-dlp | FFmpeg |
| --- | --- | --- |
| Windows | `tools/yt-dlp.exe` | `tools/ffmpeg.exe` |
| Linux / Docker | `tools/yt-dlp` | `tools/ffmpeg` |

Linux 下需要为两个文件添加执行权限：

```bash
chmod +x tools/yt-dlp tools/ffmpeg
```

### 4. 启动

```bash
bun run start
```

启动脚本会依次生成 Prisma Client、执行已有数据库迁移，然后连接 NapCat 并加载插件与定时任务。

开发时可以使用监听模式：

```bash
bun run dev
```

## 配置说明

### 配置文件与覆盖顺序

普通模式按以下顺序合并配置，后面的文件覆盖前面的同名字段：

```text
config/app.toml
  → config/ff14.toml
  → config/vtb.toml
  → config/app.local.toml
```

Docker 模式最后再合并：

```text
→ config/app.docker.toml
```

对象字段会递归合并，数组会整体替换。`ff14.toml`、`vtb.toml` 和 `app.local.toml` 都是可选文件；`app.toml` 始终必需。

运行期间修改 `config` 目录中的 TOML 文件，会重新加载插件和定时任务配置。如果修改了网关地址、NapLink 连接参数等连接级配置，建议重启进程以确保完全生效。

### 主要配置段

| 配置段 | 作用 |
| --- | --- |
| `[miz.gateway]` | NapCat OneBot WebSocket 地址和访问令牌。 |
| `[miz.postgresql]` | PostgreSQL 主机地址、数据库名、用户名和密码。 |
| `[miz.naplink]` | 日志级别、连接超时、心跳、API 超时、重试和重连次数。 |
| `[miz.plugins]` | 命令前缀和插件目录，默认分别为 `miz`、`plugins`。 |
| `[miz.network]` | 供视频和 VTB 请求使用的代理地址 `proxyUrl`。 |
| `[miz.bilibili]` | B 站 Cookie，供视频下载和 VTB 接口请求复用。 |
| `[miz.reminder]` | 提醒轮询、批量处理数量和管理白名单。 |
| `[miz.schedule]` | 群日程轮询、提前提醒分钟数和管理白名单。 |
| `[miz.activity]` | 活动提醒、人数上限、批量处理数量和管理白名单。 |
| `[miz.faq]` | 每群词条上限、答案长度上限和管理白名单。 |
| `[miz.todo]` | 群待办提醒、批量处理数量和管理白名单。 |
| `[miz.broadcast]` | 可以向机器人所在全部群发送广播的用户白名单。 |
| `[miz.video]` | 视频开关、白名单、下载目录、NapCat 媒体目录和工具路径。 |
| `[miz.news]` | 财经新闻接口、目标群和定时表达式。 |
| `[miz.wallpaper]` | Bing 壁纸接口、图片地址和定时表达式。 |
| `[miz.ff14]` | 市场接口、返回条数、低价提醒开关和定时表达式。 |
| `[miz.vtb]` | B 站接口、轮询策略、缓存、同步白名单和订阅管理白名单。 |

未填写对应接口地址时，依赖该接口的命令会提示尚未配置，相关定时任务会自动停用并记录原因。

### VTB 订阅

每个群使用一个 `[[miz.vtb.subscriptions]]` 配置块：

```toml
[[miz.vtb.subscriptions]]
groupId = "123456789"
streamers = ["主播甲", "主播乙"]
atAllStreamers = ["主播甲"]
```

- `streamers` 中的主播会推送开播、下播和最新动态。
- `atAllStreamers` 只影响开播通知。
- 只有机器人是群主或管理员，且该 QQ 账号在群内仍有可用的 `@全体成员` 次数时才会真正 `@全体`；否则发送普通通知。
- 动态和下播通知不会 `@全体`。
- 群管理员或订阅白名单成员可以通过命令直接维护 `config/vtb.toml` 中的订阅。

## Docker 部署

项目自带 [`docker-compose.yml`](docker-compose.yml)，使用 `oven/bun:latest`，将项目根目录挂载到容器的 `/app`，并在容器启动时安装生产依赖、执行数据库迁移和启动机器人。

Compose 使用名为 `diana` 的外部网络。首次部署时，如果该网络不存在，需要先创建：

```bash
docker network create diana
docker compose up -d
```

如使用其他网络名称，请同步修改 Compose。NapCat、PostgreSQL、代理或 RSSHub 等依赖服务也需要加入同一网络，或者在 `config/app.docker.toml` 中填写容器能够访问的地址。

首次执行 `bun run start:docker` 时，会自动创建最小的 `config/app.docker.toml`：

- NapCat：`ws://napcat-miz:3000`
- PostgreSQL：`http://postgresql:5432`
- 代理：`http://clash:7890`
- VTB 动态 RSSHub：`http://rsshub:1200/bilibili/user/dynamic/`

这些名称只是默认容器名，请按实际环境修改。文件创建后不会被后续启动覆盖。

Docker 模式发送视频时，miz 将视频写入项目的 `temp` 目录，并把 `napcatMediaDirectory` 下的文件 URL 交给 NapCat。NapCat 容器必须把同一个宿主机 `temp` 目录挂载为该路径，例如：

```yaml
services:
  napcat:
    volumes:
      - ./temp:/app/media
```

对应配置：

```toml
[miz.video]
napcatMediaDirectory = "/app/media"
```

## 命令

默认命令前缀为 `miz`，可以通过 `[miz.plugins].commandPrefix` 修改。发送 `miz help` 或 `miz 帮助` 可以查看机器人实际加载的命令。

| 命令 | 说明与权限 |
| --- | --- |
| `miz help` | 显示已加载插件和命令说明。 |
| `miz 占卜 [主题]` | 抽取今日签，可附带想问的事情；英文命令为 `fortune`。 |
| `miz news` | 查询当前会话尚未投递的财经快讯。 |
| `miz wallpaper` | 获取并发送当日 Bing 壁纸。 |
| `miz qrcode <文本>` | 将最多 1000 个字符生成二维码。 |
| `miz qrcode decode` | 与二维码图片放在同一条消息中，识别最大 10 MB 的图片。 |
| `miz video <URL>` | 下载并发送最长 10 分钟的视频；普通成员仅可使用 B 站链接，白名单成员可使用其他 yt-dlp 支持的站点。 |
| `miz remind 30m 内容` | 创建单次提醒；支持 `m`、`h`、`d`，最长 365 天。 |
| `miz remind every 1d 内容` | 创建循环提醒。使用 `@QQ号` 指定他人需要群管理或提醒白名单权限。 |
| `miz remind list/cancel/edit ...` | 查看、取消或编辑提醒；普通成员只能管理自己创建的提醒。 |
| `miz schedule add YYYY-MM-DD HH:mm 内容` | 创建群日程；需要群主、群管理员或日程白名单权限。 |
| `miz schedule list` | 查看本群即将开始的日程。 |
| `miz schedule cancel <编号>` | 取消群日程；需要日程管理权限。 |
| `miz activity create YYYY-MM-DD HH:mm 内容` | 发起活动报名；需要群管理或活动白名单权限。 |
| `miz activity list/join/leave ...` | 查看、参加或退出活动；参加和退出不需要管理权限。 |
| `miz activity cancel <编号>` | 取消活动；需要活动管理权限。 |
| `miz faq <关键词>` / `miz faq list` | 查询群问答或查看已收录关键词。 |
| `miz faq add/edit/delete ...` | 添加、修改或删除词条；需要群管理或 FAQ 白名单权限。 |
| `miz todo add [YYYY-MM-DD HH:mm] [@QQ号] 内容` | 添加群待办；指定其他负责人需要群管理或待办白名单权限。 |
| `miz todo list/done/cancel ...` | 查看、完成或取消待办；创建者、负责人和管理者拥有不同的处理权限。 |
| `miz vtb live <主播昵称>` | 查询主播当前直播状态。 |
| `miz vtb dynamic <主播昵称>` | 查询主播最新动态。 |
| `miz vtb list/subscribe/unsubscribe ...` | 查看或维护本群订阅；需要群管理员或订阅白名单权限。 |
| `miz vtb sync` | 同步主播昵称、MID 和直播间资料；仅同步白名单可用。 |
| `miz ff14 <分区> <道具名>` | 查询国服市场；分区简写为猫、猪、狗、鸟。 |
| `miz broadcast <内容>` | 向机器人所在全部群发送最多 1000 字的广播；仅广播白名单可用。 |
| `miz joke` | 随机发送 10 张不重复的米哈游笑话图。 |

多数英文命令同时提供中文别名，具体以 `miz help` 的输出为准。

复读不是命令：同一群连续第 3 次出现相同文本或图片时，机器人复读一次。可识别的命令消息不会参与复读计数。

## 定时任务

| 任务 | 默认计划 |
| --- | --- |
| 每日壁纸 | 每天 07:00，发送到机器人所在的全部群。 |
| 财经新闻 | 每 5 分钟检查配置群的新内容。 |
| 单次与循环提醒 | 每分钟检查，单批默认处理 20 条。 |
| 群日程 | 每分钟检查，默认提前 30 分钟提醒。 |
| 活动报名 | 每分钟检查，默认提前 30 分钟提醒报名成员。 |
| 群待办 | 每分钟检查，默认提前 30 分钟提醒负责人。 |
| VTB 直播 | 每 3 分钟批量检查直播状态。 |
| VTB 动态 | 分片轮转，默认约 15 分钟覆盖全部订阅主播。 |
| VTB 资料同步 | 默认每周日 00:00。 |
| FF14 低价提醒 | 默认每小时检查，实际目标由 `config/ff14.toml` 配置。 |
| yt-dlp 更新 | 默认每天 00:00。 |

同一个定时任务不会重叠执行：前一次还未结束时，下一次会跳过并写入日志。VTB 上游请求还会合并相同并发查询、限制请求间隔，并在遇到 429、412 或连续故障时暂时熔断，冷却后自动恢复。

## 插件开发

准备为 miz 添加插件时，请先阅读完整的 [插件开发指南](PLUGIN_DEVELOPMENT.md)。其中包含插件接口、命令解析、消息格式、权限、并发、配置、数据库、定时任务和测试约定。

运行时会递归扫描 `[miz.plugins].directory`，加载 `.ts`、`.js` 和 `.mjs` 文件。模块可以通过 `default`、`plugin` 或 `plugins` 导出一个或多个插件。

最小命令插件：

```ts
import type { MizPlugin } from "@/plugins";

const pingPlugin: MizPlugin = {
  name: "ping",
  commands: ["ping"],
  description: "检查机器人是否在线。\n用法：miz ping",
  async handle({ reply }) {
    await reply("pong");
  },
};

export default pingPlugin;
```

插件可以使用 `reply`、`replyForward`、网关实例、当前配置、日志器和已加载插件信息。没有命令但需要监听所有消息的插件，可以提供 `onMessage`，内置复读功能就是这种形式。

## 项目结构

```text
config/example/   配置模板
plugins/          可自动发现的命令与消息插件
prisma/           Prisma Schema 与数据库迁移
scripts/          启动和迁移脚本
src/              网关、配置、任务、仓储和业务实现
tests/            Bun 单元测试
tools/            本地 yt-dlp 与 FFmpeg（不提交到 Git）
temp/             临时媒体文件（不提交到 Git）
```

## 验证与维护

```bash
bun test
bun run typecheck
bun run prisma:generate
bun run prisma:migrate
bun audit
```

常用脚本：

| 脚本 | 作用 |
| --- | --- |
| `bun run start` | 普通模式启动，自动生成 Prisma Client 并执行迁移。 |
| `bun run start:docker` | Docker 模式启动并加载 `app.docker.toml`。 |
| `bun run dev` | 普通模式监听源文件变化。 |
| `bun run dev:docker` | Docker 配置下监听源文件变化。 |
| `bun run prisma:migrate` | 使用当前配置执行 `prisma migrate deploy`。 |
| `bun run prisma:push` | 将 Schema 直接推送到数据库，适合本地开发验证。 |

日志默认输出到控制台。外部接口调用失败时，优先检查接口地址、代理、B 站 Cookie、容器网络、PostgreSQL 和 NapCat 网关状态。

## 常见问题

### 配置启动时报校验错误

检查是否保留了完整示例中的空字符串或不合法的 `0` 占位值。只保留需要覆盖的可选字段，或者为其填写有效值。

### Docker 中视频下载成功但 QQ 无法读取

确认 miz 的项目 `temp` 目录与 NapCat 的 `napcatMediaDirectory` 指向同一份宿主机目录，并确认 NapCat 容器有读取权限。

### VTB、新闻、壁纸或 FF14 功能提示未配置

这些功能依赖外部接口。补全对应配置段中的 API 地址后保存 TOML；运行时会尝试热重载配置，也可以重启进程确认生效。

### 开播通知没有 `@全体成员`

确认主播已加入该群订阅的 `atAllStreamers`，机器人在群内具有群主或管理员身份，并且账号仍有可用的 `@全体成员` 次数。
