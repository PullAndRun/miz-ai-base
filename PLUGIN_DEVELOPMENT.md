# miz 插件开发指南

本文面向希望为 miz 新增命令、消息监听或相关后台能力的开发者。阅读前建议先完成项目安装，并能运行：

```bash
bun test
bun run typecheck
```

## 1. 插件系统能做什么

miz 的插件运行时负责：

- 递归扫描插件目录并加载模块。
- 解析命令前缀、命令名和参数。
- 为插件提供当前消息、回复方法、网关、配置和日志器。
- 将插件说明加入 `miz help`。
- 捕获插件抛出的未处理异常并写入日志。
- 配置重载或进程退出时，等待正在执行的插件处理器结束。

插件接口刻意保持轻量。目前没有独立的 `setup`、`start`、`stop` 生命周期钩子。普通命令和消息监听可以只修改 `plugins/`；需要数据库模型、定时任务或新配置段时，还要修改 `src/`、`prisma/` 和配置模板。

## 2. 创建第一个插件

在 `plugins/` 下创建 `hello.ts`：

```ts
import type { MizPlugin } from "@/plugins";

const helloPlugin: MizPlugin = {
  name: "hello",
  commands: ["hello", "你好"],
  description: [
    "向 miz 打个招呼。",
    "用法：miz hello [名字]",
  ].join("\n"),
  async handle({ command, reply }) {
    const name = command.args.trim();
    await reply(name ? `你好，${name}！` : "你好！");
  },
};

export default helloPlugin;
```

启动开发模式：

```bash
bun run dev
```

然后发送：

```text
miz hello
miz hello Diana
miz 你好
```

生产环境修改或新增插件后应重启机器人。TOML 配置可以热重载，但插件源码不会在普通 `bun run start` 中热更新。

## 3. 插件的加载规则

默认插件目录是 `plugins`，可以通过配置修改：

```toml
[miz.plugins]
commandPrefix = "miz"
directory = "plugins"
```

运行时会：

1. 递归扫描插件目录。
2. 加载 `.ts`、`.js`、`.mjs` 文件，忽略 `.d.ts`。
3. 按文件路径排序后依次加载。
4. 读取模块的 `default`、`plugin`、`plugins` 导出。
5. 校验插件结构并建立命令索引。

支持以下任意一种导出方式：

```ts
export default myPlugin;
```

```ts
export const plugin = myPlugin;
```

```ts
export const plugins = [pluginA, pluginB];
```

每种导出都可以是单个插件或插件数组。选择一种即可，不要通过多个导出重复暴露同一个插件，否则它会被重复加载。

如果两个插件注册了相同命令，先加载的插件生效，后面的重复命令会被忽略并记录警告。不要依赖文件排序解决冲突，应为命令选择唯一名称。

## 4. `MizPlugin` 接口

插件类型定义位于 [`src/plugins.ts`](src/plugins.ts)：

```ts
export type MizPlugin = {
  name: string;
  commands: readonly string[];
  description?: string;
  handle?(context: PluginContext): void | Promise<void>;
  onMessage?(context: PluginMessageContext): void | Promise<void>;
};
```

字段说明：

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `name` | 是 | 插件的稳定内部名称，不能为空。建议使用小写英文。 |
| `commands` | 是 | 命令名和别名。纯消息监听插件可以使用空数组。 |
| `description` | 否 | `miz help` 中显示的功能说明和用法。 |
| `handle` | 条件必需 | 命令处理器。注册命令时通常需要提供。 |
| `onMessage` | 条件必需 | 每条群聊或私聊消息都会调用的监听器。 |

插件必须至少提供 `handle` 或 `onMessage`。同一个插件可以同时提供两者。

如果希望帮助菜单显示更友好的中文标题，可以在 [`plugins/help.ts`](plugins/help.ts) 的 `pluginDisplayNames` 中为 `name` 添加映射；未添加时会直接显示插件内部名称。

