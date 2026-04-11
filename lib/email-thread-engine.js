/**
 * Email Thread Engine -- threading and triage scoring.
 *
 * Groups flat messages into threads using RFC 5322 References/In-Reply-To
 * headers, then scores each thread on a 0-100 triage scale based on:
 *   - Thread velocity (messages/hr)
 *   - Recency (time since last message)
 *   - Direct vs CC addressing
 *   - Sender importance (learned VIPs + frequency)
 *   - Awaiting-response state
 *   - Thread depth (conversation vs single)
 *   - AI-assessed urgency from subject/body
 */

'use strict';

const WEIGHTS = {
  threadVelocity: 0.20,
  recency:        0.15,
  directAddress:  0.15,
  senderImport:   0.15,
  awaitingReply:  0.15,
  threadDepth:    0.10,
  sentiment:      0.10,
};

const PRIORITY_THRESHOLDS = {
  critical: 80,
  high:     60,
  medium:   30,
  low:      0,
};

class EmailThreadEngine {
  constructor({ userEmail, ai } = {}) {
    this._userEmail = (userEmail || '').toLowerCase();
    this._ai = ai;
    this._senderFrequency = new Map();
    this._vipSenders = new Set();
    this._threads = new Map();
  }

  setUserEmail(email) {
    this._userEmail = (email || '').toLowerCase();
  }

  addVipSender(email) {
    this._vipSenders.add(email.toLowerCase());
  }

  removeVipSender(email) {
    this._vipSenders.delete(email.toLowerCase());
  }

  /**
   * Build threads from a flat list of messages.
   * Each message should have: uid, messageId, inReplyTo, references,
   * from, fromAddress, to, cc, subject, date, isRead, isFlagged
   */
  buildThreads(messages) {
    const byMessageId = new Map();
    const threadMap = new Map();

    for (const msg of messages) {
      if (msg.messageId) byMessageId.set(msg.messageId, msg);
      this._trackSenderFrequency(msg.fromAddress);
    }

    for (const msg of messages) {
      const threadId = this._resolveThreadId(msg, byMessageId, threadMap);

      if (!threadMap.has(threadId)) {
        threadMap.set(threadId, {
          id: threadId,
          subject: this._normalizeSubject(msg.subject),
          messages: [],
          participants: new Set(),
          firstDate: null,
          lastDate: null,
        });
      }

      const thread = threadMap.get(threadId);
      thread.messages.push(msg);
      if (msg.fromAddress) thread.participants.add(msg.fromAddress.toLowerCase());

      const msgDate = msg.date ? new Date(msg.date) : null;
      if (msgDate) {
        if (!thread.firstDate || msgDate < thread.firstDate) thread.firstDate = msgDate;
        if (!thread.lastDate || msgDate > thread.lastDate) thread.lastDate = msgDate;
      }
    }

    for (const thread of threadMap.values()) {
      thread.messages.sort((a, b) => {
        const da = a.date ? new Date(a.date).getTime() : 0;
        const db = b.date ? new Date(b.date).getTime() : 0;
        return da - db;
      });
      thread.participants = Array.from(thread.participants);
    }

    this._threads = threadMap;
    return Array.from(threadMap.values());
  }

  _resolveThreadId(msg, byMessageId, threadMap) {
    const refs = msg.references || [];
    const allRefs = msg.inReplyTo ? [msg.inReplyTo, ...refs] : refs;

    for (const ref of allRefs) {
      for (const [threadId, thread] of threadMap) {
        if (thread.messages.some((m) => m.messageId === ref)) {
          return threadId;
        }
      }
    }

    if (allRefs.length > 0) {
      return allRefs[0];
    }

    const normalized = this._normalizeSubject(msg.subject);
    for (const [threadId, thread] of threadMap) {
      if (thread.subject === normalized) {
        return threadId;
      }
    }

    return msg.messageId || `thread-${msg.uid}`;
  }

  _normalizeSubject(subject) {
    return (subject || '')
      .replace(/^(re|fwd?|fw)\s*:\s*/gi, '')
      .replace(/^(re|fwd?|fw)\s*:\s*/gi, '')
      .trim()
      .toLowerCase();
  }

  _trackSenderFrequency(address) {
    if (!address) return;
    const key = address.toLowerCase();
    this._senderFrequency.set(key, (this._senderFrequency.get(key) || 0) + 1);
  }

  /**
   * Score all threads and return sorted by triage score descending.
   * Optionally uses AI for sentiment analysis on top threads.
   */
  async scoreThreads(threads, { useAI = false, topN = 10 } = {}) {
    const now = Date.now();
    const scored = [];

    for (const thread of threads) {
      const signals = this._computeSignals(thread, now);
      let sentimentScore = 50;

      if (useAI && this._ai && scored.length < topN) {
        sentimentScore = await this._aiAssessUrgency(thread);
      }

      signals.sentiment = sentimentScore;
      const composite = this._compositeScore(signals);

      scored.push({
        ...thread,
        triageScore: Math.round(composite),
        priority: this._scoreToPriority(composite),
        signals,
        messageCount: thread.messages.length,
        isConversation: thread.messages.length > 1,
        awaitingReply: signals._awaitingReply,
        hasUnread: thread.messages.some((m) => !m.isRead),
        hasFlagged: thread.messages.some((m) => m.isFlagged),
      });
    }

    scored.sort((a, b) => b.triageScore - a.triageScore);
    return scored;
  }

