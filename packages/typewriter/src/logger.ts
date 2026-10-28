import {
  Cause,
  Clock,
  Effect,
  Layer,
  Logger,
  type LogLevel,
  Predicate,
  References,
} from "effect";

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

/**
 * An error that typewriter raises on purpose: an Effect tagged error that it
 * failed with. Its message says what went wrong, so its stack, which points
 * into typewriter, is noise. Any other error, or a defect, is a bug, and keeps
 * its stack.
 */
function isKnownError({ error, defect }: LogError): boolean {
  return !defect && Predicate.isString((error as { _tag?: unknown })._tag);
}

/** An error's `cause`, with an Effect `Cause` reduced to its first error. */
function errorCause(error: Error): unknown {
  return Cause.isCause(error.cause) ? Cause.squash(error.cause) : error.cause;
}

/** An error a log is about, and whether it reached the log as a defect. */
type LogError = { error: unknown; defect: boolean };

/**
 * The errors a log is about, from its message and its cause. An interrupt is
 * a cancellation, not an error, so it is left out.
 */
function logErrors(
  message: readonly unknown[],
  cause: Cause.Cause<unknown>,
): LogError[] {
  const errors: LogError[] = message
    .filter((m) => m instanceof Error)
    .map((error) => ({ error, defect: false }));
  for (const reason of cause.reasons) {
    if (Cause.isFailReason(reason)) {
      errors.push({ error: reason.error, defect: false });
    } else if (Cause.isDieReason(reason)) {
      errors.push({ error: reason.defect, defect: true });
    }
  }
  return errors;
}

// -----------------------------------------------------------------------------
// Pretty

const { NO_COLOR, FORCE_COLOR } = process.env;
const useColor =
  process.stdout.isTTY === true &&
  NO_COLOR === undefined &&
  FORCE_COLOR !== "0";

const ansi =
  (open: number, close: number) =>
  (text: string): string =>
    useColor ? `\x1b[${open}m${text}\x1b[${close}m` : text;
const dim = ansi(2, 22);
const red = ansi(31, 39);
const green = ansi(32, 39);
const yellow = ansi(33, 39);
const blue = ansi(34, 39);
const gray = ansi(90, 39);

const PRETTY_LEVELS: Record<LogLevel.LogLevel, string> = {
  All: gray("TRACE"),
  Trace: gray("TRACE"),
  Debug: blue("DEBUG"),
  Info: green("INFO "),
  Warn: yellow("WARN "),
  Error: red("ERROR"),
  Fatal: red("FATAL"),
  None: "",
};

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  fractionalSecondDigits: 3,
  hour12: false,
});

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.floor(ms / 1000);

  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds - h * 3600) / 60);
  const s = seconds - h * 3600 - m * 60;

  const hstr = h > 0 ? `${h}h ` : "";
  const mstr = m > 0 || h > 0 ? `${m < 10 && h > 0 ? "0" : ""}${m}m ` : "";
  const sstr = s > 0 || m > 0 ? `${s < 10 && m > 0 ? "0" : ""}${s}s` : "";

  return `${hstr}${mstr}${sstr}`;
}

function formatValue(value: unknown): string {
  if (Predicate.isString(value)) return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (Predicate.isObject(value)) return stringify(value);
  return String(value);
}

/**
 * `Name: message` for each error in the cause chain, or the stack of an
 * unknown top-level error. The stack of a cause points into the library that
 * threw it, so it is left out.
 */
function formatErrorLines(error: LogError): string[] {
  const lines: string[] = [];
  let current: unknown = error.error;
  for (let depth = 0; current !== undefined && depth < 10; depth++) {
    const prefix = depth === 0 ? "" : "  cause: ";
    if (!(current instanceof Error)) {
      lines.push(`${prefix}${formatValue(current)}`);
      break;
    }
    const text = `${current.name}: ${current.message}`;
    lines.push(`${prefix}${text.replaceAll("\n", "\n    ")}`);
    // The stack's own header can predate the message, as a tagged error's does.
    if (depth === 0 && !isKnownError(error) && current.stack) {
      lines.push(...current.stack.split("\n").filter((l) => /^\s+at /.test(l)));
    }
    current = errorCause(current);
  }
  return lines;
}

