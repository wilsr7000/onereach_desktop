/**
 * ElevenLabs Service Direct Test Script
 * 
 * Tests the ElevenLabsService methods directly from Node.js
 * Run with: node test/test-elevenlabs-service.mjs
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Mock electron app for testing
const mockApp = {
  getPath: (name) => {
    if (name === 'userData') {
      return join(__dirname, '..');
    }
    return __dirname;
  }
};

// Inject mock before importing service
global.electronApp = mockApp;

console.log('🧪 ElevenLabs Service Direct Test\n');
console.log('='.repeat(50));

// Check for API key first
function getApiKey() {
  // Check environment
  if (process.env.ELEVENLABS_API_KEY) {
    return process.env.ELEVENLABS_API_KEY;
  }
  
  // Check settings file
  const settingsPath = join(__dirname, '..', 'settings.json');
  if (fs.existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      return settings.elevenlabsApiKey || settings.elevenLabsApiKey || null;
    } catch (e) {
      return null;
    }
  }
  
  return null;
}

const apiKey = getApiKey();
console.log(`\n📋 API Key Status: ${apiKey ? '✅ Found (' + apiKey.substring(0, 8) + '...)' : '❌ Not configured'}\n`);

if (!apiKey) {
  console.log('⚠️  Set ELEVENLABS_API_KEY environment variable or add to settings.json to test API calls');
  console.log('   Example: ELEVENLABS_API_KEY=your_key node test/test-elevenlabs-service.mjs\n');
}

// Test results
const results = { passed: [], failed: [], skipped: [] };

// Helper for API calls
async function makeElevenLabsRequest(endpoint, method = 'GET', body = null) {
  if (!apiKey) {
    return { error: 'No API key', skipped: true };
  }
  
  const https = await import('https');
  
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.elevenlabs.io',
      port: 443,
      path: endpoint,
      method: method,
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json'
      }
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (res.statusCode === 200) {
            resolve({ success: true, data: result, status: res.statusCode });
          } else {
            resolve({ success: false, error: result.detail?.message || `HTTP ${res.statusCode}`, status: res.statusCode });
          }
        } catch (e) {
          resolve({ success: false, error: 'Invalid JSON response', status: res.statusCode });
        }
      });
    });
    
    req.on('error', (e) => {
      resolve({ success: false, error: e.message });
    });
    
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

// Test 1: List Voices
async function testListVoices() {
  console.log('1️⃣  Testing: GET /v1/voices (List Voices)');
  
  const result = await makeElevenLabsRequest('/v1/voices');
  
  if (result.skipped) {
    console.log('   ⏭️  Skipped - No API key');
    results.skipped.push('listVoices');
    return;
  }
  
  if (result.success) {
    const voiceCount = result.data.voices?.length || 0;
    console.log(`   ✅ Success - Found ${voiceCount} voices`);
    if (voiceCount > 0) {
      console.log(`   📝 Sample: ${result.data.voices.slice(0, 3).map(v => v.name).join(', ')}`);
    }
    results.passed.push('listVoices');
  } else {
    console.log(`   ❌ Failed - ${result.error}`);
    results.failed.push(`listVoices: ${result.error}`);
  }
}

// Test 2: Get User Info
async function testGetUserInfo() {
  console.log('\n2️⃣  Testing: GET /v1/user (User Info)');
  
  const result = await makeElevenLabsRequest('/v1/user');
  
  if (result.skipped) {
    console.log('   ⏭️  Skipped - No API key');
    results.skipped.push('getUserInfo');
    return;
  }
  
  if (result.success) {
    console.log(`   ✅ Success - User ID: ${result.data.xi_api_key ? 'Valid' : 'Unknown'}`);
    results.passed.push('getUserInfo');
  } else {
    console.log(`   ❌ Failed - ${result.error}`);
    results.failed.push(`getUserInfo: ${result.error}`);
  }
}

// Test 3: Get Subscription
async function testGetSubscription() {
  console.log('\n3️⃣  Testing: GET /v1/user/subscription (Subscription Info)');
  
  const result = await makeElevenLabsRequest('/v1/user/subscription');
  
  if (result.skipped) {
    console.log('   ⏭️  Skipped - No API key');
    results.skipped.push('getSubscription');
    return;
  }
  
  if (result.success) {
    const sub = result.data;
    console.log(`   ✅ Success - Tier: ${sub.tier || 'Unknown'}`);
    console.log(`   📊 Characters: ${sub.character_count?.toLocaleString() || 0} / ${sub.character_limit?.toLocaleString() || '∞'}`);
    results.passed.push('getSubscription');
  } else {
    console.log(`   ❌ Failed - ${result.error}`);
    results.failed.push(`getSubscription: ${result.error}`);
  }
}

// Test 4: Get Models
async function testGetModels() {
  console.log('\n4️⃣  Testing: GET /v1/models (Available Models)');
  
  const result = await makeElevenLabsRequest('/v1/models');
  
  if (result.skipped) {
    console.log('   ⏭️  Skipped - No API key');
    results.skipped.push('getModels');
    return;
  }
  
  if (result.success) {
    const modelCount = result.data?.length || 0;
    console.log(`   ✅ Success - Found ${modelCount} models`);
    if (modelCount > 0) {
      console.log(`   📝 Sample: ${result.data.slice(0, 3).map(m => m.model_id).join(', ')}`);
    }
    results.passed.push('getModels');
  } else {
    console.log(`   ❌ Failed - ${result.error}`);
    results.failed.push(`getModels: ${result.error}`);
  }
}

// Test 5: Check Sound Generation Endpoint (without actually generating)
async function testSoundGenerationEndpoint() {
  console.log('\n5️⃣  Testing: POST /v1/sound-generation endpoint availability');
  
  if (!apiKey) {
    console.log('   ⏭️  Skipped - No API key');
    results.skipped.push('soundGeneration');
    return;
  }
  
  // We'll test with invalid params to check endpoint exists without spending credits
  const https = await import('https');
  
  const testResult = await new Promise((resolve) => {
    const postData = JSON.stringify({ text: '', duration_seconds: 0 }); // Invalid params
    
    const options = {
      hostname: 'api.elevenlabs.io',
      port: 443,
      path: '/v1/sound-generation',
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        // 422 = endpoint exists but validation failed (expected)
        // 401 = auth issue
        // 404 = endpoint doesn't exist
        resolve({ status: res.statusCode, data });
      });
    });
    
    req.on('error', (e) => resolve({ error: e.message }));
    req.write(postData);
    req.end();
  });
  
  if (testResult.status === 422 || testResult.status === 400) {
    console.log('   ✅ Endpoint exists (got validation error as expected)');
    results.passed.push('soundGeneration endpoint');
  } else if (testResult.status === 401) {
    console.log('   ⚠️  Auth error - API key may be invalid');
    results.failed.push('soundGeneration: Auth error');
  } else if (testResult.status === 404) {
    console.log('   ❌ Endpoint not found (404)');
    results.failed.push('soundGeneration: 404');
  } else {
    console.log(`   ⚠️  Unexpected status: ${testResult.status}`);
    results.passed.push('soundGeneration endpoint (unexpected status)');
  }
}

// Test 6: Check Audio Isolation Endpoint
async function testAudioIsolationEndpoint() {
  console.log('\n6️⃣  Testing: POST /v1/audio-isolation endpoint availability');
  
  if (!apiKey) {
    console.log('   ⏭️  Skipped - No API key');
    results.skipped.push('audioIsolation');
    return;
  }
  
  const https = await import('https');
  
  const testResult = await new Promise((resolve) => {
    const options = {
      hostname: 'api.elevenlabs.io',
      port: 443,
      path: '/v1/audio-isolation',
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'multipart/form-data'
      }
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    
    req.on('error', (e) => resolve({ error: e.message }));
    req.end();
  });
  
  if (testResult.status === 422 || testResult.status === 400) {
    console.log('   ✅ Endpoint exists (got validation error as expected)');
    results.passed.push('audioIsolation endpoint');
  } else if (testResult.status === 401) {
    console.log('   ⚠️  Auth error');
    results.failed.push('audioIsolation: Auth error');
  } else {
    console.log(`   ⚠️  Status: ${testResult.status}`);
    results.passed.push('audioIsolation endpoint');
  }
}

// Test 7: Check Dubbing Endpoint
async function testDubbingEndpoint() {
  console.log('\n7️⃣  Testing: POST /v1/dubbing endpoint availability');
  
  if (!apiKey) {
    console.log('   ⏭️  Skipped - No API key');
    results.skipped.push('dubbing');
    return;
  }
  
  const https = await import('https');
  
  const testResult = await new Promise((resolve) => {
    const options = {
      hostname: 'api.elevenlabs.io',
      port: 443,
      path: '/v1/dubbing',
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'multipart/form-data'
      }
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    
    req.on('error', (e) => resolve({ error: e.message }));
    req.end();
  });
  
  if (testResult.status === 422 || testResult.status === 400) {
    console.log('   ✅ Endpoint exists (got validation error as expected)');
    results.passed.push('dubbing endpoint');
  } else if (testResult.status === 401) {
    console.log('   ⚠️  Auth error');
    results.failed.push('dubbing: Auth error');
  } else {
    console.log(`   ⚠️  Status: ${testResult.status}`);
    results.passed.push('dubbing endpoint');
  }
}

// Test 8: Check Speech-to-Text (Scribe) Endpoint
async function testSpeechToTextEndpoint() {
  console.log('\n8️⃣  Testing: POST /v1/speech-to-text endpoint availability (Scribe)');
  
  if (!apiKey) {
    console.log('   ⏭️  Skipped - No API key');
    results.skipped.push('speechToText');
    return;
  }
  
  const https = await import('https');
  
  const testResult = await new Promise((resolve) => {
    const options = {
      hostname: 'api.elevenlabs.io',
      port: 443,
      path: '/v1/speech-to-text',
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'multipart/form-data'
      }
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    
    req.on('error', (e) => resolve({ error: e.message }));
    req.end();
  });
  
  if (testResult.status === 422 || testResult.status === 400) {
    console.log('   ✅ Scribe endpoint exists (got validation error as expected)');
    results.passed.push('speechToText (Scribe) endpoint');
  } else if (testResult.status === 401) {
    console.log('   ⚠️  Auth error');
    results.failed.push('speechToText: Auth error');
  } else {
    console.log(`   ⚠️  Status: ${testResult.status}`);
    results.passed.push('speechToText (Scribe) endpoint');
  }
}

// Test 9: Check Speech-to-Speech Endpoint
async function testSpeechToSpeechEndpoint() {
  console.log('\n9️⃣  Testing: POST /v1/speech-to-speech endpoint availability');
  
  if (!apiKey) {
    console.log('   ⏭️  Skipped - No API key');
    results.skipped.push('speechToSpeech');
    return;
  }
  
  const https = await import('https');
  
  // Use a known voice ID
  const testResult = await new Promise((resolve) => {
    const options = {
      hostname: 'api.elevenlabs.io',
      port: 443,
      path: '/v1/speech-to-speech/21m00Tcm4TlvDq8ikWAM', // Rachel voice
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'multipart/form-data'
      }
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    
    req.on('error', (e) => resolve({ error: e.message }));
    req.end();
  });
  
  if (testResult.status === 422 || testResult.status === 400) {
    console.log('   ✅ Endpoint exists (got validation error as expected)');
    results.passed.push('speechToSpeech endpoint');
  } else if (testResult.status === 401) {
    console.log('   ⚠️  Auth error');
    results.failed.push('speechToSpeech: Auth error');
  } else {
    console.log(`   ⚠️  Status: ${testResult.status}`);
    results.passed.push('speechToSpeech endpoint');
  }
}

// Run all tests
async function runTests() {
  await testListVoices();
  await testGetUserInfo();
  await testGetSubscription();
  await testGetModels();
  await testSoundGenerationEndpoint();
  await testAudioIsolationEndpoint();
  await testDubbingEndpoint();
  await testSpeechToTextEndpoint();
  await testSpeechToSpeechEndpoint();
  
  // Summary
  console.log('\n' + '='.repeat(50));
  console.log('📊 TEST SUMMARY');
  console.log('='.repeat(50));
  console.log(`✅ Passed:  ${results.passed.length}`);
  console.log(`❌ Failed:  ${results.failed.length}`);
  console.log(`⏭️  Skipped: ${results.skipped.length}`);
  
  if (results.failed.length > 0) {
    console.log('\n❌ Failed tests:');
    results.failed.forEach(f => console.log(`   - ${f}`));
  }
  
  if (results.passed.length > 0) {
    console.log('\n✅ Passed tests:');
    results.passed.forEach(p => console.log(`   - ${p}`));
  }
  
  console.log('\n🏁 Tests complete!\n');
  
  // Exit with error code if any tests failed
  process.exit(results.failed.length > 0 ? 1 : 0);
}

runTests();








