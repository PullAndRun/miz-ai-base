import dayjs from "dayjs";
import type { MizPlugin, PluginContext } from "@/plugins";
import { canManageGroupFeature } from "@/group-permissions";
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
    "把容易忘的事交给 miz，到时间会准时来敲你，也支持循环提醒。",
    "创建单次提醒：miz remind 30m 喝水",
    "创建循环提醒：miz remind every 1d 喝水",
    "指定提醒对象：miz remind 30m @QQ号 内容",
    "查看提醒：miz remind list",
    "取消提醒：miz remind cancel 编号",
    "编辑提醒：miz remind edit 编号 2h 新内容",
    "支持 m（分钟）、h（小时）、d（天），最长 365 天。",
    "提醒其他成员或管理他人创建的提醒，需要管理员或提醒白名单权限。",
  ].join("\n"),
  async handle({ command, config, logger, message, reply }) {
    if (message.groupId === undefined || message.userId === undefined) {
      await reply("提醒会跟着群聊保存，回到对应群里创建或管理吧。");
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

      const canManage = canManageGroupFeature(message.raw, message.userId, config.reminder.manageWhitelistUserIds);
      const targetId = reminder.targetId ?? String(message.userId);
      if (targetId !== String(message.userId) && !canManage) {
        await reply("给自己挂提醒可以直接用；想提醒其他群友，需要管理员或提醒白名单权限。");
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
      await reply(`⏰ 提醒挂好啦 · #${created.id}\n\n${formatReminderSpec(reminder)}\n📝 ${reminder.content}\n\n到时候准时来敲你。`);
    } catch (error) {
      logger.error("plugin", "reminder command failed", error);
      await reply("提醒刚才没挂稳，稍后再试一次吧。");
    }
  },
};

export default remindPlugin;

const listReminders = async ({ config, message, reply }: ReminderContext) => {
  const canManage = canManageGroupFeature(message.raw, message.userId, config.reminder.manageWhitelistUserIds);
  const repository = await getVtbRepository(config);
  const reminders = await repository.listPendingReminders(
    message.groupId!,
    canManage ? undefined : message.userId,
  );
  if (reminders.length === 0) {
    await reply(canManage ? "⏰ 这个群目前没有等待触发的提醒。" : "⏰ 你目前没有等待触发的提醒。");
    return;
  }

  await reply([
    canManage ? `⏰ 这个群挂着 ${reminders.length} 条提醒：` : `⏰ 你挂着 ${reminders.length} 条提醒：`,
    ...reminders.map((reminder) => [
      `#${reminder.id}`,
      dayjs(reminder.remindAt).format("YYYY年MM月DD日 HH:mm"),
      reminder.repeatIntervalMinutes ? `每 ${formatMinutes(reminder.repeatIntervalMinutes)}` : "单次",
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
    await reply(`没找到还在等待的提醒 #${id}。发 miz remind list 看看当前编号吧。`);
    return;
  }

  const canManage = canManageGroupFeature(message.raw, message.userId, config.reminder.manageWhitelistUserIds);
  if (String(reminder.creatorId) !== String(message.userId) && !canManage) {
    await reply("自己的提醒可以随时取下；管理别人创建的提醒需要管理员或提醒白名单权限。");
    return;
  }

  const result = await repository.cancelPendingReminder(id, message.groupId!);
  await reply(result.count === 1 ? `提醒 #${id} 已经取下，不会再来敲门啦。` : "这条提醒已经触发或取消，不用再处理啦。");
};

const editReminder = async ({ config, message, reply }: ReminderContext, id: number, spec: ReminderSpec) => {
  const repository = await getVtbRepository(config);
  const reminder = await repository.findPendingReminder(id, message.groupId!);
  if (!reminder) {
    await reply(`没找到还在等待的提醒 #${id}。发 miz remind list 看看当前编号吧。`);
    return;
  }

  const canManage = canManageGroupFeature(message.raw, message.userId, config.reminder.manageWhitelistUserIds);
  if (String(reminder.creatorId) !== String(message.userId) && !canManage) {
    await reply("自己的提醒可以随时调整；管理别人创建的提醒需要管理员或提醒白名单权限。");
    return;
  }

  const targetId = spec.targetId ?? reminder.targetId;
  if (targetId !== String(message.userId) && !canManage) {
    await reply("想把提醒转给其他群友，需要管理员或提醒白名单权限。");
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
  await reply(result.count === 1 ? `⏰ 提醒 #${id} 调整好啦\n${formatReminderSpec({ ...spec, targetId })}` : "这条提醒已经触发或取消，没法再调整啦。");
};

const parseAction = (args: string) => {
  const normalized = args.trim();
  if (normalized === "list") {
    return { type: "list" as const };
  }
  const cancel = /^cancel\s+(\d+)$/.exec(normalized);
  if (cancel) {
    const id = Number(cancel[1]);
    return Number.isSafeInteger(id) && id > 0 ? { type: "cancel" as const, id } : undefined;
  }
  const edit = /^edit\s+(\d+)\s+(.+)$/.exec(normalized);
  const spec = edit ? parseReminderSpec(edit[2]) : undefined;
  const id = edit ? Number(edit[1]) : Number.NaN;
  return edit && spec && Number.isSafeInteger(id) && id > 0
    ? { type: "edit" as const, id, spec }
    : undefined;
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

const formatReminderSpec = (spec: ReminderSpec) => [
  spec.repeatIntervalMinutes
    ? `🔁 ${formatMinutes(spec.delayMinutes)}后第一次，之后每 ${formatMinutes(spec.repeatIntervalMinutes)}一次`
    : `🔔 ${formatMinutes(spec.delayMinutes)}后提醒一次`,
  ...(spec.targetId ? [`👤 提醒 @${spec.targetId}`] : []),
].join("\n");

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
  "⏰ 提醒可以这样挂：",
  "单次提醒：miz remind 30m 提醒内容",
  "循环提醒：miz remind every 1d 提醒内容",
  "提醒别人：miz remind 30m @123456789 提醒内容",
  "修改提醒：miz remind edit 编号 2h 新内容",
  "查看或取消：miz remind list / miz remind cancel 编号",
  "时间单位支持 m（分钟）、h（小时）、d（天），最长 365 天。",
].join("\n");
