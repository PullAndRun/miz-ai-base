import dayjs from "dayjs";
import type { MizPlugin } from "@/plugins";
import { canManageGroupFeature } from "@/group-permissions";
import { parseStrictLocalDateTime } from "@/local-date-time";
import { getVtbRepository } from "@/vtb";

const MAX_ACTIVITY_CONTENT_LENGTH = 300;
type ActivityAction =
  | { type: "list" }
  | { type: "join"; id: number }
  | { type: "leave"; id: number }
  | { type: "cancel"; id: number }
  | { type: "create"; eventAt: Date; content: string };

const activityPlugin: MizPlugin = {
  name: "activity",
  commands: ["activity", "活动"],
  description: [
    "想和群友攒个局？发起活动报名，大家可以自由参加或退出，开场前还会收到提醒。",
    "发起活动：miz activity create 2030-08-01 20:00 活动内容",
    "查看活动：miz activity list",
    "参加活动：miz activity join 编号",
    "退出活动：miz activity leave 编号",
    "取消活动：miz activity cancel 编号",
    "发起和取消活动需要群管理或活动白名单权限。",
  ].join("\n"),
  async handle({ command, config, logger, message, reply }) {
    if (message.groupId === undefined || message.userId === undefined) {
      await reply("活动报名要在群里热闹起来，回到想办活动的群里操作吧。");
      return;
    }

    const action = parseActivityAction(command.args, Date.now());
    if (!action) {
      await reply(createActivityUsage());
      return;
    }

    try {
      const repository = await getVtbRepository(config);
      if (action.type === "list") {
        const activities = await repository.listUpcomingActivities(message.groupId);
        await reply(activities.length === 0
          ? "📅 现在还没有活动在招募。想约大家的话，就来开第一场吧！"
          : [
              `📅 现在有 ${activities.length} 个活动正在招募：`,
              ...activities.map((activity) =>
                `#${activity.displayId} · ⏰ ${dayjs(activity.eventAt).format("M月D日 HH:mm")} · ${activity.content} · 👥 ${activity._count.registrations}/${config.activity.maxParticipants}`),
            ].join("\n"));
        return;
      }

      if (action.type === "join") {
        const result = await repository.joinActivity(
          action.id,
          message.groupId,
          message.userId,
          config.activity.maxParticipants,
        );
        if (result.status === "joined") {
          await reply(`🎉 报名成功！你已经加入活动 #${action.id}\n现在共 ${result.participantCount} 人，开场前会来提醒你。`);
        } else if (result.status === "already_joined") {
          await reply(`你已经在活动 #${action.id} 的名单里啦，不用重复报名。`);
        } else if (result.status === "full") {
          await reply(`活动 #${action.id} 的 ${config.activity.maxParticipants} 个名额刚好坐满了，这次没赶上。`);
        } else {
          await reply(`没找到正在招募的活动 #${action.id}。发 miz activity list 看看当前名单吧。`);
        }
        return;
      }

      if (action.type === "leave") {
        const result = await repository.leaveActivity(action.id, message.groupId, message.userId);
        await reply(result.status === "left"
          ? `已经退出活动 #${action.id}，名额也空出来啦。`
          : result.status === "not_joined"
            ? `你还没加入活动 #${action.id}，不用退出。`
            : `没找到正在招募的活动 #${action.id}。发 miz activity list 看看当前名单吧。`);
        return;
      }

      const canManage = canManageGroupFeature(
        message.raw,
        message.userId,
        config.activity.manageWhitelistUserIds,
      );
      if (!canManage) {
        await reply("加入和退出可以自由操作；想发起或取消活动，需要群管理或活动白名单权限。");
        return;
      }

      if (action.type === "cancel") {
        const result = await repository.cancelUpcomingActivity(action.id, message.groupId);
        await reply(result.count === 1
          ? `活动 #${action.id} 已取消，招募也一起收队啦。`
          : `没找到还没开始的活动 #${action.id}。发 miz activity list 看看当前安排吧。`);
        return;
      }

      const reminderMilliseconds = config.activity.reminderMinutes * 60_000;
      const now = new Date();
      const remindAt = new Date(action.eventAt.getTime() - reminderMilliseconds);
      const activity = await repository.createActivity({
        groupId: message.groupId,
        creatorId: message.userId,
        content: action.content,
        eventAt: action.eventAt,
        remindAt: remindAt > now ? remindAt : now,
      });
      logger.info("plugin", "activity created", {
        displayId: activity.displayId,
        groupId: message.groupId,
        creatorId: message.userId,
      });
      await reply([
        `🎊 活动招募开始啦 · #${activity.displayId}`,
        "",
        `「${action.content}」`,
        `⏰ ${dayjs(action.eventAt).format("YYYY年M月D日 HH:mm")}`,
        `👥 名额 ${config.activity.maxParticipants} 人`,
        "",
        `想来就发：miz activity join ${activity.displayId}`,
      ].join("\n"));
    } catch (error) {
      logger.error("plugin", "activity command failed", error);
      await reply("活动刚才没能开张，稍后再发起一次吧。");
    }
  },
};

export default activityPlugin;

export const parseActivityAction = (args: string, nowMs: number): ActivityAction | undefined => {
  const normalized = args.trim();
  if (normalized === "list") return { type: "list" as const };

  const numbered = /^(join|leave|cancel)\s+(\d+)$/.exec(normalized);
  if (numbered) {
    const id = Number(numbered[2]);
    if (!Number.isSafeInteger(id) || id <= 0) return undefined;
    const type = numbered[1];
    if (type === "join" || type === "leave" || type === "cancel") return { type, id };
    return undefined;
  }

  const create = /^(?:create|add)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+(.+)$/.exec(normalized);
  if (!create) return undefined;
  const eventAt = parseStrictLocalDateTime(create[1], create[2]);
  const content = create[3].trim();
  if (!eventAt || eventAt.getTime() <= nowMs || !content || content.length > MAX_ACTIVITY_CONTENT_LENGTH) {
    return undefined;
  }
  return { type: "create" as const, eventAt, content };
};

const createActivityUsage = () => [
  "🎊 活动报名可以这样玩：",
  "发起：miz activity create 2030-08-01 20:00 活动内容",
  "查看：miz activity list",
  "参加：miz activity join 编号",
  "退出：miz activity leave 编号",
  "取消：miz activity cancel 编号",
  "时间请写成 YYYY-MM-DD HH:mm，并且要晚于现在。",
].join("\n");
