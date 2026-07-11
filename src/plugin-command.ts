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
  const name = names.find((candidate) =>
    commandText === candidate || commandText.startsWith(`${candidate} `));

  return name === undefined
    ? undefined
    : {
      name,
      args: commandText.slice(name.length).trim(),
      raw: commandText,
    };
};
