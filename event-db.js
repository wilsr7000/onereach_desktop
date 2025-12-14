/**
 * Event Database for GSX Create
 * JSON file-based storage for event logs and transactions
 * DuckDB for querying JSON files across spaces
 * Logs are stored in each space's folder
 */

const path = require('path');
const fs = require('fs');

let DuckDB;
try {
  DuckDB = require('@duckdb/node-api');
} catch (e) {
  console.warn('[EventDB] @duckdb/node-api not installed');
  DuckDB = null;
}

class EventDB {
  constructor(appDataPath, spacesPath) {
    this.appDataPath = appDataPath;
    this.spacesPath = spacesPath || path.join(require('os').homedir(), 'Documents', 'OR-Spaces', 'spaces');
    this.instance = null;
    this.connection = null;
    this.duckdbReady = false;
    this.initPromise = null;
  }

  async init() {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._initDuckDB();
    return this.initPromise;
  }

  async _initDuckDB() {
    if (!DuckDB) {
      console.log('[EventDB] DuckDB not available, using JSON-only mode');
      return false;
    }

    try {
      // In-memory DuckDB for querying JSON files (no persistent DB needed)
      this.instance = await DuckDB.DuckDBInstance.create(':memory:');
      this.connection = await this.instance.connect();
      this.duckdbReady = true;
      console.log('[EventDB] DuckDB initialized (in-memory for JSON queries)');
      return true;
    } catch (e) {
      console.error('[EventDB] Failed to initialize DuckDB:', e);
      return false;
    }
  }

  // ========== FILE HELPERS ==========

  getSpaceLogsPath(spaceId) {
    return path.join(this.spacesPath, spaceId, 'logs');
  }

  getEventLogFile(spaceId) {
    return path.join(this.getSpaceLogsPath(spaceId), 'events.json');
  }

  getTransactionLogFile(spaceId) {
    return path.join(this.getSpaceLogsPath(spaceId), 'transactions.json');
  }

  ensureLogsDir(spaceId) {
    const logsPath = this.getSpaceLogsPath(spaceId);
    if (!fs.existsSync(logsPath)) {
      fs.mkdirSync(logsPath, { recursive: true });
    }
    return logsPath;
  }

