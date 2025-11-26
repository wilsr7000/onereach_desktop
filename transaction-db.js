/**
 * Transaction Database for GSX Create
 * SQLite-based storage for API transactions, costs, and logs
 */

const path = require('path');
const fs = require('fs');

let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  console.warn('[TransactionDB] better-sqlite3 not installed, falling back to JSON storage');
  Database = null;
}

class TransactionDB {
  constructor(appDataPath) {
    this.appDataPath = appDataPath;
    this.dbPath = path.join(appDataPath, 'gsx-transactions.db');
    this.db = null;
    this.useSqlite = !!Database;
    
    // Fallback JSON storage
    this.jsonPath = path.join(appDataPath, 'gsx-transactions.json');
    this.jsonData = null;
    
    this.init();
  }

  init() {
    // Ensure directory exists
    if (!fs.existsSync(this.appDataPath)) {
      fs.mkdirSync(this.appDataPath, { recursive: true });
    }

    if (this.useSqlite) {
      this.initSqlite();
    } else {
      this.initJson();
    }
  }

  initSqlite() {
    try {
      this.db = new Database(this.dbPath);
      
      // Create tables
      this.db.exec(`
        -- API Transactions
        CREATE TABLE IF NOT EXISTS transactions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp TEXT NOT NULL,
          space_id TEXT,
          space_name TEXT,
          type TEXT NOT NULL,
          model TEXT,
          input_tokens INTEGER DEFAULT 0,
          output_tokens INTEGER DEFAULT 0,
          cost REAL DEFAULT 0,
          status TEXT DEFAULT 'success',
          prompt_preview TEXT,
          response_preview TEXT,
          error_message TEXT,
          metadata TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        -- Daily summaries for fast aggregation
        CREATE TABLE IF NOT EXISTS daily_summaries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          date TEXT NOT NULL,
          space_id TEXT,
          total_cost REAL DEFAULT 0,
          total_calls INTEGER DEFAULT 0,
          total_input_tokens INTEGER DEFAULT 0,
          total_output_tokens INTEGER DEFAULT 0,
          UNIQUE(date, space_id)
        );

        -- Model usage stats
        CREATE TABLE IF NOT EXISTS model_stats (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          model TEXT NOT NULL,
          space_id TEXT,
          total_cost REAL DEFAULT 0,
          total_calls INTEGER DEFAULT 0,
          total_input_tokens INTEGER DEFAULT 0,
          total_output_tokens INTEGER DEFAULT 0,
          last_used TEXT,
          UNIQUE(model, space_id)
        );

        -- Event logs (general app events)
        CREATE TABLE IF NOT EXISTS event_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp TEXT NOT NULL,
          level TEXT DEFAULT 'info',
          category TEXT,
          message TEXT,
          data TEXT,
          space_id TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        -- Create indexes for common queries
        CREATE INDEX IF NOT EXISTS idx_transactions_timestamp ON transactions(timestamp);
        CREATE INDEX IF NOT EXISTS idx_transactions_space ON transactions(space_id);
        CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type);
        CREATE INDEX IF NOT EXISTS idx_transactions_model ON transactions(model);
        CREATE INDEX IF NOT EXISTS idx_daily_summaries_date ON daily_summaries(date);
        CREATE INDEX IF NOT EXISTS idx_event_logs_timestamp ON event_logs(timestamp);
        CREATE INDEX IF NOT EXISTS idx_event_logs_category ON event_logs(category);
      `);

      console.log('[TransactionDB] SQLite database initialized at:', this.dbPath);
    } catch (error) {
      console.error('[TransactionDB] SQLite init error:', error);
      this.useSqlite = false;
      this.initJson();
    }
  }

  initJson() {
    try {
      if (fs.existsSync(this.jsonPath)) {
        this.jsonData = JSON.parse(fs.readFileSync(this.jsonPath, 'utf8'));
      } else {
        this.jsonData = {
          transactions: [],
          dailySummaries: {},
          modelStats: {},
          eventLogs: []
        };
        this.saveJson();
      }
      console.log('[TransactionDB] JSON fallback initialized at:', this.jsonPath);
    } catch (error) {
      console.error('[TransactionDB] JSON init error:', error);
      this.jsonData = { transactions: [], dailySummaries: {}, modelStats: {}, eventLogs: [] };
    }
  }

