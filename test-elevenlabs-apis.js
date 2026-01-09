/**
 * ElevenLabs API Test Script
 * 
 * Run this in the Video Editor's DevTools console (Cmd+Option+I)
 * to test all ElevenLabs API integrations.
 */

async function testElevenLabsAPIs() {
  console.log('🧪 Starting ElevenLabs API Tests...\n');
  
  const results = {
    passed: [],
    failed: []
  };
  
  // Test 1: Check API Key
  console.log('1️⃣ Testing: Check ElevenLabs API Key');
  try {
    const keyResult = await window.videoEditor.checkElevenLabsApiKey();
    if (keyResult.hasKey) {
      console.log('   ✅ API key is configured');
      results.passed.push('checkElevenLabsApiKey');
    } else {
      console.log('   ⚠️ No API key configured - some tests will fail');
      results.failed.push('checkElevenLabsApiKey (no key)');
    }
  } catch (e) {
    console.log('   ❌ Error:', e.message);
    results.failed.push('checkElevenLabsApiKey: ' + e.message);
  }
  
  // Test 2: List Voices
  console.log('\n2️⃣ Testing: List Voices API');
  try {
    const voicesResult = await window.videoEditor.listVoices();
    if (voicesResult.success) {
      console.log(`   ✅ Found ${voicesResult.voices?.length || 0} voices`);
      if (voicesResult.voices?.length > 0) {
        console.log('   Sample voices:', voicesResult.voices.slice(0, 3).map(v => v.name).join(', '));
      }
      results.passed.push('listVoices');
    } else {
      console.log('   ❌ Failed:', voicesResult.error);
      results.failed.push('listVoices: ' + voicesResult.error);
    }
  } catch (e) {
    console.log('   ❌ Error:', e.message);
    results.failed.push('listVoices: ' + e.message);
  }
  
  // Test 3: Get Subscription
  console.log('\n3️⃣ Testing: Get Subscription API');
  try {
    const subResult = await window.videoEditor.getSubscription();
    if (subResult.success) {
      const sub = subResult.subscription;
      console.log(`   ✅ Subscription: ${sub?.tier || 'Unknown'}`);
      console.log(`   Characters: ${sub?.character_count?.toLocaleString() || 0} / ${sub?.character_limit?.toLocaleString() || '∞'}`);
      results.passed.push('getSubscription');
    } else {
      console.log('   ❌ Failed:', subResult.error);
      results.failed.push('getSubscription: ' + subResult.error);
    }
  } catch (e) {
    console.log('   ❌ Error:', e.message);
    results.failed.push('getSubscription: ' + e.message);
  }
  
  // Test 4: Get Usage Stats
  console.log('\n4️⃣ Testing: Get Usage Stats API');
  try {
    const usageResult = await window.videoEditor.getUsageStats();
    if (usageResult.success) {
      console.log('   ✅ Usage stats retrieved');
      console.log('   Stats:', JSON.stringify(usageResult.stats).substring(0, 100) + '...');
      results.passed.push('getUsageStats');
    } else {
      console.log('   ❌ Failed:', usageResult.error);
      results.failed.push('getUsageStats: ' + usageResult.error);
    }
  } catch (e) {
    console.log('   ❌ Error:', e.message);
    results.failed.push('getUsageStats: ' + e.message);
  }
  
  // Test 5: Check if generateSFX method exists
  console.log('\n5️⃣ Testing: generateSFX method exists');
  if (typeof window.videoEditor.generateSFX === 'function') {
    console.log('   ✅ generateSFX method is exposed');
    results.passed.push('generateSFX method exists');
  } else {
    console.log('   ❌ generateSFX method not found');
    results.failed.push('generateSFX method missing');
  }
  
  // Test 6: Check if speechToSpeech method exists
  console.log('\n6️⃣ Testing: speechToSpeech method exists');
  if (typeof window.videoEditor.speechToSpeech === 'function') {
    console.log('   ✅ speechToSpeech method is exposed');
    results.passed.push('speechToSpeech method exists');
  } else {
    console.log('   ❌ speechToSpeech method not found');
    results.failed.push('speechToSpeech method missing');
  }
  
  // Test 7: Check if isolateAudio method exists
  console.log('\n7️⃣ Testing: isolateAudio method exists');
  if (typeof window.videoEditor.isolateAudio === 'function') {
    console.log('   ✅ isolateAudio method is exposed');
    results.passed.push('isolateAudio method exists');
  } else {
    console.log('   ❌ isolateAudio method not found');
    results.failed.push('isolateAudio method missing');
  }
  
  // Test 8: Check if createDubbing method exists
  console.log('\n8️⃣ Testing: createDubbing method exists');
  if (typeof window.videoEditor.createDubbing === 'function') {
    console.log('   ✅ createDubbing method is exposed');
    results.passed.push('createDubbing method exists');
  } else {
    console.log('   ❌ createDubbing method not found');
    results.failed.push('createDubbing method missing');
  }
  
  // Summary
  console.log('\n' + '='.repeat(50));
  console.log('📊 TEST SUMMARY');
  console.log('='.repeat(50));
  console.log(`✅ Passed: ${results.passed.length}`);
  console.log(`❌ Failed: ${results.failed.length}`);
  
  if (results.failed.length > 0) {
    console.log('\nFailed tests:');
    results.failed.forEach(f => console.log('  - ' + f));
  }
  
  console.log('\n🏁 Tests complete!');
  return results;
}

// Run tests
testElevenLabsAPIs();










