'use strict';

const path = require('path');
const os = require('os');
const crypto = require('crypto');

let _fs = require('fs');
let _execSync = require('child_process').execSync;
let _electron;
function getElectron() { if (!_electron) _electron = require('electron'); return _electron; }

const CHROME_PATHS = {
  darwin: path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'Default', 'Cookies'),
  win32: path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data', 'Default', 'Network', 'Cookies'),
  linux: path.join(os.homedir(), '.config', 'google-chrome', 'Default', 'Cookies'),
};

const PBKDF2_ITERATIONS = {
  darwin: 1003,
  linux: 1,
  win32: 1,
};

function getChromeProfilePath() {
  return CHROME_PATHS[process.platform] || null;
}

const _failedDomains = new Set();

function isChromeAvailable() {
  if (_cachedKey === null) return false;
  const cookiePath = getChromeProfilePath();
  if (!cookiePath) return false;
  try {
    _fs.accessSync(cookiePath, _fs.constants.R_OK);
    return true;
  } catch (_) {
    return false;
  }
}

function isDomainFailed(domain) {
  return _failedDomains.has(domain);
}

function markDomainFailed(domain) {
  _failedDomains.add(domain);
}

let _cachedKey = undefined; // undefined = not yet attempted, null = failed, Buffer = key

function _getChromeDecryptionKey() {
  if (_cachedKey !== undefined) return _cachedKey;

  if (process.platform !== 'darwin') {
    _cachedKey = null;
    return null;
  }

  try {
    const raw = _execSync(
      'security find-generic-password -s "Chrome Safe Storage" -w',
      { encoding: 'utf8', timeout: 5000 }
    ).trim();

    _cachedKey = crypto.pbkdf2Sync(
      raw,
      'saltysalt',
      PBKDF2_ITERATIONS.darwin,
      16,
      'sha1'
    );
    return _cachedKey;
  } catch (_) {
    _cachedKey = null;
    return null;
  }
}

function _decryptValue(encryptedValue, key) {
  if (!encryptedValue || encryptedValue.length < 4) return '';
  if (!key) return '';

  const prefix = encryptedValue.slice(0, 3).toString('utf8');
  if (prefix !== 'v10' && prefix !== 'v11') {
    return encryptedValue.toString('utf8');
  }

  try {
    const iv = Buffer.alloc(16, ' ');
    const data = encryptedValue.slice(3);
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
    let decrypted = decipher.update(data);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString('utf8');
  } catch (_) {
    return '';
  }
}

function _queryCookieDb(dbPath, domain) {
  try {
    const tmpDb = path.join(os.tmpdir(), `chrome-cookies-${Date.now()}.db`);
    _fs.copyFileSync(dbPath, tmpDb);

    const hostPattern = domain.startsWith('.') ? domain : `.${domain}`;
    const sql = `SELECT host_key, name, path, is_secure, is_httponly, expires_utc, hex(encrypted_value), samesite FROM cookies WHERE host_key LIKE '%${hostPattern}' OR host_key = '${domain}'`;
    const result = _execSync(
      `sqlite3 -separator '|||' "${tmpDb}" "${sql}"`,
      { encoding: 'utf8', timeout: 10000, maxBuffer: 5 * 1024 * 1024 }
    );

    try { _fs.unlinkSync(tmpDb); } catch (_) {}

    if (!result || result.trim().length === 0) return [];

    const lines = result.trim().split('\n').filter(Boolean);
    return lines.map((line) => {
      const parts = line.split('|||');
      if (parts.length < 7) return null;
      return {
        host_key: parts[0],
        name: parts[1],
        path: parts[2],
        is_secure: parts[3] === '1',
        is_httponly: parts[4] === '1',
        expires_utc: parseInt(parts[5], 10) || 0,
        encrypted_value_hex: parts[6],
        samesite: parseInt(parts[7], 10) || -1,
      };
    }).filter(Boolean);
  } catch (_) {
    return [];
  }
}

function _chromeSameSiteToElectron(sameSiteValue) {
  switch (sameSiteValue) {
    case 0: return 'no_restriction';
    case 1: return 'lax';
    case 2: return 'strict';
    default: return undefined;
  }
}

function _chromeTimestampToUnix(chromeTimestamp) {
  if (!chromeTimestamp || chromeTimestamp === 0) return undefined;
  // Chrome timestamps are microseconds since 1601-01-01
  const unixEpochDiff = 11644473600;
  return Math.floor(chromeTimestamp / 1000000) - unixEpochDiff;
}

async function importChromeCookies(domain, targetPartition) {
  if (_failedDomains.has(domain)) {
    return { imported: 0, reason: 'domain-previously-failed' };
  }
  if (!isChromeAvailable()) {
    return { imported: 0, reason: 'chrome-not-available' };
  }

  const dbPath = getChromeProfilePath();
  const key = _getChromeDecryptionKey();
  if (!key) {
    return { imported: 0, reason: 'keychain-unavailable' };
  }

  const rows = _queryCookieDb(dbPath, domain);
  if (rows.length === 0) {
    _failedDomains.add(domain);
    return { imported: 0, reason: 'no-cookies-found' };
  }

  const targetSes = getElectron().session.fromPartition(targetPartition);
  let imported = 0;

  for (const row of rows) {
    try {
      let value = '';
      if (row.encrypted_value_hex && key) {
        const buf = Buffer.from(row.encrypted_value_hex, 'hex');
        value = _decryptValue(buf, key);
      }
      if (!value) continue;

      const cookieOpts = {
        url: `http${row.is_secure ? 's' : ''}://${row.host_key.replace(/^\./, '')}${row.path || '/'}`,
        name: row.name,
        value,
        domain: row.host_key,
        path: row.path || '/',
        secure: row.is_secure,
        httpOnly: row.is_httponly,
      };

      const expiry = _chromeTimestampToUnix(row.expires_utc);
      if (expiry && expiry > 0) cookieOpts.expirationDate = expiry;

      const sameSite = _chromeSameSiteToElectron(row.samesite);
      if (sameSite) cookieOpts.sameSite = sameSite;

      await targetSes.cookies.set(cookieOpts);
      imported++;
    } catch (_) {}
  }

  if (imported > 0) await targetSes.cookies.flushStore();

  return { imported, total: rows.length };
}

function _injectDeps({ fs: injFs, execSync: injExec, electron, resetCaches } = {}) {
  if (injFs) _fs = injFs;
  if (injExec) _execSync = injExec;
  if (electron) _electron = electron;
  if (resetCaches) {
    _cachedKey = undefined;
    _failedDomains.clear();
  }
}

module.exports = {
  getChromeProfilePath,
  isChromeAvailable,
  isDomainFailed,
  markDomainFailed,
  importChromeCookies,
  _getChromeDecryptionKey,
  _decryptValue,
  _queryCookieDb,
  _chromeSameSiteToElectron,
  _chromeTimestampToUnix,
  _injectDeps,
};
