/**
 * Email Service -- IMAP/SMTP connection manager.
 *
 * Manages multiple email accounts with:
 * - ImapFlow for reading (IDLE-capable for real-time push)
 * - Nodemailer for sending
 * - Connection state machine with automatic reconnect
 * - Local message cache for fast agent queries
 */

'use strict';

const { ImapFlow } = require('imapflow');
const nodemailer = require('nodemailer');
const { simpleParser } = require('mailparser');
const { EventEmitter } = require('events');
const { v4: uuidv4 } = require('uuid');

const RECONNECT_DELAY_MS = 15_000;
const MAX_RECONNECT_ATTEMPTS = 5;
const POLL_FALLBACK_MS = 5 * 60 * 1000;

const PROVIDER_PRESETS = {
  gmail: {
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    setupUrl: 'https://myaccount.google.com/apppasswords',
    setupNote: 'Generate an App Password (requires 2-Step Verification).',
  },
  outlook: {
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp.office365.com', port: 587, secure: false },
    setupUrl: 'https://account.live.com/proofs/manage/additional',
    setupNote: 'Create an App Password from Security settings.',
  },
  yahoo: {
    imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true },
    setupUrl: 'https://login.yahoo.com/account/security',
    setupNote: 'Generate an App Password from Account Security.',
  },
  icloud: {
    imap: { host: 'imap.mail.me.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.me.com', port: 587, secure: false },
    setupUrl: 'https://appleid.apple.com/account/manage',
    setupNote: 'Generate an app-specific password from Apple ID.',
  },
};

/**
 * Per-account connection wrapper.
 * States: disconnected -> connecting -> connected -> idle -> error
 */
class EmailAccount extends EventEmitter {
  constructor(config, credentialFn) {
    super();
    this.id = config.id;
    this.label = config.label;
    this.email = config.email;
    this.provider = config.provider || 'custom';
    this.imapConfig = config.imap;
    this.smtpConfig = config.smtp;
    this._credentialFn = credentialFn;

    this._imap = null;
    this._smtp = null;
    this._state = 'disconnected';
    this._reconnectAttempts = 0;
    this._reconnectTimer = null;
    this._pollTimer = null;
    this._idleSupported = false;

    this._messageCache = new Map();
    this._lastSeenUid = 0;
  }

  get state() { return this._state; }

  _setState(s) {
    this._state = s;
    this.emit('state-change', { accountId: this.id, state: s });
  }

  async connect() {
    if (this._state === 'connected' || this._state === 'idle') return;
    this._setState('connecting');

    try {
      const password = await this._credentialFn(this.id);
      if (!password) throw new Error('No password found in keychain');

      this._imap = new ImapFlow({
        host: this.imapConfig.host,
        port: this.imapConfig.port,
        secure: this.imapConfig.secure,
        auth: { user: this.email, pass: password },
        logger: false,
        emitLogs: false,
      });

      this._imap.on('error', (err) => this._handleImapError(err));
      this._imap.on('close', () => this._handleImapClose());

      await this._imap.connect();
      this._reconnectAttempts = 0;
      this._setState('connected');

      this._setupSmtp(password);
      this._startListening();
    } catch (err) {
      this._setState('error');
      this.emit('error', { accountId: this.id, error: err.message });
      this._scheduleReconnect();
    }
  }

  _setupSmtp(password) {
    this._smtp = nodemailer.createTransport({
      host: this.smtpConfig.host,
      port: this.smtpConfig.port,
      secure: this.smtpConfig.secure,
      auth: { user: this.email, pass: password },
    });
  }

  async _startListening() {
    try {
      const lock = await this._imap.getMailboxLock('INBOX');
      try {
        this._imap.on('exists', (data) => {
          this.emit('new-mail', { accountId: this.id, count: data.count });
        });
        this._idleSupported = true;
        this._setState('idle');
      } finally {
        lock.release();
      }
    } catch (_err) {
      this._idleSupported = false;
      this._startPollFallback();
    }
  }

  _startPollFallback() {
    if (this._pollTimer) return;
    this._pollTimer = setInterval(() => {
      this.emit('new-mail', { accountId: this.id, count: -1 });
    }, POLL_FALLBACK_MS);
  }

  _handleImapError(err) {
    console.error(`[EmailService] IMAP error on ${this.id}:`, err.message);
    this._setState('error');
    this.emit('error', { accountId: this.id, error: err.message });
  }

