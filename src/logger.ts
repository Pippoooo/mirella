// Logging abstraction: scoped loggers instead of bare console.* calls, so
// output is attributable and the destination is a decision made in one place.
// No dependency injection for now — no test framework or second sink exists —
// but call sites go through the Logger interface, so a sink change later
// doesn't touch them.

export interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

// info goes to stdout; warn/error to stderr. `stderr: true` forces ALL
// levels to stderr — required for the MCP server, whose stdout is the
// JSON-RPC protocol channel and must never carry log output.
export function createLogger(
  scope: string,
  opts: { stderr?: boolean } = {},
): Logger {
  const toStderr = opts.stderr === true;
  const write =
    (stream: "log" | "error") =>
    (...args: unknown[]): void => {
      console[stream](`[${scope}]`, ...args);
    };
  return {
    info: toStderr ? write("error") : write("log"),
    warn: write("error"),
    error: write("error"),
  };
}