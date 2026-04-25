import { usageError } from "./errors.ts";

export function requireArgument(
  name: string,
  value: string | undefined,
): string {
  if (!value) {
    throw usageError(`Missing ${name}.`);
  }

  return value;
}

export function requireNoExtraArgs(
  command: string,
  args: readonly string[],
): void {
  if (args.length > 0) {
    throw usageError(`Unexpected argument for ${command}: ${args[0]}`);
  }
}

export function requireOptionValue(
  option: string,
  value: string | undefined,
): string {
  if (!value) {
    throw usageError(`Missing value for ${option}.`);
  }

  return value;
}