## 5. 命令解析规则

命令由前缀、命令名和参数组成：

```text
<commandPrefix> <command> <args>
```

默认前缀是 `miz`。以下写法均可能被识别：

```text
miz help
mizhelp
miz 占卜 明天
miz占卜明天
```

具体规则：

- 前缀和命令之间的空格可省略。
- 英文命令后的参数需要空格，因此 `mizhelpful` 不会被当作 `help`。
- 非 ASCII 命令可以紧跟参数，例如 `miz占卜明天`。
- 多个命令名同时匹配时，使用最长的命令名。
- 命令比较区分大小写，插件需要自行决定是否将参数转为小写。
- 输入只有前缀或未知命令时，由运行时回复帮助提示。

`handle` 中的 `command` 结构：

```ts
type PluginCommand = {
  name: string; // 实际匹配到的命令或别名
  args: string; // 去掉命令名并 trim 后的参数
  raw: string;  // 去掉前缀后的完整命令文本
};
```

例如消息 `miz video https://example.com/a.mp4` 会得到：

```ts
{
  name: "video",
  args: "https://example.com/a.mp4",
  raw: "video https://example.com/a.mp4",
}
```

复杂命令应把解析写成独立纯函数并导出，以便单元测试：

```ts
type Action =
  | { type: "list" }
  | { type: "show"; id: number };

export const parseAction = (args: string): Action | undefined => {
  const normalized = args.trim();
  if (normalized === "list") {
    return { type: "list" };
  }

  const matched = /^show\s+(\d+)$/.exec(normalized);
  const id = matched ? Number(matched[1]) : Number.NaN;
  return Number.isSafeInteger(id) && id > 0
    ? { type: "show", id }
    : undefined;
};
```

不要使用宽松的日期解析。项目提供 [`parseStrictLocalDateTime`](src/local-date-time.ts)，可以拒绝 `2030-02-31`、`25:00` 等会被 JavaScript 自动归一化的无效时间。

## 6. 插件上下文

命令插件收到 `PluginContext`，消息监听插件收到不含 `command` 的 `PluginMessageContext`。

| 属性 | 说明 |
| --- | --- |
| `config` | 已完成默认值填充和分层合并的 `MizConfig`。 |
| `command` | 当前命令名、参数和原始命令文本，仅 `handle` 存在。 |
| `message` | 归一化后的 NapCat 消息。 |
| `reply` | 回复当前群或当前私聊，使用 NapLink 的正常重试策略。 |
| `replyWithoutRetry` | 回复当前会话但禁用 API 重试，可指定超时。 |
| `replyForward` | 向当前会话发送合并转发消息。 |
| `gateway` | 向指定群或用户发送消息，以及获取群列表。 |
| `logger` | 统一日志器。插件日志上下文应使用 `plugin`。 |
| `plugins` | 已加载命令插件的只读名称、命令和描述列表。 |
| `commandPrefix` | 当前命令前缀，不要在用户文案中硬编码 `miz`。 |

推荐使用解构，只取当前处理器需要的属性：

```ts
async handle({ command, config, logger, message, reply }) {
  // ...
}
```

### `message`

```ts
type IncomingMessage = {
  text: string;
  messageType?: string;
  messageId?: number | string;
  groupId?: number | string;
  userId?: number | string;
  raw: Record<string, unknown>;
};
```

- `text` 是消息中所有文本段拼接后的内容，图片等非文本段不会出现在这里。
- `groupId` 存在表示群消息；私聊通常只有 `userId`。
- ID 可能是字符串或数字，比较时统一使用 `String(id)`。
- `raw` 是原始 OneBot 事件，可用于读取 `sender.role`、CQ/消息段和 NapCat 扩展字段。
- `raw` 内的数据仍是外部输入。读取复杂结构时应进行类型判断或使用 Zod 校验，不要直接断言为可信类型。

