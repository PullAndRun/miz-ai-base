import type { PluginCommand } from "@/plugins";

/** Pure command parsing and matching rules used by the plugin I/O adapter. */
export const parseCommandText = (text: string, commandPrefix: string) => {
  const trimmedText = text.trim();
  if (!trimmedText.startsWith(commandPrefix)) {
    return undefined;
  }

  const suffix = trimmedText.slice(commandPrefix.length);
  return suffix === "" || /^\s/.test(suffix) ? suffix.trim() : undefined;
};

export const findPluginCommand = (
  commandText: string,
  commandNames: readonly string[],
): PluginCommand | undefined => {
  const names = [...commandNames].sort((left, right) => right.length - left.length);
  // Arguments may be written directly after a command name, e.g. `miz 占卜123`.
  // Check longer command names first so overlapping names remain unambiguous.
  const name = names.find((candidate) => {
    if (!commandText.startsWith(candidate)) {
      return false;
    }

    const suffix = commandText.slice(candidate.length);
    return suffix === "" || /^\s/.test(suffix) || /[^\x00-\x7F]$/.test(candidate);
  });

  return name === undefined
    ? undefined
    : {
      name,
      args: commandText.slice(name.length).trim(),
      raw: commandText,
    };
};
