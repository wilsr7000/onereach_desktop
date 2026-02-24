'use strict';

const BLOCKED_DOMAINS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  'internal',
  'intranet',
  'corp',
  'admin.google.com',
  'console.cloud.google.com',
  'console.aws.amazon.com',
  'portal.azure.com',
  'banking',
  'bank',
]);

const BLOCKED_DOMAIN_PATTERNS = [
  /\.internal\./i,
  /\.corp\./i,
  /\.local$/i,
  /\.intranet$/i,
  /192\.168\./,
  /10\.\d+\.\d+\.\d+/,
  /172\.(1[6-9]|2\d|3[01])\./,
];

const SENSITIVE_FIELD_TYPES = new Set([
  'password',
  'credit-card',
  'creditcard',
  'cc-number',
  'cc-exp',
  'cc-csc',
  'ssn',
  'social-security',
  'bank-account',
  'routing-number',
  'pin',
]);

const SENSITIVE_FIELD_PATTERNS = [
  /passw/i,
  /secret/i,
  /token/i,
  /credit.?card/i,
  /card.?number/i,
  /cvv|cvc|csc/i,
  /ssn|social.?sec/i,
  /bank.?account/i,
  /routing.?num/i,
  /\bpin\b/i,
  /security.?code/i,
  /security.?answer/i,
  /mother.?maiden/i,
];

const DEFAULT_LIMITS = {
  maxActionsPerSession: 50,
  maxSessionsTotal: 10,
  maxSessionDurationMs: 5 * 60 * 1000,
  maxParallelSessions: 5,
  maxScreenshotsPerSession: 20,
  maxNavigationsPerSession: 30,
  maxDataExtractionMb: 10,
  costBudgetPerSession: 0.50,
};

let _customBlocklist = new Set();
let _customLimits = {};

function isDomainBlocked(url) {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();

    if (BLOCKED_DOMAINS.has(hostname)) return { blocked: true, reason: `Domain "${hostname}" is blocklisted` };

    for (const domain of _customBlocklist) {
      if (hostname === domain || hostname.endsWith('.' + domain)) {
        return { blocked: true, reason: `Domain "${hostname}" matches custom blocklist entry "${domain}"` };
      }
    }

    for (const pattern of BLOCKED_DOMAIN_PATTERNS) {
      if (pattern.test(hostname) || pattern.test(url)) {
        return { blocked: true, reason: `Domain "${hostname}" matches blocked pattern ${pattern}` };
      }
    }

    if (parsed.protocol === 'file:') return { blocked: true, reason: 'file:// URLs are not allowed' };
    if (parsed.protocol === 'javascript:') return { blocked: true, reason: 'javascript: URLs are not allowed' };
    if (parsed.protocol === 'data:') return { blocked: true, reason: 'data: URLs are not allowed' };

    return { blocked: false };
  } catch {
    return { blocked: true, reason: 'Invalid URL' };
  }
}

function isSensitiveField(fieldInfo) {
  const name = (fieldInfo.name || '').toLowerCase();
  const type = (fieldInfo.type || '').toLowerCase();
  const id = (fieldInfo.id || '').toLowerCase();
  const autocomplete = (fieldInfo.autocomplete || '').toLowerCase();
  const label = (fieldInfo.label || '').toLowerCase();

  if (type === 'password') return { sensitive: true, field: 'password', reason: 'Password field detected' };

  if (SENSITIVE_FIELD_TYPES.has(type)) {
    return { sensitive: true, field: type, reason: `Sensitive field type: ${type}` };
  }
  if (SENSITIVE_FIELD_TYPES.has(autocomplete)) {
    return { sensitive: true, field: autocomplete, reason: `Sensitive autocomplete: ${autocomplete}` };
  }

  const allText = [name, id, label, autocomplete].join(' ');
  for (const pattern of SENSITIVE_FIELD_PATTERNS) {
    if (pattern.test(allText)) {
      return { sensitive: true, field: allText, reason: `Field matches sensitive pattern: ${pattern}` };
    }
  }

  return { sensitive: false };
}

function checkActionSafety(action, sessionState) {
  const issues = [];
  const limits = { ...DEFAULT_LIMITS, ..._customLimits };

  if (sessionState.actionCount >= limits.maxActionsPerSession) {
    issues.push({ severity: 'block', reason: `Max actions per session (${limits.maxActionsPerSession}) exceeded` });
  }

  if (sessionState.navigationCount >= limits.maxNavigationsPerSession) {
    issues.push({ severity: 'block', reason: `Max navigations per session (${limits.maxNavigationsPerSession}) exceeded` });
  }

  if (Date.now() - sessionState.startTime > limits.maxSessionDurationMs) {
    issues.push({ severity: 'block', reason: `Session duration limit (${limits.maxSessionDurationMs / 1000}s) exceeded` });
  }

  if (action.action === 'navigate' && action.url) {
    const domainCheck = isDomainBlocked(action.url);
    if (domainCheck.blocked) {
      issues.push({ severity: 'block', reason: domainCheck.reason });
    }
  }

  if (action.action === 'fill' && action.fieldInfo) {
    const sensitiveCheck = isSensitiveField(action.fieldInfo);
    if (sensitiveCheck.sensitive) {
      issues.push({
        severity: 'warn',
        reason: sensitiveCheck.reason,
        requiresConfirmation: true,
      });
    }
  }

  return {
    safe: issues.filter((i) => i.severity === 'block').length === 0,
    issues,
    requiresConfirmation: issues.some((i) => i.requiresConfirmation),
  };
}

function validateSessionCreation(currentSessionCount) {
  const limits = { ...DEFAULT_LIMITS, ..._customLimits };

  if (currentSessionCount >= limits.maxSessionsTotal) {
    return { allowed: false, reason: `Max total sessions (${limits.maxSessionsTotal}) reached` };
  }

  return { allowed: true };
}

function addBlockedDomain(domain) {
  _customBlocklist.add(domain.toLowerCase());
}

function removeBlockedDomain(domain) {
  _customBlocklist.delete(domain.toLowerCase());
}

function getBlockedDomains() {
  return [...BLOCKED_DOMAINS, ..._customBlocklist];
}

function setLimits(overrides) {
  _customLimits = { ..._customLimits, ...overrides };
}

function getLimits() {
  return { ...DEFAULT_LIMITS, ..._customLimits };
}

function resetCustomConfig() {
  _customBlocklist = new Set();
  _customLimits = {};
}

module.exports = {
  isDomainBlocked,
  isSensitiveField,
  checkActionSafety,
  validateSessionCreation,
  addBlockedDomain,
  removeBlockedDomain,
  getBlockedDomains,
  setLimits,
  getLimits,
  resetCustomConfig,
  DEFAULT_LIMITS,
  BLOCKED_DOMAINS,
  SENSITIVE_FIELD_TYPES,
};
