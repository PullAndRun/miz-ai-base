import type { PluginCommand } from "@/plugins";

/** Pure command parsing and matching rules used by the plugin I/O adapter. */
export const parseCommandText = (text: string, commandPrefix: string) => {
  const trimmedText = text.trim();
  return trimmedText.startsWith(commandPrefix)
    ? trimmedText.slice(commandPrefix.length).trim()
    : undefined;
};

export const findPluginCommand = (
  commandText: string,
  commandNames: readonly string[],
): PluginCommand | undefined => {
  const names = [...commandNames].sort((left, right) => right.length - left.length);
  // Arguments may be written directly after a command name, e.g. `miz 占卜123`.
  // Check longer command names first so overlapping names remain unambiguous.
  const name = names.find((candidate) => commandText.startsWith(candidate));

  return name === undefined
    ? undefined
    : {
      name,
      args: commandText.slice(name.length).trim(),
      raw: commandText,
    };
};