  readJsonFile(filePath) {
    try {
      if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
      }
    } catch (e) {
      console.error('[EventDB] Error reading:', filePath, e.message);
    }
    return [];
  }

  writeJsonFile(filePath, data) {
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
      return true;
    } catch (e) {
      console.error('[EventDB] Error writing:', filePath, e.message);
      return false;
    }
  }

  // ========== EVENT LOGGING (JSON FILES) ==========

  async logEvent(event) {
    const spaceId = event.spaceId;
    if (!spaceId) {
      console.warn('[EventDB] No spaceId provided for event, skipping');
      return false;
    }

    try {
      this.ensureLogsDir(spaceId);
      const filePath = this.getEventLogFile(spaceId);
      const events = this.readJsonFile(filePath);

      const newEvent = {
        id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
        timestamp: event.timestamp || new Date().toISOString(),
        level: event.level || 'info',
        category: event.category || null,
        message: event.message || '',
        details: event.details || null,
        source: event.source || null,
        userAction: event.userAction || null,
        filePath: event.filePath || null,
        errorStack: event.errorStack || null
      };

      events.unshift(newEvent); // Add to beginning

      // Keep last 1000 events per space
      if (events.length > 1000) {
        events.length = 1000;
      }

      this.writeJsonFile(filePath, events);
      console.log('[EventDB] Event logged to:', filePath);
      return true;
    } catch (e) {
      console.error('[EventDB] Failed to log event:', e);
      return false;
    }
  }

  async getEventLogs(options = {}) {
    const spaceId = options.spaceId;
    
    if (spaceId) {
      // Get logs for specific space
      const filePath = this.getEventLogFile(spaceId);
      let events = this.readJsonFile(filePath);

      // Apply filters
      if (options.level) {
        events = events.filter(e => e.level === options.level);
      }
      if (options.category) {
        events = events.filter(e => e.category === options.category);
      }
      if (options.since) {
        events = events.filter(e => new Date(e.timestamp) >= new Date(options.since));
      }
      if (options.limit) {
        events = events.slice(0, parseInt(options.limit));
      }

      return events;
    } else {
      // Get logs from all spaces (use DuckDB if available)
      if (this.duckdbReady) {
        return await this._queryAllEventLogs(options);
      }
      return [];
    }
  }

  async _queryAllEventLogs(options) {
    try {
      const globPattern = path.join(this.spacesPath, '*', 'logs', 'events.json').replace(/\\/g, '/');
      let query = `SELECT * FROM read_json_auto('${globPattern}')`;
      
      const conditions = [];
      if (options.level) conditions.push(`level = '${options.level}'`);
      if (options.category) conditions.push(`category = '${options.category}'`);
      
      if (conditions.length > 0) {
        query += ' WHERE ' + conditions.join(' AND ');
      }
      
      query += ' ORDER BY timestamp DESC';
      if (options.limit) query += ` LIMIT ${parseInt(options.limit)}`;

      const result = await this.connection.run(query);
      return await result.getRows() || [];
    } catch (e) {
      console.error('[EventDB] Query all events failed:', e);
      return [];
    }
  }

  // ========== TRANSACTION LOGGING (JSON FILES) ==========

  async logTransaction(tx) {
    const spaceId = tx.spaceId;
    if (!spaceId) {
      console.warn('[EventDB] No spaceId provided for transaction, skipping');
      return false;
    }

    try {
      this.ensureLogsDir(spaceId);
      const filePath = this.getTransactionLogFile(spaceId);
      const transactions = this.readJsonFile(filePath);

      const newTx = {
        id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
        timestamp: tx.timestamp || new Date().toISOString(),
        type: tx.type || 'api_call',
        model: tx.model || null,
        inputTokens: tx.inputTokens || 0,
        outputTokens: tx.outputTokens || 0,
        cost: tx.cost || 0,
        status: tx.status || 'success',
        promptPreview: tx.promptPreview || null,
        responsePreview: tx.responsePreview || null,
        errorMessage: tx.errorMessage || null,
        durationMs: tx.durationMs || null,
        metadata: tx.metadata || null
      };

      transactions.unshift(newTx);

      // Keep last 500 transactions per space
      if (transactions.length > 500) {
        transactions.length = 500;
      }

      this.writeJsonFile(filePath, transactions);
      return true;
    } catch (e) {
      console.error('[EventDB] Failed to log transaction:', e);
      return false;
    }
  }

  async getTransactions(options = {}) {
    const spaceId = options.spaceId;
    
    if (spaceId) {
      const filePath = this.getTransactionLogFile(spaceId);
      let transactions = this.readJsonFile(filePath);

      if (options.model) {
        transactions = transactions.filter(t => t.model === options.model);
      }
      if (options.since) {
        transactions = transactions.filter(t => new Date(t.timestamp) >= new Date(options.since));
      }
      if (options.limit) {
        transactions = transactions.slice(0, parseInt(options.limit));
      }

      return transactions;
    } else if (this.duckdbReady) {
      return await this._queryAllTransactions(options);
    }
    return [];
  }

  async _queryAllTransactions(options) {
    try {
      const globPattern = path.join(this.spacesPath, '*', 'logs', 'transactions.json').replace(/\\/g, '/');
      let query = `SELECT * FROM read_json_auto('${globPattern}')`;
      
      if (options.model) query += ` WHERE model = '${options.model}'`;
      query += ' ORDER BY timestamp DESC';
      if (options.limit) query += ` LIMIT ${parseInt(options.limit)}`;

      const result = await this.connection.run(query);
      return await result.getRows() || [];
    } catch (e) {
      console.error('[EventDB] Query all transactions failed:', e);
      return [];
    }
  }

  // ========== ANALYTICS (FROM JSON FILES) ==========

  async getCostSummary(spaceId = null) {
    if (spaceId) {
      const transactions = await this.getTransactions({ spaceId });
      return {
        totalCalls: transactions.length,
        totalInputTokens: transactions.reduce((sum, t) => sum + (t.inputTokens || 0), 0),
        totalOutputTokens: transactions.reduce((sum, t) => sum + (t.outputTokens || 0), 0),
        totalCost: transactions.reduce((sum, t) => sum + (t.cost || 0), 0)
      };
    }

    // Aggregate across all spaces using DuckDB
    if (this.duckdbReady) {
      try {
        const globPattern = path.join(this.spacesPath, '*', 'logs', 'transactions.json').replace(/\\/g, '/');
        const result = await this.connection.run(`
          SELECT 
            COUNT(*) as total_calls,
            COALESCE(SUM(inputTokens), 0) as total_input_tokens,
            COALESCE(SUM(outputTokens), 0) as total_output_tokens,
            COALESCE(SUM(cost), 0) as total_cost
          FROM read_json_auto('${globPattern}')
        `);
        const rows = await result.getRows();
        if (rows && rows.length > 0) {
          const row = rows[0];
          // Convert snake_case to camelCase for consistency
          return {
            totalCalls: row.total_calls || 0,
            totalInputTokens: row.total_input_tokens || 0,
            totalOutputTokens: row.total_output_tokens || 0,
            totalCost: row.total_cost || 0
          };
        }
        return null;
      } catch (e) {
        console.error('[EventDB] Cost summary query failed:', e);
      }
    }
    return { totalCalls: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCost: 0 };
  }

  async getCostByModel(spaceId = null) {
    const transactions = spaceId 
      ? await this.getTransactions({ spaceId })
      : (this.duckdbReady ? await this._queryAllTransactions({}) : []);

    const byModel = {};
    for (const tx of transactions) {
      if (!tx.model) continue;
      if (!byModel[tx.model]) {
        byModel[tx.model] = { model: tx.model, calls: 0, input_tokens: 0, output_tokens: 0, total_cost: 0 };
      }
      byModel[tx.model].calls++;
      byModel[tx.model].input_tokens += tx.inputTokens || 0;
      byModel[tx.model].output_tokens += tx.outputTokens || 0;
      byModel[tx.model].total_cost += tx.cost || 0;
    }

    return Object.values(byModel).sort((a, b) => b.total_cost - a.total_cost);
  }

  async getDailyCosts(spaceId = null, days = 30) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const transactions = spaceId
      ? await this.getTransactions({ spaceId, since: since.toISOString() })
      : (this.duckdbReady ? await this._queryAllTransactions({ since: since.toISOString() }) : []);

    const byDay = {};
    for (const tx of transactions) {
      const day = tx.timestamp.split('T')[0];
      if (!byDay[day]) {
        byDay[day] = { date: day, calls: 0, total_cost: 0 };
      }
      byDay[day].calls++;
      byDay[day].total_cost += tx.cost || 0;
    }

    return Object.values(byDay).sort((a, b) => b.date.localeCompare(a.date));
  }

  // ========== QUERY SPACE JSON FILES (DuckDB) ==========

  async querySpaceMetadata(whereClause) {
    if (!this.duckdbReady) {
      await this.init();
    }
    if (!this.connection) return [];

    try {
      const globPattern = path.join(this.spacesPath, '*', 'space-metadata.json').replace(/\\/g, '/');
      const result = await this.connection.run(`
        SELECT * FROM read_json_auto('${globPattern}')
        ${whereClause ? 'WHERE ' + whereClause : ''}
      `);
      return await result.getRows() || [];
    } catch (e) {
      console.error('[EventDB] Query space metadata failed:', e);
      return [];
    }
  }

  async searchAcrossSpaces(searchTerm) {
    if (!this.duckdbReady) {
      await this.init();
    }
    if (!this.connection) return [];

    try {
      const globPattern = path.join(this.spacesPath, '*', 'space-metadata.json').replace(/\\/g, '/');
      const result = await this.connection.run(`
        SELECT spaceId, name, projectConfig
        FROM read_json_auto('${globPattern}')
        WHERE name ILIKE '%${searchTerm}%' 
           OR projectConfig.description ILIKE '%${searchTerm}%'
      `);
      return await result.getRows() || [];
    } catch (e) {
      console.error('[EventDB] Search spaces failed:', e);
      return [];
    }
  }

  // ========== RAW QUERY (DuckDB) ==========

  async query(sql) {
    if (!this.duckdbReady) {
      await this.init();
    }
    if (!this.connection) return [];

    try {
      const result = await this.connection.run(sql);
      return await result.getRows() || [];
    } catch (e) {
      console.error('[EventDB] Query failed:', e);
      return [];
    }
  }

  // ========== CLEANUP ==========

  async close() {
    if (this.connection) {
      await this.connection.close();
      this.connection = null;
    }
    if (this.instance) {
      await this.instance.close();
      this.instance = null;
    }
    this.duckdbReady = false;
  }
}

// Singleton instance
let eventDBInstance = null;

function getEventDB(appDataPath, spacesPath) {
  if (!eventDBInstance) {
    eventDBInstance = new EventDB(appDataPath, spacesPath);
  }
  return eventDBInstance;
}

module.exports = { EventDB, getEventDB };
