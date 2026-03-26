/**
 * Edison SDK Manager
 *
 * Centralized lifecycle management for all Edison platform SDKs.
 * Handles token acquisition/caching, lazy SDK initialization, and
 * thorough health checks for the Settings UI.
 *
 * Other modules should import from here rather than initializing
 * SDKs directly.
 */

const fs = require('fs');
const path = require('path');
const _crypto = require('crypto');
const { app } = require('electron');

let KeyValueStorage, Flows, Bots, LibraryV2, FilesSyncNode, Discovery, Accounts, ApiTokens, Deployer;
let FilesSDK, StepTemplates, Tags, DataHubSvc;

const SDK_PACKAGES = {
  'key-value-storage': { label: 'Key-Value Storage', pkg: '@or-sdk/key-value-storage', exportName: 'KeyValueStorage' },
  flows:              { label: 'Flows',              pkg: '@or-sdk/flows',              exportName: 'Flows' },
  bots:               { label: 'Bots',               pkg: '@or-sdk/bots',               exportName: 'Bots' },
  deployer:           { label: 'Deployer',            pkg: '@or-sdk/deployer',           exportName: 'Deployer' },
  discovery:          { label: 'Discovery',           pkg: '@or-sdk/discovery',          exportName: 'Discovery' },
  library:            { label: 'Library',             pkg: '@or-sdk/library',            exportName: 'LibraryV2' },
  'files-sync':       { label: 'Files Sync',         pkg: '@or-sdk/files-sync-node',    exportName: 'FilesSyncNode' },
  accounts:           { label: 'Accounts',            pkg: '@or-sdk/accounts',           exportName: 'Accounts' },
  'api-tokens':       { label: 'API Tokens',          pkg: '@or-sdk/api-tokens',         exportName: 'ApiTokens' },
  files:              { label: 'Files',               pkg: '@or-sdk/files',              exportName: 'Files' },
  'step-templates':   { label: 'Step Templates',      pkg: '@or-sdk/step-templates',     exportName: 'StepTemplates' },
  tags:               { label: 'Tags',                pkg: '@or-sdk/tags',               exportName: 'Tags' },
  'data-hub-svc':     { label: 'Data Hub',            pkg: '@or-sdk/data-hub-svc',       exportName: 'DataHubSvc' },
};

const DEFAULT_DISCOVERY_URL = 'https://discovery.edison.api.onereach.ai';
const DEFAULT_ACCOUNT_ID = '35254342-4a2e-475b-aec1-18547e517e29';
const TOKEN_CACHE_DURATION_MS = 50 * 60 * 1000; // 50 minutes

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let tokenCache = null; // { token, expiresAt }
let sdkInstances = {}; // { kv, flows, bots, library, filesSync }
let lastTestResults = {};
let configPath = null;

function getConfigPath() {
  if (!configPath) {
    try {
      configPath = path.join(app.getPath('userData'), 'edison-sdk-config.json');
    } catch {
      configPath = path.join(require('os').homedir(), '.edison-sdk-config.json');
    }
  }
  return configPath;
}

