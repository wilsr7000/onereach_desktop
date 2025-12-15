/**
 * Agentic Video Player
 * A seamless video player that fetches clips in batches from an API
 * 
 * Architecture:
 * 1. Player calls API with user prompt + context
 * 2. API returns batch of 1-5 clips with video URLs
 * 3. Player queues clips and plays seamlessly
 * 4. Pre-fetches next batch before queue empties
 * 5. Stops when API returns done: true
 */

const player = {
  // Configuration
  config: {
    apiEndpoint: null,
    apiKey: null,
    apiHeaders: {},
    context: {},
    prefetchWhenRemaining: 2,  // Fetch more when this many clips left
    prefetchThreshold: 5,      // Seconds before clip end to check queue
    mode: 'api',               // 'api' or 'beats' mode
    beats: [],                 // Story beats for beats mode
    videoPath: null            // Local video path for beats mode
  },

  // Session state
  session: {
    id: null,
    active: false,
    prompt: '',
    timeLimit: 0,
    timeWatched: 0,
    watchedIds: []
  },

  // Playback state
  playback: {
    queue: [],              // Clips waiting to play
    history: [],            // Clips already played
    currentClip: null,
    currentEndTime: null,
    isFetching: false,
    endSignaled: false
  },

  // DOM
  video: null,
  ui: {},

  // ==================== INITIALIZATION ====================

  async init() {
    console.log('[Player] Initializing...');
    
    this.loadConfig();
    this.cacheUI();
    this.setupVideoEvents();
    this.setupMessageListener();
    
    console.log('[Player] Ready. API:', this.config.apiEndpoint || '(not configured)');
  },

  setupMessageListener() {
    // Listen for beats data from editor
    window.addEventListener('message', (event) => {
      if (event.data.type === 'load-beats') {
        console.log('[Player] Received beats data:', event.data.config);
        this.loadBeatsMode(event.data.config);
      }
    });
  },

  loadBeatsMode(config) {
    this.config.mode = 'beats';
    this.config.beats = config.beats || [];
    this.config.videoPath = config.videoPath;
    
    // Load video if provided
    if (config.videoPath && this.video) {
      this.video.src = config.videoPath;
    }
    
    // Show beats in UI
    this.displayBeatsNavigation();
  },

  displayBeatsNavigation() {
    // Remove existing beats navigation if present (prevent duplicates)
    const existingNav = document.getElementById('beatsNavigation');
    if (existingNav) {
      existingNav.remove();
    }
    
    // Add beats navigation to UI
    const beatsNav = document.createElement('div');
    beatsNav.id = 'beatsNavigation';
    beatsNav.style.cssText = `
      position: fixed;
      right: 20px;
      top: 80px;
      width: 250px;
      background: rgba(0, 0, 0, 0.9);
      border-radius: 12px;
      padding: 16px;
      max-height: calc(100vh - 120px);
      overflow-y: auto;
      z-index: 100;
    `;
    
    beatsNav.innerHTML = `
      <h3 style="margin: 0 0 12px 0; font-size: 14px; color: #fff;">Story Beats</h3>
      <div id="beatsList" style="display: flex; flex-direction: column; gap: 8px;"></div>
    `;
    
    document.body.appendChild(beatsNav);
    
    const beatsList = document.getElementById('beatsList');
    this.config.beats.forEach((beat, index) => {
      const beatEl = document.createElement('div');
      beatEl.style.cssText = `
        padding: 10px;
        background: rgba(255, 255, 255, 0.1);
        border-radius: 6px;
        cursor: pointer;
        transition: background 0.2s;
      `;
      beatEl.innerHTML = `
        <div style="font-size: 12px; font-weight: 600; margin-bottom: 4px;">${beat.name}</div>
        <div style="font-size: 10px; color: #aaa;">${beat.timeIn} - ${beat.timeOut}</div>
        ${beat.description ? `<div style="font-size: 10px; color: #888; margin-top: 4px;">${beat.description}</div>` : ''}
      `;
      
      beatEl.addEventListener('mouseenter', () => {
        beatEl.style.background = 'rgba(232, 76, 61, 0.3)';
      });
      
      beatEl.addEventListener('mouseleave', () => {
        beatEl.style.background = 'rgba(255, 255, 255, 0.1)';
      });
      
      beatEl.addEventListener('click', () => {
        this.seekToBeat(beat);
      });
      
      beatsList.appendChild(beatEl);
    });
  },

  seekToBeat(beat) {
    if (!this.video) return;
    
    // Parse time string (HH:MM:SS or MM:SS)
    const timeStr = beat.timeIn;
    const parts = timeStr.split(':').reverse();
    let seconds = 0;
    
    if (parts[0]) seconds += parseFloat(parts[0]);
    if (parts[1]) seconds += parseFloat(parts[1]) * 60;
    if (parts[2]) seconds += parseFloat(parts[2]) * 3600;
    
    this.video.currentTime = seconds;
    this.video.play();
    
    console.log('[Player] Seeking to beat:', beat.name, 'at', seconds);
  },

  loadConfig() {
    const cfg = window.AGENTIC_PLAYER_CONFIG || {};
    // Preserve existing mode/beats settings when loading API config
    const existingMode = this.config.mode;
    const existingBeats = this.config.beats;
    const existingVideoPath = this.config.videoPath;
    
    this.config = {
      apiEndpoint: cfg.apiEndpoint || null,
      apiKey: cfg.apiKey || null,
      apiHeaders: cfg.apiHeaders || {},
      context: cfg.context || {},
      prefetchWhenRemaining: cfg.prefetchWhenRemaining || 2,
      prefetchThreshold: cfg.prefetchThreshold || 5,
      // Preserve beats mode settings
      mode: existingMode || 'api',
      beats: existingBeats || [],
      videoPath: existingVideoPath || null
    };
  },

  cacheUI() {
    this.video = document.getElementById('videoPlayer');
    this.ui = {
      overlay: document.getElementById('videoOverlay'),
      sceneInfo: document.getElementById('sceneInfoOverlay'),
      thinking: document.getElementById('aiThinkingOverlay'),
      sceneNumber: document.getElementById('currentSceneNumber'),
      sceneName: document.getElementById('currentSceneName'),
      progress: document.getElementById('progressPlayed'),
      currentTime: document.getElementById('currentTime'),
      totalTime: document.getElementById('totalTime'),
      sceneIndex: document.getElementById('sceneIndex'),
      totalScenes: document.getElementById('totalScenes'),
      playPauseBtn: document.getElementById('playPauseBtn'),
      muteBtn: document.getElementById('muteBtn'),
      status: document.getElementById('sessionStatus'),
      prompt: document.getElementById('sessionPrompt'),
      timeLimit: document.getElementById('timeLimit'),
      showReasoning: document.getElementById('showReasoning'),
      setupSection: document.getElementById('setupSection'),
      nowPlaying: document.getElementById('nowPlayingSection'),
      reasoningSection: document.getElementById('reasoningSection'),
      controls: document.getElementById('sessionControls'),
      queueList: document.getElementById('queueList'),
      queueCount: document.getElementById('queueCount'),
      reasoningLog: document.getElementById('reasoningLog'),
      npName: document.getElementById('npSceneName'),
      npTime: document.getElementById('npSceneTime'),
      npDesc: document.getElementById('npDescription')
    };
  },

  setupVideoEvents() {
    this.video.addEventListener('timeupdate', () => this.onTimeUpdate());
    this.video.addEventListener('ended', () => this.onClipEnded());
    this.video.addEventListener('play', () => this.updatePlayPauseBtn());
    this.video.addEventListener('pause', () => this.updatePlayPauseBtn());
    this.video.addEventListener('error', (e) => this.onVideoError(e));
  },

  // ==================== SESSION CONTROL ====================

  async startSession() {
    const prompt = this.ui.prompt.value.trim();
    
    if (!prompt) {
      alert('Please enter a prompt describing what you want to see.');
      return;
    }

    if (!this.config.apiEndpoint) {
      alert('No API endpoint configured. Set window.AGENTIC_PLAYER_CONFIG.apiEndpoint');
      return;
    }

    // Initialize session
    this.session = {
      id: this.generateId(),
      active: true,
      prompt: prompt,
      timeLimit: parseInt(this.ui.timeLimit.value) || 0,
      timeWatched: 0,
      watchedIds: []
    };

    // Reset playback
    this.playback = {
      queue: [],
      history: [],
      currentClip: null,
      currentEndTime: null,
      isFetching: false,
      endSignaled: false
    };

    // Update UI
    this.ui.status.textContent = 'Active';
    this.ui.status.classList.add('active');
    this.ui.setupSection.classList.add('hidden');
    this.ui.nowPlaying.classList.remove('hidden');
    this.ui.controls.classList.remove('hidden');
    this.ui.overlay.classList.add('hidden');
    
    if (this.ui.showReasoning.checked) {
      this.ui.reasoningSection.classList.remove('hidden');
      this.ui.reasoningLog.innerHTML = '';
    }

    console.log(`[Player] Session started: ${this.session.id}`);
    this.logReasoning(null, `Session started: "${prompt}"`);

    // Fetch first batch
    await this.fetchClips();
  },

  endSession(reason = 'Session ended') {
    this.session.active = false;
    this.video.pause();
    
    this.playback.queue = [];
    this.playback.endSignaled = false;
    
    this.ui.status.textContent = 'Ended';
    this.ui.status.classList.remove('active');
    
    this.logReasoning(null, `Ended: ${reason}`);
    console.log(`[Player] Session ended: ${reason} (watched ${this.playback.history.length} clips)`);

    setTimeout(() => {
      this.ui.setupSection.classList.remove('hidden');
      this.ui.controls.classList.add('hidden');
    }, 2000);
  },

  // ==================== API COMMUNICATION ====================

  async fetchClips() {
    if (!this.session.active || this.playback.isFetching || this.playback.endSignaled) {
      return;
    }

    // Check time limit
    if (this.session.timeLimit > 0 && this.session.timeWatched >= this.session.timeLimit) {
      this.endSession('Time limit reached');
      return;
    }

    this.playback.isFetching = true;
    console.log('[Player] Fetching clips from API...');

    try {
      const response = await fetch(this.config.apiEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.apiKey && { 'Authorization': `Bearer ${this.config.apiKey}` }),
          ...this.config.apiHeaders
        },
        body: JSON.stringify({
          prompt: this.session.prompt,
          sessionId: this.session.id,
          watchedIds: this.session.watchedIds,
          timeWatched: this.session.timeWatched,
          timeLimit: this.session.timeLimit,
          queueLength: this.playback.queue.length,
          context: this.config.context
        })
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      const data = await response.json();
      console.log('[Player] API response:', data);

      // Handle end signal
      if (data.done) {
        this.playback.endSignaled = true;
        if (this.playback.queue.length === 0 && !this.playback.currentClip) {
          this.endSession(data.endMessage || data.reasoning || 'Playback complete');
        }
        return;
      }

      // Add clips to queue
      if (data.scenes && data.scenes.length > 0) {
        this.playback.queue.push(...data.scenes);
        console.log(`[Player] Queued ${data.scenes.length} clips (total: ${this.playback.queue.length})`);
        
        if (data.reasoning) {
          this.logReasoning(null, data.reasoning);
        }

        this.renderQueue();

        // Start playing if not already
        if (!this.playback.currentClip) {
          this.playNext();
        }
      }

    } catch (error) {
      console.error('[Player] API error:', error);
      this.logReasoning(null, `Error: ${error.message}`);
      
      if (this.playback.queue.length === 0 && !this.playback.currentClip) {
        this.endSession(`API Error: ${error.message}`);
      }
    } finally {
      this.playback.isFetching = false;
    }
  },

  // ==================== PLAYBACK ====================

  playNext() {
    if (!this.session.active) return;

    // Check if we've reached the end
    if (this.playback.queue.length === 0) {
      if (this.playback.endSignaled) {
        this.endSession('Playback complete');
      } else {
        // Try to fetch more
        this.ui.thinking.classList.remove('hidden');
        this.fetchClips();
      }
      return;
    }

    this.ui.thinking.classList.add('hidden');

    // Get next clip from queue
    const clip = this.playback.queue.shift();
    this.playback.currentClip = clip;
    this.playback.currentEndTime = clip.outTime;

    // Track as watched
    if (clip.id && !this.session.watchedIds.includes(clip.id)) {
      this.session.watchedIds.push(clip.id);
    }

    // Add to history
    this.playback.history.push(clip);

    // Load and play video
    this.loadVideo(clip);
    
    // Update UI
    this.updateNowPlaying(clip);
    this.renderQueue();

    // Check if we need to pre-fetch
    this.checkPrefetch();
  },

  loadVideo(clip) {
    const videoUrl = clip.videoUrl || clip.videoSrc;
    const startTime = clip.inTime || 0;

    console.log(`[Player] Playing: "${clip.name}" from ${videoUrl}`);

    // Check if we need to change source
    const needsNewSource = !this.video.src || 
      (videoUrl.startsWith('http') ? this.video.src !== videoUrl : !this.video.src.endsWith(videoUrl));

    if (needsNewSource) {
      this.video.src = videoUrl;
      this.video.addEventListener('loadedmetadata', () => {
        this.video.currentTime = startTime;
        this.video.play().catch(e => console.warn('[Player] Autoplay blocked:', e));
      }, { once: true });
    } else {
      this.video.currentTime = startTime;
      this.video.play().catch(e => console.warn('[Player] Autoplay blocked:', e));
    }
  },

  checkPrefetch() {
    const remaining = this.playback.queue.length;
    
    if (remaining <= this.config.prefetchWhenRemaining && 
        !this.playback.isFetching && 
        !this.playback.endSignaled) {
      console.log(`[Player] Queue low (${remaining}), pre-fetching...`);
      this.fetchClips();
    }
  },

  // ==================== VIDEO EVENTS ====================

  onTimeUpdate() {
    const currentTime = this.video.currentTime;
    const duration = this.video.duration || 0;

    // Update progress
    if (duration > 0) {
      this.ui.progress.style.width = `${(currentTime / duration) * 100}%`;
    }
    this.ui.currentTime.textContent = this.formatTime(currentTime);
    this.ui.totalTime.textContent = this.formatTime(duration);

    // Check if clip should end
    if (this.playback.currentEndTime && currentTime >= this.playback.currentEndTime - 0.1) {
      this.onClipEnded();
    }

    // Check prefetch threshold
    if (this.playback.currentEndTime) {
      const timeRemaining = this.playback.currentEndTime - currentTime;
      if (timeRemaining <= this.config.prefetchThreshold) {
        this.checkPrefetch();
      }
    }
  },

  onClipEnded() {
    if (!this.session.active) return;

    const clip = this.playback.currentClip;
    if (clip) {
      // Track time watched
      const duration = (clip.outTime || this.video.duration) - (clip.inTime || 0);
      this.session.timeWatched += duration;
      console.log(`[Player] Clip ended. Total time: ${this.formatTime(this.session.timeWatched)}`);
    }

    this.playback.currentClip = null;
    this.playback.currentEndTime = null;
    
    // Play next
    this.playNext();
  },

  onVideoError(e) {
    console.error('[Player] Video error:', e);
    this.logReasoning(null, `Video error: ${this.video.error?.message || 'Unknown error'}`);
    
    // Try next clip
    if (this.playback.queue.length > 0) {
      this.playNext();
    }
  },

  // ==================== UI UPDATES ====================

  updateNowPlaying(clip) {
    const index = this.playback.history.length;
    
    this.ui.sceneNumber.textContent = index;
    this.ui.sceneName.textContent = clip.name || 'Untitled';
    this.ui.sceneInfo.classList.remove('hidden');
    
    this.ui.npName.textContent = clip.name || 'Untitled';
    this.ui.npTime.textContent = `${this.formatTime(clip.inTime || 0)} - ${this.formatTime(clip.outTime || 0)}`;
    this.ui.npDesc.textContent = clip.description || '';
    
    this.ui.sceneIndex.textContent = index;
    this.ui.totalScenes.textContent = this.playback.queue.length > 0 
      ? `${index}+${this.playback.queue.length}` 
      : (this.playback.endSignaled ? index : `${index}+`);
  },

  renderQueue() {
    const total = this.playback.history.length + this.playback.queue.length;
    this.ui.queueCount.textContent = total;

    if (this.playback.history.length === 0 && this.playback.queue.length === 0) {
      this.ui.queueList.innerHTML = '<div class="queue-empty">Waiting for clips...</div>';
      return;
    }

    let html = '';

    // History (played clips)
    this.playback.history.forEach((clip, i) => {
      const isCurrent = (i === this.playback.history.length - 1) && this.playback.currentClip;
      html += this.renderQueueItem(clip, i + 1, isCurrent ? 'current' : 'played');
    });

    // Queue (upcoming clips)
    this.playback.queue.forEach((clip, i) => {
      const num = this.playback.history.length + i + 1;
      html += this.renderQueueItem(clip, num, 'pending');
    });

    this.ui.queueList.innerHTML = html;
  },

  renderQueueItem(clip, num, state) {
    const duration = (clip.outTime || 0) - (clip.inTime || 0);
    return `
      <div class="queue-item ${state}">
        <span class="queue-number">${num}</span>
        <div class="queue-item-info">
          <div class="queue-item-name">${clip.name || 'Clip'}</div>
          <div class="queue-item-duration">${this.formatTime(duration)}</div>
        </div>
      </div>
    `;
  },

  logReasoning(clip, text) {
    if (!this.ui.showReasoning?.checked) return;
    
    const entry = document.createElement('div');
    entry.className = 'reasoning-entry';
    entry.innerHTML = `
      ${clip ? `<div class="reasoning-scene">→ ${clip.name}</div>` : ''}
      <div class="reasoning-text">${text}</div>
    `;
    this.ui.reasoningLog.insertBefore(entry, this.ui.reasoningLog.firstChild);
  },

  updatePlayPauseBtn() {
    this.ui.playPauseBtn.textContent = this.video.paused ? '▶️' : '⏸️';
  },

  // ==================== CONTROLS ====================

  togglePlay() {
    if (this.video.paused) {
      this.video.play();
    } else {
      this.video.pause();
    }
  },

  toggleMute() {
    this.video.muted = !this.video.muted;
    this.ui.muteBtn.textContent = this.video.muted ? '🔇' : '🔊';
  },

  skipClip() {
    if (this.session.active) {
      console.log('[Player] Skipping clip...');
      this.playback.currentEndTime = null;
      this.onClipEnded();
    }
  },

  toggleSection(el) {
    el.closest('.sidebar-section').classList.toggle('collapsed');
  },

  // ==================== UTILITIES ====================

  generateId() {
    return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  },

  formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }
};

// Initialize on load
document.addEventListener('DOMContentLoaded', () => player.init());