  saveJson() {
    try {
      fs.writeFileSync(this.jsonPath, JSON.stringify(this.jsonData, null, 2));
    } catch (error) {
      console.error('[TransactionDB] JSON save error:', error);
    }
  }

  /**
   * Record an API transaction
   */
  recordTransaction(data) {
    const {
      spaceId = null,
      spaceName = null,
      type = 'prompt',
      model = 'unknown',
      inputTokens = 0,
      outputTokens = 0,
      cost = 0,
      status = 'success',
      promptPreview = '',
      responsePreview = '',
      errorMessage = null,
      metadata = {}
    } = data;

    const timestamp = new Date().toISOString();
    const date = timestamp.split('T')[0];

    if (this.useSqlite) {
      try {
        // Insert transaction
        const stmt = this.db.prepare(`
          INSERT INTO transactions (timestamp, space_id, space_name, type, model, input_tokens, output_tokens, cost, status, prompt_preview, response_preview, error_message, metadata)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const result = stmt.run(timestamp, spaceId, spaceName, type, model, inputTokens, outputTokens, cost, status, promptPreview, responsePreview, errorMessage, JSON.stringify(metadata));

        // Update daily summary
        this.db.prepare(`
          INSERT INTO daily_summaries (date, space_id, total_cost, total_calls, total_input_tokens, total_output_tokens)
          VALUES (?, ?, ?, 1, ?, ?)
          ON CONFLICT(date, space_id) DO UPDATE SET
            total_cost = total_cost + excluded.total_cost,
            total_calls = total_calls + 1,
            total_input_tokens = total_input_tokens + excluded.total_input_tokens,
            total_output_tokens = total_output_tokens + excluded.total_output_tokens
        `).run(date, spaceId, cost, inputTokens, outputTokens);

        // Update model stats
        this.db.prepare(`
          INSERT INTO model_stats (model, space_id, total_cost, total_calls, total_input_tokens, total_output_tokens, last_used)
          VALUES (?, ?, ?, 1, ?, ?, ?)
          ON CONFLICT(model, space_id) DO UPDATE SET
            total_cost = total_cost + excluded.total_cost,
            total_calls = total_calls + 1,
            total_input_tokens = total_input_tokens + excluded.total_input_tokens,
            total_output_tokens = total_output_tokens + excluded.total_output_tokens,
            last_used = excluded.last_used
        `).run(model, spaceId, cost, inputTokens, outputTokens, timestamp);

        console.log('[TransactionDB] Transaction recorded:', result.lastInsertRowid);
        return { success: true, id: result.lastInsertRowid };
      } catch (error) {
        console.error('[TransactionDB] Record error:', error);
        return { success: false, error: error.message };
      }
    } else {
      // JSON fallback
      const id = Date.now();
      this.jsonData.transactions.unshift({
        id, timestamp, spaceId, spaceName, type, model, inputTokens, outputTokens, cost, status, promptPreview, responsePreview, errorMessage, metadata
      });

      // Keep last 10000 transactions
      if (this.jsonData.transactions.length > 10000) {
        this.jsonData.transactions = this.jsonData.transactions.slice(0, 10000);
      }

      // Update daily summary
      const key = `${date}_${spaceId || 'global'}`;
      if (!this.jsonData.dailySummaries[key]) {
        this.jsonData.dailySummaries[key] = { date, spaceId, totalCost: 0, totalCalls: 0, totalInputTokens: 0, totalOutputTokens: 0 };
      }
      this.jsonData.dailySummaries[key].totalCost += cost;
      this.jsonData.dailySummaries[key].totalCalls += 1;
      this.jsonData.dailySummaries[key].totalInputTokens += inputTokens;
      this.jsonData.dailySummaries[key].totalOutputTokens += outputTokens;

      // Update model stats
      const modelKey = `${model}_${spaceId || 'global'}`;
      if (!this.jsonData.modelStats[modelKey]) {
        this.jsonData.modelStats[modelKey] = { model, spaceId, totalCost: 0, totalCalls: 0, totalInputTokens: 0, totalOutputTokens: 0 };
      }
      this.jsonData.modelStats[modelKey].totalCost += cost;
      this.jsonData.modelStats[modelKey].totalCalls += 1;
      this.jsonData.modelStats[modelKey].totalInputTokens += inputTokens;
      this.jsonData.modelStats[modelKey].totalOutputTokens += outputTokens;
      this.jsonData.modelStats[modelKey].lastUsed = timestamp;

      this.saveJson();
      return { success: true, id };
    }
  }

  /**
   * Log an event
   */
  logEvent(level, category, message, data = {}, spaceId = null) {
    const timestamp = new Date().toISOString();

    if (this.useSqlite) {
      try {
        const stmt = this.db.prepare(`
          INSERT INTO event_logs (timestamp, level, category, message, data, space_id)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        stmt.run(timestamp, level, category, message, JSON.stringify(data), spaceId);
      } catch (error) {
        console.error('[TransactionDB] Log event error:', error);
      }
    } else {
      this.jsonData.eventLogs.unshift({ timestamp, level, category, message, data, spaceId });
      if (this.jsonData.eventLogs.length > 5000) {
        this.jsonData.eventLogs = this.jsonData.eventLogs.slice(0, 5000);
      }
      this.saveJson();
    }
  }

  /**
   * Get transactions with filters
   */
  getTransactions(options = {}) {
    const {
      spaceId = null,
      type = null,
      model = null,
      startDate = null,
      endDate = null,
      limit = 100,
      offset = 0
    } = options;

    if (this.useSqlite) {
      let sql = 'SELECT * FROM transactions WHERE 1=1';
      const params = [];

      if (spaceId) { sql += ' AND space_id = ?'; params.push(spaceId); }
      if (type) { sql += ' AND type = ?'; params.push(type); }
      if (model) { sql += ' AND model = ?'; params.push(model); }
      if (startDate) { sql += ' AND timestamp >= ?'; params.push(startDate); }
      if (endDate) { sql += ' AND timestamp <= ?'; params.push(endDate); }

      sql += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
      params.push(limit, offset);

      return this.db.prepare(sql).all(...params);
    } else {
      let results = this.jsonData.transactions;
      if (spaceId) results = results.filter(t => t.spaceId === spaceId);
      if (type) results = results.filter(t => t.type === type);
      if (model) results = results.filter(t => t.model === model);
      if (startDate) results = results.filter(t => t.timestamp >= startDate);
      if (endDate) results = results.filter(t => t.timestamp <= endDate);
      return results.slice(offset, offset + limit);
    }
  }

  /**
   * Get summary statistics
   */
  getSummary(spaceId = null, days = 30) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const startDateStr = startDate.toISOString().split('T')[0];

    if (this.useSqlite) {
      const whereClause = spaceId ? 'WHERE space_id = ?' : '';
      const params = spaceId ? [spaceId] : [];

      const totals = this.db.prepare(`
        SELECT 
          COUNT(*) as totalCalls,
          COALESCE(SUM(cost), 0) as totalCost,
          COALESCE(SUM(input_tokens), 0) as totalInputTokens,
          COALESCE(SUM(output_tokens), 0) as totalOutputTokens
        FROM transactions ${whereClause}
      `).get(...params);

      const today = new Date().toISOString().split('T')[0];
      const todayParams = spaceId ? [today, spaceId] : [today];
      const todayStats = this.db.prepare(`
        SELECT 
          COUNT(*) as calls,
          COALESCE(SUM(cost), 0) as cost
        FROM transactions 
        WHERE DATE(timestamp) = ? ${spaceId ? 'AND space_id = ?' : ''}
      `).get(...todayParams);

      const dailyParams = spaceId ? [startDateStr, spaceId] : [startDateStr];
      const dailyData = this.db.prepare(`
        SELECT date, total_cost, total_calls
        FROM daily_summaries
        WHERE date >= ? ${spaceId ? 'AND space_id = ?' : ''}
        ORDER BY date DESC
      `).all(...dailyParams);

      const modelData = this.db.prepare(`
        SELECT model, total_cost, total_calls, total_input_tokens, total_output_tokens
        FROM model_stats
        ${whereClause}
        ORDER BY total_cost DESC
      `).all(...params);

      const recentCalls = this.db.prepare(`
        SELECT * FROM transactions
        ${whereClause}
        ORDER BY timestamp DESC
        LIMIT 20
      `).all(...params);

      return {
        totalCost: totals.totalCost,
        totalCalls: totals.totalCalls,
        totalInputTokens: totals.totalInputTokens,
        totalOutputTokens: totals.totalOutputTokens,
        todayCost: todayStats.cost,
        todayCalls: todayStats.calls,
        dailyData,
        modelBreakdown: modelData.reduce((acc, m) => {
          acc[m.model] = { cost: m.total_cost, calls: m.total_calls, inputTokens: m.total_input_tokens, outputTokens: m.total_output_tokens };
          return acc;
        }, {}),
        recentCalls
      };
    } else {
      // JSON fallback
      let transactions = this.jsonData.transactions;
      if (spaceId) transactions = transactions.filter(t => t.spaceId === spaceId);

      const today = new Date().toISOString().split('T')[0];
      const todayTx = transactions.filter(t => t.timestamp.startsWith(today));

      return {
        totalCost: transactions.reduce((sum, t) => sum + (t.cost || 0), 0),
        totalCalls: transactions.length,
        totalInputTokens: transactions.reduce((sum, t) => sum + (t.inputTokens || 0), 0),
        totalOutputTokens: transactions.reduce((sum, t) => sum + (t.outputTokens || 0), 0),
        todayCost: todayTx.reduce((sum, t) => sum + (t.cost || 0), 0),
        todayCalls: todayTx.length,
        dailyData: Object.values(this.jsonData.dailySummaries).filter(d => !spaceId || d.spaceId === spaceId),
        modelBreakdown: Object.values(this.jsonData.modelStats).filter(m => !spaceId || m.spaceId === spaceId).reduce((acc, m) => {
          acc[m.model] = { cost: m.totalCost, calls: m.totalCalls, inputTokens: m.totalInputTokens, outputTokens: m.totalOutputTokens };
          return acc;
        }, {}),
        recentCalls: transactions.slice(0, 20)
      };
    }
  }

