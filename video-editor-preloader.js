/**
 * Video Editor Preloader
 * 
 * Checks for missing project assets (transcript, thumbnails, waveform) and
 * presents a checklist modal allowing users to generate or skip each before
 * the editor fully loads.
 * 
 * This is a separate module to reduce the size of video-editor-app.js
 */

(function() {
  'use strict';

  // Asset types and their properties
  const ASSET_TYPES = {
    transcript: {
      name: 'Word-Level Transcript',
      description: 'Accurate word timestamps using ElevenLabs Scribe',
      icon: '📝',
      estimateTime: (duration) => Math.ceil(duration / 600) * 30, // ~30s per 10min
      priority: 1
    },
    thumbnails: {
      name: 'Timeline Thumbnails',
      description: 'Video frame previews for all zoom levels',
      icon: '🖼️',
      estimateTime: (duration) => Math.ceil(duration / 600) * 10, // ~10s per 10min
      priority: 2
    },
    waveform: {
      name: 'Audio Waveform',
      description: 'Visual audio representation (spectrogram)',
      icon: '🔊',
      estimateTime: (duration) => Math.ceil(duration / 600) * 5, // ~5s per 10min
      priority: 3
    }
  };

  /**
   * Check which assets are missing for a video project
   * @param {string} videoPath - Path to video file
   * @param {object} metadata - Project metadata (transcriptSegments, transcriptSource, etc.)
   * @returns {Promise<object>} - { missing: [], existing: [] }
   */
  async function checkAssets(videoPath, metadata) {
    const missing = [];
    const existing = [];

    // Check transcript - accept both Whisper and ElevenLabs Scribe as accurate sources
    const accurateTranscriptSources = ['whisper', 'elevenlabs-scribe'];
    const hasAccurateTranscript = accurateTranscriptSources.includes(metadata.transcriptSource) && 
                                  metadata.transcriptSegments && 
                                  metadata.transcriptSegments.length > 0;
    
    if (hasAccurateTranscript) {
      existing.push({ type: 'transcript', ...ASSET_TYPES.transcript });
    } else if (metadata.transcriptSegments && metadata.transcriptSegments.length > 0) {
      // Has transcript but not from an accurate source - offer upgrade
      missing.push({ 
        type: 'transcript', 
        ...ASSET_TYPES.transcript,
        description: 'Upgrade to accurate ElevenLabs Scribe timestamps (current: ' + (metadata.transcriptSource || 'unknown') + ')'
      });
    } else {
      missing.push({ type: 'transcript', ...ASSET_TYPES.transcript });
    }

    // Check waveform cache
    try {
      const waveformCache = await window.videoEditor.loadWaveformCache(videoPath);
      if (waveformCache && waveformCache.masterPeaks && waveformCache.masterPeaks.length > 0) {
        existing.push({ type: 'waveform', ...ASSET_TYPES.waveform });
      } else {
        missing.push({ type: 'waveform', ...ASSET_TYPES.waveform });
      }
    } catch (e) {
      missing.push({ type: 'waveform', ...ASSET_TYPES.waveform });
    }

    // Check for saved thumbnail strip images (the actual JPEG files)
    try {
      // Specifically check for the DETAIL tier, which is the most important/expensive one
      const detailResult = await window.videoEditor.loadThumbnailStrip(videoPath, 'detail');
      const hasDetail = detailResult && detailResult.exists;
      
      const previewResult = await window.videoEditor.loadThumbnailStrip(videoPath, 'preview');
      const hasPreview = previewResult && previewResult.exists;
      
      // We need at least the detail tier to consider thumbnails "ready"
      // If we only have preview, we should prompt to generate detail
      if (hasDetail) {
        existing.push({ type: 'thumbnails', ...ASSET_TYPES.thumbnails });
      } else {
        missing.push({ type: 'thumbnails', ...ASSET_TYPES.thumbnails });
      }
    } catch (e) {
      // No strip images - thumbnails need to be generated
      missing.push({ type: 'thumbnails', ...ASSET_TYPES.thumbnails });
    }

    // Sort by priority
    missing.sort((a, b) => a.priority - b.priority);
    existing.sort((a, b) => a.priority - b.priority);

    return { missing, existing };
  }

  /**
   * Format seconds to human-readable duration
   */
  function formatDuration(seconds) {
    if (seconds < 60) return `~${seconds}s`;
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return secs > 0 ? `~${mins}m ${secs}s` : `~${mins}m`;
  }

  /**
   * Create and show the preloader modal
   * @param {object} options - { videoPath, videoName, duration, missing, existing }
   * @returns {Promise<object>} - { selected: ['transcript', 'waveform', ...], skipped: boolean }
   */
  function showModal(options) {
    return new Promise((resolve) => {
      const { videoPath, videoName, duration, missing, existing } = options;

      // Get or create overlay
      let overlay = document.getElementById('preloaderOverlay');
      if (!overlay) {
        console.error('[Preloader] Modal overlay not found in DOM');
        resolve({ selected: [], skipped: true });
        return;
      }

      // Check if transcript is missing (required - can't be skipped)
      const hasTranscriptMissing = missing.some(a => a.type === 'transcript');
      
      // Build checklist HTML
      const checklistHtml = missing.map(asset => {
        const estTime = formatDuration(asset.estimateTime(duration));
        const isRequired = asset.type === 'transcript'; // Transcript is always required
        const disabledAttr = isRequired ? 'disabled' : '';
        const requiredBadge = isRequired ? '<span class="preloader-required-badge">Required</span>' : '';
        return `
          <label class="preloader-item ${isRequired ? 'required' : ''}">
            <input type="checkbox" name="asset" value="${asset.type}" checked ${disabledAttr}>
            <span class="preloader-item-icon">${asset.icon}</span>
            <span class="preloader-item-content">
              <span class="preloader-item-name">${asset.name} ${requiredBadge}</span>
              <span class="preloader-item-desc">${asset.description}</span>
            </span>
            <span class="preloader-item-time">${estTime}</span>
          </label>
        `;
      }).join('');

      // Existing assets info
      const existingHtml = existing.length > 0 ? `
        <div class="preloader-existing">
          <span class="preloader-existing-label">Already cached:</span>
          ${existing.map(a => `<span class="preloader-existing-item">${a.icon} ${a.name}</span>`).join('')}
        </div>
      ` : '';

      // Video info
      const videoInfo = `
        <div class="preloader-video-info">
          <span class="preloader-video-name" title="${videoPath}">${videoName}</span>
          <span class="preloader-video-duration">${formatVideoDuration(duration)}</span>
        </div>
      `;

      // Calculate total estimated time
      const totalEstTime = missing.reduce((sum, asset) => sum + asset.estimateTime(duration), 0);
      const isLongOperation = totalEstTime > 60; // More than 1 minute
      const isVeryLongVideo = duration > 3600; // More than 1 hour
      
      // Warning message for long operations
      const warningHtml = (isLongOperation || isVeryLongVideo) ? `
        <div class="preloader-warning">
          <span class="preloader-warning-icon">⚠️</span>
          <span class="preloader-warning-text">
            ${isVeryLongVideo ? 'Long video detected. ' : ''}
            Generation may take ${formatDuration(totalEstTime)}. 
            <strong>Avoid other tasks</strong> to prevent slowdowns.
          </span>
        </div>
      ` : '';

      // Check if transcript is missing - if so, don't allow skipping
      const transcriptMissing = missing.some(asset => asset.type === 'transcript');
      const allowSkip = !transcriptMissing; // Can't skip if transcript is missing

      // Update modal content
      const modal = overlay.querySelector('.preloader-modal');
      modal.innerHTML = `
        <h2>Prepare Project Assets</h2>
        <p class="preloader-subtitle">${transcriptMissing ? 'Transcript is required for this project' : 'Pre-generate assets for better performance'}</p>
        ${videoInfo}
        ${existingHtml}
        ${warningHtml}
        <div class="preloader-checklist">
          ${checklistHtml || '<div class="preloader-empty">All assets are ready!</div>'}
        </div>
        <div class="preloader-progress hidden">
          <div class="progress-status"></div>
          <div class="progress-bar"><div class="progress-fill"></div></div>
          <div class="progress-detail"></div>
          <div class="progress-warning hidden">
            <span>⚡ Processing in progress - please wait...</span>
          </div>
        </div>
        <div class="preloader-actions">
          ${allowSkip ? `<button class="btn-skip">${missing.length > 0 ? 'Skip All' : 'Continue'}</button>` : ''}
          ${missing.length > 0 ? `<button class="btn-generate">${transcriptMissing ? 'Generate Transcript' : 'Generate Selected'}</button>` : ''}
        </div>
      `;

      // Show overlay
      overlay.classList.remove('hidden');
      console.log('[Preloader] Modal shown - waiting for user to select assets or skip');

      // Event handlers
      const skipBtn = modal.querySelector('.btn-skip');
      const generateBtn = modal.querySelector('.btn-generate');

      // Only add skip handler if skip button exists (not shown when transcript is missing)
      if (skipBtn) {
        skipBtn.onclick = () => {
          console.log('[Preloader] User clicked Skip - no assets will be generated');
          overlay.classList.add('hidden');
          resolve({ selected: [], skipped: true });
        };
      }

      if (generateBtn) {
        generateBtn.onclick = () => {
          // Get all checked checkboxes (including disabled ones which are always checked)
          const checkboxes = modal.querySelectorAll('input[name="asset"]:checked');
          let selected = Array.from(checkboxes).map(cb => cb.value);
          
          // Ensure transcript is always included if it was missing (it's required)
          if (hasTranscriptMissing && !selected.includes('transcript')) {
            selected.push('transcript');
          }
          
          console.log('[Preloader] User clicked Generate - selected assets:', selected);
          
          if (selected.length === 0 && allowSkip) {
            console.log('[Preloader] No assets selected - skipping');
            overlay.classList.add('hidden');
            resolve({ selected: [], skipped: true });
          } else if (selected.length === 0 && !allowSkip) {
            // Transcript is required - auto-select it
            console.log('[Preloader] Transcript required - auto-selecting');
            resolve({ selected: ['transcript'], skipped: false, modal, overlay });
          } else {
            console.log('[Preloader] Starting generation for:', selected.join(', '));
            resolve({ selected, skipped: false, modal, overlay });
          }
        };
      }
    });
  }

  /**
   * Format video duration to HH:MM:SS
   */
  function formatVideoDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    
    if (h > 0) {
      return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  /**
   * Update progress in the modal
   */
  function updateProgress(modal, status, percent, detail = '') {
    const progressSection = modal.querySelector('.preloader-progress');
    const statusEl = modal.querySelector('.progress-status');
    const fillEl = modal.querySelector('.progress-fill');
    const detailEl = modal.querySelector('.progress-detail');
    const actionsEl = modal.querySelector('.preloader-actions');
    const checklistEl = modal.querySelector('.preloader-checklist');
    const warningEl = modal.querySelector('.progress-warning');
    const warningBanner = modal.querySelector('.preloader-warning');

    progressSection.classList.remove('hidden');
    actionsEl.classList.add('hidden');
    checklistEl.classList.add('generating');
    
    // Show processing warning
    if (warningEl) {
      warningEl.classList.remove('hidden');
    }
    
    // Hide the initial warning banner during progress
    if (warningBanner) {
      warningBanner.style.display = 'none';
    }

    statusEl.textContent = status;
    fillEl.style.width = `${percent}%`;
    detailEl.textContent = detail;
  }

  /**
   * Generate selected assets
   * @param {object} options - { videoPath, selected, modal, overlay, callbacks }
   */
  async function generateAssets(options) {
    const { videoPath, selected, modal, overlay, callbacks, duration, spaceItemId } = options;
    
    const totalSteps = selected.length;
    let completedSteps = 0;

    // Process in order: transcript -> thumbnails -> waveform
    const orderedAssets = selected.sort((a, b) => {
      const priorities = { transcript: 1, thumbnails: 2, waveform: 3 };
      return priorities[a] - priorities[b];
    });

    for (const assetType of orderedAssets) {
      const asset = ASSET_TYPES[assetType];
      const stepProgress = (completedSteps / totalSteps) * 100;
      
      updateProgress(modal, `${asset.icon} Generating ${asset.name}...`, stepProgress, 'Starting...');

      try {
        if (assetType === 'transcript') {
          await generateTranscript(videoPath, duration, spaceItemId, (progress) => {
            const overallProgress = stepProgress + (progress / totalSteps);
            let detail = '';
            if (progress < 20) {
              detail = 'Extracting audio...';
            } else if (progress < 95) {
              detail = 'Transcribing with ElevenLabs Scribe...';
            } else {
              detail = 'Finalizing...';
            }
            updateProgress(modal, `${asset.icon} Generating ${asset.name}...`, overallProgress, detail);
          }, callbacks.onTranscriptGenerated);
        } 
        else if (assetType === 'waveform') {
          await generateWaveform(videoPath, duration, (progress) => {
            const overallProgress = stepProgress + (progress / totalSteps);
            updateProgress(modal, `${asset.icon} Generating ${asset.name}...`, overallProgress,
              `${Math.round(progress)}% complete`);
          }, callbacks.onWaveformGenerated);
        }
        else if (assetType === 'thumbnails') {
          await generateThumbnails(videoPath, duration, (progress) => {
            const overallProgress = stepProgress + (progress / totalSteps);
            updateProgress(modal, `${asset.icon} Generating ${asset.name}...`, overallProgress,
              `${Math.round(progress)}% complete`);
          }, callbacks.onThumbnailsGenerated);
        }

        completedSteps++;
        updateProgress(modal, `${asset.icon} ${asset.name} complete!`, 
          (completedSteps / totalSteps) * 100, '');

      } catch (error) {
        console.error(`[Preloader] Failed to generate ${assetType}:`, error);
        updateProgress(modal, `⚠️ ${asset.name} failed`, stepProgress, error.message);
        // Continue with next asset
        completedSteps++;
      }
    }

    // All done
    updateProgress(modal, '✅ All assets ready!', 100, '');
    
    // Auto-close after brief delay
    setTimeout(() => {
      overlay.classList.add('hidden');
    }, 800);
  }

  /**
   * Generate transcript using ElevenLabs Scribe
   */
  async function generateTranscript(videoPath, duration, spaceItemId, onProgress, onComplete) {
    console.log('[Preloader] Starting transcript generation for:', videoPath);
    
    // ElevenLabs Scribe doesn't provide chunk progress, so we'll simulate progress
    // Show extracting audio phase, then transcribing phase
    let progressInterval = null;
    let currentPhase = 'extracting';
    let simulatedProgress = 0;
    
    // Start progress simulation
    progressInterval = setInterval(() => {
      if (currentPhase === 'extracting' && simulatedProgress < 20) {
        simulatedProgress += 2;
        onProgress(simulatedProgress);
      } else if (currentPhase === 'transcribing' && simulatedProgress < 95) {
        // Slower progress during transcription (it's the main work)
        simulatedProgress += 0.5;
        onProgress(simulatedProgress);
      }
    }, 500);
    
    try {
      // Show extracting phase
      console.log('[Preloader] Calling transcribeRange...');
      onProgress(5);
      
      const result = await window.videoEditor.transcribeRange(videoPath, {
        startTime: 0,
        endTime: duration
      });
      
      console.log('[Preloader] transcribeRange returned:', result?.success, result?.error);
      
      // Stop progress simulation
      if (progressInterval) {
        clearInterval(progressInterval);
        progressInterval = null;
      }
      
      if (result && result.success && (result.segments || result.words)) {
        const segments = result.segments || result.words;
        console.log('[Preloader] Transcript generated:', segments.length, 'segments');
        onProgress(100);
        
        // Save to space metadata if applicable
        if (spaceItemId && window.clipboard) {
          try {
            await window.clipboard.updateMetadata(spaceItemId, {
              transcriptSegments: segments,
              transcriptionSource: 'elevenlabs-scribe',
              transcriptionDate: new Date().toISOString()
            });
            console.log('[Preloader] Saved transcript to Space metadata');
          } catch (e) {
            console.warn('[Preloader] Could not save transcript to metadata:', e);
          }
        }

        if (onComplete) {
          onComplete(segments, 'elevenlabs-scribe');
        }
        
        return result;
      } else {
        const errorMsg = result?.error || 'No transcript segments returned';
        console.error('[Preloader] Transcription failed:', errorMsg);
        throw new Error(errorMsg);
      }
    } catch (err) {
      console.error('[Preloader] Transcript generation error:', err);
      if (progressInterval) {
        clearInterval(progressInterval);
      }
      throw err;
    }
  }

  /**
   * Generate waveform cache AND spectrogram image
   */
  async function generateWaveform(videoPath, duration, onProgress, onComplete) {
    const MAX_DURATION_FOR_SPECTROGRAM = 1800; // 30 minutes
    const canGenerateSpectrogram = duration <= MAX_DURATION_FOR_SPECTROGRAM;
    
    onProgress(5);
    
    let audioBuffer = null;
    let masterPeaks = null;
    
    // Try Web Audio decode first (needed for spectrogram)
    if (canGenerateSpectrogram) {
      try {
        console.log('[Preloader] Decoding audio for spectrogram...');
        const video = document.getElementById('videoPlayer');
        if (video?.src) {
          const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
          const response = await fetch(video.src);
          const arrayBuffer = await response.arrayBuffer();
          audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
          
          // Calculate peaks from audio buffer
          const channelData = audioBuffer.numberOfChannels === 1 
            ? audioBuffer.getChannelData(0)
            : (() => {
                const left = audioBuffer.getChannelData(0);
                const right = audioBuffer.getChannelData(1);
                const mixed = new Float32Array(left.length);
                for (let i = 0; i < left.length; i++) {
                  mixed[i] = (left[i] + right[i]) / 2;
                }
                return mixed;
              })();
          
          const numSamples = Math.min(duration * 500, 50000);
          masterPeaks = calculatePeaksFromChannelData(channelData, numSamples);
          console.log('[Preloader] Audio decoded, peaks calculated:', masterPeaks.length);
        }
      } catch (e) {
        console.warn('[Preloader] Web Audio decode failed:', e.message);
      }
    }
    
    onProgress(30);
    
    // Fallback to FFmpeg if Web Audio failed
    if (!masterPeaks) {
      console.log('[Preloader] Using FFmpeg for waveform peaks...');
      const waveformData = await window.videoEditor.getWaveform(videoPath, {
        samples: Math.min(duration * 50, 30000)
      });
      if (waveformData && waveformData.peaks) {
        masterPeaks = waveformData.peaks;
      }
    }
    
    onProgress(50);
    
    // Save peaks to cache
    if (masterPeaks) {
      const cacheData = {
        masterPeaks: Array.from(masterPeaks),
        duration: duration,
        sampleRate: audioBuffer?.sampleRate || 44100,
        generatedAt: new Date().toISOString()
      };
      await window.videoEditor.saveWaveformCache(videoPath, cacheData);
      console.log('[Preloader] Peaks saved to cache');
    }
    
    onProgress(60);
    
    // Generate spectrogram image if we have audio buffer
    if (audioBuffer && canGenerateSpectrogram) {
      try {
        console.log('[Preloader] Generating spectrogram image...');
        const spectrogramDataUrl = await generateSpectrogramImage(audioBuffer, duration);
        
        if (spectrogramDataUrl) {
          // Save spectrogram image for each zoom tier
          const zoomTiers = [50, 100, 200, 350, 500];
          for (const tier of zoomTiers) {
            const imageKey = `spectrogram_${tier}`;
            await window.videoEditor.saveWaveformImage(videoPath, imageKey, spectrogramDataUrl);
          }
          console.log('[Preloader] Spectrogram images saved for all tiers');
        }
      } catch (e) {
        console.warn('[Preloader] Could not generate spectrogram:', e.message);
      }
    }
    
    onProgress(90);
    
    // Also generate bars waveform image as fallback
    if (masterPeaks) {
      try {
        const barsDataUrl = await generateBarsImage(masterPeaks, duration);
        if (barsDataUrl) {
          const zoomTiers = [50, 100, 200, 350, 500];
          for (const tier of zoomTiers) {
            const imageKey = `bars_${tier}`;
            await window.videoEditor.saveWaveformImage(videoPath, imageKey, barsDataUrl);
          }
          console.log('[Preloader] Bars waveform images saved');
        }
      } catch (e) {
        console.warn('[Preloader] Could not generate bars image:', e.message);
      }
    }
    
    onProgress(100);
    
    if (onComplete) {
      onComplete({ masterPeaks, audioBuffer, duration });
    }
    
    return { peaks: masterPeaks, audioBuffer };
  }
  
  /**
   * Calculate peaks from raw audio channel data
   */
  function calculatePeaksFromChannelData(channelData, numSamples) {
    const samplesPerPeak = Math.max(1, Math.floor(channelData.length / numSamples));
    const peaks = new Float32Array(numSamples);
    
    for (let i = 0; i < numSamples; i++) {
      const start = i * samplesPerPeak;
      const end = Math.min(start + samplesPerPeak, channelData.length);
      let max = 0;
      for (let j = start; j < end; j++) {
        const abs = Math.abs(channelData[j]);
        if (abs > max) max = abs;
      }
      peaks[i] = max;
    }
    
    // Normalize using 95th percentile
    const sorted = Array.from(peaks).sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] || 1;
    const normalizer = p95 > 0.01 ? p95 : 1;
    
    for (let i = 0; i < numSamples; i++) {
      peaks[i] = Math.min(1, peaks[i] / normalizer * 0.8);
    }
    
    return peaks;
  }
  
  /**
   * Generate spectrogram image from audio buffer
   */
  async function generateSpectrogramImage(audioBuffer, duration) {
    const width = 4000;  // High-res for zooming
    const height = 120;
    
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    
    const channelData = audioBuffer.getChannelData(0);
    const totalSamples = channelData.length;
    
    // Generate color palette
    const colors = [];
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      let r, g, b;
      if (t < 0.2) {
        r = 15; g = 15; b = Math.floor(40 + t * 5 * 120);
      } else if (t < 0.4) {
        r = Math.floor((t - 0.2) * 5 * 80); g = Math.floor((t - 0.2) * 5 * 150); b = 160;
      } else if (t < 0.6) {
        r = 80; g = 150 + Math.floor((t - 0.4) * 5 * 105); b = Math.floor(160 - (t - 0.4) * 5 * 160);
      } else if (t < 0.8) {
        r = 80 + Math.floor((t - 0.6) * 5 * 175); g = 255; b = 0;
      } else {
        r = 255; g = Math.floor(255 - (t - 0.8) * 5 * 100); b = Math.floor((t - 0.8) * 5 * 80);
      }
      colors.push({ r, g, b });
    }
    
    // Create image data
    const imageData = ctx.createImageData(width, height);
    const data = imageData.data;
    
    // Dark background
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 15; data[i + 1] = 15; data[i + 2] = 35; data[i + 3] = 255;
    }
    
    // Find max amplitude
    const stride = Math.max(1, Math.floor(totalSamples / (width * 64)));
    let globalMax = 0;
    for (let i = 0; i < totalSamples; i += stride * 10) {
      const amp = Math.abs(channelData[i]);
      if (amp > globalMax) globalMax = amp;
    }
    if (globalMax < 0.001) globalMax = 1;
    
    // Draw columns
    for (let x = 0; x < width; x++) {
      const sampleStart = Math.floor((x / width) * totalSamples);
      const sampleEnd = Math.floor(((x + 1) / width) * totalSamples);
      
      let peak = 0, sum = 0, count = 0;
      for (let i = sampleStart; i < sampleEnd; i += stride) {
        const amp = Math.abs(channelData[i] || 0);
        if (amp > peak) peak = amp;
        sum += amp;
        count++;
      }
      const avg = count > 0 ? sum / count : 0;
      const normPeak = peak / globalMax;
      const normAvg = avg / globalMax;
      const barHeight = Math.floor(normPeak * height * 0.9);
      
      for (let y = 0; y < barHeight; y++) {
        const screenY = height - 1 - y;
        const yRatio = y / barHeight;
        const intensity = (normAvg * 0.5 + yRatio * 0.5) * normPeak;
        const colorIdx = Math.min(255, Math.floor(intensity * 255));
        const color = colors[colorIdx];
        
        const idx = (screenY * width + x) * 4;
        data[idx] = color.r;
        data[idx + 1] = color.g;
        data[idx + 2] = color.b;
        data[idx + 3] = 255;
      }
    }
    
    ctx.putImageData(imageData, 0, 0);
    return canvas.toDataURL('image/png');
  }
  
  /**
   * Generate bars waveform image from peaks
   */
  async function generateBarsImage(peaks, duration) {
    const width = 4000;
    const height = 80;
    
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    
    ctx.clearRect(0, 0, width, height);
    
    // Purple gradient
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, 'rgba(139, 92, 246, 0.9)');
    gradient.addColorStop(0.5, 'rgba(99, 102, 241, 0.85)');
    gradient.addColorStop(1, 'rgba(139, 92, 246, 0.9)');
    ctx.fillStyle = gradient;
    
    const barWidth = 2;
    const gap = 1;
    const totalBarWidth = barWidth + gap;
    const numBars = Math.min(peaks.length, Math.floor(width / totalBarWidth));
    const peaksPerBar = peaks.length / numBars;
    
    for (let i = 0; i < numBars; i++) {
      const startPeak = Math.floor(i * peaksPerBar);
      const endPeak = Math.floor((i + 1) * peaksPerBar);
      let maxPeak = 0;
      for (let j = startPeak; j < endPeak && j < peaks.length; j++) {
        if (peaks[j] > maxPeak) maxPeak = peaks[j];
      }
      const barHeight = Math.max(1, maxPeak * height * 0.9);
      const x = i * totalBarWidth;
      const y = (height - barHeight) / 2;
      
      ctx.beginPath();
      ctx.roundRect(x, y, barWidth, barHeight, 1);
      ctx.fill();
    }
    
    // Center line
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();
    
    return canvas.toDataURL('image/png');
  }

  /**
   * Generate thumbnail strips
   * Note: Thumbnails are generated by the main app when timeline loads.
   * This pre-generates them so they're ready when needed.
   */
  async function generateThumbnails(videoPath, duration, onProgress, onComplete) {
    // Define zoom tiers (MUST match video-editor-app.js zoomTiers)
    // Simplified to 2 tiers (must match video-editor-app.js)
    const zoomTiers = [
      { name: 'preview', maxZoom: 5, count: 50 },      // Quick load
      { name: 'detail', maxZoom: Infinity, count: 300 } // Full detail
    ];

    const thumbnailStrips = {};
    const thumbnailCounts = {};
    const totalTiers = zoomTiers.length;

    for (let i = 0; i < zoomTiers.length; i++) {
      const tier = zoomTiers[i];
      onProgress((i / totalTiers) * 100);

      try {
        // Cap count based on duration (no point having more thumbs than seconds)
        const count = Math.min(tier.count, Math.ceil(duration));
        
        const result = await window.videoEditor.getTimelineThumbnails(videoPath, {
          count: count,
          width: 160,
          height: 90
        });

        // Result is an array of thumbnail paths, or an object with error
        let paths = [];
        if (result && !result.error && Array.isArray(result) && result.length > 0) {
          paths = result;
        } else if (result && result.thumbnails) {
          paths = result.thumbnails;
        }

        if (paths.length > 0) {
          thumbnailStrips[tier.name] = paths;
          thumbnailCounts[tier.name] = paths.length;
          console.log(`[Preloader] ${tier.name} thumbnails generated: ${paths.length} frames`);
          
          // GENERATE AND SAVE STRIP IMAGE IMMEDIATELY
          try {
            const thumbWidth = 160;
            const thumbHeight = 90;
            const canvas = document.createElement('canvas');
            canvas.width = thumbWidth * paths.length;
            canvas.height = thumbHeight;
            const ctx = canvas.getContext('2d');
            
            const loadImage = (src) => new Promise((resolve, reject) => {
              const img = new Image();
              img.onload = () => resolve(img);
              img.onerror = reject;
              img.src = `file://${src}`;
            });
            
            for (let j = 0; j < paths.length; j++) {
              try {
                const img = await loadImage(paths[j]);
                ctx.drawImage(img, j * thumbWidth, 0, thumbWidth, thumbHeight);
              } catch (e) {
                // Draw placeholder
                ctx.fillStyle = '#2a4a6a';
                ctx.fillRect(j * thumbWidth, 0, thumbWidth, thumbHeight);
              }
            }
            
            const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
            await window.videoEditor.saveThumbnailStrip(videoPath, tier.name, dataUrl);
            console.log(`[Preloader] Saved ${tier.name} strip to disk`);
          } catch (e) {
            console.warn(`[Preloader] Failed to save ${tier.name} strip image:`, e);
          }

        }
      } catch (e) {
        console.warn(`[Preloader] Failed to generate ${tier.name} thumbnails:`, e);
      }
    }

    onProgress(90);

    // Save thumbnail cache metadata (paths to generated thumbnails)
    try {
      const cacheData = {
        tiers: thumbnailStrips,
        counts: thumbnailCounts,
        duration: duration,
        generatedAt: new Date().toISOString()
      };
      await window.videoEditor.saveThumbnailCache(videoPath, cacheData);
      console.log('[Preloader] Thumbnail cache saved');
    } catch (e) {
      console.warn('[Preloader] Failed to save thumbnail cache:', e);
    }

    onProgress(100);

    if (onComplete) {
      onComplete(thumbnailStrips, thumbnailCounts);
    }

    return thumbnailStrips;
  }

  /**
   * Main entry point - check for missing assets and prompt user
   * @param {string} videoPath - Path to video file
   * @param {object} metadata - { transcriptSegments, transcriptSource, duration, spaceItemId }
   * @param {object} callbacks - { onTranscriptGenerated, onWaveformGenerated, onThumbnailsGenerated }
   * @returns {Promise<object>} - { skipped, generated }
   */
  async function checkAndPrompt(videoPath, metadata, callbacks = {}) {
    try {
      const { duration = 0, spaceItemId } = metadata || {};
      const videoName = videoPath ? (videoPath.split('/').pop() || videoPath.split('\\').pop() || 'Video') : 'Video';

      console.log('[Preloader] Checking assets for:', videoName);

      // Safety check - don't run if no video path
      if (!videoPath) {
        console.log('[Preloader] No video path, skipping');
        return { skipped: true, generated: [] };
      }

      // Check what's missing (with error handling)
      let missing = [], existing = [];
      try {
        const result = await checkAssets(videoPath, metadata || {});
        missing = result.missing;
        existing = result.existing;
      } catch (checkErr) {
        console.warn('[Preloader] Error checking assets:', checkErr);
        return { skipped: true, generated: [] };
      }

      console.log('[Preloader] Missing:', missing.map(a => a.type));
      console.log('[Preloader] Existing:', existing.map(a => a.type));

      // If nothing missing, skip modal
      if (missing.length === 0) {
        console.log('[Preloader] All assets present, skipping modal');
        return { skipped: true, generated: [] };
      }

      // Show modal
      const result = await showModal({
        videoPath,
        videoName,
        duration,
        missing,
        existing
      });

      if (result.skipped || result.selected.length === 0) {
        return { skipped: true, generated: [] };
      }

      // Generate selected assets
      await generateAssets({
        videoPath,
        selected: result.selected,
        modal: result.modal,
        overlay: result.overlay,
        callbacks,
        duration,
        spaceItemId
      });

      return { skipped: false, generated: result.selected };
    } catch (err) {
      console.error('[Preloader] Unexpected error:', err);
      return { skipped: true, generated: [] };
    }
  }

  // Export to window
  window.VideoEditorPreloader = {
    checkAndPrompt,
    checkAssets,
    ASSET_TYPES
  };

  console.log('[VideoEditorPreloader] Module loaded');
})();