只允许群聊使用的功能应尽早返回：

```ts
if (message.groupId === undefined || message.userId === undefined) {
  await reply("这个功能需要在群聊中使用。");
  return;
}
```

## 7. 发送消息

### 文本回复

```ts
await reply("处理完成");
```

`reply` 会自动判断当前消息来自群聊还是私聊。

### OneBot 消息段

```ts
await reply([
  { type: "at", data: { qq: message.userId } },
  { type: "text", data: { text: " 任务完成了。" } },
]);
```

发送图片：

```ts
await reply({
  type: "image",
  data: { file: `base64://${imageBuffer.toString("base64")}` },
});
```

发送视频等大媒体时，应参考 [`plugins/video.ts`](plugins/video.ts) 处理路径映射、超时和清理，尤其要区分普通模式与 Docker 模式。

### 合并转发

```ts
await replyForward(
  ["第一页", "第二页", [{ type: "text", data: { text: "第三页" } }]],
  {
    title: "查询结果",
    source: "miz example",
    summary: "共 3 条",
  },
);
```

`replyForward` 的每一项可以是字符串或 OneBot 消息段数组。

### 向指定目标发送

```ts
await gateway.sendGroupMessage(groupId, "群消息");
await gateway.sendPrivateMessage(userId, "私聊消息");
```

发送到多个群时不要无限并发：

```ts
import { settleWithConcurrency } from "@/concurrency";

const results = await settleWithConcurrency(
  groupIds,
  5,
  (groupId) => gateway.sendGroupMessage(groupId, "公告"),
);
```

### 何时使用 `replyWithoutRetry`

普通文本和幂等查询结果优先使用 `reply`。视频、文件或其他无法安全重复发送的内容，可以使用：

```ts
const payload = {
  type: "video",
  data: { file: videoFile },
};
await replyWithoutRetry(payload, { timeoutMs: 60_000 });
```

超时只表示客户端没有及时获得确认，不能证明消息一定未发送。不要在超时后立刻自动补发非幂等媒体，否则可能产生重复消息。

## 8. 权限控制

公共权限工具位于 [`src/group-permissions.ts`](src/group-permissions.ts)：

```ts
import {
  canManageGroupFeature,
  isGroupAdministrator,
  isWhitelistedUser,
} from "@/group-permissions";
```

群管理或功能白名单：

```ts
const allowed = canManageGroupFeature(
  message.raw,
  message.userId,
  config.example.manageWhitelistUserIds,
);
```

仅白名单：

```ts
const allowed = isWhitelistedUser(
  message.userId,
  config.example.whitelistUserIds,
);
```

`isGroupAdministrator` 通过 OneBot 事件的 `sender.role` 判断 `admin` 或 `owner`。私聊、缺少发送者信息或异常事件不会被视为群管理。

权限拒绝时应明确告诉用户：哪些操作可以直接使用，哪些操作需要群管理或白名单。不要只回复“无权限”。

## 9. 消息监听插件

不注册命令、只监听消息时，将 `commands` 设为空数组并提供 `onMessage`：

```ts
import type { MizPlugin } from "@/plugins";

const keywordPlugin: MizPlugin = {
  name: "keyword",
  commands: [],
  async onMessage({ message, reply }) {
    if (message.groupId === undefined) {
      return;
    }

    if (message.text.trim() === "晚安") {
      await reply("晚安，早点休息。");
    }
  },
};

export default keywordPlugin;
```

运行顺序如下：

```text
收到一条消息
  → 按插件加载顺序执行所有 onMessage
  → 解析并执行匹配命令的 handle