function readConfig() {
  try {
    const raw = fs.readFileSync(getConfigPath(), 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeConfig(data) {
  try {
    const existing = readConfig();
    const merged = { ...existing, ...data };
    fs.writeFileSync(getConfigPath(), JSON.stringify(merged, null, 2));
  } catch (err) {
    console.error('[Edison SDK] Failed to write config:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Settings integration
// ---------------------------------------------------------------------------

function getAccountId() {
  const sm = global.settingsManager;
  if (sm) {
    const all = sm.getAll();
    if (all.edisonAccountId) return all.edisonAccountId;
    if (all.gsxAccountId) return all.gsxAccountId;
  }
  const cfg = readConfig();
  return cfg.accountId || DEFAULT_ACCOUNT_ID;
}

function getDiscoveryUrl() {
  const sm = global.settingsManager;
  if (sm) {
    const all = sm.getAll();
    if (all.edisonDiscoveryUrl) return all.edisonDiscoveryUrl;
  }
  const cfg = readConfig();
  return cfg.discoveryUrl || DEFAULT_DISCOVERY_URL;
}

// ---------------------------------------------------------------------------
// SDK loading (require at call time to avoid breaking app startup)
// ---------------------------------------------------------------------------

function loadSDKs() {
  if (!KeyValueStorage) {
    try { KeyValueStorage = require('@or-sdk/key-value-storage').KeyValueStorage; } catch (e) {
      console.warn('[Edison SDK] @or-sdk/key-value-storage not available:', e.message);
    }
  }
  if (!Flows) {
    try { Flows = require('@or-sdk/flows').Flows; } catch (e) {
      console.warn('[Edison SDK] @or-sdk/flows not available:', e.message);
    }
  }
  if (!Bots) {
    try { Bots = require('@or-sdk/bots').Bots; } catch (e) {
      console.warn('[Edison SDK] @or-sdk/bots not available:', e.message);
    }
  }
  if (!LibraryV2) {
    try {
      const lib = require('@or-sdk/library');
      LibraryV2 = lib.LibraryV2 || lib.LibraryV1;
    } catch (e) {
      console.warn('[Edison SDK] @or-sdk/library not available:', e.message);
    }
  }
  if (!FilesSyncNode) {
    try { FilesSyncNode = require('@or-sdk/files-sync-node').FilesSyncNode; } catch (e) {
      console.warn('[Edison SDK] @or-sdk/files-sync-node not available:', e.message);
    }
  }
  if (!Discovery) {
    try { Discovery = require('@or-sdk/discovery').Discovery; } catch (e) {
      console.warn('[Edison SDK] @or-sdk/discovery not available:', e.message);
    }
  }
  if (!Accounts) {
    try { Accounts = require('@or-sdk/accounts').Accounts; } catch (e) {
      console.warn('[Edison SDK] @or-sdk/accounts not available:', e.message);
    }
  }
  if (!ApiTokens) {
    try { ApiTokens = require('@or-sdk/api-tokens').ApiTokens; } catch (e) {
      console.warn('[Edison SDK] @or-sdk/api-tokens not available:', e.message);
    }
  }
  if (!Deployer) {
    try { Deployer = require('@or-sdk/deployer').Deployer; } catch (e) {
      console.warn('[Edison SDK] @or-sdk/deployer not available:', e.message);
    }
  }
  if (!FilesSDK) {
    try { FilesSDK = require('@or-sdk/files').Files; } catch (e) {
      console.warn('[Edison SDK] @or-sdk/files not available:', e.message);
    }
  }
  if (!StepTemplates) {
    try { StepTemplates = require('@or-sdk/step-templates').StepTemplates; } catch (e) {
      console.warn('[Edison SDK] @or-sdk/step-templates not available:', e.message);
    }
  }
  if (!Tags) {
    try { Tags = require('@or-sdk/tags').Tags; } catch (e) {
      console.warn('[Edison SDK] @or-sdk/tags not available:', e.message);
    }
  }
  if (!DataHubSvc) {
    try { DataHubSvc = require('@or-sdk/data-hub-svc').DataHubSvc; } catch (e) {
      console.warn('[Edison SDK] @or-sdk/data-hub-svc not available:', e.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Token management (pattern from podscan/knowledge-twin/lib/deployHelper.js)
// ---------------------------------------------------------------------------

async function getToken(forceRefresh = false) {
  if (!forceRefresh && tokenCache && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }

  const accountId = getAccountId();
  const tokenUrl = `https://em.edison.api.onereach.ai/http/${accountId}/refresh_token`;

  const resp = await fetch(tokenUrl);
  if (!resp.ok) {
    throw new Error(`Token fetch failed: ${resp.status} ${resp.statusText}`);
  }

  const data = await resp.json();
  let token = data.token || data.access_token || '';
  if (!token) throw new Error('No token in response');

  token = token.startsWith('FLOW ') ? token : `FLOW ${token}`;

  tokenCache = {
    token,
    expiresAt: Date.now() + TOKEN_CACHE_DURATION_MS,
    fetchedAt: new Date().toISOString(),
  };

  writeConfig({ tokenCache: { expiresAt: tokenCache.expiresAt, fetchedAt: tokenCache.fetchedAt } });
  return token;
}

function getTokenStatus() {
  if (!tokenCache) return { status: 'none', message: 'No token cached' };
  const remaining = tokenCache.expiresAt - Date.now();
  if (remaining <= 0) return { status: 'expired', message: 'Token expired' };
  const mins = Math.floor(remaining / 60000);
  return {
    status: 'valid',
    message: `Valid for ${mins}m`,
    maskedToken: tokenCache.token.substring(0, 12) + '...',
    expiresAt: tokenCache.expiresAt,
    fetchedAt: tokenCache.fetchedAt,
  };
}

// ---------------------------------------------------------------------------
// SDK instance getters (lazy init)
// ---------------------------------------------------------------------------

function invalidateInstances() {
  sdkInstances = {};
}

function getKV() {
  if (!sdkInstances.kv) {
    loadSDKs();
    if (!KeyValueStorage) throw new Error('@or-sdk/key-value-storage not installed');
    sdkInstances.kv = new KeyValueStorage({
      token: () => tokenCache?.token || '',
      discoveryUrl: getDiscoveryUrl(),
      accountId: getAccountId(),
    });
  }
  return sdkInstances.kv;
}

function getFlows() {
  if (!sdkInstances.flows) {
    loadSDKs();
    if (!Flows) throw new Error('@or-sdk/flows not installed');
    sdkInstances.flows = new Flows({
      token: () => tokenCache?.token || '',
      discoveryUrl: getDiscoveryUrl(),
    });
  }
  return sdkInstances.flows;
}

function getBots() {
  if (!sdkInstances.bots) {
    loadSDKs();
    if (!Bots) throw new Error('@or-sdk/bots not installed');
    sdkInstances.bots = new Bots({
      token: () => tokenCache?.token || '',
      discoveryUrl: getDiscoveryUrl(),
    });
  }
  return sdkInstances.bots;
}

function getLibrary(packageType) {
  const type = packageType || 'STEP';
  const cacheKey = `library_${type}`;
  if (!sdkInstances[cacheKey]) {
    loadSDKs();
    if (!LibraryV2) throw new Error('@or-sdk/library not installed');
    sdkInstances[cacheKey] = new LibraryV2({
      token: () => tokenCache?.token || '',
      discoveryUrl: getDiscoveryUrl(),
      packageType: type,
    });
  }
  return sdkInstances[cacheKey];
}

function getFilesSync() {
  if (!sdkInstances.filesSync) {
    loadSDKs();
    if (!FilesSyncNode) throw new Error('@or-sdk/files-sync-node not installed');
    sdkInstances.filesSync = new FilesSyncNode({
      token: tokenCache?.token || '',
      discoveryUrl: getDiscoveryUrl(),
    });
  }
  return sdkInstances.filesSync;
}

function getDiscoverySDK() {
  if (!sdkInstances.discovery) {
    loadSDKs();
    if (!Discovery) throw new Error('@or-sdk/discovery not installed');
    sdkInstances.discovery = new Discovery({
      token: () => tokenCache?.token || '',
      discoveryUrl: getDiscoveryUrl(),
    });
  }
  return sdkInstances.discovery;
}

function getAccounts() {
  if (!sdkInstances.accounts) {
    loadSDKs();
    if (!Accounts) throw new Error('@or-sdk/accounts not installed');
    sdkInstances.accounts = new Accounts({
      token: () => tokenCache?.token || '',
      discoveryUrl: getDiscoveryUrl(),
      accountId: getAccountId(),
    });
  }
  return sdkInstances.accounts;
}

function getApiTokens() {
  if (!sdkInstances.apiTokens) {
    loadSDKs();
    if (!ApiTokens) throw new Error('@or-sdk/api-tokens not installed');
    sdkInstances.apiTokens = new ApiTokens({
      token: () => tokenCache?.token || '',
      discoveryUrl: getDiscoveryUrl(),
      accountId: getAccountId(),
    });
  }
  return sdkInstances.apiTokens;
}

function getDeployer() {
  if (!sdkInstances.deployer) {
    loadSDKs();
    if (!Deployer) throw new Error('@or-sdk/deployer not installed');
    sdkInstances.deployer = new Deployer({
      token: () => tokenCache?.token || '',
      discoveryUrl: getDiscoveryUrl(),
    });
  }
  return sdkInstances.deployer;
}

function getFiles() {
  if (!sdkInstances.files) {
    loadSDKs();
    if (!FilesSDK) throw new Error('@or-sdk/files not installed');
    sdkInstances.files = new FilesSDK({
      token: () => tokenCache?.token || '',
      discoveryUrl: getDiscoveryUrl(),
      accountId: getAccountId(),
    });
  }
  return sdkInstances.files;
}

function getStepTemplates() {
  if (!sdkInstances.stepTemplates) {
    loadSDKs();
    if (!StepTemplates) throw new Error('@or-sdk/step-templates not installed');
    sdkInstances.stepTemplates = new StepTemplates({
      token: () => tokenCache?.token || '',
      discoveryUrl: getDiscoveryUrl(),
    });
  }
  return sdkInstances.stepTemplates;
}

function getTags() {
  if (!sdkInstances.tags) {
    loadSDKs();
    if (!Tags) throw new Error('@or-sdk/tags not installed');
    sdkInstances.tags = new Tags({
      token: () => tokenCache?.token || '',
      discoveryUrl: getDiscoveryUrl(),
    });
  }
  return sdkInstances.tags;
}

function getDataHubSvc() {
  if (!sdkInstances.dataHubSvc) {
    loadSDKs();
    if (!DataHubSvc) throw new Error('@or-sdk/data-hub-svc not installed');
    sdkInstances.dataHubSvc = new DataHubSvc({
      token: () => tokenCache?.token || '',
      discoveryUrl: getDiscoveryUrl(),
    });
  }
  return sdkInstances.dataHubSvc;
}

// ---------------------------------------------------------------------------
// Package version detection
// ---------------------------------------------------------------------------

function getPackageVersion(pkgName) {
  try {
    const pkgPath = require.resolve(`${pkgName}/package.json`);
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return pkg.version || 'unknown';
  } catch {
    return 'not installed';
  }
}

// ---------------------------------------------------------------------------
// Thorough SDK tests
// ---------------------------------------------------------------------------

async function testToken() {
  const steps = [];
  const t0 = Date.now();

  // Step 1: Fresh fetch
  try {
    const start = Date.now();
    const token = await getToken(true);
    steps.push({ name: 'Fetch token', ok: true, latencyMs: Date.now() - start, detail: `Got FLOW token (${token.length} chars)` });
  } catch (err) {
    steps.push({ name: 'Fetch token', ok: false, latencyMs: Date.now() - t0, detail: err.message });
    return { ok: false, steps, totalLatencyMs: Date.now() - t0 };
  }

  // Step 2: Cache hit
  try {
    const start = Date.now();
    await getToken(false);
    const latency = Date.now() - start;
    steps.push({ name: 'Cache hit', ok: true, latencyMs: latency, detail: `Returned cached token in ${latency}ms` });
  } catch (err) {
    steps.push({ name: 'Cache hit', ok: false, latencyMs: 0, detail: err.message });
  }

  // Step 3: Verify FLOW prefix
  const hasPrefix = tokenCache?.token?.startsWith('FLOW ');
  steps.push({ name: 'FLOW prefix', ok: hasPrefix, latencyMs: 0, detail: hasPrefix ? 'Token correctly prefixed' : 'Missing FLOW prefix' });

  return { ok: steps.every(s => s.ok), steps, totalLatencyMs: Date.now() - t0 };
}

async function testKV() {
  const steps = [];
  const t0 = Date.now();
  const collection = '__sdk_test';
  const testKey1 = `test-${Date.now()}-1`;
  const testKey2 = `test-${Date.now()}-2`;

  try {
    await getToken();
    const kv = getKV();

    // Step 1: Write key 1
    let start = Date.now();
    await kv.setValueByKey(collection, testKey1, { ts: Date.now(), msg: 'hello' });
    steps.push({ name: 'Write key 1', ok: true, latencyMs: Date.now() - start, detail: `Set ${testKey1}` });

    // Step 2: Read key 1
    start = Date.now();
    const record = await kv.getValueByKey(collection, testKey1);
    const readOk = record && record.value && record.value.msg === 'hello';
    steps.push({ name: 'Read key 1', ok: readOk, latencyMs: Date.now() - start, detail: readOk ? 'Value matches' : `Unexpected: ${JSON.stringify(record)}` });

    // Step 3: Write key 2
    start = Date.now();
    await kv.setValueByKey(collection, testKey2, { ts: Date.now(), msg: 'world' });
    steps.push({ name: 'Write key 2', ok: true, latencyMs: Date.now() - start, detail: `Set ${testKey2}` });

    // Step 4: List all keys (should have at least 2)
    start = Date.now();
    const listResult = await kv.scrollKeys({ numberOfItems: 50 }, collection, '', true);
    const listOk = listResult && listResult.items && listResult.items.length >= 2;
    steps.push({ name: 'List keys (withValues)', ok: listOk, latencyMs: Date.now() - start, detail: `${listResult?.items?.length || 0} keys found` });

    // Step 5: Prefix scan for key 1
    start = Date.now();
    const prefixBase = testKey1.replace(/-1$/, '');
    const prefixResult = await kv.scrollKeys({ numberOfItems: 50 }, collection, prefixBase);
    const prefixOk = prefixResult && prefixResult.items && prefixResult.items.length >= 1;
    steps.push({ name: 'Prefix scan', ok: prefixOk, latencyMs: Date.now() - start, detail: `${prefixResult?.items?.length || 0} keys with prefix "${prefixBase}"` });

    // Step 6: Delete key 1
    start = Date.now();
    await kv.deleteKey(collection, testKey1);
    steps.push({ name: 'Delete key 1', ok: true, latencyMs: Date.now() - start, detail: 'Deleted' });

    // Step 7: Delete key 2
    start = Date.now();
    await kv.deleteKey(collection, testKey2);
    steps.push({ name: 'Delete key 2', ok: true, latencyMs: Date.now() - start, detail: 'Deleted' });

    // Step 8: Verify cleanup
    start = Date.now();
    let cleanupOk = true;
    try {
      await kv.getValueByKey(collection, testKey1);
      cleanupOk = false;
    } catch {
      cleanupOk = true;
    }
    steps.push({ name: 'Verify cleanup', ok: cleanupOk, latencyMs: Date.now() - start, detail: cleanupOk ? 'Keys confirmed deleted' : 'Key still exists after delete' });

  } catch (err) {
    const isAuthError = err.message.includes('401') || err.message.includes('Unauthorized') || err.message.includes('Reason Unknown');
    const detail = isAuthError
      ? 'KV SDK requires a user-level token (not FLOW token). KV access will work from within Edison flows via or-sdk/storage, or when a platform API token is available.'
      : err.message;
    steps.push({ name: 'KV Access', ok: false, latencyMs: Date.now() - t0, detail });
  }

  return { ok: steps.every(s => s.ok), steps, totalLatencyMs: Date.now() - t0 };
}

async function testFlows() {
  const steps = [];
  const t0 = Date.now();

  try {
    await getToken();
    const flowsApi = getFlows();

    // Step 1: Need a botId to list flows -- get one from Bots SDK first
    let start = Date.now();
    const botsApi = getBots();
    const allBots = await botsApi.listBots();
    const botItems = Array.isArray(allBots) ? allBots : (allBots?.items || []);
    if (botItems.length === 0) {
      steps.push({ name: 'Find space', ok: false, latencyMs: Date.now() - start, detail: 'No spaces found -- cannot list flows without a botId' });
      return { ok: false, steps, totalLatencyMs: Date.now() - t0 };
    }
    const botId = botItems[0].botId || botItems[0].id;
    const botLabel = botItems[0].data?.label || '(unnamed)';
    steps.push({ name: 'Find space', ok: true, latencyMs: Date.now() - start, detail: `Using "${botLabel}" (${botId})` });

    // Step 2: List flows in that space
    start = Date.now();
    const list = await flowsApi.listFlows({ query: { botId } });
    const items = list?.items || list || [];
    const count = Array.isArray(items) ? items.length : 0;
    steps.push({ name: 'List flows', ok: count >= 0, latencyMs: Date.now() - start, detail: `${count} flows in "${botLabel}"` });

    // Step 3: Fetch a single flow
    if (count > 0) {
      const firstFlow = items[0];
      const flowId = firstFlow.flowId || firstFlow.id;
      start = Date.now();
      const flow = await flowsApi.getFlow(flowId);
      const hasLabel = !!(flow?.data?.label);
      const label = flow?.data?.label || '(no label)';
      const stepCount = flow?.data?.trees?.main?.steps ? Object.keys(flow.data.trees.main.steps).length : 0;
      steps.push({ name: 'Get flow detail', ok: hasLabel, latencyMs: Date.now() - start, detail: `"${label}" - ${stepCount} steps` });
    }

  } catch (err) {
    steps.push({ name: 'Error', ok: false, latencyMs: Date.now() - t0, detail: err.message });
  }

  return { ok: steps.every(s => s.ok), steps, totalLatencyMs: Date.now() - t0 };
}

async function testBots() {
  const steps = [];
  const t0 = Date.now();

  try {
    await getToken();
    const botsApi = getBots();

    // Step 1: List bots/spaces
    let start = Date.now();
    const allBots = await botsApi.listBots();
    const items = Array.isArray(allBots) ? allBots : (allBots?.items || []);
    steps.push({ name: 'List spaces', ok: items.length >= 0, latencyMs: Date.now() - start, detail: `${items.length} spaces found` });

    // Step 2: Report space names
    const labels = items.slice(0, 10).map(b => b.data?.label || b.label || '(unnamed)');
    steps.push({ name: 'Space names', ok: true, latencyMs: 0, detail: labels.join(', ') || '(none)' });

    // Step 3: Fetch one space detail
    if (items.length > 0) {
      const botId = items[0].botId || items[0].id;
      if (botId) {
        start = Date.now();
        const bot = await botsApi.getBot(botId);
        const hasLabel = !!(bot?.data?.label || bot?.label);
        steps.push({ name: 'Get space detail', ok: hasLabel, latencyMs: Date.now() - start, detail: `"${bot?.data?.label || bot?.label}"` });
      }
    }

  } catch (err) {
    steps.push({ name: 'Error', ok: false, latencyMs: Date.now() - t0, detail: err.message });
  }

  return { ok: steps.every(s => s.ok), steps, totalLatencyMs: Date.now() - t0 };
}

async function testLibrary() {
  const steps = [];
  const t0 = Date.now();

  try {
    await getToken();
    const lib = getLibrary('STEP');

    // Step 1: Search for step templates
    let start = Date.now();
    const results = await lib.searchPackages({ query: 'key value', take: 5 });
    const items = results?.items || results || [];
    const count = Array.isArray(items) ? items.length : 0;
    steps.push({ name: 'Search steps', ok: count > 0, latencyMs: Date.now() - start, detail: `${count} results for "key value"` });

    // Step 2: Report template names
    if (count > 0) {
      const names = items.slice(0, 5).map(i => i.meta?.name || i.name || i.label || '(unnamed)');
      steps.push({ name: 'Step names', ok: true, latencyMs: 0, detail: names.join(', ') });
    }

    // Step 3: Browse packages (getPackages)
    start = Date.now();
    const pkgs = await lib.getPackages({ take: 3 });
    const pkgItems = pkgs?.items || pkgs || [];
    const pkgCount = Array.isArray(pkgItems) ? pkgItems.length : 0;
    steps.push({ name: 'Get packages', ok: pkgCount > 0, latencyMs: Date.now() - start, detail: `${pkgCount} packages returned` });

  } catch (err) {
    steps.push({ name: 'Error', ok: false, latencyMs: Date.now() - t0, detail: err.message });
  }

  return { ok: steps.every(s => s.ok), steps, totalLatencyMs: Date.now() - t0 };
}

async function testFilesSync() {
  const steps = [];
  const t0 = Date.now();

  try {
    await getToken();
    const start = Date.now();
    const fs = getFilesSync();
    const hasClient = !!(fs.filesClient || fs);
    steps.push({ name: 'Initialize client', ok: hasClient, latencyMs: Date.now() - start, detail: hasClient ? 'Client ready' : 'No filesClient' });
  } catch (err) {
    steps.push({ name: 'Error', ok: false, latencyMs: Date.now() - t0, detail: err.message });
  }

  return { ok: steps.every(s => s.ok), steps, totalLatencyMs: Date.now() - t0 };
}

async function testDiscovery() {
  const steps = [];
  const t0 = Date.now();

  try {
    await getToken();
    const disc = getDiscoverySDK();

    // Step 1: List services
    let start = Date.now();
    const services = await disc.listServices();
    const items = Array.isArray(services) ? services : (services?.items || []);
    const serviceKeys = items.map(s => s.serviceKey).filter(Boolean);
    steps.push({ name: 'List services', ok: items.length > 0, latencyMs: Date.now() - start, detail: `${items.length} services (${serviceKeys.slice(0, 6).join(', ')}...)` });

    // Step 2: Resolve sdk-api URL
    start = Date.now();
    const sdkApiUrl = await disc.getServiceUrl('sdk-api');
    const hasUrl = typeof sdkApiUrl === 'string' && sdkApiUrl.startsWith('http');
    steps.push({ name: 'Resolve sdk-api URL', ok: hasUrl, latencyMs: Date.now() - start, detail: hasUrl ? sdkApiUrl : 'Could not resolve' });

    // Step 3: Resolve flow-builder URL
    start = Date.now();
    try {
      const fbUrl = await disc.getServiceUrl('flow-builder');
      const fbOk = typeof fbUrl === 'string' && fbUrl.startsWith('http');
      steps.push({ name: 'Resolve flow-builder URL', ok: fbOk, latencyMs: Date.now() - start, detail: fbOk ? fbUrl : 'Could not resolve' });
    } catch {
      steps.push({ name: 'Resolve flow-builder URL', ok: false, latencyMs: Date.now() - start, detail: 'Service not found' });
    }

  } catch (err) {
    steps.push({ name: 'Error', ok: false, latencyMs: Date.now() - t0, detail: err.message });
  }

  return { ok: steps.every(s => s.ok), steps, totalLatencyMs: Date.now() - t0 };
}

async function testAccounts() {
  const steps = [];
  const t0 = Date.now();

  try {
    await getToken();

    // Step 1: Verify SDK loads and instantiates
    let start = Date.now();
    const accts = getAccounts();
    steps.push({ name: 'Initialize client', ok: true, latencyMs: Date.now() - start, detail: `Client ready (accountId: ${getAccountId().substring(0, 8)}...)` });

    // Step 2: Try account data fetch
    start = Date.now();
    const accountData = await accts.getAccountData();
    const hasData = accountData && (accountData.name || accountData.id || Object.keys(accountData).length > 0);
    const name = accountData?.name || accountData?.label || '(unnamed)';
    steps.push({ name: 'Get account data', ok: !!hasData, latencyMs: Date.now() - start, detail: hasData ? `Account: "${name}"` : 'No data returned' });

  } catch (err) {
    const isGuidErr = err.message.includes('valid GUID');
    const isAuthError = err.message.includes('401') || err.message.includes('Unauthorized') || err.message.includes('Reason Unknown');
    let detail;
    if (isGuidErr) {
      detail = 'Server rejected accountId -- FLOW token may not carry account context. Requires user-level platform token.';
    } else if (isAuthError) {
      detail = 'Accounts SDK requires higher-privilege token (user-level, not FLOW token)';
    } else {
      detail = err.message;
    }
    if (steps.length === 0) {
      steps.push({ name: 'Initialize client', ok: true, latencyMs: 0, detail: 'Client created' });
    }
    steps.push({ name: 'Account access', ok: false, latencyMs: Date.now() - t0, detail });
  }

  return { ok: steps.every(s => s.ok), steps, totalLatencyMs: Date.now() - t0 };
}

async function testApiTokens() {
  const steps = [];
  const t0 = Date.now();

  try {
    await getToken();

    // Step 1: Verify SDK loads and instantiates
    let start = Date.now();
    const apiTok = getApiTokens();
    steps.push({ name: 'Initialize client', ok: true, latencyMs: Date.now() - start, detail: 'Client ready' });

    // Step 2: List existing API tokens
    start = Date.now();
    const tokenList = await apiTok.list();
    const items = Array.isArray(tokenList) ? tokenList : (tokenList?.items || tokenList?.data || []);
    steps.push({ name: 'List API tokens', ok: true, latencyMs: Date.now() - start, detail: `${items.length} token(s) found` });

    // Step 3: Report token names
    if (items.length > 0) {
      const names = items.slice(0, 5).map(t => t.name || t.label || t.id || '(unnamed)');
      steps.push({ name: 'Token names', ok: true, latencyMs: 0, detail: names.join(', ') });
    }

  } catch (err) {
    const is404 = err.message.includes('404') || err.message.includes('Not Found');
    const isAuthError = err.message.includes('401') || err.message.includes('Unauthorized');
    let detail;
    if (is404) {
      detail = 'api-tokens-api service not found in this Edison environment. Service may not be deployed or requires different discovery URL.';
    } else if (isAuthError) {
      detail = 'API Tokens SDK requires a user-level or admin token (not FLOW token)';
    } else {
      detail = err.message;
    }
    if (steps.length === 0) {
      steps.push({ name: 'Initialize client', ok: true, latencyMs: 0, detail: 'Client created' });
    }
    steps.push({ name: 'API Tokens access', ok: false, latencyMs: Date.now() - t0, detail });
  }

  return { ok: steps.every(s => s.ok), steps, totalLatencyMs: Date.now() - t0 };
}

async function testDeployer() {
  const steps = [];
  const t0 = Date.now();

  try {
    await getToken();
    const start = Date.now();
    const _dep = getDeployer();
    steps.push({ name: 'Initialize client', ok: true, latencyMs: Date.now() - start, detail: 'Deployer client ready (used internally by Flows SDK)' });
  } catch (err) {
    steps.push({ name: 'Error', ok: false, latencyMs: Date.now() - t0, detail: err.message });
  }

  return { ok: steps.every(s => s.ok), steps, totalLatencyMs: Date.now() - t0 };
}

async function testFiles() {
  const steps = [];
  const t0 = Date.now();

  try {
    await getToken();
    const filesApi = getFiles();

    // Step 1: List items in root (treePrefix, isPublic, attributes)
    let start = Date.now();
    const itemsResult = await filesApi.getItemsList('/', false);
    const files = itemsResult?.files || [];
    const folders = itemsResult?.folders || [];
    const _totalCount = files.length + folders.length;
    steps.push({ name: 'List root items', ok: true, latencyMs: Date.now() - start, detail: `${files.length} file(s), ${folders.length} folder(s)` });

    // Step 2: List folders (treePrefix, options)
    start = Date.now();
    const folderResult = await filesApi.getFoldersList('/');
    const folderList = Array.isArray(folderResult) ? folderResult : (folderResult?.items || folderResult?.data || []);
    const folderCount = folderList.length;
    steps.push({ name: 'List folders', ok: true, latencyMs: Date.now() - start, detail: `${folderCount} folder(s)` });

    // Step 3: Search for files (term, isPublic)
    start = Date.now();
    const searchResult = await filesApi.search('*', false);
    const searchFiles = searchResult?.files || [];
    const searchFolders = searchResult?.folders || [];
    steps.push({ name: 'Search files', ok: true, latencyMs: Date.now() - start, detail: `${searchFiles.length} file(s), ${searchFolders.length} folder(s) for "*"` });

    // Step 4: Get a file detail (if any exist)
    if (files.length > 0) {
      const firstFile = files[0];
      const fileId = firstFile?.id || firstFile?.fileId;
      if (fileId) {
        start = Date.now();
        try {
          const file = await filesApi.getFile(fileId);
          const hasName = !!(file?.name || file?.fileName);
          steps.push({ name: 'Get file detail', ok: hasName, latencyMs: Date.now() - start, detail: `"${file?.name || file?.fileName || '(unnamed)'}"` });
        } catch (e) {
          steps.push({ name: 'Get file detail', ok: false, latencyMs: Date.now() - start, detail: e.message });
        }
      }
    }

  } catch (err) {
    const isAuthError = err.message?.includes('401') || err.message?.includes('Unauthorized') || err.message?.includes('Reason Unknown');
    const isAdminErr = err.message?.includes('SUPER_ADMIN');
    let detail;
    if (isAdminErr) {
      detail = 'Operation requires SUPER_ADMIN role -- FLOW token does not have this permission';
    } else if (isAuthError) {
      detail = 'Files SDK requires user-level token for file operations';
    } else {
      detail = err.message;
    }
    steps.push({ name: 'Files access', ok: false, latencyMs: Date.now() - t0, detail });
  }

  return { ok: steps.every(s => s.ok), steps, totalLatencyMs: Date.now() - t0 };
}

async function testStepTemplates() {
  const steps = [];
  const t0 = Date.now();

  try {
    await getToken();
    const stApi = getStepTemplates();

    // Step 1: List popular step template IDs
    let start = Date.now();
    const popular = await stApi.listPopularStepTemplateIds();
    const popularList = Array.isArray(popular) ? popular : (popular?.items || popular?.data || []);
    const popularCount = popularList.length;
    steps.push({ name: 'List popular IDs', ok: popularCount >= 0, latencyMs: Date.now() - start, detail: `${popularCount} popular template(s)` });

    // Step 2: List step templates (paginated)
    start = Date.now();
    const templates = await stApi.listStepTemplates({ skip: 0, take: 5 });
    const templateItems = templates?.items || templates?.data || templates || [];
    const templateCount = Array.isArray(templateItems) ? templateItems.length : 0;
    steps.push({ name: 'List step templates', ok: templateCount > 0, latencyMs: Date.now() - start, detail: `${templateCount} template(s) returned` });

    // Step 3: Report template names
    if (templateCount > 0) {
      const names = templateItems.slice(0, 5).map(t => t.name || t.label || t.meta?.name || '(unnamed)');
      steps.push({ name: 'Template names', ok: true, latencyMs: 0, detail: names.join(', ') });
    }

    // Step 4: Fetch a single template by ID
    if (templateCount > 0) {
      const firstId = templateItems[0].id || templateItems[0].stepTemplateId;
      if (firstId) {
        start = Date.now();
        const detail = await stApi.getStepTemplateById(firstId);
        const hasName = !!(detail?.name || detail?.label || detail?.meta?.name);
        steps.push({ name: 'Get template by ID', ok: hasName, latencyMs: Date.now() - start, detail: `"${detail?.name || detail?.label || detail?.meta?.name || '(unnamed)'}"` });
      }
    }

  } catch (err) {
    const isAuthError = err.message?.includes('401') || err.message?.includes('Unauthorized');
    const detail = isAuthError
      ? 'StepTemplates SDK requires appropriate token permissions'
      : err.message;
    steps.push({ name: 'StepTemplates access', ok: false, latencyMs: Date.now() - t0, detail });
  }

  return { ok: steps.every(s => s.ok), steps, totalLatencyMs: Date.now() - t0 };
}

async function testTags() {
  const steps = [];
  const t0 = Date.now();
  const testTagName = `__sdk_test_${Date.now()}`;

  try {
    await getToken();
    const tagsApi = getTags();

    // Step 1: List all tags
    let start = Date.now();
    const allTags = await tagsApi.listAllTags();
    const tagList = Array.isArray(allTags) ? allTags : (allTags?.items || allTags?.data || []);
    const tagCount = tagList.length;
    steps.push({ name: 'List all tags', ok: tagCount >= 0, latencyMs: Date.now() - start, detail: `${tagCount} tag(s) found` });

    // Step 2: Report tag names
    if (tagCount > 0) {
      const names = tagList.slice(0, 8).map(t => t.name || t.label || '(unnamed)');
      steps.push({ name: 'Tag names', ok: true, latencyMs: 0, detail: names.join(', ') });
    }

    // Step 3: Create a test tag
    start = Date.now();
    let createdTag = null;
    try {
      createdTag = await tagsApi.createTag({ data: { label: testTagName } });
      steps.push({ name: 'Create test tag', ok: true, latencyMs: Date.now() - start, detail: `Created "${testTagName}" (id: ${createdTag?.id || createdTag?.tagId || '?'})` });
    } catch (e) {
      steps.push({ name: 'Create test tag', ok: false, latencyMs: Date.now() - start, detail: e.message });
    }

    // Step 4: Fetch by ID to verify
    if (createdTag) {
      const tagId = createdTag.id || createdTag.tagId;
      if (tagId) {
        start = Date.now();
        try {
          const fetched = await tagsApi.getTagById(tagId);
          const match = (fetched?.data?.label === testTagName);
          steps.push({ name: 'Get tag by ID', ok: match, latencyMs: Date.now() - start, detail: match ? `Label matches: "${testTagName}"` : `Got: ${fetched?.data?.label || '(no label)'}` });
        } catch (e) {
          steps.push({ name: 'Get tag by ID', ok: false, latencyMs: Date.now() - start, detail: e.message });
        }
      }
    }

    // Step 5: Delete the test tag (cleanup -- deleteTag expects { id })
    if (createdTag) {
      const tagId = createdTag.id || createdTag.tagId;
      if (tagId) {
        start = Date.now();
        try {
          await tagsApi.deleteTag({ id: tagId });
          steps.push({ name: 'Delete test tag', ok: true, latencyMs: Date.now() - start, detail: 'Cleaned up' });
        } catch (e) {
          steps.push({ name: 'Delete test tag', ok: false, latencyMs: Date.now() - start, detail: e.message });
        }
      }
    }

  } catch (err) {
    const isAuthError = err.message?.includes('401') || err.message?.includes('Unauthorized');
    const detail = isAuthError
      ? 'Tags SDK requires appropriate token permissions'
      : err.message;
    steps.push({ name: 'Tags access', ok: false, latencyMs: Date.now() - t0, detail });
  }

  return { ok: steps.every(s => s.ok), steps, totalLatencyMs: Date.now() - t0 };
}

async function testDataHubSvc() {
  const steps = [];
  const t0 = Date.now();

  try {
    await getToken();

    // Step 1: Initialize client
    let start = Date.now();
    const dh = getDataHubSvc();
    steps.push({ name: 'Initialize client', ok: true, latencyMs: Date.now() - start, detail: 'DataHubSvc client ready' });

    // Step 2: Resolve data-hub service URL via Discovery
    start = Date.now();
    try {
      const disc = getDiscoverySDK();
      const dhUrl = await disc.getServiceUrl('data-hub');
      const hasUrl = typeof dhUrl === 'string' && dhUrl.startsWith('http');
      steps.push({ name: 'Resolve data-hub URL', ok: hasUrl, latencyMs: Date.now() - start, detail: hasUrl ? dhUrl : 'Could not resolve' });

      // Step 3: Make a lightweight request via the resolved URL
      if (hasUrl) {
        start = Date.now();
        const result = await dh.makeRequest({ method: 'GET', url: `${dhUrl}/step-templates`, params: { skip: 0, take: 1 } });
        const items = result?.items || result?.data || result || [];
        const count = Array.isArray(items) ? items.length : (items ? 1 : 0);
        steps.push({ name: 'GET step-templates', ok: true, latencyMs: Date.now() - start, detail: `${count} item(s) returned` });
      }
    } catch (e) {
      steps.push({ name: 'DataHubSvc request', ok: false, latencyMs: Date.now() - start, detail: e.message });
    }

  } catch (err) {
    const isAuthError = err.message?.includes('401') || err.message?.includes('Unauthorized');
    const detail = isAuthError
      ? 'DataHubSvc requires appropriate token permissions'
      : err.message;
    steps.push({ name: 'DataHubSvc access', ok: false, latencyMs: Date.now() - t0, detail });
  }

  return { ok: steps.every(s => s.ok), steps, totalLatencyMs: Date.now() - t0 };
}

// ---------------------------------------------------------------------------
// Aggregated status and test runners
// ---------------------------------------------------------------------------

async function testSDK(name) {
  const testers = {
    token: testToken,
    'key-value-storage': testKV,
    flows: testFlows,
    bots: testBots,
    deployer: testDeployer,
    discovery: testDiscovery,
    library: testLibrary,
    'files-sync': testFilesSync,
    accounts: testAccounts,
    'api-tokens': testApiTokens,
    files: testFiles,
    'step-templates': testStepTemplates,
    tags: testTags,
    'data-hub-svc': testDataHubSvc,
  };

  const fn = testers[name];
  if (!fn) return { ok: false, steps: [{ name: 'Unknown SDK', ok: false, detail: `No test for "${name}"` }] };

  const result = await fn();
  result.testedAt = new Date().toISOString();
  lastTestResults[name] = result;

  writeConfig({ lastTestResults });
  return result;
}

async function testAll() {
  const results = {};
  const order = ['token', 'key-value-storage', 'flows', 'bots', 'deployer', 'discovery', 'library', 'files-sync', 'accounts', 'api-tokens', 'files', 'step-templates', 'tags', 'data-hub-svc'];

  for (const name of order) {
    try {
      results[name] = await testSDK(name);
    } catch (err) {
      results[name] = { ok: false, steps: [{ name: 'Exception', ok: false, detail: err.message }], testedAt: new Date().toISOString() };
    }
  }

  return results;
}

function getStatus() {
  loadSDKs();

  const versions = {};
  for (const [key, info] of Object.entries(SDK_PACKAGES)) {
    versions[key] = { label: info.label, version: getPackageVersion(info.pkg), installed: getPackageVersion(info.pkg) !== 'not installed' };
  }

  return {
    accountId: getAccountId(),
    discoveryUrl: getDiscoveryUrl(),
    token: getTokenStatus(),
    sdks: versions,
    lastTestResults,
  };
}

// ---------------------------------------------------------------------------
// Quick actions (for Settings UI interactive exploration)
// ---------------------------------------------------------------------------

async function listSpaces() {
  await getToken();
  const botsApi = getBots();
  const allBots = await botsApi.listBots();
  const items = Array.isArray(allBots) ? allBots : (allBots?.items || []);
  return items.map(b => ({
    id: b.botId || b.id,
    label: b.data?.label || b.label || '(unnamed)',
    description: b.data?.description || '',
  }));
}

async function searchLibrary(query) {
  await getToken();
  const lib = getLibrary('STEP');
  const results = await lib.searchPackages({ query: query || 'key value', take: 20 });
  const items = results?.items || results || [];
  return (Array.isArray(items) ? items : []).map(i => ({
    id: i.id || i.packageId,
    name: i.meta?.name || i.name || i.label || '(unnamed)',
    description: i.meta?.help || i.description || '',
    version: i.version || '',
  }));
}

async function browseKV(collection, prefix) {
  await getToken();
  const kv = getKV();
  const result = await kv.scrollKeys({ numberOfItems: 50 }, collection || '__sdk_test', prefix || '', true);
  return (result?.items || []).map(item => ({
    key: item.key || item.name,
    value: item.value,
  }));
}

// ---------------------------------------------------------------------------
// callFlow -- call an Edison flow HTTP endpoint (authenticated with FLOW token)
// ---------------------------------------------------------------------------

async function callFlow(flowPath, payload = {}, method = 'POST') {
  const token = await getToken();
  const accountId = getAccountId();
  const url = `https://em.edison.api.onereach.ai/http/${accountId}/${flowPath}`;

  const resp = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: token,
    },
    body: method !== 'GET' ? JSON.stringify(payload) : undefined,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`callFlow ${flowPath}: ${resp.status} ${resp.statusText} ${text}`);
  }

  const contentType = resp.headers.get('content-type') || '';
  if (contentType.includes('json')) {
    return resp.json();
  }
  return resp.text();
}

// ---------------------------------------------------------------------------
// Flow discovery helpers (used by Dev Tools "Configure Step", etc.)
// ---------------------------------------------------------------------------

const _flowByNameCache = {};  // { 'name::botId': flowId }
const _flowHttpPathCache = {}; // { flowId: httpPath }

async function findFlowByName(name, botId) {
  const cacheKey = `${name}::${botId || '*'}`;
  if (_flowByNameCache[cacheKey]) return _flowByNameCache[cacheKey];

  await getToken();
  const flowsApi = getFlows();
  const botsApi = getBots();
  const normalised = name.trim().toLowerCase();

  async function searchInBot(bid) {
    const list = await flowsApi.listFlows({ query: { botId: bid } });
    const items = list?.items || list || [];
    if (!Array.isArray(items)) return null;
    for (const f of items) {
      const label = (f.data?.label || f.label || '').trim().toLowerCase();
      if (label === normalised) return f.flowId || f.id;
    }
    return null;
  }

  if (botId) {
    const found = await searchInBot(botId);
    if (found) { _flowByNameCache[cacheKey] = found; return found; }
  }

  const allBots = await botsApi.listBots();
  const botItems = Array.isArray(allBots) ? allBots : (allBots?.items || []);
  for (const bot of botItems) {
    const bid = bot.botId || bot.id;
    if (bid === botId) continue;
    const found = await searchInBot(bid);
    if (found) { _flowByNameCache[cacheKey] = found; return found; }
  }

  return null;
}

async function getFlowHttpPath(flowId) {
  if (_flowHttpPathCache[flowId]) return _flowHttpPathCache[flowId];

  await getToken();
  const flowsApi = getFlows();
  const flow = await flowsApi.getFlow(flowId);

  const tplArr = flow?.data?.stepTemplates || [];
  const gatewayTemplateIds = new Set(tplArr.filter(t => t?.isGatewayStep).map(t => t.id));

  for (const treeName of Object.keys(flow?.data?.trees || {})) {
    const steps = flow.data.trees[treeName]?.steps || [];
    const arr = Array.isArray(steps) ? steps : Object.values(steps);
    for (const step of arr) {
      const isGateway = step.isGatewayStep === true ||
        (step.type && gatewayTemplateIds.has(step.type));
      if (!isGateway) continue;

      const pathFromInput = step.stepInputData?.path;
      const pathFromData = step.data?.path;
      const raw = pathFromInput || pathFromData;
      if (!raw) continue;

      const cleaned = String(raw).replace(/^`|`$/g, '').trim();
      if (cleaned) {
        _flowHttpPathCache[flowId] = cleaned;
        return cleaned;
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  getToken,
  getTokenStatus,
  invalidateInstances,
  getKV,
  getFlows,
  getBots,
  getLibrary,
  getFilesSync,
  getDiscoverySDK,
  getAccounts,
  getApiTokens,
  getDeployer,
  getFiles,
  getStepTemplates,
  getTags,
  getDataHubSvc,
  getStatus,
  testSDK,
  testAll,
  testToken,
  testKV,
  testFlows,
  testBots,
  testLibrary,
  testFilesSync,
  testDiscovery,
  testAccounts,
  testApiTokens,
  testDeployer,
  testFiles,
  testStepTemplates,
  testTags,
  testDataHubSvc,
  listSpaces,
  searchLibrary,
  browseKV,
  callFlow,
  findFlowByName,
  getFlowHttpPath,
  getAccountId,
  getDiscoveryUrl,
  SDK_PACKAGES,
  _getTokenCache: () => tokenCache,
  _setTokenCache: (val) => { tokenCache = val; },
};
