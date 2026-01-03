import winston from 'winston';
import { LoggingWinston } from '@google-cloud/logging-winston';
import { LogContext } from './context';

const isDevelopment = process.env.NODE_ENV === 'development';

// Configure transports - only use Cloud Logging in production
const transports: winston.transport[] = [new winston.transports.Console()];

// Only add Google Cloud Logging in production
if (!isDevelopment) {
  try {
    // Configure LoggingWinston with proper labels for GCP structured logging
    const loggingWinston = new LoggingWinston({
      // Use service name and version for better log organization
      serviceContext: {
        service: 'process-audio-cloud-run',
        version: process.env.K_SERVICE_VERSION || '1.0.0',
      },
      // Log level mapping
      level: process.env.LOG_LEVEL || 'info',
      // Use labels for filterable metadata (these will be extracted from log entries)
      labels: {
        service: 'process-audio-cloud-run',
      },
    });
    transports.push(loggingWinston);
  } catch (error) {
    // If Cloud Logging fails to initialize, just use console
    console.warn('Failed to initialize Cloud Logging, using console only:', error);
  }
}

// Custom format for GCP structured logging
// Ensures metadata is properly structured at top level for easy filtering
// LoggingWinston will handle severity mapping and timestamps automatically
const gcpFormat = winston.format((info) => {
  // GCP structured logging best practice: 
  // - message should be the main log entry
  // - All metadata should be at top level (not nested) for easy filtering
  // - LoggingWinston will automatically map level to severity and add timestamp
  return info;
})();

const baseLogger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    gcpFormat,
    winston.format.json()
  ),
  transports,
});

// Helper to merge context with metadata following GCP structured logging best practices
// GCP best practices: Use top-level fields for filterable metadata, not nested objects
function mergeContext(context: LogContext | undefined, meta?: any): any {
  const structuredMeta: Record<string, any> = {};
  
  // Extract context fields to top level for easy filtering
  if (context) {
    if (context.requestId) structuredMeta.requestId = context.requestId;
    if (context.sermonId) structuredMeta.sermonId = context.sermonId;
    if (context.operation) structuredMeta.operation = context.operation;
    // Add any other context fields
    Object.keys(context).forEach(key => {
      if (key !== 'requestId' && key !== 'sermonId' && key !== 'operation' && context[key] !== undefined) {
        structuredMeta[key] = context[key];
      }
    });
  }
  
  // Merge additional metadata
  if (meta === undefined || meta === null) {
    return structuredMeta;
  }
  if (typeof meta === 'string' || typeof meta === 'number' || typeof meta === 'boolean') {
    structuredMeta.value = meta;
  } else if (typeof meta === 'object') {
    // Flatten nested objects to top level for better filtering
    Object.keys(meta).forEach(key => {
      const value = meta[key];
      // If value is an object, we can either flatten it or keep it nested
      // For GCP, prefer top-level fields when possible
      if (value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
        // For nested objects, prefix with parent key to avoid collisions
        Object.keys(value).forEach(nestedKey => {
          structuredMeta[`${key}_${nestedKey}`] = value[nestedKey];
        });
      } else {
        structuredMeta[key] = value;
      }
    });
  }
  
  return structuredMeta;
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
