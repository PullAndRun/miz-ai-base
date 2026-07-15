import dayjs from "dayjs";
import type { MizPlugin } from "@/plugins";
import { canManageGroupFeature } from "@/group-permissions";
import { parseStrictLocalDateTime } from "@/local-date-time";
import { getVtbRepository } from "@/vtb";

const MAX_SCHEDULE_CONTENT_LENGTH = 300;

const schedulePlugin: MizPlugin = {
  name: "schedule",
  commands: ["schedule", "日程"],
  description: [
    "把群里的重要安排放进日程表，临近开始时会来提醒大家。",
    "添加日程：miz schedule add 2030-08-01 20:00 活动内容",
    "查看日程：miz schedule list",
    "取消日程：miz schedule cancel 编号",
    "添加或取消日程需要管理员或日程白名单权限。",
  ].join("\n"),
  async handle({ command, config, logger, message, reply }) {
    if (message.groupId === undefined || message.userId === undefined) {
      await reply("日程表跟着群聊走，回到对应群里创建或查看吧。");
      return;
    }

    const action = parseScheduleAction(command.args, Date.now());
    if (!action) {
      await reply("📅 群日程可以这样安排：\n添加：miz schedule add 2030-08-01 20:00 活动内容\n查看：miz schedule list\n取消：miz schedule cancel 编号\n时间请写成 YYYY-MM-DD HH:mm，并且要晚于现在。");
      return;
    }

    try {
      const repository = await getVtbRepository(config);
      if (action.type === "list") {
        const events = await repository.listUpcomingScheduleEvents(message.groupId);
        await reply(
          events.length === 0
            ? "📅 日程表现在很清爽，接下来还没有安排。"
            : [
                `📅 接下来有 ${events.length} 项安排：`,
                ...events.map((event) => `#${event.displayId} · ⏰ ${dayjs(event.eventAt).format("M月D日 HH:mm")} · ${event.content}`),
              ].join("\n"),
        );
        return;
      }

      if (!canManageGroupFeature(message.raw, message.userId, config.schedule.manageWhitelistUserIds)) {
        await reply("翻日程表可以直接用；添加或取消安排需要群主、群管理员或日程白名单权限。");
        return;
      }

      if (action.type === "cancel") {
        const result = await repository.cancelUpcomingScheduleEvent(action.id, message.groupId);
        await reply(result.count === 1 ? `日程 #${action.id} 已从安排里划掉。` : `没找到还没开始的日程 #${action.id}。发 miz schedule list 看看当前安排吧。`);
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
      await reply(`📅 新日程排好啦 · #${event.displayId}\n\n「${action.content}」\n⏰ ${dayjs(action.eventAt).format("YYYY年MM月DD日 HH:mm")}\n\n临近开始时会来提醒大家。`);
    } catch (error) {
      logger.error("plugin", "schedule command failed", error);
      await reply("日程刚才没能排进去，稍后再试一次吧。");
    }
  },
};

export default schedulePlugin;

export const parseScheduleAction = (args: string, nowMs: number) => {
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

  const eventAt = parseStrictLocalDateTime(add[1], add[2]);
  const content = add[3].trim();
  if (
    !eventAt ||
    eventAt.getTime() <= nowMs ||
    !content ||
    content.length > MAX_SCHEDULE_CONTENT_LENGTH
  ) {
    return undefined;
  }

  return { type: "add" as const, eventAt, content };
};