  _handleImapClose() {
    if (this._state !== 'disconnected') {
      this._setState('error');
      this.emit('connection-lost', { accountId: this.id });
      this._scheduleReconnect();
    }
  }

  _scheduleReconnect() {
    if (this._reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.emit('error', {
        accountId: this.id,
        error: `Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached`,
      });
      return;
    }
    this._reconnectAttempts++;
    const delay = RECONNECT_DELAY_MS * this._reconnectAttempts;
    this._reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  async disconnect() {
    this._setState('disconnected');
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    if (this._pollTimer) clearInterval(this._pollTimer);
    this._pollTimer = null;
    if (this._imap) {
      try { await this._imap.logout(); } catch (_) { /* best effort */ }
      this._imap = null;
    }
    if (this._smtp) {
      this._smtp.close();
      this._smtp = null;
    }
  }

  async fetchInbox({ count = 20, unreadOnly = false } = {}) {
    if (!this._imap || this._state === 'disconnected') {
      return { connected: false, emails: [], total: 0 };
    }

    const lock = await this._imap.getMailboxLock('INBOX');
    try {
      const status = await this._imap.status('INBOX', { messages: true, unseen: true });
      const range = `${Math.max(1, status.messages - count + 1)}:*`;
      const messages = [];

      for await (const msg of this._imap.fetch(range, {
        envelope: true,
        flags: true,
        bodyStructure: true,
        uid: true,
      })) {
        if (unreadOnly && msg.flags.has('\\Seen')) continue;
        const parsed = this._envelopeToMessage(msg);
        messages.push(parsed);
        this._messageCache.set(parsed.uid, parsed);
      }

      messages.reverse();

      return {
        connected: true,
        emails: messages.slice(0, count),
        total: status.messages,
        unread: status.unseen,
      };
    } finally {
      lock.release();
    }
  }

  async fetchMessage(uid) {
    if (!this._imap || this._state === 'disconnected') return null;

    const lock = await this._imap.getMailboxLock('INBOX');
    try {
      const source = await this._imap.download(String(uid), undefined, { uid: true });
      if (!source || !source.content) return null;

      const chunks = [];
      for await (const chunk of source.content) chunks.push(chunk);
      const buffer = Buffer.concat(chunks);
      const parsed = await simpleParser(buffer);

      return {
        uid,
        messageId: parsed.messageId,
        inReplyTo: parsed.inReplyTo || null,
        references: parsed.references || [],
        from: parsed.from?.text || '',
        to: parsed.to?.text || '',
        cc: parsed.cc?.text || '',
        subject: parsed.subject || '',
        date: parsed.date?.toISOString() || null,
        text: parsed.text || '',
        html: parsed.html || '',
        attachments: (parsed.attachments || []).map((a) => ({
          filename: a.filename,
          contentType: a.contentType,
          size: a.size,
        })),
      };
    } finally {
      lock.release();
    }
  }

  async searchMessages(query, { count = 20 } = {}) {
    if (!this._imap || this._state === 'disconnected') {
      return { connected: false, emails: [], query };
    }

    const lock = await this._imap.getMailboxLock('INBOX');
    try {
      const uids = await this._imap.search({ or: [
        { subject: query },
        { from: query },
        { body: query },
      ] }, { uid: true });

      const subset = uids.slice(-count);
      const messages = [];

      if (subset.length > 0) {
        const uidRange = subset.join(',');
        for await (const msg of this._imap.fetch(uidRange, {
          envelope: true,
          flags: true,
          uid: true,
        })) {
          messages.push(this._envelopeToMessage(msg));
        }
      }

      messages.reverse();
      return { connected: true, emails: messages, query };
    } finally {
      lock.release();
    }
  }

  async send({ to, cc, bcc, subject, body, inReplyTo, references }) {
    if (!this._smtp) {
      return { success: false, message: 'SMTP not connected' };
    }

    const mailOptions = {
      from: this.email,
      to,
      cc,
      bcc,
      subject,
      text: body,
      inReplyTo,
      references,
    };

    const info = await this._smtp.sendMail(mailOptions);
    return { success: true, messageId: info.messageId, message: `Sent to ${to}` };
  }

  async flagMessage(uid, flag, add = true) {
    if (!this._imap || this._state === 'disconnected') return false;
    const lock = await this._imap.getMailboxLock('INBOX');
    try {
      if (add) {
        await this._imap.messageFlagsAdd(String(uid), [flag], { uid: true });
      } else {
        await this._imap.messageFlagsRemove(String(uid), [flag], { uid: true });
      }
      return true;
    } finally {
      lock.release();
    }
  }

  async markRead(uid) { return this.flagMessage(uid, '\\Seen', true); }
  async markFlagged(uid) { return this.flagMessage(uid, '\\Flagged', true); }
  async unflag(uid) { return this.flagMessage(uid, '\\Flagged', false); }

  _envelopeToMessage(msg) {
    const env = msg.envelope || {};
    return {
      uid: msg.uid,
      flags: Array.from(msg.flags || []),
      messageId: env.messageId || null,
      inReplyTo: env.inReplyTo || null,
      from: env.from?.[0] ? `${env.from[0].name || ''} <${env.from[0].address}>`.trim() : '',
      fromAddress: env.from?.[0]?.address || '',
      to: (env.to || []).map((a) => a.address).join(', '),
      cc: (env.cc || []).map((a) => a.address).join(', '),
      subject: env.subject || '(no subject)',
      date: env.date ? new Date(env.date).toISOString() : null,
      isRead: (msg.flags || new Set()).has('\\Seen'),
      isFlagged: (msg.flags || new Set()).has('\\Flagged'),
    };
  }
}

/**
 * Singleton email service managing all accounts.
 */
class EmailService extends EventEmitter {
  constructor() {
    super();
    this._accounts = new Map();
    this._credentialManager = null;
    this._settingsManager = null;
    this._initialized = false;
  }