  /**
   * Get event logs
   */
  getEventLogs(options = {}) {
    const { category = null, level = null, spaceId = null, limit = 100, offset = 0 } = options;

    if (this.useSqlite) {
      let sql = 'SELECT * FROM event_logs WHERE 1=1';
      const params = [];

      if (category) { sql += ' AND category = ?'; params.push(category); }
      if (level) { sql += ' AND level = ?'; params.push(level); }
      if (spaceId) { sql += ' AND space_id = ?'; params.push(spaceId); }

      sql += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
      params.push(limit, offset);

      return this.db.prepare(sql).all(...params);
    } else {
      let results = this.jsonData.eventLogs;
      if (category) results = results.filter(e => e.category === category);
      if (level) results = results.filter(e => e.level === level);
      if (spaceId) results = results.filter(e => e.spaceId === spaceId);
      return results.slice(offset, offset + limit);
    }
  }

  /**
   * Export data to JSON
   */
  exportToJson() {
    if (this.useSqlite) {
      return {
        transactions: this.db.prepare('SELECT * FROM transactions ORDER BY timestamp DESC').all(),
        dailySummaries: this.db.prepare('SELECT * FROM daily_summaries ORDER BY date DESC').all(),
        modelStats: this.db.prepare('SELECT * FROM model_stats').all(),
        eventLogs: this.db.prepare('SELECT * FROM event_logs ORDER BY timestamp DESC LIMIT 1000').all()
      };
    } else {
      return this.jsonData;
    }
  }