```

同一条消息的 `onMessage` 是顺序执行的，因此慢监听器会拖延后续监听器和命令响应。只有确实需要等待的工作才应 `await`；耗时外部请求应设置超时。

`onMessage` 也会看到命令消息。如果不希望处理命令，应使用 [`parseCommandText`](src/plugin-command.ts) 和当前插件命令列表排除，内置 [`plugins/repeat.ts`](plugins/repeat.ts) 可作为参考。

## 10. 并发与状态

不同消息可能同时执行。网关收到消息后不会等待上一条消息处理完才分发下一条，因此插件必须考虑：

- 同一用户快速重复发送命令。
- 同一群中多个成员同时修改数据。
- 外部接口的并发限制和速率限制。
- 消息发送成功但客户端超时。
- 配置重载发生在命令执行期间。

建议：

- 数据写入依赖数据库唯一约束或事务，不要只做“先查询再写入”。
- 批量请求使用 [`settleWithConcurrency`](src/concurrency.ts) 或 `startWithConcurrency`。
- 缓存必须有容量上限，优先使用 [`src/cache.ts`](src/cache.ts) 的有界缓存和过期缓存。
- 对相同上游请求做 in-flight Promise 合并，避免并发击穿。
- 不要在内存中永久保存群号、用户号或消息内容。
- 模块级状态在配置重载后可能继续存在，因为模块由运行时缓存；状态设计应可重复使用且有界。

项目采用函数式架构，测试会拒绝项目代码中的 `class` 声明和 `this.` 实例状态。使用纯函数、闭包、只读对象和显式状态转换。

## 11. 调用外部接口

优先复用 [`src/http.ts`](src/http.ts)：

```ts
import { fetchWithRetry, readResponseJson } from "@/http";

const response = await fetchWithRetry(apiUrl, {
  timeoutMs: 15_000,
  retryCount: 2,
  retryDelayMs: 1_000,
});
const payload = await readResponseJson(response, 1_000_000);
```

开发要求：

- 为请求设置合理超时。
- 限制响应体最大字节数，防止异常上游耗尽内存。
- 使用 Zod 或明确的类型保护校验 JSON。
- 只重试瞬时错误；非幂等请求默认不要重试。
- 尊重 `Retry-After` 和上游限流。
- 代理地址优先复用 `config.network.proxyUrl`。
- B 站登录信息优先复用 `config.bilibili.cookie`。
- 不要把 Cookie、令牌、完整授权头写进回复或日志。

## 12. 日志和错误处理

```ts
logger.info("plugin", "example query completed", {
  userId: message.userId,
  groupId: message.groupId,
});
```

日志级别：

- `debug`：详细诊断信息。
- `info`：正常启动、完成、投递等关键事件。
- `warn`：功能降级、上游部分异常、可恢复问题。
- `error`：命令失败、数据不一致或无法恢复的操作。

处理器外层虽然会捕获未处理异常，但只会写日志，不会自动回复用户。插件应捕获预期的网络、解析和发送错误，记录技术信息，再回复自然、可操作的提示：

```ts
try {
  const result = await querySomething();
  await reply(formatResult(result));
} catch (error) {
  logger.error("plugin", "example query failed", error);
  await reply("查询暂时没有成功，稍后再试一次吧。");
}
```

可以使用 [`summarizeError`](src/errors.ts) 记录精简错误，或使用 `serializeError` 保留堆栈。统一日志器会尝试隐藏常见的密码、Cookie 和令牌字段，但插件仍不应主动记录敏感值。

## 13. 添加插件配置

仓库内置插件的配置统一由 [`src/config.ts`](src/config.ts) 使用 Zod 校验并填充默认值。

添加新配置段通常需要：

1. 在 `rawMizConfigSchema` 中定义原始可选字段和约束。
2. 在 `mizConfigSchema.transform` 中填充安全默认值。
3. 为归一化后的配置补充类型。
4. 在 [`config/example/app.toml`](config/example/app.toml) 中添加示例。
5. 在 README 的配置表中补充说明。
6. 为默认值、边界值或合并行为添加测试。

示例：

```ts
// rawMizConfigSchema 内
example: z.object({
  enabled: z.boolean().optional(),
  apiUrl: z.string().trim().min(1).optional(),
  whitelistUserIds: z.array(targetIdSchema).optional(),
}).optional(),