  init({ credentialManager, settingsManager }) {
    this._credentialManager = credentialManager;
    this._settingsManager = settingsManager;
    this._initialized = true;
  }

  getProviderPresets() {
    return PROVIDER_PRESETS;
  }

  getProviderPreset(provider) {
    return PROVIDER_PRESETS[provider] || null;
  }

  _getAccounts() {
    if (!this._settingsManager) return [];
    return this._settingsManager.get('emailAccounts') || [];
  }

  _saveAccounts(accounts) {
    if (!this._settingsManager) return;
    this._settingsManager.set('emailAccounts', accounts);
  }

  async _getPassword(accountId) {
    if (!this._credentialManager) return null;
    return this._credentialManager.getEmailPassword(accountId);
  }

  async addAccount({ label, email, provider, imap, smtp, password }) {
    const id = uuidv4();
    const preset = PROVIDER_PRESETS[provider];
    const config = {
      id,
      label: label || email,
      email,
      provider: provider || 'custom',
      imap: imap || preset?.imap,
      smtp: smtp || preset?.smtp,
    };

    if (!config.imap || !config.smtp) {
      throw new Error('IMAP and SMTP configuration required');
    }

    if (this._credentialManager && password) {
      await this._credentialManager.saveEmailPassword(id, password);
    }

    const accounts = this._getAccounts();
    accounts.push({ id, label: config.label, email, provider: config.provider, imap: config.imap, smtp: config.smtp });
    this._saveAccounts(accounts);

    return config;
  }

  async removeAccount(accountId) {
    const existing = this._accounts.get(accountId);
    if (existing) {
      await existing.disconnect();
      this._accounts.delete(accountId);
    }
    if (this._credentialManager) {
      await this._credentialManager.deleteEmailPassword(accountId);
    }
    const accounts = this._getAccounts().filter((a) => a.id !== accountId);
    this._saveAccounts(accounts);
    return true;
  }

  async updateAccount(accountId, updates) {
    const accounts = this._getAccounts();
    const idx = accounts.findIndex((a) => a.id === accountId);
    if (idx === -1) throw new Error(`Account ${accountId} not found`);

    Object.assign(accounts[idx], updates);
    this._saveAccounts(accounts);

    if (updates.password && this._credentialManager) {
      await this._credentialManager.saveEmailPassword(accountId, updates.password);
    }

    const existing = this._accounts.get(accountId);
    if (existing) {
      await existing.disconnect();
      this._accounts.delete(accountId);
    }

    return accounts[idx];
  }

