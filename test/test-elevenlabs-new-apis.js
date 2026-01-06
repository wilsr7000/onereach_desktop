/**
 * Test script for new ElevenLabs API integrations
 * Run with: node test/test-elevenlabs-new-apis.js
 */

const path = require('path');
const https = require('https');
const fs = require('fs');

// Mock Electron app for standalone testing
const mockUserDataPath = path.join(__dirname, '..', 'test-output');
if (!fs.existsSync(mockUserDataPath)) {
  fs.mkdirSync(mockUserDataPath, { recursive: true });
}

// Load settings to get API key - check multiple possible locations
const os = require('os');
const possiblePaths = [
  path.join(os.homedir(), 'Library', 'Application Support', 'Onereach.ai', 'app-settings.json'),
  path.join(os.homedir(), 'Library', 'Application Support', 'onereach-ai', 'app-settings.json'),
  path.join(os.homedir(), 'Library', 'Application Support', 'onereach-app', 'settings.json'),
];

// Get API key from: 1) Command line arg, 2) Environment variable, 3) Settings files
let elevenLabsApiKey = process.argv[2] || process.env.ELEVENLABS_API_KEY || null;

if (!elevenLabsApiKey) {
  for (const settingsPath of possiblePaths) {
    try {
      if (fs.existsSync(settingsPath)) {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        if (settings.elevenLabsApiKey) {
          elevenLabsApiKey = settings.elevenLabsApiKey;
          console.log('Found API key in:', settingsPath);
          break;
        }
      }
    } catch (e) {
      // Try next path
    }
  }
}

// If still no key, provide instructions
if (!elevenLabsApiKey) {
  console.log('\nChecked these paths for settings:');
  possiblePaths.forEach(p => console.log('  -', p));
  console.log('\nYou can also pass API key as: node test/test-elevenlabs-new-apis.js YOUR_API_KEY');
  console.log('Or set ELEVENLABS_API_KEY environment variable');
}