// transform 返回值内
example: {
  enabled: config.example?.enabled ?? true,
  apiUrl: config.example?.apiUrl ?? "",
  whitelistUserIds: config.example?.whitelistUserIds ?? [],
},
```

配置文件按以下顺序覆盖：

```text
app.toml → ff14.toml → vtb.toml → app.local.toml → app.docker.toml
```

最后一项只在 Docker 模式加载。对象递归合并，数组整体替换。处理命令时不要修改 `config`，它是当前运行时的配置快照。

如果插件准备作为完全独立的外部插件分发，而不修改核心配置 Schema，可以自行读取单独配置文件并进行完整校验；这种配置不会自动进入 `MizConfig`，也不应假设会获得与内置配置相同的热重载行为。

## 14. 数据库与持久化

需要跨重启保存的数据应使用 PostgreSQL，不要使用无限增长的模块级 `Map` 或本地 JSON 文件。

仓库集成式插件通常需要：

1. 在 [`prisma/schema.prisma`](prisma/schema.prisma) 添加模型、约束和索引。
2. 在 `prisma/migrations/` 添加迁移。
3. 将数据库访问封装在 `src/` 的仓储函数中。
4. 让插件处理器调用业务或仓储函数，不在 `handle` 内拼接 SQL。
5. 测试重复请求、并发写入、唯一约束和失败重试。

执行：

```bash
bun run prisma:generate
bun run prisma:migrate
bun run typecheck
```

生产启动会自动执行 `prisma migrate deploy`。迁移必须保持向前兼容，不能依赖手工修改生产数据库。

数据库设计建议：

- 群内展示编号使用群 ID 与展示编号的联合唯一约束。
- 投递任务保存明确的已投递状态，发送失败时允许安全重试。
- 为轮询字段、时间字段和常用查询条件建立索引。
- 使用数据库时间和明确的时区转换，用户输入时间使用本地严格解析。

## 15. 定时任务

插件接口目前没有定时任务生命周期。需要定时能力时，不要在模块导入阶段直接创建永久 `setInterval`，因为配置重载和优雅停机无法可靠管理它。

仓库内置定时任务应：

1. 在 [`src/tasks.ts`](src/tasks.ts) 中创建启动函数。
2. 使用 [`createExclusiveCronTask`](src/scheduled-task.ts) 防止同一任务重叠执行。
3. 返回 `ScheduledTaskRuntime`，实现可等待的 `stop()`。
4. 在 `startScheduledTasks` 中注册。
5. 为禁用开关、空配置、无效 Cron 和初始化失败提供清晰日志。

结构示例：

```ts
const startExampleTask = (
  config: MizConfig,
  gateway: Gateway,
  logger: Logger,
): ScheduledTaskRuntime => {
  if (!config.example.enabled) {
    logger.info("plugin", "example task disabled: config switch is off");
    return { stop: async () => {} };
  }

  return createExclusiveCronTask({
    cronExpression: config.example.cron,
    logger,
    run: async () => {
      // 查询、投递、记录状态
    },
    skippedMessage: "example task skipped: previous run is still active",
    failureMessage: "example task failed",
    shutdownFailureMessage: "example task failed during shutdown",
  });
};
```

批量投递要限制并发，并将每个目标的投递结果分别记录，避免一个群失败导致其他群全部重发。

## 16. 测试

测试使用 `bun:test`，文件放在 `tests/`：

```ts
import { describe, expect, test } from "bun:test";
import { parseAction } from "../plugins/example";

