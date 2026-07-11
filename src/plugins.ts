import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { MizConfig } from "@/config";
import type { Gateway, IncomingMessage } from "@/gateway";
import type { Logger } from "@/logger";

export type PluginCommand = {
  name: string;
  args: string;
  raw: string;
};

export type ForwardMessageContent = string | readonly unknown[];

export type PluginInfo = {
  name: string;
  commands: readonly string[];
  description?: string;
};

export type PluginContext = {
  config: MizConfig;
  command: PluginCommand;
  message: IncomingMessage;
  reply(message: unknown): Promise<unknown>;
  replyForward(messages: readonly ForwardMessageContent[], options?: {
    title?: string;
    source?: string;
    summary?: string;
  }): Promise<unknown>;
  gateway: Pick<Gateway, "getGroupList" | "sendGroupMessage" | "sendPrivateMessage" | "sendForwardMessage">;
  logger: Logger;
  plugins: readonly PluginInfo[];
  commandPrefix: string;
};

export type PluginMessageContext = Omit<PluginContext, "command">;

export type MizPlugin = {
  name: string;
  commands: readonly string[];
  description?: string;
  handle?(context: PluginContext): void | Promise<void>;
  onMessage?(context: PluginMessageContext): void | Promise<void>;
};

export type PluginRuntime = {
  handleMessage(message: IncomingMessage): Promise<void>;
};

const nonEmptyStringSchema = z.string().trim().min(1);

const pluginModuleSchema = z.looseObject({
  default: z.unknown().optional(),
  plugin: z.unknown().optional(),
  plugins: z.unknown().optional(),
});

type PluginModule = z.infer<typeof pluginModuleSchema>;

const mizPluginSchema = z.object({
  name: nonEmptyStringSchema,
  commands: z.array(nonEmptyStringSchema),
  description: z.string().optional(),
  handle: z.custom<MizPlugin["handle"]>((value) => typeof value === "function", {
    message: "handle must be a function",
  }).optional(),
  onMessage: z
    .custom<NonNullable<MizPlugin["onMessage"]>>((value) => typeof value === "function", {
      message: "onMessage must be a function",
    })
    .optional(),
}).refine((plugin) => plugin.handle || plugin.onMessage, {
  message: "plugin must provide a command handler or message hook",
});

const nodeErrorSchema = z.looseObject({
  code: z.string(),
});

export const createPluginRuntime = async (
  config: MizConfig,
  gateway: Gateway,
  logger: Logger,
): Promise<PluginRuntime> => {
  const plugins = await loadPlugins(config.plugins.directory, logger);
  const pluginsByCommand = createCommandIndex(plugins, logger);
  const pluginInfo = createPluginInfo(plugins);

  logger.info("plugin", `loaded ${plugins.length} plugin(s)`, {
    directory: config.plugins.directory,
    commandPrefix: config.plugins.commandPrefix,
    commands: Array.from(pluginsByCommand.keys()),
  });

  return {
    handleMessage: async (message) => {
      await notifyPluginsOfMessage({
        config,
        gateway,
        logger,
        message,
        pluginInfo,
        plugins,
      });
      await dispatchPluginCommand({
        config,
        gateway,
        logger,
        message,
        pluginInfo,
        pluginsByCommand,
      });
    },
  };
};

const notifyPluginsOfMessage = async ({
  config,
  gateway,
  logger,
  message,
  pluginInfo,
  plugins,
}: {
  config: MizConfig;
  gateway: Gateway;
  logger: Logger;
  message: IncomingMessage;
  pluginInfo: readonly PluginInfo[];
  plugins: readonly MizPlugin[];
}) => {
  for (const plugin of plugins) {
    if (!plugin.onMessage) {
      continue;
    }

    try {
      await plugin.onMessage({
        config,
        message,
        gateway,
        logger,
        plugins: pluginInfo,
        commandPrefix: config.plugins.commandPrefix,
        reply: (replyMessage) => replyToMessage(gateway, message, replyMessage),
        replyForward: (messages, options) =>
          gateway.sendForwardMessage(
            message,
            messages,
            {
              title: options?.title,
              source: options?.source,
              summary: options?.summary,
            },
          ),
      });
    } catch (error) {
      logger.error("plugin", `message hook failed: ${plugin.name}`, error);
    }
  }
};

const loadPlugins = async (directory: string, logger: Logger) => {
  const files = await listPluginFiles(directory);
  const plugins: MizPlugin[] = [];

  for (const file of files) {
    try {
      const module = pluginModuleSchema.parse(await import(pathToFileURL(file).href));
      plugins.push(...readPluginsFromModule(module).map((plugin) => validatePlugin(plugin, file)));
    } catch (error) {
      logger.error("plugin", `failed to load plugin module: ${file}`, error);
    }
  }

  return plugins;
};

