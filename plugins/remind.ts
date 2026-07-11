import dayjs from "dayjs";
import type { MizPlugin, PluginContext } from "@/plugins";
import { getVtbRepository } from "@/vtb";

const MAX_REMINDER_CONTENT_LENGTH = 300;
const durationUnitsInMinutes = {
  m: 1,
  h: 60,
  d: 24 * 60,
} as const;
const MAX_REMINDER_MINUTES = 365 * durationUnitsInMinutes.d;

type ReminderContext = Pick<PluginContext, "config" | "message" | "reply">;
type ReminderSpec = {
  delayMinutes: number;
  repeatIntervalMinutes?: number;
  targetId?: string;
  content: string;
};

const remindPlugin: MizPlugin = {
  name: "remind",
  commands: ["remind", "提醒"],
  description: [
    "创建、查看和管理群提醒。",
    "创建一次提醒：miz remind 30m 喝水",
    "创建循环提醒：miz remind every 1d 喝水",
    "指定提醒对象：miz remind 30m @QQ号 内容",
    "查看提醒：miz remind list",
    "取消提醒：miz remind cancel 编号",
    "编辑提醒：miz remind edit 编号 2h 新内容",
  ].join("\n"),
  async handle({ command, config, logger, message, reply }) {
    if (message.groupId === undefined || message.userId === undefined) {
      await reply("提醒只能在群聊中创建，这样才能按时提醒到对应成员。");
      return;
    }

    const action = parseAction(command.args);
    try {
      if (action?.type === "list") {
        await listReminders({ config, message, reply });
        return;
      }
      if (action?.type === "cancel") {
        await cancelReminder({ config, message, reply }, action.id);
        return;
      }
      if (action?.type === "edit") {
        await editReminder({ config, message, reply }, action.id, action.spec);
        return;
      }

      const reminder = parseReminderSpec(command.args);
      if (!reminder) {
        await reply(createUsageMessage());
        return;
      }

      const canManage = isReminderManager(message.raw, message.userId, config.reminder.manageWhitelistUserIds);
      const targetId = reminder.targetId ?? String(message.userId);
      if (targetId !== String(message.userId) && !canManage) {
        await reply("指定其他成员需要群主、群管理员或提醒管理白名单权限。你仍可以为自己创建提醒。");
        return;
      }

      const remindAt = new Date(Date.now() + reminder.delayMinutes * 60_000);
      const repository = await getVtbRepository(config);
      const created = await repository.createReminder({
        groupId: message.groupId,
        creatorId: message.userId,
        targetId,
        content: reminder.content,
        remindAt,
        repeatIntervalMinutes: reminder.repeatIntervalMinutes,
      });
      logger.info("plugin", "reminder created", {
        id: created.id,
        groupId: message.groupId,
        creatorId: message.userId,
        targetId,
        remindAt,
        repeatIntervalMinutes: reminder.repeatIntervalMinutes,
      });
      await reply(`已记下提醒 #${created.id}\n${formatReminderSpec(reminder)}\n提醒内容：${reminder.content}`);
    } catch (error) {
      logger.error("plugin", "reminder command failed", error);
      await reply("提醒没有保存成功，请稍后再试。");
    }
  },
};

export default remindPlugin;

const listReminders = async ({ config, message, reply }: ReminderContext) => {
  const canManage = isReminderManager(message.raw, message.userId, config.reminder.manageWhitelistUserIds);
  const repository = await getVtbRepository(config);
  const reminders = await repository.listPendingReminders(
    message.groupId!,
    canManage ? undefined : message.userId,
  );
  if (reminders.length === 0) {
    await reply(canManage ? "本群目前没有待处理的提醒。" : "你在本群目前没有待处理的提醒。");
    return;
  }

  await reply([
    canManage ? `本群待处理提醒（${reminders.length} 条）：` : `你的待处理提醒（${reminders.length} 条）：`,
    ...reminders.map((reminder) => [
      `#${reminder.id}`,
      dayjs(reminder.remindAt).format("MM-DD HH:mm"),
      reminder.repeatIntervalMinutes ? `每 ${formatMinutes(reminder.repeatIntervalMinutes)}` : "一次",
      `@${reminder.targetId}`,
      reminder.content,
      ...(canManage ? [`创建者 ${reminder.creatorId}`] : []),
    ].join(" · ")),
  ].join("\n"));
};

const cancelReminder = async ({ config, message, reply }: ReminderContext, id: number) => {
  const repository = await getVtbRepository(config);
  const reminder = await repository.findPendingReminder(id, message.groupId!);
  if (!reminder) {
    await reply("没有找到这个待处理提醒编号。请先用 miz remind list 查看编号。");
    return;
  }

  const canManage = isReminderManager(message.raw, message.userId, config.reminder.manageWhitelistUserIds);
  if (String(reminder.creatorId) !== String(message.userId) && !canManage) {
    await reply("你只能取消自己创建的提醒；群主、群管理员和白名单成员可管理本群提醒。");
    return;
  }

  const result = await repository.cancelPendingReminder(id, message.groupId!);
  await reply(result.count === 1 ? `提醒 #${id} 已取消。` : "这个提醒已经处理完毕，无需重复取消。");
};

