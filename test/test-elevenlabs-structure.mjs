/**
 * ElevenLabs Implementation Structure Test
 * 
 * Verifies that all methods and handlers are properly implemented
 * Does NOT require an API key - tests code structure only
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');

console.log('🔍 ElevenLabs Implementation Structure Test\n');
console.log('='.repeat(60));

const results = { passed: [], failed: [] };

function test(name, condition, details = '') {
  if (condition) {
    console.log(`✅ ${name}`);
    if (details) console.log(`   ${details}`);
    results.passed.push(name);
  } else {
    console.log(`❌ ${name}`);
    if (details) console.log(`   ${details}`);
    results.failed.push(name);
  }
}

// Test 1: ElevenLabsService.js exists and has required methods
console.log('\n📁 1. ElevenLabsService.js Methods\n');

const servicePath = path.join(rootDir, 'src/video/audio/ElevenLabsService.js');
const serviceContent = fs.readFileSync(servicePath, 'utf8');

const serviceMethods = [
  'listVoices',
  'generateSoundEffect',
  'speechToSpeech',
  'isolateAudio',
  'createDubbingProject',
  'getDubbingStatus',
  'downloadDubbedAudio',
  'getUserSubscription',
  'getUserInfo',
  'getUsageStats',
  'generateAudio',  // Original TTS
  'getApiKey',
  'transcribeAudio'  // ElevenLabs Scribe (replaces Whisper)
];

serviceMethods.forEach(method => {
  const hasMethod = serviceContent.includes(`async ${method}(`) || 
                    serviceContent.includes(`${method}(`) ||
                    serviceContent.includes(`${method} (`);
  test(`ElevenLabsService.${method}()`, hasMethod);
});

// Test 2: VideoEditorIPC.js has required handlers
console.log('\n📁 2. VideoEditorIPC.js Handlers\n');

const ipcPath = path.join(rootDir, 'src/video/ipc/VideoEditorIPC.js');
const ipcContent = fs.readFileSync(ipcPath, 'utf8');

const ipcHandlers = [
  'video-editor:generate-sfx',
  'video-editor:speech-to-speech',
  'video-editor:isolate-audio',
  'video-editor:create-dubbing',
  'video-editor:get-dubbing-status',
  'video-editor:download-dubbed-audio',
  'video-editor:list-voices',
  'video-editor:get-subscription',
  'video-editor:get-user-info',
  'video-editor:get-usage-stats',
  'video-editor:check-elevenlabs-key',
  'video-editor:generate-elevenlabs-audio',
  'video-editor:transcribe-scribe'  // ElevenLabs Scribe transcription
];

ipcHandlers.forEach(handler => {
  const hasHandler = ipcContent.includes(`'${handler}'`);
  test(`IPC Handler: ${handler}`, hasHandler);
});

// Test 3: preload-video-editor.js exposes methods
console.log('\n📁 3. Preload API Exposure\n');

const preloadPath = path.join(rootDir, 'preload-video-editor.js');
const preloadContent = fs.readFileSync(preloadPath, 'utf8');

const preloadMethods = [
  'generateSFX',
  'speechToSpeech',
  'isolateAudio',
  'createDubbing',
  'getDubbingStatus',
  'downloadDubbedAudio',
  'listVoices',
  'getSubscription',
  'getUserInfo',
  'getUsageStats',
  'checkElevenLabsApiKey',
  'generateElevenLabsAudio',
  'transcribeScribe'  // ElevenLabs Scribe transcription
];

preloadMethods.forEach(method => {
  const hasMethod = preloadContent.includes(`${method}:`);
  test(`Preload: window.videoEditor.${method}`, hasMethod);
});

// Test 4: video-editor-app.js has UI handlers
console.log('\n📁 4. UI Handler Functions\n');

const appPath = path.join(rootDir, 'video-editor-app.js');
const appContent = fs.readFileSync(appPath, 'utf8');

const uiHandlers = [
  'showGenerateAIVoiceDialog',
  'showSpeechToSpeechDialog',
  'isolateVocalsAction',
  'showCloneVoiceDialog',
  'showGenerateSFXDialog',
  'showDubRegionDialog',
  'showDubVideoDialog',
  'showElevenLabsUsageStats',
  'addGeneratedAudioToTrack',
  'executeGenerateSFX',
  'executeSpeechToSpeech'
];

uiHandlers.forEach(handler => {
  const hasHandler = appContent.includes(`${handler}(`) || 
                     appContent.includes(`${handler} (`);
  test(`UI Handler: ${handler}()`, hasHandler);
});

// Test 5: Keyboard shortcuts registered
console.log('\n📁 5. Keyboard Shortcuts\n');

const shortcuts = [
  { key: 'Alt+v', action: 'generateAIVoice' },
  { key: 'Alt+r', action: 'speechToSpeech' },
  { key: 'Alt+i', action: 'isolateVocals' },
  { key: 'Alt+k', action: 'cloneVoice' },
  { key: 'Alt+x', action: 'generateSFX' },
  { key: 'Alt+b', action: 'dubRegion' },
  { key: 'Alt+u', action: 'showUsageStats' }
];

shortcuts.forEach(({ key, action }) => {
  const hasShortcut = appContent.includes(`'${key}'`) && appContent.includes(`'${action}'`);
  test(`Shortcut: ${key} → ${action}`, hasShortcut);
});

// Test 6: Context menu items
console.log('\n📁 6. Context Menu Items\n');

const menuItems = [
  'Generate AI Voice',
  'Transform Voice',
  'Isolate Vocals',
  'Clone Voice',
  'Generate SFX',
  'Dub to Language'
];

menuItems.forEach(item => {
  const hasItem = appContent.includes(item);
  test(`Context Menu: "${item}"`, hasItem);
});

// Test 7: ElevenLabs category in shortcuts panel
console.log('\n📁 7. Shortcuts Panel Category\n');

const hasCategory = appContent.includes("'ElevenLabs'") && 
                    appContent.includes("category: 'ElevenLabs'");
test('Shortcuts panel includes ElevenLabs category', hasCategory);

// Summary
console.log('\n' + '='.repeat(60));
console.log('📊 TEST SUMMARY');
console.log('='.repeat(60));
console.log(`✅ Passed:  ${results.passed.length}`);
console.log(`❌ Failed:  ${results.failed.length}`);

if (results.failed.length > 0) {
  console.log('\n❌ Failed tests:');
  results.failed.forEach(f => console.log(`   - ${f}`));
}

console.log('\n🏁 Structure tests complete!\n');

// Exit with error code if any tests failed
process.exit(results.failed.length > 0 ? 1 : 0);








