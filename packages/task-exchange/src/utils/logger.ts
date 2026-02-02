/**
 * Logger utility for debugging
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LoggerConfig {
  level: LogLevel;
  prefix: string;
  timestamps: boolean;
  colors: boolean;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

const DEFAULT_CONFIG: LoggerConfig = {
  level: 'info',
  prefix: '',
  timestamps: true,
  colors: true,
};

export class Logger {
  private config: LoggerConfig;

  constructor(prefix: string, config: Partial<LoggerConfig> = {}) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      prefix,
    };
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.config.level];
  }

  private formatTimestamp(): string {
    if (!this.config.timestamps) return '';
    const now = new Date();
    return now.toISOString().split('T')[1].slice(0, -1);
  }

  private formatMessage(level: LogLevel, message: string, data?: unknown): string {
    const timestamp = this.formatTimestamp();
    const prefix = this.config.prefix ? `[${this.config.prefix}]` : '';
    
    let levelStr = level.toUpperCase().padEnd(5);
    let dataStr = data !== undefined ? ` ${JSON.stringify(data)}` : '';
    
    if (this.config.colors) {
      const color = {
        debug: COLORS.gray,
        info: COLORS.cyan,
        warn: COLORS.yellow,
        error: COLORS.red,
      }[level];
      
      levelStr = `${color}${levelStr}${COLORS.reset}`;
      if (timestamp) {
        return `${COLORS.dim}${timestamp}${COLORS.reset} ${levelStr} ${COLORS.blue}${prefix}${COLORS.reset} ${message}${dataStr}`;
      }
    }
    
    return `${timestamp} ${levelStr} ${prefix} ${message}${dataStr}`.trim();
  }

  debug(message: string, data?: unknown): void {
    if (this.shouldLog('debug')) {
      console.log(this.formatMessage('debug', message, data));
    }
  }

  info(message: string, data?: unknown): void {
    if (this.shouldLog('info')) {
      console.log(this.formatMessage('info', message, data));
    }
  }

  warn(message: string, data?: unknown): void {
    if (this.shouldLog('warn')) {
      console.warn(this.formatMessage('warn', message, data));
    }
  }

  error(message: string, data?: unknown): void {
    if (this.shouldLog('error')) {
      console.error(this.formatMessage('error', message, data));
    }
  }

  /**
   * Create a child logger with additional prefix
   */
  child(prefix: string): Logger {
    const newPrefix = this.config.prefix ? `${this.config.prefix}:${prefix}` : prefix;
    return new Logger(newPrefix, this.config);
  }

  /**
   * Set log level
   */
  setLevel(level: LogLevel): void {
    this.config.level = level;
  }

  /**
   * Enable/disable colors
   */
  setColors(enabled: boolean): void {
    this.config.colors = enabled;
  }
}

// Global logger factory
let globalLevel: LogLevel = 'info';

export function setGlobalLogLevel(level: LogLevel): void {
  globalLevel = level;
}

export function createLogger(prefix: string): Logger {
  return new Logger(prefix, { level: globalLevel });
}

// Pre-configured loggers for each module
export const exchangeLogger = createLogger('Exchange');
export const auctionLogger = createLogger('Auction');
export const orderBookLogger = createLogger('OrderBook');
export const reputationLogger = createLogger('Reputation');
export const transportLogger = createLogger('Transport');
export const agentLogger = createLogger('Agent');
