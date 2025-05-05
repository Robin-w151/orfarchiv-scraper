import { Logger, LogLevel } from 'effect';
import { createLogger, format, transports } from 'winston';
const { align, colorize, combine, printf, timestamp } = format;

const logger = createLogger({
  level: 'info',
  format: combine(
    align(),
    colorize(),
    timestamp(),
    printf((log) => `${log.timestamp} ${log.level} ${log.message}`),
  ),
  transports: [new transports.Console()],
});

const effectLogger = Logger.make(({ logLevel, message }) => {
  logger.log(mapLogLevel(logLevel), Array.isArray(message) ? message.join(' ') : message);
});

export const loggerLayer = Logger.replace(Logger.defaultLogger, effectLogger);

function mapLogLevel(logLevel: LogLevel.LogLevel): string {
  switch (logLevel) {
    case LogLevel.Fatal:
      return 'error';
    case LogLevel.Warning:
      return 'warn';
    case LogLevel.Trace:
      return 'debug';
    default:
      return logLevel.label.toLowerCase();
  }
}