function formatPretty(options: Logger.Options<unknown>): string {
  const message = Array.isArray(options.message)
    ? options.message
    : [options.message];
  const annotations = options.fiber.getRef(References.CurrentLogAnnotations);
  const msg = message.filter(Predicate.isString).join(" ");

  let keys = "";
  let duration = "";
  const errors = logErrors(message, options.cause);
  for (const [key, value] of Object.entries(annotations)) {
    if (key === "duration" && Predicate.isNumber(value)) {
      duration = ` ${gray(`(${formatDuration(value)})`)}`;
    } else if (key === "error") {
      errors.unshift({ error: value, defect: false });
    } else {
      keys += ` ${key}=${formatValue(value)}`;
    }
  }

  const time = timeFormatter.format(options.date);
  const lines = [
    `${dim(time)} ${PRETTY_LEVELS[options.logLevel]} ${msg}${dim(keys)}${duration}`,
  ];
  for (const error of errors) lines.push(...formatErrorLines(error));
  return lines.join("\n");
}

// -----------------------------------------------------------------------------
// JSON

function stringify(value: unknown): string {
  return JSON.stringify(value, (_, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
}

/**
 * `name`, `message`, the error's own fields, the serialized `cause`, and the
 * stack of an unknown top-level error.
 */
function serializeError(error: unknown, known: boolean, depth = 0): unknown {
  if (!(error instanceof Error)) return error;
  const serialized: {
    name: string;
    message: string;
    stack?: string;
    cause?: unknown;
    [key: string]: unknown;
  } = {
    name: error.name,
    message: error.message,
  };
  for (const [key, value] of Object.entries(error)) {
    if (key === "_tag" || key === "cause" || key === "message") continue;
    serialized[key] = value;
  }
  if (depth === 0 && !known && error.stack) {
    serialized.stack = error.stack;
  }
  const cause = errorCause(error);
  if (cause !== undefined && depth < 10) {
    serialized.cause = serializeError(cause, known, depth + 1);
  }
  return serialized;
}

const JSON_RESERVED_KEYS = new Set(["level", "time", "msg", "error"]);

function formatJson(options: Logger.Options<unknown>): string {
  const message = Array.isArray(options.message)
    ? options.message
    : [options.message];
  const annotations = options.fiber.getRef(References.CurrentLogAnnotations);
  const log: {
    level: string;
    time: string;
    msg: string;
    error?: unknown;
    [key: string]: unknown;
  } = {
    level: options.logLevel.toLowerCase(),
    time: options.date.toISOString(),
    msg: message.filter(Predicate.isString).join(" "),
  };
  const errors = logErrors(message, options.cause);
  for (const [key, value] of Object.entries(annotations)) {
    if (key === "error") errors.unshift({ error: value, defect: false });
    else if (!JSON_RESERVED_KEYS.has(key)) log[key] = value;
  }
  const serialized = errors.map((e) =>
    serializeError(e.error, isKnownError(e)),
  );
  if (serialized.length === 1) log.error = serialized[0];
  else if (serialized.length > 1) log.error = serialized;
  return stringify(log);
}

// -----------------------------------------------------------------------------
// Logger

/**
 * Prints one log per line in the format of `TYPEWRITER_LOG_FORMAT`. A string
 * message is the log's message, and an error message, an `error` annotation,
 * or the cause is printed as its error.
 */
export const logger = Logger.make((options) => {
  console.log(
    logFormat === "json" ? formatJson(options) : formatPretty(options),
  );
});

export const loggerLayer = Layer.merge(
  Logger.layer([logger]),
  Layer.succeed(References.MinimumLogLevel, logLevel),
);

/** The `Clock`'s monotonic time in nanoseconds, which a simulation controls. */
export const startTimer: Effect.Effect<bigint> = Clock.clockWith(
  (clock) => clock.monotonicTimeNanos,
);

/** The milliseconds since `start`, to two decimal places. */
export function durationMs(start: bigint): Effect.Effect<number> {
  return Effect.map(startTimer, (now) => Number((now - start) / 10_000n) / 100);
}
