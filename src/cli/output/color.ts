export function green(value: string): string {
  return color(32, value);
}

export function blue(value: string): string {
  return color(34, value);
}

export function magenta(value: string): string {
  return color(35, value);
}

export function cyan(value: string): string {
  return color(36, value);
}

export function red(value: string): string {
  return color(31, value);
}

export function yellow(value: string): string {
  return color(33, value);
}

export function color(code: number, value: string): string {
  return `\x1b[${code}m${value}\x1b[0m`;
}
