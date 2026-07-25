import type { ParsedArgs, TopLevelCommand } from "../args.js";
import type { CliEnvelope } from "../output.js";

export type CommandHandler = (
  args: ParsedArgs
) => Promise<CliEnvelope<unknown>>;

export interface CommandRegistry {
  get(command: TopLevelCommand): CommandHandler | undefined;
  commands(): readonly TopLevelCommand[];
}

export function createCommandRegistry(
  handlers: Partial<Record<TopLevelCommand, CommandHandler>>
): CommandRegistry {
  const entries = new Map<TopLevelCommand, CommandHandler>();
  for (const [command, handler] of Object.entries(handlers) as Array<[
    TopLevelCommand,
    CommandHandler | undefined
  ]>) {
    if (handler !== undefined) {
      entries.set(command, handler);
    }
  }
  return {
    get(command) {
      return entries.get(command);
    },
    commands() {
      return [...entries.keys()];
    }
  };
}
