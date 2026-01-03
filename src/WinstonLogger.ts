import winston from 'winston';
import { LoggingWinston } from '@google-cloud/logging-winston';
import { LogContext } from './context';

const isDevelopment = process.env.NODE_ENV === 'development';

// Configure transports - only use Cloud Logging in production
const transports: winston.transport[] = [new winston.transports.Console()];

// Only add Google Cloud Logging in production
if (!isDevelopment) {
  try {
    const loggingWinston = new LoggingWinston();
    transports.push(loggingWinston);
  } catch (error) {
    // If Cloud Logging fails to initialize, just use console
    console.warn('Failed to initialize Cloud Logging, using console only:', error);
  }
}

const baseLogger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.json(),
  transports,
});

// Helper to merge context with metadata
function mergeContext(context: LogContext | undefined, meta?: any): any {
  const baseMeta = context ? { ctx: context } : {};
  if (meta === undefined || meta === null) {
    return baseMeta;
  }
  if (typeof meta === 'string' || typeof meta === 'number' || typeof meta === 'boolean') {
    return { ...baseMeta, value: meta };
  }
  if (typeof meta === 'object') {
    return { ...baseMeta, ...meta };
  }
  return baseMeta;
}

// Create a logger instance with context
function createLoggerWithContext(context?: LogContext) {
  return {
    info: (msg: string, meta?: any) => {
      baseLogger.log('info', msg, mergeContext(context, meta));
    },
    warn: (msg: string, meta?: any) => {
      baseLogger.log('warn', msg, mergeContext(context, meta));
    },
    error: (msg: string, meta?: any) => {
      baseLogger.log('error', msg, mergeContext(context, meta));
    },
    debug: (msg: string, meta?: any) => {
      baseLogger.log('debug', msg, mergeContext(context, meta));
    },
  };
}

// Default logger (no context)
const logger = createLoggerWithContext();

// Export both default logger and factory function
export default logger;
export { createLoggerWithContext };
