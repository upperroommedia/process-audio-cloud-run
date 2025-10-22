import winston from 'winston';
import { LoggingWinston } from '@google-cloud/logging-winston';

// Configure structured JSON logging
const loggingWinston = new LoggingWinston();

const baseLogger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [new winston.transports.Console(), loggingWinston],
});

// 🧠 Helper: normalize arguments
function logWithMeta(level: string, message: string, meta: string | number | boolean | object | undefined | null) {
  if (typeof meta === 'string' || typeof meta === 'number' || typeof meta === 'boolean') {
    // Wrap string metadata into an object
    baseLogger.log(level, message, { extra: meta });
  } else if (meta && typeof meta === 'object') {
    baseLogger.log(level, message, meta);
  } else {
    baseLogger.log(level, message);
  }
}

// 🔧 Export a nice API
const logger = {
  info: (msg: string, meta?: string | number | boolean | object | undefined | null) => logWithMeta('info', msg, meta),
  warn: (msg: string, meta?: string | number | boolean | object | undefined | null) => logWithMeta('warn', msg, meta),
  error: (msg: string, meta?: any) => logWithMeta('error', msg, meta),
  debug: (msg: string, meta?: string | number | boolean | object | undefined | null) => logWithMeta('debug', msg, meta),
};
export default logger;
