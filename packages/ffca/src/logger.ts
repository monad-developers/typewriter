import { Layer, Logger, References } from "effect";

export const logger =
  process.env.NODE_ENV === "production"
    ? Logger.consoleJson
    : Logger.consolePretty();

export const loggerLayer = Layer.merge(
  Logger.layer([logger]),
  Layer.succeed(References.MinimumLogLevel, "Debug"),
);
