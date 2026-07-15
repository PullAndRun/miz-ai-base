import dayjs from "dayjs";
import type { MizPlugin } from "@/plugins";
import { canManageGroupFeature } from "@/group-permissions";
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
    "发起活动报名，群友可以自己参加或退出，开始前会提醒已经报名的人。",
    "发起活动：miz activity create 2030-08-01 20:00 活动内容",
    "查看活动：miz activity list",
    "参加活动：miz activity join 编号",
    "退出活动：miz activity leave 编号",
    "取消活动：miz activity cancel 编号",
    "发起和取消活动需要群管理或活动白名单权限。",
  ].join("\n"),
  async handle({ command, config, logger, message, reply }) {
    if (message.groupId === undefined || message.userId === undefined) {
      await reply("活动报名要放在对应群里操作，这样报名名单才不会串群。");
      return;
    }

    const action = parseActivityAction(command.args);
    if (!action) {
      await reply(createActivityUsage());
      return;
    }

    try {
      const repository = await getVtbRepository(config);
      if (action.type === "list") {
        const activities = await repository.listUpcomingActivities(message.groupId);
        await reply(activities.length === 0
          ? "最近还没有活动在报名。想约大家的话，可以直接发起一个。"
          : [
              `正在报名的活动有 ${activities.length} 个：`,
              ...activities.map((activity) =>
                `#${activity.displayId} · ${dayjs(activity.eventAt).format("YYYY年M月D日 HH:mm")} · ${activity.content} · ${activity._count.registrations}/${config.activity.maxParticipants} 人`),
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
          await reply(`报名成功，活动 #${action.id} 现在有 ${result.participantCount} 人。开始前会在群里叫你。`);
        } else if (result.status === "already_joined") {
          await reply(`你已经报名活动 #${action.id} 了，不用重复报名。`);
        } else if (result.status === "full") {
          await reply(`活动 #${action.id} 已经满员（${config.activity.maxParticipants} 人），这次先没能排进去。`);
        } else {
          await reply("没找到这个正在报名的活动。可以先发 miz activity list 核对编号。");
        }
        return;
      }

      if (action.type === "leave") {
        const result = await repository.leaveActivity(action.id, message.groupId, message.userId);
        await reply(result.status === "left"
          ? `已经退出活动 #${action.id}。`
          : result.status === "not_joined"
            ? `你还没有报名活动 #${action.id}，不需要退出。`
            : "没找到这个正在报名的活动。可以先发 miz activity list 核对编号。");
        return;
      }

      const canManage = canManageGroupFeature(
        message.raw,
        message.userId,
        config.activity.manageWhitelistUserIds,
      );
      if (!canManage) {
        await reply("报名和退出可以直接操作；发起或取消活动需要群管理或活动白名单权限。");
        return;
      }

      if (action.type === "cancel") {
        const result = await repository.cancelUpcomingActivity(action.id, message.groupId);
        await reply(result.count === 1
          ? `活动 #${action.id} 已取消。`
          : "没找到这个还没开始的活动。可以先发 miz activity list 核对编号。");
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
        `活动报名开好了 · #${activity.displayId}`,
        dayjs(action.eventAt).format("YYYY年M月D日 HH:mm"),
        action.content,
        `名额 ${config.activity.maxParticipants} 人，参加请发：miz activity join ${activity.displayId}`,
      ].join("\n"));
    } catch (error) {
      logger.error("plugin", "activity command failed", error);
      await reply("活动信息刚才没保存成功。稍后再试一次，原命令可以直接重发。");
    }
  },
};

export default activityPlugin;

export const parseActivityAction = (args: string): ActivityAction | undefined => {
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
  const eventAt = parseLocalDateTime(create[1], create[2]);
  const content = create[3].trim();
  if (!eventAt || eventAt <= new Date() || !content || content.length > MAX_ACTIVITY_CONTENT_LENGTH) {
    return undefined;
  }
  return { type: "create" as const, eventAt, content };
};

const parseLocalDateTime = (date: string, time: string) => {
  const value = new Date(`${date}T${time}:00`);
  if (
    Number.isNaN(value.getTime()) ||
    value.getFullYear() !== Number(date.slice(0, 4)) ||
    value.getMonth() + 1 !== Number(date.slice(5, 7)) ||
    value.getDate() !== Number(date.slice(8, 10)) ||
    value.getHours() !== Number(time.slice(0, 2)) ||
    value.getMinutes() !== Number(time.slice(3, 5))
  ) return undefined;
  return value;
};

const createActivityUsage = () => [
  "活动报名这样用：",
  "发起：miz activity create 2030-08-01 20:00 活动内容",
  "查看：miz activity list",
  "参加：miz activity join 编号",
  "退出：miz activity leave 编号",
  "取消：miz activity cancel 编号",
  "时间请写成 YYYY-MM-DD HH:mm，并且要晚于现在。",
].join("\n");
