const CLI_ERROR_KIND = Symbol("pm3.cliErrorKind");

type CliErrorKind = "usage" | "input";

type CliError = Error & {
  [CLI_ERROR_KIND]: CliErrorKind;
};

function createCliError(kind: CliErrorKind, message: string): CliError {
  const error = new Error(message) as CliError;
  error[CLI_ERROR_KIND] = kind;
  return error;
}

export function usageError(message: string): CliError {
  return createCliError("usage", message);
}

export function inputError(message: string): CliError {
  return createCliError("input", message);
}

function isCliError(error: unknown): error is CliError {
  return error instanceof Error && CLI_ERROR_KIND in error;
}

export type CliErrorOutput = {
  message: string;
};

export function formatCliError(error: unknown): CliErrorOutput {
  if (isCliError(error)) {
    return {
      message: error.message,
    };
  }

  if (error instanceof Error && error.message) {
    return {
      message: error.message,
    };
  }

  return {
    message: "Command failed",
  };
}