const listPluginFiles = async (directory: string): Promise<string[]> => {
  try {
    const directoryStat = await stat(directory);
    if (!directoryStat.isDirectory()) {
      throw new Error(`Plugin path is not a directory: ${directory}`);
    }
  } catch (error) {
    if (isMissingPathError(error)) {
      return [];
    }

    throw error;
  }

  return listPluginFilesRecursive(directory);
};

const listPluginFilesRecursive = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return listPluginFilesRecursive(entryPath);
      }

      if (entry.isFile() && isPluginFile(entry.name)) {
        return [entryPath];
      }

      return [];
    }),
  );

  return files.flat();
};

const isPluginFile = (filename: string) =>
  /\.(ts|js|mjs)$/.test(filename) && !filename.endsWith(".d.ts");

const readPluginsFromModule = (module: PluginModule) => [
  ...readPluginExport(module.default),
  ...readPluginExport(module.plugin),
  ...readPluginExport(module.plugins),
];

const readPluginExport = (value: unknown): unknown[] => {
  if (value === undefined) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
};

const validatePlugin = (plugin: unknown, sourceFile: string): MizPlugin => {
  const result = mizPluginSchema.safeParse(plugin);
  if (!result.success) {
    throw new Error(`Invalid plugin export in ${sourceFile}: ${result.error.message}`);
  }

  return result.data;
};

const createCommandIndex = (plugins: MizPlugin[], logger: Logger) => {
  const pluginsByCommand = new Map<string, MizPlugin>();

  for (const plugin of plugins) {
    for (const command of plugin.commands) {
      if (pluginsByCommand.has(command)) {
        logger.warn("plugin", `duplicate command ignored: ${command}`, {
          plugin: plugin.name,
          existingPlugin: pluginsByCommand.get(command)?.name,
        });
        continue;
      }

      pluginsByCommand.set(command, plugin);
    }
  }

  return pluginsByCommand;
};

const createPluginInfo = (plugins: MizPlugin[]): PluginInfo[] =>
  plugins
    .filter((plugin) => plugin.commands.length > 0)
    .map((plugin) => ({
      name: plugin.name,
      commands: plugin.commands,
      description: plugin.description,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

const dispatchPluginCommand = async ({
  config,
  gateway,
  logger,
  message,
  pluginInfo,
  pluginsByCommand,
}: {
  config: MizConfig;
  gateway: Gateway;
  logger: Logger;
  message: IncomingMessage;
  pluginInfo: readonly PluginInfo[];
  pluginsByCommand: Map<string, MizPlugin>;
}) => {
  const commandText = parseCommandText(message.text, config.plugins.commandPrefix);
  if (!commandText) {
    return;
  }

  const command = findPluginCommand(commandText, pluginsByCommand);
  if (!command) {
    logger.warn("plugin", "unknown command", {
      commandText,
      availableCommands: Array.from(pluginsByCommand.keys()),
    });
    return;
  }

  const plugin = pluginsByCommand.get(command.name);
  if (!plugin?.handle) {
    return;
  }

  try {
    await plugin.handle({
      command,
      config,
      message,
      gateway,
      logger,
      plugins: pluginInfo,
      commandPrefix: config.plugins.commandPrefix,
      reply: (replyMessage) => replyToMessage(gateway, message, replyMessage),
      replyForward: (messages, options) =>
        gateway.sendForwardMessage(message, messages, {
          title: options?.title,
          source: options?.source,
          summary: options?.summary,
        }),
    });
  } catch (error) {
    logger.error("plugin", `plugin failed: ${plugin.name}`, error);
  }
};

const parseCommandText = (text: string, commandPrefix: string) => {
  const trimmedText = text.trim();
  if (!trimmedText.startsWith(commandPrefix)) {
    return undefined;
  }

  return trimmedText.slice(commandPrefix.length).trim();
};

const findPluginCommand = (commandText: string, pluginsByCommand: Map<string, MizPlugin>) => {
  const commands = Array.from(pluginsByCommand.keys()).sort((left, right) => right.length - left.length);

  for (const name of commands) {
    if (commandText === name) {
      return { name, args: "", raw: commandText };
    }

    if (commandText.startsWith(`${name} `)) {
      return { name, args: commandText.slice(name.length).trim(), raw: commandText };
    }
  }

  return undefined;
};

const replyToMessage = (gateway: Gateway, message: IncomingMessage, replyMessage: unknown) => {
  if (message.groupId !== undefined) {
    return gateway.sendGroupMessage(message.groupId, replyMessage);
  }

  if (message.userId !== undefined) {
    return gateway.sendPrivateMessage(message.userId, replyMessage);
  }

  throw new Error("Cannot reply: message has no group_id or user_id");
};

const isMissingPathError = (error: unknown) =>
  nodeErrorSchema.safeParse(error).data?.code === "ENOENT";