  _computeSignals(thread, now) {
    const msgs = thread.messages;
    const lastMsg = msgs[msgs.length - 1];
    const lastDate = thread.lastDate ? thread.lastDate.getTime() : now;
    const firstDate = thread.firstDate ? thread.firstDate.getTime() : lastDate;
    const spanHours = Math.max((lastDate - firstDate) / 3_600_000, 0.1);

    // Thread velocity: messages per hour, capped at 100
    const velocity = msgs.length / spanHours;
    const velocityScore = Math.min(velocity * 25, 100);

    // Recency: exponential decay, halves every 12 hours
    const ageHours = (now - lastDate) / 3_600_000;
    const recencyScore = 100 * Math.exp(-0.058 * ageHours);

    // Direct address: user in To: (100), CC: (40), neither (0)
    let directScore = 0;
    if (lastMsg) {
      const to = (lastMsg.to || '').toLowerCase();
      const cc = (lastMsg.cc || '').toLowerCase();
      if (this._userEmail && to.includes(this._userEmail)) {
        directScore = 100;
      } else if (this._userEmail && cc.includes(this._userEmail)) {
        directScore = 40;
      }
    }

    // Sender importance: VIP (100), frequent (proportional), unknown (20)
    let senderScore = 20;
    if (lastMsg) {
      const addr = (lastMsg.fromAddress || '').toLowerCase();
      if (this._vipSenders.has(addr)) {
        senderScore = 100;
      } else {
        const freq = this._senderFrequency.get(addr) || 0;
        const maxFreq = Math.max(...this._senderFrequency.values(), 1);
        senderScore = 20 + (freq / maxFreq) * 60;
      }
    }

    // Awaiting reply: last message is from someone else (not the user)
    let awaitingReply = false;
    if (lastMsg && this._userEmail) {
      const fromAddr = (lastMsg.fromAddress || '').toLowerCase();
      awaitingReply = fromAddr !== this._userEmail;
    }
    const awaitingScore = awaitingReply ? 100 : 0;

    // Thread depth: single (20), 2 messages (50), 3+ (80-100)
    let depthScore = 20;
    if (msgs.length === 2) depthScore = 50;
    else if (msgs.length >= 3) depthScore = Math.min(80 + (msgs.length - 3) * 5, 100);

    return {
      threadVelocity: velocityScore,
      recency: recencyScore,
      directAddress: directScore,
      senderImport: senderScore,
      awaitingReply: awaitingScore,
      threadDepth: depthScore,
      sentiment: 50,
      _awaitingReply: awaitingReply,
    };
  }

  _compositeScore(signals) {
    let score = 0;
    for (const [key, weight] of Object.entries(WEIGHTS)) {
      score += (signals[key] || 0) * weight;
    }
    return Math.max(0, Math.min(100, score));
  }

  _scoreToPriority(score) {
    if (score >= PRIORITY_THRESHOLDS.critical) return 'critical';
    if (score >= PRIORITY_THRESHOLDS.high) return 'high';
    if (score >= PRIORITY_THRESHOLDS.medium) return 'medium';
    return 'low';
  }

  async _aiAssessUrgency(thread) {
    if (!this._ai) return 50;
    const lastMsg = thread.messages[thread.messages.length - 1];
    const snippet = (lastMsg?.subject || '') + ' ' + ((lastMsg?.text || '').slice(0, 200));

    try {
      const result = await this._ai.json(
        `Rate the urgency of this email on a scale of 0-100 (0 = not urgent at all, 100 = extremely urgent/time-sensitive).
Consider: deadlines, requests for immediate action, severity of consequences.

Subject + body snippet:
"${snippet}"

Return JSON: { "urgency": <number 0-100>, "reason": "<brief reason>" }`,
        { profile: 'fast', feature: 'email-triage', maxTokens: 100, temperature: 0.2 }
      );
      return typeof result?.urgency === 'number' ? result.urgency : 50;
    } catch (_err) {
      return 50;
    }
  }

  /**
   * Generate a triage summary suitable for voice/text briefing.
   */
  summarize(scoredThreads) {
    const conversations = scoredThreads.filter((t) => t.isConversation && t.awaitingReply);
    const unreadSingles = scoredThreads.filter((t) => !t.isConversation && t.hasUnread);
    const critical = scoredThreads.filter((t) => t.priority === 'critical');
    const high = scoredThreads.filter((t) => t.priority === 'high');

    const parts = [];

    if (critical.length > 0) {
      parts.push(`${critical.length} critical item${critical.length > 1 ? 's' : ''} needing attention`);
    }
    if (conversations.length > 0) {
      parts.push(`${conversations.length} active conversation${conversations.length > 1 ? 's' : ''} awaiting your reply`);
    }
    if (high.length > 0) {
      parts.push(`${high.length} high-priority thread${high.length > 1 ? 's' : ''}`);
    }
    if (unreadSingles.length > 0) {
      parts.push(`${unreadSingles.length} new message${unreadSingles.length > 1 ? 's' : ''}`);
    }

    if (parts.length === 0) return 'Your inbox is clear.';
    return `Email triage: ${parts.join(', ')}.`;
  }

  getThread(threadId) {
    return this._threads.get(threadId) || null;
  }
}

let _instance = null;
function getEmailThreadEngine(opts) {
  if (!_instance) _instance = new EmailThreadEngine(opts);
  return _instance;
}

module.exports = { EmailThreadEngine, getEmailThreadEngine, WEIGHTS, PRIORITY_THRESHOLDS };