const editReminder = async ({ config, message, reply }: ReminderContext, id: number, spec: ReminderSpec) => {
  const repository = await getVtbRepository(config);
  const reminder = await repository.findPendingReminder(id, message.groupId!);
  if (!reminder) {
    await reply("没有找到这个待处理提醒编号。请先用 miz remind list 查看编号。");
    return;
  }

  const canManage = isReminderManager(message.raw, message.userId, config.reminder.manageWhitelistUserIds);
  if (String(reminder.creatorId) !== String(message.userId) && !canManage) {
    await reply("你只能编辑自己创建的提醒；群主、群管理员和白名单成员可管理本群提醒。");
    return;
  }

  const targetId = spec.targetId ?? reminder.targetId;
  if (targetId !== String(message.userId) && !canManage) {
    await reply("指定其他成员需要群主、群管理员或提醒管理白名单权限。");
    return;
  }

  const result = await repository.editPendingReminder({
    id,
    groupId: message.groupId!,
    targetId,
    content: spec.content,
    remindAt: new Date(Date.now() + spec.delayMinutes * 60_000),
    repeatIntervalMinutes: spec.repeatIntervalMinutes,
  });
  await reply(result.count === 1 ? `提醒 #${id} 已更新：\n${formatReminderSpec({ ...spec, targetId })}` : "这个提醒已经处理完毕，无法再编辑。");
};

const parseAction = (args: string) => {
  const normalized = args.trim();
  if (normalized === "list") {
    return { type: "list" as const };
  }
  const cancel = /^cancel\s+(\d+)$/.exec(normalized);
  if (cancel) {
    return { type: "cancel" as const, id: Number(cancel[1]) };
  }
  const edit = /^edit\s+(\d+)\s+(.+)$/.exec(normalized);
  const spec = edit ? parseReminderSpec(edit[2]) : undefined;
  return edit && spec ? { type: "edit" as const, id: Number(edit[1]), spec } : undefined;
};

const parseReminderSpec = (args: string): ReminderSpec | undefined => {
  const normalized = args.trim();
  const repeating = /^every\s+(\d+)\s*([mhdMHD])\s+(.+)$/.exec(normalized);
  const once = /^(\d+)\s*([mhdMHD])\s+(.+)$/.exec(normalized);
  const matched = repeating ?? once;
  if (!matched) {
    return undefined;
  }

  const amount = Number(matched[1]);
  const unit = matched[2].toLowerCase() as keyof typeof durationUnitsInMinutes;
  const delayMinutes = amount * durationUnitsInMinutes[unit];
  const target = /^@(\d+)\s+(.+)$/.exec(matched[3].trim());
  const content = (target?.[2] ?? matched[3]).trim();
  if (!Number.isSafeInteger(delayMinutes) || delayMinutes <= 0 || delayMinutes > MAX_REMINDER_MINUTES || !content || content.length > MAX_REMINDER_CONTENT_LENGTH) {
    return undefined;
  }

  return {
    delayMinutes,
    repeatIntervalMinutes: repeating ? delayMinutes : undefined,
    targetId: target?.[1],
    content,
  };
};

const isReminderManager = (
  raw: Record<string, unknown>,
  userId: string | number | undefined,
  whitelistUserIds: readonly (string | number)[],
) => isGroupAdministrator(raw) || (
  userId !== undefined && whitelistUserIds.some((id) => String(id) === String(userId))
);

const isGroupAdministrator = (raw: Record<string, unknown>) => {
  const sender = raw.sender;
  if (!sender || typeof sender !== "object") {
    return false;
  }

  const role = (sender as Record<string, unknown>).role;
  return role === "admin" || role === "owner";
};

const formatReminderSpec = (spec: ReminderSpec) =>
  `${spec.repeatIntervalMinutes ? "循环提醒" : "一次性提醒"}：${formatMinutes(spec.delayMinutes)}后${spec.repeatIntervalMinutes ? `，每 ${formatMinutes(spec.repeatIntervalMinutes)}` : ""}${spec.targetId ? `，提醒 @${spec.targetId}` : ""}`;

const formatMinutes = (minutes: number) => {
  if (minutes % durationUnitsInMinutes.d === 0) {
    return `${minutes / durationUnitsInMinutes.d} 天`;
  }
  if (minutes % durationUnitsInMinutes.h === 0) {
    return `${minutes / durationUnitsInMinutes.h} 小时`;
  }
  return `${minutes} 分钟`;
};

const createUsageMessage = () => [
  "创建一次提醒：miz remind 30m 提醒内容",
  "创建循环提醒：miz remind every 1d 提醒内容",
  "提醒指定成员：miz remind 30m @123456789 提醒内容",
  "修改提醒：miz remind edit 编号 2h 新内容",
  "查看或取消：miz remind list / miz remind cancel 编号",
].join("\n");