  async connectAccount(accountId) {
    const accounts = this._getAccounts();
    const config = accounts.find((a) => a.id === accountId);
    if (!config) throw new Error(`Account ${accountId} not found`);

    if (this._accounts.has(accountId)) {
      await this._accounts.get(accountId).disconnect();
    }

    const account = new EmailAccount(config, (id) => this._getPassword(id));

    account.on('new-mail', (data) => this.emit('new-mail', data));
    account.on('error', (data) => this.emit('account-error', data));
    account.on('connection-lost', (data) => this.emit('connection-lost', data));
    account.on('state-change', (data) => this.emit('account-state-change', data));

    this._accounts.set(accountId, account);
    await account.connect();
    return { accountId, state: account.state };
  }

  async connectAll() {
    const accounts = this._getAccounts();
    const results = [];
    for (const acct of accounts) {
      try {
        const result = await this.connectAccount(acct.id);
        results.push(result);
      } catch (err) {
        results.push({ accountId: acct.id, state: 'error', error: err.message });
      }
    }
    return results;
  }

  async disconnectAll() {
    for (const account of this._accounts.values()) {
      await account.disconnect();
    }
    this._accounts.clear();
  }

  getAccountStatuses() {
    const accounts = this._getAccounts();
    return accounts.map((a) => {
      const live = this._accounts.get(a.id);
      return {
        id: a.id,
        label: a.label,
        email: a.email,
        provider: a.provider,
        state: live ? live.state : 'disconnected',
      };
    });
  }

  _getConnectedAccount(accountId) {
    if (accountId) {
      const acct = this._accounts.get(accountId);
      if (!acct) return null;
      return acct;
    }
    for (const acct of this._accounts.values()) {
      if (acct.state === 'idle' || acct.state === 'connected') return acct;
    }
    return this._accounts.values().next().value || null;
  }

  async fetchInbox(accountId, opts) {
    const acct = this._getConnectedAccount(accountId);
    if (!acct) return { connected: false, emails: [], total: 0 };
    return acct.fetchInbox(opts);
  }

  async fetchMessage(accountId, uid) {
    const acct = this._getConnectedAccount(accountId);
    if (!acct) return null;
    return acct.fetchMessage(uid);
  }

  async searchMessages(accountId, query, opts) {
    const acct = this._getConnectedAccount(accountId);
    if (!acct) return { connected: false, emails: [], query };
    return acct.searchMessages(query, opts);
  }

  async send(accountId, message) {
    const acct = this._getConnectedAccount(accountId);
    if (!acct) return { success: false, message: 'No connected account' };
    return acct.send(message);
  }

  async markRead(accountId, uid) {
    const acct = this._getConnectedAccount(accountId);
    if (!acct) return false;
    return acct.markRead(uid);
  }

  async markFlagged(accountId, uid) {
    const acct = this._getConnectedAccount(accountId);
    if (!acct) return false;
    return acct.markFlagged(uid);
  }

  async getSummary(accountId) {
    const acct = this._getConnectedAccount(accountId);
    if (!acct) {
      return { connected: false, unreadCount: 0, urgentEmails: [], recentEmails: [] };
    }
    const inbox = await acct.fetchInbox({ count: 30 });
    if (!inbox.connected) {
      return { connected: false, unreadCount: 0, urgentEmails: [], recentEmails: [] };
    }

    const unread = inbox.emails.filter((e) => !e.isRead);
    const flagged = inbox.emails.filter((e) => e.isFlagged);

    return {
      connected: true,
      unreadCount: inbox.unread || unread.length,
      urgentEmails: flagged,
      recentEmails: inbox.emails.slice(0, 10),
      totalMessages: inbox.total,
    };
  }

  async testConnection({ email, password, imap, smtp }) {
    const errors = [];

    try {
      const client = new ImapFlow({
        host: imap.host,
        port: imap.port,
        secure: imap.secure,
        auth: { user: email, pass: password },
        logger: false,
        emitLogs: false,
      });
      await client.connect();
      await client.logout();
    } catch (err) {
      errors.push({ type: 'imap', error: err.message });
    }

    try {
      const transport = nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure,
        auth: { user: email, pass: password },
      });
      await transport.verify();
      transport.close();
    } catch (err) {
      errors.push({ type: 'smtp', error: err.message });
    }

    return {
      success: errors.length === 0,
      errors,
      imap: errors.find((e) => e.type === 'imap') ? 'failed' : 'ok',
      smtp: errors.find((e) => e.type === 'smtp') ? 'failed' : 'ok',
    };
  }
}

let _instance = null;
function getEmailService() {
  if (!_instance) _instance = new EmailService();
  return _instance;
}

module.exports = { EmailService, EmailAccount, getEmailService, PROVIDER_PRESETS };
