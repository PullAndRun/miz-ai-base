import dayjs from "dayjs";
import type { MizPlugin } from "@/plugins";
import { canManageGroupFeature } from "@/group-permissions";
import { getVtbRepository } from "@/vtb";

const MAX_TODO_CONTENT_LENGTH = 300;
type TodoAction =
  | { type: "list" }
  | { type: "done"; id: number }
  | { type: "cancel"; id: number }
  | { type: "add"; dueAt?: Date; assigneeId?: string; content: string };

const todoPlugin: MizPlugin = {
  name: "todo",
  commands: ["todo", "待办"],
  description: [
    "把群里的事情记成待办，可以指定负责人和截止时间；快到期时会提醒。",
    "添加待办：miz todo add 待办内容",
    "添加截止时间：miz todo add 2030-08-01 20:00 待办内容",
    "指定负责人：miz todo add 2030-08-01 20:00 @QQ号 待办内容",
    "查看待办：miz todo list",
    "完成待办：miz todo done 编号",
    "取消待办：miz todo cancel 编号",
  ].join("\n"),
  async handle({ command, config, logger, message, reply }) {
    if (message.groupId === undefined || message.userId === undefined) {
      await reply("群待办按群保存，请回到对应群里创建或处理。");
      return;
    }

    const action = parseTodoAction(command.args);
    if (!action) {
      await reply(createTodoUsage());
      return;
    }

    try {
      const repository = await getVtbRepository(config);
      if (action.type === "list") {
        const todos = await repository.listPendingTodos(message.groupId);
        await reply(todos.length === 0
          ? "现在没有待办，事情都处理完了。"
          : [
              `还有 ${todos.length} 项待办：`,
              ...todos.map((todo) => [
                `#${todo.displayId}`,
                todo.dueAt ? `截止 ${dayjs(todo.dueAt).format("M月D日 HH:mm")}` : "不设截止时间",
                todo.assigneeId ? `负责人 @${todo.assigneeId}` : `创建者 @${todo.creatorId}`,
                todo.content,
              ].join(" · ")),
            ].join("\n"));
        return;
      }

      const canManage = canManageGroupFeature(message.raw, message.userId, config.todo.manageWhitelistUserIds);
      if (action.type === "done" || action.type === "cancel") {
        const todo = await repository.findPendingTodo(action.id, message.groupId);
        if (!todo) {
          await reply(`没找到未完成的待办 #${action.id}。先发 miz todo list 看看编号吧。`);
          return;
        }

        const isCreator = todo.creatorId === String(message.userId);
        const isAssignee = todo.assigneeId === String(message.userId);
        if (action.type === "done") {
          if (!isCreator && !isAssignee && !canManage) {
            await reply("这项待办可以由创建者、负责人或群管理标记完成。");
            return;
          }
          const result = await repository.completeTodo(action.id, message.groupId, message.userId);
          await reply(result.count === 1 ? `待办 #${action.id} 已完成，辛苦了。` : "这项待办已经处理过了，不用重复操作。");
          return;
        }

        if (!isCreator && !canManage) {
          await reply("取消待办需要创建者、群管理或待办白名单权限。");
          return;
        }
        const result = await repository.cancelTodo(action.id, message.groupId);
        await reply(result.count === 1 ? `待办 #${action.id} 已取消。` : "这项待办已经处理过了，不用重复操作。");
        return;
      }

      if (action.assigneeId && action.assigneeId !== String(message.userId) && !canManage) {
        await reply("你可以给自己记待办；指定其他负责人需要群管理或待办白名单权限。");
        return;
      }

      const remindAt = action.dueAt
        ? new Date(Math.max(Date.now(), action.dueAt.getTime() - config.todo.reminderMinutes * 60_000))
        : undefined;
      const todo = await repository.createTodo({
        groupId: message.groupId,
        creatorId: message.userId,
        assigneeId: action.assigneeId,
        content: action.content,
        dueAt: action.dueAt,
        remindAt,
      });
      logger.info("plugin", "todo created", {
        displayId: todo.displayId,
        groupId: message.groupId,
        creatorId: message.userId,
        assigneeId: action.assigneeId,
      });
      await reply([
        `待办记好了 · #${todo.displayId}`,
        `内容：${action.content}`,
        action.assigneeId ? `负责人：@${action.assigneeId}` : "负责人：你自己",
        action.dueAt
          ? `截止：${dayjs(action.dueAt).format("YYYY年M月D日 HH:mm")}，到期前会提醒`
          : "截止：未设置，完成后手动标记即可",
      ].join("\n"));
    } catch (error) {
      logger.error("plugin", "todo command failed", error);
      await reply("待办刚才没记上，稍后再试一次吧。");
    }
  },
};

export default todoPlugin;

export const parseTodoAction = (args: string): TodoAction | undefined => {
  const normalized = args.trim();
  if (normalized === "list") return { type: "list" as const };

  const numbered = /^(done|cancel)\s+(\d+)$/.exec(normalized);
  if (numbered) {
    const id = Number(numbered[2]);
    if (!Number.isSafeInteger(id) || id <= 0) return undefined;
    const type = numbered[1];
    return type === "done" || type === "cancel" ? { type, id } : undefined;
  }

  const add = /^add\s+([\s\S]+)$/.exec(normalized);
  if (!add) return undefined;
  let remaining = add[1].trim();
  let dueAt: Date | undefined;
  const dateTime = /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+([\s\S]+)$/.exec(remaining);
  if (dateTime) {
    dueAt = parseLocalDateTime(dateTime[1], dateTime[2]);
    if (!dueAt || dueAt <= new Date()) return undefined;
    remaining = dateTime[3].trim();
  }

  if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}$/.test(remaining) || /^@\d+$/.test(remaining)) {
    return undefined;
  }

  const target = /^@(\d+)\s+([\s\S]+)$/.exec(remaining);
  const assigneeId = target?.[1];
  const content = (target?.[2] ?? remaining).trim();
  if (!content || content.length > MAX_TODO_CONTENT_LENGTH) return undefined;
  return { type: "add" as const, dueAt, assigneeId, content };
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

const createTodoUsage = () => [
  "群待办支持这些操作：",
  "添加：miz todo add 待办内容",
  "带截止时间：miz todo add 2030-08-01 20:00 待办内容",
  "指定负责人：miz todo add 2030-08-01 20:00 @123456789 待办内容",
  "查看：miz todo list",
  "完成：miz todo done 编号",
  "取消：miz todo cancel 编号",
].join("\n");
