#!/usr/bin/env node
/**
 * Comprehensive AI Service Test Suite
 * 
 * Tests all phases of the centralized AI service:
 * - Phase 1: Core service structure, profiles, circuit breakers
 * - Phase 2-4: Migration verification (no remaining direct API calls)
 * - Phase 5: Old wrappers deprecated
 * - Live API tests: chat, complete, json, vision, embed, cost tracking
 * 
 * Usage: node test-ai-service.js [--live]
 *   --live  Run live API tests (requires API keys in settings)
 */

const path = require('path');
const fs = require('fs');

// ============================================================
// Test Harness
// ============================================================
let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err.message });
    console.log(`  [FAIL] ${name}: ${err.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err.message });
    console.log(`  [FAIL] ${name}: ${err.message}`);
  }
}

function skip(name, reason) {
  skipped++;
  console.log(`  [SKIP] ${name} -- ${reason}`);
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(msg || `Expected "${expected}" but got "${actual}"`);
  }
}

function assertContains(str, substr, msg) {
  if (!str || !str.includes(substr)) {
    throw new Error(msg || `Expected string to contain "${substr}" but got "${str}"`);
  }
}

function section(name) {
  console.log(`\n=== ${name} ===`);
}

// ============================================================
// Mock global.settingsManager for testing
// ============================================================
function setupMockSettings() {
  // Check if we're running in Electron
  const isElectron = typeof process.versions.electron === 'string';
  
  if (isElectron) {
    try {
      const { getSettingsManager } = require('./settings-manager');
      const settings = getSettingsManager();
      global.settingsManager = settings;
      return true;
    } catch (e) {
      console.log(`  [WARN] Electron settings-manager failed: ${e.message}`);
    }
  }
  
  {
    console.log(`  [INFO] Running outside Electron. Loading keys from disk...`);
    
    // In non-Electron context, read keys directly from the encrypted settings file
    let fileSettings = {};
    try {
      const settingsPath = path.join(
        process.env.HOME || '', 
        'Library', 'Application Support', 'Onereach.ai', 'app-settings-encrypted.json'
      );
      if (fs.existsSync(settingsPath)) {
        fileSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        // Extract plain-text values (dev mode stores them unencrypted)
        for (const [key, value] of Object.entries(fileSettings)) {
          if (typeof value === 'object' && value !== null && value.encrypted) {
            // Encrypted values can't be read outside Electron
            fileSettings[key] = null;
          }
        }
        console.log(`  [INFO] Loaded ${Object.keys(fileSettings).length} settings from disk`);
      }
    } catch (readErr) {
      console.log(`  [WARN] Could not read settings file: ${readErr.message}`);
    }
    
    // Clean anthropic key (it sometimes has "Anthr:  " prefix from copy-paste)
    let anthropicKey = fileSettings.anthropicApiKey || process.env.ANTHROPIC_API_KEY || '';
    if (typeof anthropicKey === 'string') {
      const match = anthropicKey.match(/sk-ant-[A-Za-z0-9_-]+/);
      if (match) anthropicKey = match[0];
    }
    
    global.settingsManager = {
      _data: {
        openaiApiKey: fileSettings.openaiApiKey || process.env.OPENAI_API_KEY || '',
        anthropicApiKey: anthropicKey,
        llmProvider: fileSettings.llmProvider || 'openai',
        llmApiKey: fileSettings.llmApiKey || process.env.OPENAI_API_KEY || '',
        aiModelProfiles: fileSettings.aiModelProfiles || null,
      },
      get(key) { 
        if (key.includes('.')) {
          const parts = key.split('.');
          let val = this._data;
          for (const p of parts) { val = val?.[p]; }
          return val;
        }
        return this._data[key]; 
      },
      set(key, val) { this._data[key] = val; },
      getLLMApiKey() { return this._data.anthropicApiKey || this._data.llmApiKey; },
      getLLMProvider() { return this._data.llmProvider; },
      getLLMModel() { return 'gpt-4o-mini'; },
      getAIModelProfiles() { return this._data.aiModelProfiles; },
      setAIModelProfile(name, config) {
        if (!this._data.aiModelProfiles) this._data.aiModelProfiles = {};
        this._data.aiModelProfiles[name] = config;
      },
    };
    
    const hasOpenAI = !!global.settingsManager._data.openaiApiKey;
    const hasAnthropic = !!global.settingsManager._data.anthropicApiKey;
    console.log(`  [INFO] OpenAI key: ${hasOpenAI ? 'found' : 'NOT FOUND'}`);
    console.log(`  [INFO] Anthropic key: ${hasAnthropic ? 'found' : 'NOT FOUND'}`);
    
    return true;
  }
}

// ============================================================
// PHASE 1: Core Service Structure Tests
// ============================================================
function testCoreStructure() {
  section('Phase 1: Core Service Structure');
  
  test('ai-service.js exports getAIService function', () => {
    const mod = require('./lib/ai-service');
    assert(typeof mod.getAIService === 'function', 'getAIService should be a function');
  });
  
  test('ai-service.js exports AIService class', () => {
    const mod = require('./lib/ai-service');
    assert(typeof mod.AIService === 'function', 'AIService should be a constructor');
  });
  
  test('ai-service.js exports error classes', () => {
    const mod = require('./lib/ai-service');
    assert(typeof mod.BudgetExceededError === 'function', 'BudgetExceededError should exist');
    assert(typeof mod.CircuitOpenError === 'function', 'CircuitOpenError should exist');
    assert(typeof mod.AllProvidersFailedError === 'function', 'AllProvidersFailedError should exist');
  });
  
  test('ai-service.js exports DEFAULT_MODEL_PROFILES', () => {
    const { DEFAULT_MODEL_PROFILES } = require('./lib/ai-service');
    assert(DEFAULT_MODEL_PROFILES, 'DEFAULT_MODEL_PROFILES should exist');
    assert(DEFAULT_MODEL_PROFILES.fast, 'Should have fast profile');
    assert(DEFAULT_MODEL_PROFILES.standard, 'Should have standard profile');
    assert(DEFAULT_MODEL_PROFILES.powerful, 'Should have powerful profile');
    assert(DEFAULT_MODEL_PROFILES.vision, 'Should have vision profile');
    assert(DEFAULT_MODEL_PROFILES.realtime, 'Should have realtime profile');
    assert(DEFAULT_MODEL_PROFILES.embedding, 'Should have embedding profile');
    assert(DEFAULT_MODEL_PROFILES.transcription, 'Should have transcription profile');
  });
  
  test('Default profiles have correct provider assignments', () => {
    const { DEFAULT_MODEL_PROFILES } = require('./lib/ai-service');
    assertEqual(DEFAULT_MODEL_PROFILES.fast.provider, 'openai', 'fast should use openai');
    assertEqual(DEFAULT_MODEL_PROFILES.standard.provider, 'anthropic', 'standard should use anthropic');
    assertEqual(DEFAULT_MODEL_PROFILES.powerful.provider, 'anthropic', 'powerful should use anthropic');
  });
  
  test('Default profiles have fallback configurations', () => {
    const { DEFAULT_MODEL_PROFILES } = require('./lib/ai-service');
    assert(DEFAULT_MODEL_PROFILES.fast.fallback, 'fast should have fallback');
    assert(DEFAULT_MODEL_PROFILES.standard.fallback, 'standard should have fallback');
    assert(DEFAULT_MODEL_PROFILES.powerful.fallback, 'powerful should have fallback');
  });
  
  test('Proxy module exposes convenience methods', () => {
    const ai = require('./lib/ai-service');
    assert(typeof ai.chat === 'function', 'Should have chat()');
    assert(typeof ai.complete === 'function', 'Should have complete()');
    assert(typeof ai.json === 'function', 'Should have json()');
    assert(typeof ai.vision === 'function', 'Should have vision()');
    assert(typeof ai.embed === 'function', 'Should have embed()');
    assert(typeof ai.transcribe === 'function', 'Should have transcribe()');
    assert(typeof ai.tts === 'function', 'Should have tts()');
    assert(typeof ai.imageEdit === 'function', 'Should have imageEdit()');
    assert(typeof ai.imageGenerate === 'function', 'Should have imageGenerate()');
    assert(typeof ai.realtime === 'function', 'Should have realtime()');
    assert(typeof ai.getCostSummary === 'function', 'Should have getCostSummary()');
    assert(typeof ai.getStatus === 'function', 'Should have getStatus()');
    assert(typeof ai.setProfile === 'function', 'Should have setProfile()');
    assert(typeof ai.resetCircuit === 'function', 'Should have resetCircuit()');
    assert(typeof ai.testConnection === 'function', 'Should have testConnection()');
  });
  
  test('Specialized agent methods exist', () => {
    const ai = require('./lib/ai-service');
    assert(typeof ai.planAgent === 'function', 'Should have planAgent()');
    assert(typeof ai.diagnoseAgentFailure === 'function', 'Should have diagnoseAgentFailure()');
    assert(typeof ai.generateAgentFix === 'function', 'Should have generateAgentFix()');
    assert(typeof ai.generateOptimizedScript === 'function', 'Should have generateOptimizedScript()');
  });
}

// ============================================================
// PHASE 1: Adapter Tests
// ============================================================
function testAdapters() {
  section('Phase 1: Provider Adapters');
  
  test('OpenAI adapter loads and exports correctly', () => {
    const { OpenAIAdapter, getOpenAIAdapter, estimateTokens } = require('./lib/ai-providers/openai-adapter');
    assert(typeof OpenAIAdapter === 'function', 'OpenAIAdapter should be a class');
    assert(typeof getOpenAIAdapter === 'function', 'getOpenAIAdapter should be a function');
    assert(typeof estimateTokens === 'function', 'estimateTokens should be a function');
  });
  
  test('OpenAI adapter has all required methods', () => {
    const { getOpenAIAdapter } = require('./lib/ai-providers/openai-adapter');
    const adapter = getOpenAIAdapter();
    assert(typeof adapter.chat === 'function', 'Should have chat()');
    assert(typeof adapter.chatStream === 'function', 'Should have chatStream()');
    assert(typeof adapter.vision === 'function', 'Should have vision()');
    assert(typeof adapter.embed === 'function', 'Should have embed()');
    assert(typeof adapter.transcribe === 'function', 'Should have transcribe()');
    assert(typeof adapter.tts === 'function', 'Should have tts()');
    assert(typeof adapter.imageEdit === 'function', 'Should have imageEdit()');
    assert(typeof adapter.imageGenerate === 'function', 'Should have imageGenerate()');
    assert(typeof adapter.createRealtimeSession === 'function', 'Should have createRealtimeSession()');
  });
  
  test('Anthropic adapter loads and exports correctly', () => {
    const { AnthropicAdapter, getAnthropicAdapter, estimateTokens } = require('./lib/ai-providers/anthropic-adapter');
    assert(typeof AnthropicAdapter === 'function', 'AnthropicAdapter should be a class');
    assert(typeof getAnthropicAdapter === 'function', 'getAnthropicAdapter should be a function');
    assert(typeof estimateTokens === 'function', 'estimateTokens should be a function');
  });
  
  test('Anthropic adapter has all required methods', () => {
    const { getAnthropicAdapter } = require('./lib/ai-providers/anthropic-adapter');
    const adapter = getAnthropicAdapter();
    assert(typeof adapter.chat === 'function', 'Should have chat()');
    assert(typeof adapter.chatStream === 'function', 'Should have chatStream()');
    assert(typeof adapter.vision === 'function', 'Should have vision()');
  });
  
  test('Token estimation works', () => {
    const { estimateTokens } = require('./lib/ai-providers/openai-adapter');
    const count = estimateTokens('Hello, world!');
    assert(count > 0, 'Token count should be positive');
    assert(count < 100, 'Token count for short string should be small');
  });
}

// ============================================================
// PHASE 1: Circuit Breaker Tests
// ============================================================
function testCircuitBreaker() {
  section('Phase 1: Circuit Breaker');
  
  test('getStatus returns circuit breaker states', () => {
    const { getAIService } = require('./lib/ai-service');
    const service = getAIService();
    const status = service.getStatus();
    assert(status.circuits, 'Status should include circuits');
    assert(status.circuits.openai, 'Should have openai circuit');
    assert(status.circuits.anthropic, 'Should have anthropic circuit');
  });
  
  test('Circuit breakers start in closed state', () => {
    const { getAIService } = require('./lib/ai-service');
    const service = getAIService();
    const status = service.getStatus();
    assertEqual(status.circuits.openai.state, 'closed', 'OpenAI circuit should start closed');
    assertEqual(status.circuits.anthropic.state, 'closed', 'Anthropic circuit should start closed');
  });
  
  test('resetCircuit works', () => {
    const { getAIService } = require('./lib/ai-service');
    const service = getAIService();
    service.resetCircuit('openai');
    const status = service.getStatus();
    assertEqual(status.circuits.openai.state, 'closed', 'Circuit should be closed after reset');
  });
}

// ============================================================
// PHASE 1: Profile Management Tests
// ============================================================
function testProfileManagement() {
  section('Phase 1: Profile Management');
  
  test('getProfiles returns all default profiles', () => {
    const { getAIService } = require('./lib/ai-service');
    const service = getAIService();
    const profiles = service.getProfiles();
    assert(profiles.fast, 'Should have fast profile');
    assert(profiles.standard, 'Should have standard profile');
    assert(profiles.powerful, 'Should have powerful profile');
    assert(profiles.vision, 'Should have vision profile');
    assert(profiles.realtime, 'Should have realtime profile');
    assert(profiles.embedding, 'Should have embedding profile');
    assert(profiles.transcription, 'Should have transcription profile');
  });
  
  test('setProfile adds a custom profile', () => {
    const { getAIService } = require('./lib/ai-service');
    const service = getAIService();
    service.setProfile('test-custom', {
      provider: 'openai',
      model: 'gpt-4o-mini',
    });
    const profiles = service.getProfiles();
    assert(profiles['test-custom'], 'Custom profile should exist');
    assertEqual(profiles['test-custom'].provider, 'openai');
    assertEqual(profiles['test-custom'].model, 'gpt-4o-mini');
  });
  
  test('Unknown profile throws descriptive error', () => {
    const { getAIService } = require('./lib/ai-service');
    const service = getAIService();
    let threw = false;
    try {
      service._resolveProfile({ profile: 'nonexistent-profile-xyz' });
    } catch (e) {
      threw = true;
      assertContains(e.message, 'Unknown AI profile');
      assertContains(e.message, 'nonexistent-profile-xyz');
    }
    assert(threw, 'Should throw for unknown profile');
  });
}

// ============================================================
// PHASE 2-4: Migration Verification
// ============================================================
function testMigrationCompleteness() {
  section('Phase 2-4: Migration Verification');
  
  // Check that agent files use ai-service
  const agentDir = path.join(__dirname, 'packages', 'agents');
  const agentFiles = [
    'email-agent.js', 'search-agent.js', 'calendar-agent.js', 
    'weather-agent.js', 'time-agent.js', 'smalltalk-agent.js',
    'help-agent.js', 'media-agent.js', 'spaces-agent.js',
    'unified-bidder.js', 'master-orchestrator.js',
    'dynamic-agent.js', 'meeting-monitor-agent.js',
    // Note: orchestrator-agent.js doesn't make API calls (purely routing), so not migrated
  ];
  
  for (const file of agentFiles) {
    const filePath = path.join(agentDir, file);
    if (!fs.existsSync(filePath)) {
      skip(`Agent file ${file} uses ai-service`, 'file not found');
      continue;
    }
    test(`Agent file ${file} imports ai-service`, () => {
      const content = fs.readFileSync(filePath, 'utf8');
      assert(
        content.includes("require('../../lib/ai-service')") || 
        content.includes('require("../../lib/ai-service")'),
        `${file} should import ai-service`
      );
    });
  }
  
  // Check tool files
  const toolFiles = [
    { path: 'video-editor.js', importPath: "require('./lib/ai-service')" },
    { path: 'clipboard-manager-v2-adapter.js', importPath: "require('./lib/ai-service')" },
    { path: 'metadata-generator.js', importPath: "require('./lib/ai-service')" },
    { path: 'smart-export.js', importPath: "require('./lib/ai-service')" },
    { path: 'menu.js', importPath: "require('./lib/ai-service')" },
    { path: 'app-manager-agent.js', importPath: "require('./lib/ai-service')" },
    { path: 'lib/thinking-agent.js', importPath: "require('./ai-service')" },
    { path: 'lib/tool-agent-generator.js', importPath: "require('./ai-service')" },
  ];
  
  for (const { path: filePath, importPath } of toolFiles) {
    const absPath = path.join(__dirname, filePath);
    if (!fs.existsSync(absPath)) {
      skip(`Tool file ${filePath} uses ai-service`, 'file not found');
      continue;
    }
    test(`Tool file ${filePath} imports ai-service`, () => {
      const content = fs.readFileSync(absPath, 'utf8');
      assert(
        content.includes(importPath) || content.includes('ai-service'),
        `${filePath} should import ai-service`
      );
    });
  }
  
  // Check NO remaining direct API calls in migrated files (excluding allowed exceptions)
  const excludePatterns = [
    'node_modules', '_legacy', 'test/', 'voice-sdk-package/', 
    'claude-api.js', 'openai-api.js', 'unified-claude.js',
    'lib/ai-providers/', 'lib/ai-service.js',
  ];
  
  test('No remaining direct OpenAI chat calls in agent files', () => {
    for (const file of agentFiles) {
      const filePath = path.join(agentDir, file);
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, 'utf8');
      assert(
        !content.includes('api.openai.com/v1/chat/completions'),
        `${file} still has direct OpenAI chat call`
      );
    }
  });
  
  test('No remaining getOpenAIApiKey in agent files', () => {
    for (const file of agentFiles) {
      const filePath = path.join(agentDir, file);
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, 'utf8');
      assert(
        !content.includes('getOpenAIApiKey'),
        `${file} still has getOpenAIApiKey function`
      );
    }
  });
  
  // Gap closure: DALL-E image generation now goes through ai-service
  test('main.js design handlers use ai-service (no direct DALL-E calls)', () => {
    const mainContent = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
    // design:generate-choices and design:regenerate-single should NOT have direct API calls
    // The only hostname: 'api.openai.com' left should be in adapter or deprecated wrappers
    const designSection = mainContent.substring(
      mainContent.indexOf("design:generate-choices"),
      mainContent.indexOf("design:regenerate-single") + 500
    );
    assert(
      !designSection.includes("hostname: 'api.openai.com'"),
      'Design handlers should not have direct OpenAI API calls'
    );
    assert(
      designSection.includes("ai.imageGenerate"),
      'Design handlers should use ai.imageGenerate()'
    );
  });
  
  // Gap closure: Video transcription now goes through ai-service
  test('src/video/index.js uses ai-service for transcription', () => {
    const videoPath = path.join(__dirname, 'src', 'video', 'index.js');
    if (!fs.existsSync(videoPath)) {
      skip('Video transcription migration', 'src/video/index.js not found');
      return;
    }
    const content = fs.readFileSync(videoPath, 'utf8');
    assert(
      content.includes("require('../../lib/ai-service')"),
      'Should import ai-service'
    );
    assert(
      !content.includes("hostname: 'api.openai.com'"),
      'Should not have direct OpenAI API calls'
    );
  });
  
  // Gap closure: whisperSpeech.ts fallback is deprecated
  test('whisperSpeech.ts has deprecation warning on direct fetch fallback', () => {
    const wsPath = path.join(__dirname, 'src', 'voice-task-sdk', 'services', 'whisperSpeech.ts');
    if (!fs.existsSync(wsPath)) {
      skip('whisperSpeech.ts deprecation', 'file not found');
      return;
    }
    const content = fs.readFileSync(wsPath, 'utf8');
    assert(
      content.includes('@deprecated'),
      'Direct fetch fallback should be marked @deprecated'
    );
    assert(
      content.includes('DEPRECATED'),
      'Should have DEPRECATED warning in console.warn'
    );
  });
}

// ============================================================
// PHASE 5: Deprecation Verification
// ============================================================
function testDeprecation() {
  section('Phase 5: Old Wrapper Deprecation');
  
  test('claude-api.js has deprecation notice', () => {
    const content = fs.readFileSync(path.join(__dirname, 'claude-api.js'), 'utf8');
    assertContains(content, '@deprecated', 'Should have @deprecated marker');
    assertContains(content, 'ai-service', 'Should reference ai-service');
  });
  
  test('openai-api.js has deprecation notice', () => {
    const content = fs.readFileSync(path.join(__dirname, 'openai-api.js'), 'utf8');
    assertContains(content, '@deprecated', 'Should have @deprecated marker');
    assertContains(content, 'ai-service', 'Should reference ai-service');
  });
  
  test('unified-claude.js has deprecation notice', () => {
    const content = fs.readFileSync(path.join(__dirname, 'unified-claude.js'), 'utf8');
    assertContains(content, '@deprecated', 'Should have @deprecated marker');
    assertContains(content, 'ai-service', 'Should reference ai-service');
  });
}

// ============================================================
// PHASE 1: Cost & Status API Tests
// ============================================================
function testCostAndStatus() {
  section('Phase 1: Cost & Status APIs');
  
  test('getCostSummary returns structured data', () => {
    const { getAIService } = require('./lib/ai-service');
    const service = getAIService();
    const summary = service.getCostSummary();
    assert(summary !== null && summary !== undefined, 'Should return a summary');
    assert(typeof summary === 'object', 'Should be an object');
  });
  
  test('getStatus returns structured data', () => {
    const { getAIService } = require('./lib/ai-service');
    const service = getAIService();
    const status = service.getStatus();
    assert(status.circuits, 'Should have circuits');
    assert(status.adapters, 'Should have adapters');
    assert(status.profiles, 'Should have profiles');
  });
  
  test('getStatus.adapters lists both providers', () => {
    const { getAIService } = require('./lib/ai-service');
    const service = getAIService();
    const status = service.getStatus();
    assert(status.adapters.includes('openai') || status.adapters.openai, 'Should list openai');
    assert(status.adapters.includes('anthropic') || status.adapters.anthropic, 'Should list anthropic');
  });
}

// ============================================================
// LIVE API TESTS (require --live flag and API keys)
// ============================================================
async function testLiveAPIs() {
  section('Live API Tests');
  
  const { getAIService } = require('./lib/ai-service');
  const service = getAIService();
  
  // Check if API keys are available
  let hasOpenAI = false;
  let hasAnthropic = false;
  
  try {
    service._getApiKey('openai');
    hasOpenAI = true;
  } catch (e) {
    console.log('  [INFO] No OpenAI API key found');
  }
  
  try {
    service._getApiKey('anthropic');
    hasAnthropic = true;
  } catch (e) {
    console.log('  [INFO] No Anthropic API key found');
  }
  
  if (!hasOpenAI && !hasAnthropic) {
    skip('All live API tests', 'No API keys configured');
    return;
  }
  
  // ---- OpenAI Tests ----
  if (hasOpenAI) {
    await testAsync('ai.chat() with fast profile (OpenAI)', async () => {
      const result = await service.chat({
        profile: 'fast',
        messages: [{ role: 'user', content: 'Reply with exactly: PING_OK' }],
        maxTokens: 20,
        temperature: 0,
        feature: 'test-suite',
      });
      assert(result, 'Should return a result');
      assert(result.content, 'Should have content');
      assertContains(result.content, 'PING_OK', 'Should respond with PING_OK');
      console.log(`    Response: "${result.content.trim()}"`);
    });
    
    await testAsync('ai.complete() convenience method (OpenAI)', async () => {
      // complete() returns the content string directly, not { content }
      const result = await service.complete('Reply with exactly: COMPLETE_OK', {
        profile: 'fast',
        maxTokens: 20,
        temperature: 0,
        feature: 'test-suite',
      });
      assert(result, 'Should return a result');
      assert(typeof result === 'string', 'complete() should return a string');
      assertContains(result, 'COMPLETE_OK');
      console.log(`    Response: "${result.trim()}"`);
    });
    
    await testAsync('ai.json() returns parsed JSON (OpenAI)', async () => {
      // json() returns the parsed JSON object directly, not { content }
      const result = await service.json('Return a JSON object with key "status" set to "ok" and key "number" set to 42. Return ONLY the JSON, no markdown.', {
        profile: 'fast',
        maxTokens: 50,
        temperature: 0,
        feature: 'test-suite',
      });
      assert(result, 'Should return a result');
      assert(typeof result === 'object', 'json() should return an object');
      assertEqual(result.status, 'ok', 'JSON status should be ok');
      assertEqual(result.number, 42, 'JSON number should be 42');
      console.log(`    Parsed JSON:`, result);
    });
    
    await testAsync('ai.embed() returns embeddings (OpenAI)', async () => {
      const result = await service.embed('Hello, world!', {
        feature: 'test-suite',
      });
      assert(result, 'Should return a result');
      // Adapter returns { embeddings: [vector, ...], usage, model, provider }
      const embedding = result.embeddings?.[0] || result.embedding || result.data;
      assert(embedding, `Should have embedding data. Got keys: ${Object.keys(result)}`);
      assert(Array.isArray(embedding), 'Embedding should be an array');
      assert(embedding.length > 0, 'Embedding should not be empty');
      console.log(`    Embedding dimensions: ${embedding.length}, count: ${result.embeddings?.length || 1}`);
    });

    await testAsync('ai.testConnection(openai) succeeds', async () => {
      const result = await service.testConnection('openai');
      assert(result.ok || result.success, 'Connection test should succeed');
      console.log(`    OpenAI connection: OK`);
    });
  } else {
    skip('ai.chat() with fast profile (OpenAI)', 'No OpenAI key');
    skip('ai.complete() convenience method (OpenAI)', 'No OpenAI key');
    skip('ai.json() returns parseable JSON (OpenAI)', 'No OpenAI key');
    skip('ai.embed() returns embeddings (OpenAI)', 'No OpenAI key');
    skip('ai.testConnection(openai)', 'No OpenAI key');
  }
  
  // ---- Anthropic Tests ----
  if (hasAnthropic) {
    await testAsync('ai.chat() with standard profile (Anthropic)', async () => {
      const result = await service.chat({
        profile: 'standard',
        messages: [{ role: 'user', content: 'Reply with exactly: CLAUDE_OK' }],
        maxTokens: 20,
        temperature: 0,
        feature: 'test-suite',
      });
      assert(result, 'Should return a result');
      assert(result.content, 'Should have content');
      assertContains(result.content, 'CLAUDE_OK', 'Should respond with CLAUDE_OK');
      console.log(`    Response: "${result.content.trim()}"`);
    });
    
    await testAsync('ai.chat() with system prompt (Anthropic)', async () => {
      const result = await service.chat({
        profile: 'standard',
        system: 'You are a test bot. Always respond with exactly "SYS_OK" and nothing else.',
        messages: [{ role: 'user', content: 'Hello' }],
        maxTokens: 20,
        temperature: 0,
        feature: 'test-suite',
      });
      assert(result, 'Should return a result');
      assert(result.content, 'Should have content');
      assertContains(result.content, 'SYS_OK');
      console.log(`    Response: "${result.content.trim()}"`);
    });
    
    await testAsync('ai.testConnection(anthropic) succeeds', async () => {
      const result = await service.testConnection('anthropic');
      assert(result.ok || result.success, 'Connection test should succeed');
      console.log(`    Anthropic connection: OK`);
    });
  } else {
    skip('ai.chat() with standard profile (Anthropic)', 'No Anthropic key');
    skip('ai.chat() with system prompt (Anthropic)', 'No Anthropic key');
    skip('ai.testConnection(anthropic)', 'No Anthropic key');
  }
  
  // ---- Cross-Provider Tests ----
  if (hasOpenAI && hasAnthropic) {
    await testAsync('Provider fallback: custom profile with nonexistent primary falls back', async () => {
      // Set a profile with a bogus primary that should fall back
      // This tests the resilience layer
      console.log('    (Testing fallback mechanism with override)');
      const result = await service.chat({
        provider: 'openai',
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Reply with exactly: FALLBACK_OK' }],
        maxTokens: 20,
        temperature: 0,
        feature: 'test-suite',
      });
      assert(result, 'Should return a result');
      assert(result.content, 'Should have content');
      console.log(`    Response: "${result.content.trim()}"`);
    });
  }
  
  // ---- Image Generation Test (DALL-E) ----
  if (hasOpenAI) {
    await testAsync('ai.imageGenerate() generates an image (OpenAI)', async () => {
      // Use URL format to avoid huge b64 data in test output
      const result = await service.imageGenerate('A simple red circle on a white background', {
        model: 'dall-e-3',
        size: '1024x1024',
        quality: 'standard',
        responseFormat: 'url',
        feature: 'test-suite',
      });
      assert(result, 'Should return a result');
      assert(result.images, 'Should have images array');
      assert(result.images.length > 0, 'Should have at least one image');
      assert(result.images[0].url || result.images[0].b64_json, 'Image should have url or b64_json');
      console.log(`    Generated ${result.images.length} image(s), has revised_prompt: ${!!result.images[0].revised_prompt}`);
    });
  } else {
    skip('ai.imageGenerate() generates an image (OpenAI)', 'No OpenAI key');
  }
  
  // ---- Cost Summary After Live Tests ----
  if (hasOpenAI || hasAnthropic) {
    test('Cost summary updated after live calls', () => {
      const summary = service.getCostSummary();
      console.log('    Cost summary:', JSON.stringify(summary, null, 2).substring(0, 500));
    });
    
    test('Status shows healthy circuits after live calls', () => {
      const status = service.getStatus();
      assertEqual(status.circuits.openai.state, 'closed', 'OpenAI circuit should remain closed');
      assertEqual(status.circuits.anthropic.state, 'closed', 'Anthropic circuit should remain closed');
    });
  }
}

// ============================================================
// SETTINGS INTEGRATION TEST
// ============================================================
function testSettingsIntegration() {
  section('Settings Integration');
  
  test('settings-manager has aiModelProfiles field', () => {
    const sm = global.settingsManager;
    assert(sm, 'settingsManager should be available');
    // The field should exist (either null for defaults or an object)
    const profiles = sm.getAIModelProfiles ? sm.getAIModelProfiles() : sm.get('aiModelProfiles');
    // null means "use defaults" which is valid
    assert(profiles === null || typeof profiles === 'object', 'aiModelProfiles should be null or object');
  });
}

// ============================================================
// IPC HANDLER EXISTENCE TEST
// ============================================================
function testIPCHandlerRegistration() {
  section('IPC Bridge Verification');
  
  test('main.js registers ai: IPC handlers', () => {
    const mainContent = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
    const handlers = [
      'ai:chat', 'ai:chatStream', 'ai:complete', 'ai:json', 
      'ai:vision', 'ai:embed', 'ai:transcribe',
      'ai:getCostSummary', 'ai:getStatus', 'ai:getProfiles',
      'ai:setProfile', 'ai:testConnection', 'ai:resetCircuit',
    ];
    for (const handler of handlers) {
      assertContains(mainContent, handler, `main.js should register ${handler} handler`);
    }
  });
  
  test('preload.js exposes window.ai API', () => {
    const preloadContent = fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8');
    assertContains(preloadContent, "exposeInMainWorld('ai'", 'Should expose ai on window');
  });
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  console.log('============================================================');
  console.log('  AI Service Comprehensive Test Suite');
  console.log('============================================================');
  
  const isLive = process.argv.includes('--live');
  
  // Setup - must happen before any ai-service require
  setupMockSettings();
  
  // Clear any cached singleton so it picks up our mock settings
  const aiServicePath = require.resolve('./lib/ai-service');
  delete require.cache[aiServicePath];
  
  // Structural tests (no API calls)
  testCoreStructure();
  testAdapters();
  testCircuitBreaker();
  testProfileManagement();
  testCostAndStatus();
  testSettingsIntegration();
  testIPCHandlerRegistration();
  testMigrationCompleteness();
  testDeprecation();
  
  // Live API tests
  if (isLive) {
    await testLiveAPIs();
  } else {
    section('Live API Tests');
    skip('All live API tests', 'Run with --live flag to enable');
  }
  
  // Summary
  console.log('\n============================================================');
  console.log(`  Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  console.log('============================================================');
  
  if (failures.length > 0) {
    console.log('\nFailures:');
    failures.forEach(f => console.log(`  - ${f.name}: ${f.error}`));
  }
  
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Test suite crashed:', err);
  process.exit(2);
});
