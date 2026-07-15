import dayjs from "dayjs";
import type { MizPlugin } from "@/plugins";
import { getVtbRepository } from "@/vtb";

const MAX_SCHEDULE_CONTENT_LENGTH = 300;

const schedulePlugin: MizPlugin = {
  name: "schedule",
  commands: ["schedule", "日程"],
  description: [
    "把群里的活动安排记下来，开始前会在群里提醒。",
    "添加日程：miz schedule add 2030-08-01 20:00 活动内容",
    "查看日程：miz schedule list",
    "取消日程：miz schedule cancel 编号",
    "添加或取消日程需要管理员或日程白名单权限。",
  ].join("\n"),
  async handle({ command, config, logger, message, reply }) {
    if (message.groupId === undefined || message.userId === undefined) {
      await reply("群日程按群保存，请回到对应群里创建或查看。");
      return;
    }

    const action = parseScheduleAction(command.args);
    if (!action) {
      await reply("群日程支持这些操作：\n添加：miz schedule add 2030-08-01 20:00 活动内容\n查看：miz schedule list\n取消：miz schedule cancel 编号\n时间请写成 YYYY-MM-DD HH:mm，并且要晚于现在。");
      return;
    }

    try {
      const repository = await getVtbRepository(config);
      if (action.type === "list") {
        const events = await repository.listUpcomingScheduleEvents(message.groupId);
        await reply(
          events.length === 0
            ? "这个群接下来没有已安排的日程。"
            : [
                `接下来有 ${events.length} 项日程：`,
                ...events.map((event) => `#${event.displayId} · ${dayjs(event.eventAt).format("YYYY年MM月DD日 HH:mm")} · ${event.content}`),
              ].join("\n"),
        );
        return;
      }

      if (!isScheduleManager(message.raw, message.userId, config.schedule.manageWhitelistUserIds)) {
        await reply("查看日程可以直接用；添加或取消日程需要群主、群管理员或日程白名单权限。");
        return;
      }

      if (action.type === "cancel") {
        const result = await repository.cancelUpcomingScheduleEvent(action.id, message.groupId);
        await reply(result.count === 1 ? `日程 #${action.id} 已取消。` : `没找到待开始的日程 #${action.id}。先发 miz schedule list 看看编号吧。`);
        return;
      }

      const reminderMilliseconds = config.schedule.reminderMinutes * 60_000;
      const remindAt = new Date(action.eventAt.getTime() - reminderMilliseconds);
      const event = await repository.createScheduleEvent({
        groupId: message.groupId,
        creatorId: message.userId,
        content: action.content,
        eventAt: action.eventAt,
        remindAt: remindAt > new Date() ? remindAt : new Date(),
      });
      logger.info("plugin", "schedule event created", {
        displayId: event.displayId,
        groupId: message.groupId,
        creatorId: message.userId,
        eventAt: action.eventAt,
      });
      await reply(`日程记好了 · #${event.displayId}\n时间：${dayjs(action.eventAt).format("YYYY年MM月DD日 HH:mm")}\n安排：${action.content}\n开始前会在群里提醒。`);
    } catch (error) {
      logger.error("plugin", "schedule command failed", error);
      await reply("日程刚才没记上，稍后再试一次吧。");
    }
  },
};

export default schedulePlugin;

export const parseScheduleAction = (args: string) => {
  const normalized = args.trim();
  if (normalized === "list") {
    return { type: "list" as const };
  }
  const cancel = /^cancel\s+(\d+)$/.exec(normalized);
  if (cancel) {
    const id = Number(cancel[1]);
    return Number.isSafeInteger(id) && id > 0 ? { type: "cancel" as const, id } : undefined;
  }

  const add = /^add\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+(.+)$/.exec(normalized);
  if (!add) {
    return undefined;
  }

  const eventAt = new Date(`${add[1]}T${add[2]}:00`);
  const content = add[3].trim();
  if (
    Number.isNaN(eventAt.getTime()) ||
    eventAt <= new Date() ||
    eventAt.getFullYear() !== Number(add[1].slice(0, 4)) ||
    eventAt.getMonth() + 1 !== Number(add[1].slice(5, 7)) ||
    eventAt.getDate() !== Number(add[1].slice(8, 10)) ||
    eventAt.getHours() !== Number(add[2].slice(0, 2)) ||
    eventAt.getMinutes() !== Number(add[2].slice(3, 5)) ||
    !content ||
    content.length > MAX_SCHEDULE_CONTENT_LENGTH
  ) {
    return undefined;
  }

  return { type: "add" as const, eventAt, content };
};

const isScheduleManager = (
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
