import pino, { type Logger } from "pino";

export type AirchiveLogger = Logger;

/** Builds a Pino logger with structured JSON in production and readable output locally. */
export function createLogger(options: {
  service: string;
  level?: string;
}): AirchiveLogger {
  const level =
    process.env.LOG_LEVEL ?? options.level ?? "info";

  const isProduction = process.env.NODE_ENV === "production";

  return pino({
    level,
    base: { service: options.service },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(isProduction
      ? {}
      : {
          transport: {
            target: "pino-pretty",
            options: {
              translateTime: "SYS:standard",
            },
          },
        }),
  });
}

const logger = createLogger({ service: "airchive" });

export default logger;