  /**
   * Get database info
   */
  getInfo() {
    if (this.useSqlite) {
      const stats = fs.statSync(this.dbPath);
      const txCount = this.db.prepare('SELECT COUNT(*) as count FROM transactions').get();
      const logCount = this.db.prepare('SELECT COUNT(*) as count FROM event_logs').get();
      return {
        type: 'sqlite',
        path: this.dbPath,
        size: stats.size,
        sizeFormatted: (stats.size / 1024 / 1024).toFixed(2) + ' MB',
        transactionCount: txCount.count,
        eventLogCount: logCount.count
      };
    } else {
      const stats = fs.existsSync(this.jsonPath) ? fs.statSync(this.jsonPath) : { size: 0 };
      return {
        type: 'json',
        path: this.jsonPath,
        size: stats.size,
        sizeFormatted: (stats.size / 1024).toFixed(2) + ' KB',
        transactionCount: this.jsonData.transactions.length,
        eventLogCount: this.jsonData.eventLogs.length
      };
    }
  }

  /**
   * Close database connection
   */
  close() {
    if (this.useSqlite && this.db) {
      this.db.close();
      console.log('[TransactionDB] Database closed');
    }
  }
}

// Singleton instance
let instance = null;

function getTransactionDB(appDataPath) {
  if (!instance) {
    instance = new TransactionDB(appDataPath);
  }
  return instance;
}

module.exports = { TransactionDB, getTransactionDB };

