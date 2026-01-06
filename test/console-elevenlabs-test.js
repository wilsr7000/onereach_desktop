/**
 * ElevenLabs API Test Script - Run in Video Editor DevTools Console
 * 
 * Copy and paste this entire script into the Video Editor's DevTools console
 * (Open Video Editor > Right-click > Inspect > Console tab)
 */

(async function testElevenLabsAPIs() {
  console.log('='.repeat(60));
  console.log('🧪 ElevenLabs New APIs Test Suite');
  console.log('='.repeat(60));

  const results = { passed: [], failed: [], skipped: [] };

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
      if (result) console.log('   Result:', result);
      results.passed.push({ name });
      return result;
    } catch (error) {
      console.log(`❌ FAIL: ${name}`);
      console.log('   Error:', error.message || error);
      results.failed.push({ name, error: error.message || error });
      return null;
    }
  }

  // ==================== MODELS API ====================
  console.log('\n' + '='.repeat(40));
  console.log('MODELS API');
  console.log('='.repeat(40));

  const models = await runTest('List Models', async () => {
    const result = await window.videoEditor.listModels();
    if (!result.success) throw new Error(result.error);
    return `Found ${result.models?.length || 0} models`;
  });

  // ==================== STUDIO PROJECTS API ====================
  console.log('\n' + '='.repeat(40));
  console.log('STUDIO PROJECTS API');
  console.log('='.repeat(40));

  await runTest('List Studio Projects', async () => {
    const result = await window.videoEditor.listStudioProjects();
    if (!result.success) throw new Error(result.error);
    return `Found ${result.projects?.length || 0} studio projects`;
  });

  const testProjectName = `Test_Project_${Date.now()}`;
  const createdProject = await runTest('Create Studio Project', async () => {
    const result = await window.videoEditor.createStudioProject(testProjectName, {
      defaultModelId: 'eleven_multilingual_v2',
      qualityPreset: 'standard'
    });
    if (!result.success) throw new Error(result.error);
    return `Created project: ${result.project_id}`;
  });

  if (createdProject) {
    // Extract project ID from result string
    const projectIdMatch = createdProject.match(/Created project: (.+)/);
    if (projectIdMatch) {
      const projectId = projectIdMatch[1];
      
      await runTest('Get Studio Project', async () => {
        const result = await window.videoEditor.getStudioProject(projectId);
        if (!result.success) throw new Error(result.error);
        return `Got project: ${result.project?.name}`;
      });

      await runTest('Delete Studio Project', async () => {
        const result = await window.videoEditor.deleteStudioProject(projectId);
        if (!result.success) throw new Error(result.error);
        return 'Project deleted';
      });
    }
  }

  // ==================== VOICES API ====================
  console.log('\n' + '='.repeat(40));
  console.log('VOICES API');
  console.log('='.repeat(40));

  const voices = await runTest('List Voices', async () => {
    const result = await window.videoEditor.listVoices();
    if (!result.success) throw new Error(result.error);
    return `Found ${result.voices?.length || 0} voices`;
  });

  // Get first voice details if available
  if (voices) {
    await runTest('Get Voice Details', async () => {
      const voicesList = await window.videoEditor.listVoices();
      if (voicesList.voices?.length > 0) {
        const result = await window.videoEditor.getVoice(voicesList.voices[0].voice_id);
        if (!result.success) throw new Error(result.error);
        return `Voice: ${result.voice?.name}`;
      }
      throw new Error('No voices available');
    });
  }

  await runTest('Clone Voice', null, 'Requires audio samples - skipping');
  await runTest('Edit Voice', null, 'Skipping to avoid modifying voices');

  // ==================== VOICE DESIGN API ====================
  console.log('\n' + '='.repeat(40));
  console.log('VOICE DESIGN API');
  console.log('='.repeat(40));

  const designedVoice = await runTest('Design Voice Preview', async () => {
    const result = await window.videoEditor.designVoice({
      gender: 'female',
      age: 'young',
      accent: 'american',
      accentStrength: 1.0,
      text: 'Hello, this is a test of voice design.'
    });
    if (!result.success) throw new Error(result.error);
    return `Audio generated: ${result.audioPath}`;
  });

  await runTest('Save Designed Voice', null, 'Skipping to avoid adding test voices');

  // ==================== LANGUAGE DETECTION API ====================
  console.log('\n' + '='.repeat(40));
  console.log('LANGUAGE DETECTION API');
  console.log('='.repeat(40));

  if (designedVoice) {
    const audioPathMatch = designedVoice.match(/Audio generated: (.+)/);
    if (audioPathMatch) {
      await runTest('Detect Language', async () => {
        const result = await window.videoEditor.detectLanguage(audioPathMatch[1]);
        if (!result.success) throw new Error(result.error);
        return `Detected: ${result.detected_language}`;
      });
    }
  } else {
    await runTest('Detect Language', null, 'No audio file available');
  }

  // ==================== STREAMING TTS API ====================
  console.log('\n' + '='.repeat(40));
  console.log('STREAMING TTS API');
  console.log('='.repeat(40));

  await runTest('Generate Audio Stream', async () => {
    const result = await window.videoEditor.generateAudioStream(
      'This is a test of streaming text to speech.',
      'Rachel',
      { modelId: 'eleven_monolingual_v1' }
    );
    if (!result.success) throw new Error(result.error);
    return `Stream saved to: ${result.audioPath}`;
  });

  // ==================== HISTORY API ====================
  console.log('\n' + '='.repeat(40));
  console.log('HISTORY API');
  console.log('='.repeat(40));

  const history = await runTest('Get History', async () => {
    const result = await window.videoEditor.getHistory({ pageSize: 5 });
    if (!result.success) throw new Error(result.error);
    return `Found ${result.history?.length || 0} history items`;
  });

  if (history) {
    await runTest('Get History Item', async () => {
      const historyResult = await window.videoEditor.getHistory({ pageSize: 1 });
      if (historyResult.history?.length > 0) {
        const result = await window.videoEditor.getHistoryItem(historyResult.history[0].history_item_id);
        if (!result.success) throw new Error(result.error);
        return `Item: ${result.item?.text?.substring(0, 30)}...`;
      }
      throw new Error('No history items');
    });
  }

  await runTest('Delete History Item', null, 'Skipping to preserve history');

  // ==================== SUMMARY ====================
  console.log('\n' + '='.repeat(60));
  console.log('📊 TEST SUMMARY');
  console.log('='.repeat(60));
  console.log(`✅ Passed: ${results.passed.length}`);
  console.log(`❌ Failed: ${results.failed.length}`);
  console.log(`⏭️  Skipped: ${results.skipped.length}`);

  if (results.failed.length > 0) {
    console.log('\n❌ Failed tests:');
    results.failed.forEach(f => console.log(`   - ${f.name}: ${f.error}`));
  }

  console.log('\n' + '='.repeat(60));
  
  return results;
})();