// Standalone test service (no Electron dependencies)
class TestElevenLabsService {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.outputDir = mockUserDataPath;
  }

  getApiKey() {
    return this.apiKey;
  }

  // List models
  async listModels() {
    return this._makeRequest('GET', '/v1/models');
  }

  // List voices
  async listVoices() {
    return this._makeRequest('GET', '/v1/voices');
  }

  // Get voice details
  async getVoice(voiceId) {
    return this._makeRequest('GET', `/v1/voices/${voiceId}`);
  }

  // List studio projects
  async listStudioProjects() {
    return this._makeRequest('GET', '/v1/studio/projects');
  }

  // Create studio project
  async createStudioProject(name, options = {}) {
    const formData = new URLSearchParams();
    formData.append('name', name);
    if (options.defaultModelId) formData.append('default_model_id', options.defaultModelId);
    if (options.qualityPreset) formData.append('quality_preset', options.qualityPreset);
    
    return this._makeRequest('POST', '/v1/studio/projects', formData.toString(), 'application/x-www-form-urlencoded');
  }

  // Get studio project
  async getStudioProject(projectId) {
    return this._makeRequest('GET', `/v1/studio/projects/${projectId}`);
  }

  // Delete studio project
  async deleteStudioProject(projectId) {
    return this._makeRequest('DELETE', `/v1/studio/projects/${projectId}`);
  }

  // Get history
  async getHistory(options = {}) {
    const params = new URLSearchParams();
    if (options.pageSize) params.append('page_size', options.pageSize);
    const query = params.toString() ? `?${params.toString()}` : '';
    return this._makeRequest('GET', `/v1/history${query}`);
  }

  // Get history item
  async getHistoryItem(historyItemId) {
    return this._makeRequest('GET', `/v1/history/${historyItemId}`);
  }

  // Design voice
  async designVoice(options = {}) {
    const outputPath = path.join(this.outputDir, `voice_design_${Date.now()}.mp3`);
    const body = JSON.stringify({
      gender: options.gender || 'female',
      age: options.age || 'middle_aged',
      accent: options.accent || 'american',
      accent_strength: options.accentStrength || 1.0,
      text: options.text || 'Hello, this is a test.'
    });

    return new Promise((resolve, reject) => {
      const reqOptions = {
        hostname: 'api.elevenlabs.io',
        port: 443,
        path: '/v1/voice-generation/generate-voice',
        method: 'POST',
        headers: {
          'Accept': 'audio/mpeg',
          'xi-api-key': this.apiKey,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      };

      const file = fs.createWriteStream(outputPath);
      const req = https.request(reqOptions, (res) => {
        if (res.statusCode !== 200) {
          let errorData = '';
          res.on('data', chunk => errorData += chunk);
          res.on('end', () => reject(new Error(`Voice design error: ${res.statusCode} - ${errorData}`)));
          return;
        }
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve({ audioPath: outputPath, generatedVoiceId: res.headers['generated_voice_id'] });
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  // Streaming TTS
  async generateAudioStream(text, voice, options = {}) {
    const outputPath = path.join(this.outputDir, `stream_${Date.now()}.mp3`);
    const voiceId = voice; // Simplified - would normally look up voice ID
    const body = JSON.stringify({
      text: text,
      model_id: options.modelId || 'eleven_monolingual_v1',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 }
    });

    return new Promise((resolve, reject) => {
      const reqOptions = {
        hostname: 'api.elevenlabs.io',
        port: 443,
        path: `/v1/text-to-speech/${voiceId}/stream`,
        method: 'POST',
        headers: {
          'Accept': 'audio/mpeg',
          'xi-api-key': this.apiKey,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      };

      const file = fs.createWriteStream(outputPath);
      let chunkCount = 0;
      const req = https.request(reqOptions, (res) => {
        if (res.statusCode !== 200) {
          let errorData = '';
          res.on('data', chunk => errorData += chunk);
          res.on('end', () => reject(new Error(`Stream error: ${res.statusCode} - ${errorData}`)));
          return;
        }
        res.on('data', chunk => { file.write(chunk); chunkCount++; });
        res.on('end', () => { file.end(); resolve({ audioPath: outputPath, chunksReceived: chunkCount }); });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  // Detect language
  async detectLanguage(audioPath) {
    if (!fs.existsSync(audioPath)) {
      throw new Error(`Audio file not found: ${audioPath}`);
    }
    const audioBuffer = fs.readFileSync(audioPath);
    const boundary = '----Boundary' + Date.now();
    
    const parts = [
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="audio.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`),
      audioBuffer,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ];
    const body = Buffer.concat(parts);

    return new Promise((resolve, reject) => {
      const reqOptions = {
        hostname: 'api.elevenlabs.io',
        port: 443,
        path: '/v1/audio-language-detection',
        method: 'POST',
        headers: {
          'xi-api-key': this.apiKey,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length
        }
      };

      let responseData = '';
      const req = https.request(reqOptions, (res) => {
        res.on('data', chunk => responseData += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(responseData);
            if (res.statusCode !== 200) {
              reject(new Error(result.detail?.message || `Language detection error: ${res.statusCode}`));
              return;
            }
            resolve(result);
          } catch (e) {
            reject(new Error('Failed to parse response: ' + e.message));
          }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  // Generic request helper
  _makeRequest(method, path, body = null, contentType = 'application/json') {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.elevenlabs.io',
        port: 443,
        path: path,
        method: method,
        headers: { 'xi-api-key': this.apiKey }
      };

      if (body) {
        options.headers['Content-Type'] = contentType;
        options.headers['Content-Length'] = Buffer.byteLength(body);
      }

      let responseData = '';
      const req = https.request(options, (res) => {
        res.on('data', chunk => responseData += chunk);
        res.on('end', () => {
          if (res.statusCode === 204) {
            resolve(true);
            return;
          }
          try {
            const result = JSON.parse(responseData);
            if (res.statusCode >= 400) {
              reject(new Error(result.detail?.message || `API error: ${res.statusCode}`));
              return;
            }
            resolve(result);
          } catch (e) {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(responseData);
            } else {
              reject(new Error(`Request failed: ${res.statusCode}`));
            }
          }
        });
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }
}

// Create service instance
const service = new TestElevenLabsService(elevenLabsApiKey);

// Test results tracking
const results = {
  passed: [],
  failed: [],
  skipped: []
};

// Helper to run a test
async function runTest(name, testFn, skipReason = null) {
  if (skipReason) {
    console.log(`⏭️  SKIP: ${name} - ${skipReason}`);
    results.skipped.push({ name, reason: skipReason });
    return null;
  }
  
  try {
    console.log(`\n🧪 Testing: ${name}...`);
    const result = await testFn();
    console.log(`✅ PASS: ${name}`);
    if (result) {
      console.log('   Result:', JSON.stringify(result, null, 2).substring(0, 500));
    }
    results.passed.push({ name, result });
    return result;
  } catch (error) {
    console.log(`❌ FAIL: ${name}`);
    console.log('   Error:', error.message);
    results.failed.push({ name, error: error.message });
    return null;
  }
}

// Main test suite
async function runAllTests() {
  console.log('='.repeat(60));
  console.log('ElevenLabs New APIs Test Suite');
  console.log('='.repeat(60));
  
  // Check API key first
  const apiKey = service.getApiKey();
  if (!apiKey) {
    console.log('\n❌ ERROR: No ElevenLabs API key found!');
    console.log('Please set your API key in Settings > API Keys > ElevenLabs');
    process.exit(1);
  }
  console.log('\n✅ API Key found');

  // ==================== MODELS API ====================
  console.log('\n' + '='.repeat(40));
  console.log('MODELS API');
  console.log('='.repeat(40));
  
  const models = await runTest('List Models', async () => {
    return await service.listModels();
  });

  // ==================== STUDIO PROJECTS API ====================
  console.log('\n' + '='.repeat(40));
  console.log('STUDIO PROJECTS API');
  console.log('='.repeat(40));
  
  // List existing projects first
  const existingProjects = await runTest('List Studio Projects', async () => {
    return await service.listStudioProjects();
  });

  // Create a test project
  const testProjectName = `Test_Project_${Date.now()}`;
  const createdProject = await runTest('Create Studio Project', async () => {
    return await service.createStudioProject(testProjectName, {
      defaultModelId: 'eleven_multilingual_v2',
      qualityPreset: 'standard'
    });
  });

  // Get the project if created
  if (createdProject?.project_id) {
    await runTest('Get Studio Project', async () => {
      return await service.getStudioProject(createdProject.project_id);
    });

    // Delete the test project
    await runTest('Delete Studio Project', async () => {
      return await service.deleteStudioProject(createdProject.project_id);
    });
  }

  // ==================== VOICES API (Extended) ====================
  console.log('\n' + '='.repeat(40));
  console.log('VOICES API (Extended)');
  console.log('='.repeat(40));

  // List voices to get a voice ID
  const voices = await runTest('List Voices', async () => {
    return await service.listVoices();
  });

  // Get details of first voice
  if (voices?.voices?.length > 0) {
    const firstVoiceId = voices.voices[0].voice_id;
    await runTest('Get Voice Details', async () => {
      return await service.getVoice(firstVoiceId);
    });
  }

  // Voice cloning test - skip if no sample audio available
  await runTest('Clone Voice', null, 'Requires audio sample files - skipping automated test');

  // Voice editing - skip to avoid modifying user voices
  await runTest('Edit Voice', null, 'Skipping to avoid modifying user voices');

  // ==================== VOICE DESIGN API ====================
  console.log('\n' + '='.repeat(40));
  console.log('VOICE DESIGN API');
  console.log('='.repeat(40));

  const designedVoice = await runTest('Design Voice Preview', async () => {
    return await service.designVoice({
      gender: 'female',
      age: 'young',
      accent: 'american',
      accentStrength: 1.0,
      text: 'Hello, this is a test of the voice design feature.'
    });
  });

  // Save the designed voice - skip to avoid cluttering user's library
  await runTest('Save Designed Voice', null, 'Skipping to avoid adding test voices to library');

  // ==================== LANGUAGE DETECTION API ====================
  console.log('\n' + '='.repeat(40));
  console.log('LANGUAGE DETECTION API');
  console.log('='.repeat(40));

  // Use the designed voice audio if available for language detection
  if (designedVoice?.audioPath) {
    await runTest('Detect Language', async () => {
      return await service.detectLanguage(designedVoice.audioPath);
    });
  } else {
    await runTest('Detect Language', null, 'No audio file available for testing');
  }

  // ==================== STREAMING TTS API ====================
  console.log('\n' + '='.repeat(40));
  console.log('STREAMING TTS API');
  console.log('='.repeat(40));

  let streamedAudioPath = null;
  await runTest('Generate Audio Stream', async () => {
    let chunkCount = 0;
    streamedAudioPath = await service.generateAudioStream(
      'This is a test of the streaming text to speech API.',
      'Rachel',
      { modelId: 'eleven_monolingual_v1' },
      (chunk) => {
        chunkCount++;
      }
    );
    return { audioPath: streamedAudioPath, chunksReceived: chunkCount };
  });

  // ==================== HISTORY API ====================
  console.log('\n' + '='.repeat(40));
  console.log('HISTORY API');
  console.log('='.repeat(40));

  const history = await runTest('Get History', async () => {
    return await service.getHistory({ pageSize: 10 });
  });

  // Get first history item if available
  if (history?.history?.length > 0) {
    const firstItemId = history.history[0].history_item_id;
    
    await runTest('Get History Item', async () => {
      return await service.getHistoryItem(firstItemId);
    });

    await runTest('Get History Item Audio', async () => {
      return await service.getHistoryItemAudio(firstItemId);
    });

    // Skip deletion to preserve user's history
    await runTest('Delete History Item', null, 'Skipping to preserve user history');
  }

  // ==================== SUMMARY ====================
  console.log('\n' + '='.repeat(60));
  console.log('TEST SUMMARY');
  console.log('='.repeat(60));
  console.log(`✅ Passed: ${results.passed.length}`);
  console.log(`❌ Failed: ${results.failed.length}`);
  console.log(`⏭️  Skipped: ${results.skipped.length}`);
  
  if (results.failed.length > 0) {
    console.log('\nFailed tests:');
    results.failed.forEach(f => {
      console.log(`  - ${f.name}: ${f.error}`);
    });
  }
  
  if (results.skipped.length > 0) {
    console.log('\nSkipped tests:');
    results.skipped.forEach(s => {
      console.log(`  - ${s.name}: ${s.reason}`);
    });
  }

  console.log('\n' + '='.repeat(60));
  
  // Cleanup: remove generated test files
  const fs = require('fs');
  if (designedVoice?.audioPath && fs.existsSync(designedVoice.audioPath)) {
    try {
      fs.unlinkSync(designedVoice.audioPath);
      console.log('Cleaned up voice design test audio');
    } catch (e) {}
  }
  if (streamedAudioPath && fs.existsSync(streamedAudioPath)) {
    try {
      fs.unlinkSync(streamedAudioPath);
      console.log('Cleaned up streaming test audio');
    } catch (e) {}
  }

  return results;
}

// Run the tests
runAllTests()
  .then(results => {
    process.exit(results.failed.length > 0 ? 1 : 0);
  })
  .catch(error => {
    console.error('Test suite error:', error);
    process.exit(1);
  });







