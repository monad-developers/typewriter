import { Layer, Logger, type LogLevel, References } from "effect";

const stringify: typeof JSON.stringify = (value, replacer, space) =>
  JSON.stringify(
    value,
    (key, value_) => {
      const value = typeof value_ === "bigint" ? value_.toString() : value_;
      return typeof replacer === "function" ? replacer(key, value) : value;
    },
    space,
  );

const consoleJson = Logger.withConsoleLog(
  Logger.map(Logger.formatStructured, stringify),
);

const LOG_LEVELS = {
  trace: "Trace",
  debug: "Debug",
  info: "Info",
  warn: "Warn",
  error: "Error",
} as const satisfies Record<string, LogLevel.LogLevel>;

const LOG_FORMATS = ["pretty", "json"] as const;

function readEnv<const T extends string>(
  name: string,
  values: readonly T[],
  fallback: T,
): T {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  if (!(values as readonly string[]).includes(value)) {
    throw new Error(
      `${name} must be one of ${values.map((v) => `"${v}"`).join(", ")}, got "${value}"`,
    );
  }
  return value as T;
}

const logLevel =
  LOG_LEVELS[
    readEnv(
      "TYPEWRITER_LOG_LEVEL",
      Object.keys(LOG_LEVELS) as (keyof typeof LOG_LEVELS)[],
      "info",
    )
  ];

const logFormat = readEnv(
  "TYPEWRITER_LOG_FORMAT",
  LOG_FORMATS,
  process.env.NODE_ENV === "production" ? "json" : "pretty",
);

const output = logFormat === "json" ? consoleJson : Logger.consolePretty();

/**
 * Logs at `None` show as debug logs. The simulation test logs at `None`, the
 * one level that no minimum level filters out, so its logs always print.
 */
export const logger = Logger.make((options) =>
  output.log(
    options.logLevel === "None" ? { ...options, logLevel: "Debug" } : options,
  ),
);

export const loggerLayer = Layer.merge(
  Logger.layer([logger]),
  Layer.succeed(References.MinimumLogLevel, logLevel),
);

export function startTimer(): number {
  return performance.now();
}

export function durationMs(startMs: number): number {
  return Math.round((performance.now() - startMs) * 100) / 100;
}
