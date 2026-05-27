import { Layer, Logger, References } from "effect";

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

export const logger =
  process.env.NODE_ENV === "production" ? consoleJson : Logger.consolePretty();

export const loggerLayer = Layer.merge(
  Logger.layer([logger]),
  Layer.succeed(References.MinimumLogLevel, "Debug"),
);
