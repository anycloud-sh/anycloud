import { serializeError } from 'serialize-error';
import config from '../config.js';
import { redactValue } from './redact.js';
import { boundLoggedError } from '../../shared/log-diagnostics.js';

interface LogMetadata {
  [key: string]: unknown;
}

export interface ErrorMetadata extends LogMetadata {
  id: string; // Workload ID or 'system' for non-workload errors
  error: unknown; // Error message or Error object (auto-serialized)
  version?: string; // CLI/API version (include when available)
}

class Logger {
  /**
   * Serialize metadata for JSON output.
   * Handles circular refs in error objects via serialize-error.
   */
  private serialize(metadata?: LogMetadata): Record<string, unknown> {
    if (!metadata) return {};
    const processed: Record<string, unknown> = { ...metadata };
    if (processed.error !== undefined) {
      processed.error =
        typeof processed.error === 'string'
          ? processed.error
          : boundLoggedError(serializeError(processed.error));
    }
    return redactValue(processed) as Record<string, unknown>;
  }

  private formatLog(
    level: string,
    message: string,
    metadata?: LogMetadata,
  ): string {
    const processed = this.serialize(metadata);
    return JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message,
      ...(Object.keys(processed).length > 0 ? processed : {}),
    });
  }

  info(message: string, metadata?: LogMetadata) {
    console.log(this.formatLog('INFO', message, metadata));
  }

  debug(message: string, metadata?: LogMetadata) {
    if (config.debug) {
      console.debug(this.formatLog('DEBUG', message, metadata));
    }
  }

  error(message: string, metadata: ErrorMetadata) {
    console.error(this.formatLog('ERROR', message, metadata));
  }

  warn(message: string, metadata?: LogMetadata) {
    console.warn(this.formatLog('WARN', message, metadata));
  }
}

// Simple console logger for now
// TODO: Add Cloudflare Workers Analytics Engine or Logpush integration
export const log = new Logger();
