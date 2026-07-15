import type { PluginCommand } from "@/plugins";

/** Pure command parsing and matching rules used by the plugin I/O adapter. */
export const parseCommandText = (
  text: string,
  commandPrefix: string,
  commandNames: readonly string[],
) => {
  const trimmedText = text.trim();
  if (!trimmedText.startsWith(commandPrefix)) {
    return undefined;
  }

  const suffix = trimmedText.slice(commandPrefix.length);
  const commandText = suffix.trim();
  if (suffix === "" || /^\s/.test(suffix)) {
    return commandText;
  }

  // The gap between prefix and command is optional, but compact text is only
  // treated as a command when it actually matches a registered command name.
  return findPluginCommand(commandText, commandNames) ? commandText : undefined;
};

export const findPluginCommand = (
  commandText: string,
  commandNames: readonly string[],
): PluginCommand | undefined => {
  // Arguments may be written directly after a command name, e.g. `miz 占卜123`.
  // Select the longest matching name without sorting or allocating on every
  // incoming message, so overlapping commands remain unambiguous.
  let name: string | undefined;
  for (const candidate of commandNames) {
    if (!commandText.startsWith(candidate)) {
      continue;
    }

    const suffix = commandText.slice(candidate.length);
    const matches = suffix === "" || /^\s/.test(suffix) || /[^\x00-\x7F]$/.test(candidate);
    if (matches && (name === undefined || candidate.length > name.length)) {
      name = candidate;
    }
  }

  return name === undefined
    ? undefined
    : {
      name,
      args: commandText.slice(name.length).trim(),
      raw: commandText,
    };
};
