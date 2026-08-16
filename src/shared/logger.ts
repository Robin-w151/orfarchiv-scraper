import { Logger } from 'effect';

export const LoggerLive = Logger.layer([Logger.consoleLogFmt, Logger.tracerLogger]);
