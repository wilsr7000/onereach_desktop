/**
 * Logger - Structured debug logging with categories and levels
 * 
 * Features:
 * - Log levels (debug, info, warn, error)
 * - Categories (voice, classifier, router, queue, etc.)
 * - Configurable output handlers
 * - Sensitive data redaction
 * - Log buffer for export
 */

import type { Logger, LoggerConfig, LogEntry, LogLevel, LogCategory, LogQuery } from './types'

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

const DEFAULT_CATEGORIES: Record<LogCategory, boolean> = {
  voice: true,
  classifier: true,
  router: true,
  queue: true,
  dispatcher: true,
  agent: true,
  retry: true,
  undo: true,
  persistence: true,
  lifecycle: true,
  sdk: true,
}

export function createLogger(config: LoggerConfig = {}): Logger {
  const {
    level = 'info',
    categories = {},
    handler,
    redact = {},
    maxBufferSize = 1000,
  } = config

  let currentLevel: LogLevel = level
  const enabledCategories = { ...DEFAULT_CATEGORIES, ...categories }
  const logBuffer: LogEntry[] = []

  function shouldLog(entryLevel: LogLevel, category: LogCategory): boolean {
    // Check level
    if (LOG_LEVEL_PRIORITY[entryLevel] < LOG_LEVEL_PRIORITY[currentLevel]) {
      return false
    }

    // Check category
    if (enabledCategories[category] === false) {
      return false
    }

    return true
  }

  function redactData(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    if (!data) return data

    const result = { ...data }

    // Redact transcripts
    if (redact.transcripts && 'transcript' in result) {
      result.transcript = '[REDACTED]'
    }

    // Redact params
    if (redact.params && 'params' in result) {
      result.params = '[REDACTED]'
    }

    // Apply custom patterns to key names (for redacting fields like apiKey, password, etc.)
    if (redact.patterns) {
      for (const [key, value] of Object.entries(result)) {
        for (const pattern of redact.patterns) {
          if (pattern.test(key)) {
            result[key] = '[REDACTED]'
            break
          }
        }
      }
    }

    return result
  }

  function log(entryLevel: LogLevel, category: LogCategory, message: string, data?: Record<string, unknown>): void {
    if (!shouldLog(entryLevel, category)) {
      return
    }

    const entry: LogEntry = {
      timestamp: Date.now(),
      level: entryLevel,
      category,
      message,
      data: redactData(data),
    }

    // Add to buffer
    logBuffer.push(entry)
    while (logBuffer.length > maxBufferSize) {
      logBuffer.shift()
    }

    // Call custom handler if provided
    if (handler) {
      try {
        handler(entry)
      } catch (error) {
        console.error('[logger] Handler error:', error)
      }
    }

    // Also log to console in dev
    const prefix = `[${category}]`
    const formattedMessage = `${prefix} ${message}`

    switch (entryLevel) {
      case 'debug':
        console.debug(formattedMessage, data ?? '')
        break
      case 'info':
        console.info(formattedMessage, data ?? '')
        break
      case 'warn':
        console.warn(formattedMessage, data ?? '')
        break
      case 'error':
        console.error(formattedMessage, data ?? '')
        break
    }
  }

  function debug(category: LogCategory, message: string, data?: Record<string, unknown>): void {
    log('debug', category, message, data)
  }

  function info(category: LogCategory, message: string, data?: Record<string, unknown>): void {
    log('info', category, message, data)
  }

  function warn(category: LogCategory, message: string, data?: Record<string, unknown>): void {
    log('warn', category, message, data)
  }

  function error(category: LogCategory, message: string, data?: Record<string, unknown>): void {
    log('error', category, message, data)
  }

  function setLevel(newLevel: LogLevel): void {
    currentLevel = newLevel
  }

  function getLevel(): LogLevel {
    return currentLevel
  }

  function enableCategory(category: LogCategory): void {
    enabledCategories[category] = true
  }

  function disableCategory(category: LogCategory): void {
    enabledCategories[category] = false
  }

  function getLogs(query?: LogQuery): LogEntry[] {
    let results = [...logBuffer]

    if (query) {
      if (query.category) {
        results = results.filter(e => e.category === query.category)
      }

      if (query.level) {
        results = results.filter(e => e.level === query.level)
      }

      if (query.taskId) {
        results = results.filter(e => e.taskId === query.taskId)
      }

      if (query.agentId) {
        results = results.filter(e => e.agentId === query.agentId)
      }

      if (query.since) {
        results = results.filter(e => e.timestamp >= query.since!)
      }

      if (query.limit) {
        results = results.slice(-query.limit)
      }
    }

    return results
  }

  function exportLogs(): string {
    return JSON.stringify(logBuffer, null, 2)
  }

  function clearLogs(): void {
    logBuffer.length = 0
  }

  return {
    debug,
    info,
    warn,
    error,
    setLevel,
    getLevel,
    enableCategory,
    disableCategory,
    getLogs,
    exportLogs,
    clearLogs,
  }
}