describe("example command parsing", () => {
  test("parses valid actions", () => {
    expect(parseAction("list")).toEqual({ type: "list" });
    expect(parseAction("show 12")).toEqual({ type: "show", id: 12 });
  });

  test("rejects invalid IDs", () => {
    expect(parseAction("show 0")).toBeUndefined();
    expect(parseAction("show nope")).toBeUndefined();
  });
});
```

推荐至少覆盖：

- 正常命令与全部别名。
- 缺少参数、超长参数、非法 ID、非法日期。
- 群聊与私聊边界。
- 普通成员、群管理和白名单权限。
- 外部接口成功、超时、非 2xx、超大响应和非法 JSON。
- 并发调用、重复消息和部分投递失败。
- 帮助菜单是否包含新插件。
- 用户可见文案是否清晰自然。

运行单个测试文件：

```bash
bun test tests/example.test.ts
```

提交前运行：

```bash
bun test
bun run typecheck
```

如果改动了依赖：

```bash
bun audit
```

## 17. 用户文案约定

现有插件的回复风格是简洁、自然、直接告诉用户下一步。建议：

- 用一句话说明发生了什么。
- 参数错误时给出一条可复制的正确示例。
- 权限错误时说明需要哪种身份或白名单。
- 外部接口失败时不要暴露堆栈、URL 参数或内部结构。
- 不要把实际前缀写死，能使用 `commandPrefix` 时优先使用它。
- 重要编号使用 `#编号`，日期时间格式保持一致。
- 群功能明确说明数据属于当前群。
- 不要发送过长单条消息；大量结果使用合并转发或分页。

`description` 应包含功能用途和核心用法，因为它会直接进入帮助菜单：

```ts
description: [
  "查询示例数据。",
  `用法：miz example 关键词`,
].join("\n"),
```

如果插件需要支持自定义前缀，动态回复文案应使用 `commandPrefix`；静态 `description` 目前只能显示默认示例，因此保持与项目现有帮助风格一致即可。

## 18. 提交前检查清单

- [ ] 插件文件位于配置的插件目录，导出格式正确。
- [ ] `name` 稳定且唯一，命令和别名没有冲突。
- [ ] 至少提供 `handle` 或 `onMessage`。
- [ ] `description` 能让用户仅看帮助菜单就知道如何使用。
- [ ] 参数解析是严格、可测试的纯函数。
- [ ] 群聊、私聊和缺少用户 ID 的情况已处理。
- [ ] ID 比较统一转为字符串。
- [ ] 管理操作有群管理或白名单校验。
- [ ] 外部输入和 JSON 已校验，响应体有大小上限。
- [ ] 请求有超时、合理重试和并发限制。
- [ ] 缓存和模块级状态有容量或过期限制。
- [ ] 非幂等媒体发送没有自动重复发送风险。
- [ ] 用户收到清晰提示，日志中没有敏感信息。
- [ ] 新配置、迁移和定时任务已接入对应核心模块。
- [ ] 没有新增 `class` 或 `this.` 实例状态。
- [ ] `bun test` 和 `bun run typecheck` 均通过。

## 19. 推荐参考实现

| 需求 | 参考文件 |
| --- | --- |
| 最小命令插件 | [`plugins/wallpaper.ts`](plugins/wallpaper.ts) |
| 参数解析与随机内容 | [`plugins/divination.ts`](plugins/divination.ts) |
| 权限和数据库操作 | [`plugins/schedule.ts`](plugins/schedule.ts) |
| 多子命令与复杂权限 | [`plugins/remind.ts`](plugins/remind.ts) |
| 群列表批量发送 | [`plugins/broadcast.ts`](plugins/broadcast.ts) |
| 图片输入与输出 | [`plugins/qrcode.ts`](plugins/qrcode.ts) |
| 大媒体、无重试发送与清理 | [`plugins/video.ts`](plugins/video.ts) |
| 消息监听和有界状态 | [`plugins/repeat.ts`](plugins/repeat.ts) |
| 外部接口、缓存与风控 | [`src/vtb.ts`](src/vtb.ts) |
| 独占 Cron 与优雅停止 | [`src/tasks.ts`](src/tasks.ts) |
