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
    debugMode: false           // Enable verbose logging
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

  // Preloading
  preloadedVideo: null,     // Hidden video element for next clip

  // Retry logic
  apiRetryCount: 0,
  maxRetries: 3,
  retryDelay: 1000,         // Start with 1 second, exponential backoff

  // DOM
  video: null,
  ui: {},

  // ==================== INITIALIZATION ====================

  async init() {
    console.log('[Player] Initializing...');
    
    this.loadConfig();
    this.cacheUI();
    this.setupVideoEvents();
    
    console.log('[Player] Ready. API:', this.config.apiEndpoint || '(not configured)');
    this.debug('Debug mode:', this.config.debugMode ? 'ON' : 'OFF');
  },

  // Debug logging helper
  debug(...args) {
    if (this.config.debugMode) {
      console.log('[Player:DEBUG]', ...args);
    }
  },

  loadConfig() {
    const cfg = window.AGENTIC_PLAYER_CONFIG || {};
    this.config = {
      // Default to local server if no endpoint configured
      apiEndpoint: cfg.apiEndpoint || 'http://localhost:3456/playlist',
      apiKey: cfg.apiKey || null,
      apiHeaders: cfg.apiHeaders || {},
      context: cfg.context || {},
      prefetchWhenRemaining: cfg.prefetchWhenRemaining || 2,
      prefetchThreshold: cfg.prefetchThreshold || 5
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

    // Clean up any preloaded video from previous session
    this.clearPreloadedVideo();

    // Reset retry count
    this.apiRetryCount = 0;

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

    // Clean up preloaded video
    this.clearPreloadedVideo();

    // Reset retry count
    this.apiRetryCount = 0;
    
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

      // Success - reset retry count
      this.apiRetryCount = 0;

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
      
      // Retry logic with exponential backoff
      if (this.apiRetryCount < this.maxRetries) {
        this.apiRetryCount++;
        const delay = this.retryDelay * Math.pow(2, this.apiRetryCount - 1);
        
        console.log(`[Player] Retrying in ${delay}ms (attempt ${this.apiRetryCount}/${this.maxRetries})`);
        this.logReasoning(null, `Connection issue, retrying... (${this.apiRetryCount}/${this.maxRetries})`);
        
        // Keep isFetching true to prevent duplicate requests
        setTimeout(() => {
          this.playback.isFetching = false;
          this.fetchClips();
        }, delay);
        
        return; // Don't set isFetching = false yet
      }
      
      // Max retries exceeded
      this.apiRetryCount = 0; // Reset for next attempt
      this.logReasoning(null, `Error after ${this.maxRetries} retries: ${error.message}`);
      
      // If we have no clips to play, end session
      if (this.playback.queue.length === 0 && !this.playback.currentClip) {
        this.endSession(`API Error: ${error.message}`);
      }
    } finally {
      // Only set isFetching false if not retrying
      if (this.apiRetryCount === 0) {
      this.playback.isFetching = false;
      }
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

    // Check if this clip is a quiz/checkpoint
    if (this.checkForQuiz(clip)) {
      console.log('[Player] Quiz marker detected:', clip.name);
      this.showQuiz(clip);
      return; // Don't play video yet
    }
    this.playback.currentEndTime = clip.outTime;

    // Track as watched
    if (clip.id && !this.session.watchedIds.includes(clip.id)) {
      this.session.watchedIds.push(clip.id);
    }

    // Add to history
    this.playback.history.push(clip);

    // Use preloaded video if available for seamless transition
    const videoUrl = clip.videoUrl || clip.videoSrc;
    const startTime = clip.inTime || 0;
    
    if (this.preloadedVideo && this.preloadedVideo.src.includes(videoUrl)) {
      console.log('[Player] Using preloaded video for seamless transition');
      
      try {
        // Transfer preloaded video to main player for instant playback
        const wasPlaying = !this.video.paused;
        
        // Swap the sources
        this.video.src = this.preloadedVideo.src;
        this.video.currentTime = startTime;
        this.video.muted = false; // Unmute for actual playback
        
        // Play immediately (already buffered)
        if (wasPlaying || this.playback.history.length === 1) {
          this.video.play().catch(e => console.warn('[Player] Autoplay blocked:', e));
        }
        
        // Clean up preloaded video
        this.clearPreloadedVideo();
        
        console.log('[Player] Seamless transition complete');
      } catch (error) {
        console.error('[Player] Error in seamless transition:', error);
        // Fallback to normal loading
        this.loadVideo(clip);
        this.clearPreloadedVideo();
      }
    } else {
      // No preloaded video available, use normal loading
      console.log('[Player] Loading video normally (no preload available)');
    this.loadVideo(clip);
      
      // Clear stale preloaded video if exists
      this.clearPreloadedVideo();
    }
    
    // Update UI
    this.updateNowPlaying(clip);
    this.renderQueue();

    // Check if we need to pre-fetch and preload next
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
    this.debug('checkPrefetch called:', { remaining, isFetching: this.playback.isFetching, endSignaled: this.playback.endSignaled, hasPreload: !!this.preloadedVideo });
    
    // Fetch more clips from API
    if (remaining <= this.config.prefetchWhenRemaining && 
        !this.playback.isFetching && 
        !this.playback.endSignaled) {
      console.log(`[Player] Queue low (${remaining}), pre-fetching clips from API...`);
      this.fetchClips();
    }

    // Preload next video element for instant transition
    if (remaining > 0 && !this.preloadedVideo) {
      this.debug('Triggering video preload for next clip');
      this.preloadNextVideo();
    }
  },

  preloadNextVideo() {
    if (this.playback.queue.length === 0) return;
    
    const nextClip = this.playback.queue[0];
    const videoUrl = nextClip.videoUrl || nextClip.videoSrc;
    
    if (!videoUrl) {
      console.warn('[Player] No video URL for next clip');
      return;
    }
    
    // Create hidden video element for preloading
    const preload = document.createElement('video');
    preload.src = videoUrl;
    preload.preload = 'auto';
    preload.muted = true; // Muted to allow preload without user gesture
    preload.style.display = 'none';
    preload.crossOrigin = 'anonymous'; // For CORS if needed
    
    // Add to DOM (required for some browsers to actually preload)
    document.body.appendChild(preload);
    
    // Start loading
    preload.load();
    
    preload.addEventListener('loadeddata', () => {
      console.log(`[Player] Preloaded next clip: ${nextClip.name} (buffered: ${preload.buffered.length > 0})`);
    }, { once: true });
    
    preload.addEventListener('error', (e) => {
      console.error('[Player] Preload error:', e);
      // Clean up failed preload
      if (this.preloadedVideo === preload) {
        this.preloadedVideo = null;
      }
      preload.remove();
    }, { once: true });
    
    this.preloadedVideo = preload;
  },

  clearPreloadedVideo() {
    if (this.preloadedVideo) {
      this.preloadedVideo.pause();
      this.preloadedVideo.src = '';
      this.preloadedVideo.remove();
      this.preloadedVideo = null;
    }
  },

  // ==================== QUIZ/CHECKPOINT SYSTEM ====================

  // Quiz state
  quiz: {
    active: false,
    currentQuiz: null,
    responses: [],
    score: 0,
    totalQuestions: 0
  },

  /**
   * Check if current clip has a quiz marker
   */
  checkForQuiz(clip) {
    if (!clip) return false;
    
    // Check if this is a quiz marker or has quiz data
    const isQuizMarker = clip.markerType === 'quiz' || clip.type === 'quiz';
    const hasQuizData = clip.quizData && Object.keys(clip.quizData).length > 0;
    
    return isQuizMarker || hasQuizData;
  },

  /**
   * Show quiz UI for a clip
   */
  showQuiz(clip) {
    if (this.quiz.active) return;
    
    this.quiz.active = true;
    this.quiz.currentQuiz = clip;
    
    // Pause video
    this.video.pause();
    
    // Get quiz data
    const quizData = clip.quizData || {
      question: clip.description || clip.name || 'Knowledge Check',
      type: 'continue', // Default to just a "continue" button if no real quiz
      options: []
    };
    
    // Create quiz overlay
    const overlay = document.createElement('div');
    overlay.id = 'quiz-overlay';
    overlay.className = 'quiz-overlay';
    
    let quizContent = '';
    
    if (quizData.type === 'multiple-choice' && quizData.options) {
      // Multiple choice quiz
      quizContent = `
        <div class="quiz-container">
          <div class="quiz-header">
            <span class="quiz-icon">❓</span>
            <span class="quiz-title">Knowledge Check</span>
          </div>
          <div class="quiz-question">${this.escapeHtml(quizData.question)}</div>
          <div class="quiz-options">
            ${quizData.options.map((opt, i) => `
              <button class="quiz-option" data-index="${i}" data-correct="${opt.correct || false}">
                <span class="option-letter">${String.fromCharCode(65 + i)}</span>
                <span class="option-text">${this.escapeHtml(opt.text || opt)}</span>
              </button>
            `).join('')}
          </div>
          <div class="quiz-feedback hidden"></div>
        </div>
      `;
    } else if (quizData.type === 'true-false') {
      // True/False quiz
      quizContent = `
        <div class="quiz-container">
          <div class="quiz-header">
            <span class="quiz-icon">❓</span>
            <span class="quiz-title">True or False?</span>
          </div>
          <div class="quiz-question">${this.escapeHtml(quizData.question)}</div>
          <div class="quiz-options">
            <button class="quiz-option" data-index="0" data-correct="${quizData.answer === true}">
              <span class="option-letter">✓</span>
              <span class="option-text">True</span>
            </button>
            <button class="quiz-option" data-index="1" data-correct="${quizData.answer === false}">
              <span class="option-letter">✗</span>
              <span class="option-text">False</span>
            </button>
          </div>
          <div class="quiz-feedback hidden"></div>
        </div>
      `;
    } else {
      // Checkpoint/continue prompt
      quizContent = `
        <div class="quiz-container checkpoint">
          <div class="quiz-header">
            <span class="quiz-icon">📍</span>
            <span class="quiz-title">Checkpoint</span>
          </div>
          <div class="quiz-question">${this.escapeHtml(quizData.question || clip.name || 'Ready to continue?')}</div>
          ${clip.description ? `<div class="quiz-description">${this.escapeHtml(clip.description)}</div>` : ''}
          <button class="quiz-continue-btn">Continue Learning ▶</button>
        </div>
      `;
    }
    
    overlay.innerHTML = quizContent;
    
    // Add to DOM
    const playerContainer = this.video.closest('.video-container') || this.video.parentElement;
    playerContainer.appendChild(overlay);
    
    // Add event listeners
    this.attachQuizListeners(overlay, quizData);
    
    console.log('[Player] Quiz displayed:', quizData.question);
  },

  /**
   * Attach event listeners to quiz UI
   */
  attachQuizListeners(overlay, quizData) {
    // Multiple choice / True-False options
    overlay.querySelectorAll('.quiz-option').forEach(btn => {
      btn.addEventListener('click', (e) => {
        this.handleQuizAnswer(btn, overlay, quizData);
      });
    });
    
    // Continue button for checkpoints
    const continueBtn = overlay.querySelector('.quiz-continue-btn');
    if (continueBtn) {
      continueBtn.addEventListener('click', () => {
        this.closeQuiz(overlay);
      });
    }
  },

  /**
   * Handle quiz answer selection
   */
  handleQuizAnswer(selectedBtn, overlay, quizData) {
    const isCorrect = selectedBtn.dataset.correct === 'true';
    const feedbackEl = overlay.querySelector('.quiz-feedback');
    
    // Disable all options
    overlay.querySelectorAll('.quiz-option').forEach(btn => {
      btn.disabled = true;
      btn.classList.add('disabled');
      
      // Highlight correct answer
      if (btn.dataset.correct === 'true') {
        btn.classList.add('correct');
      }
    });
    
    // Highlight selected answer
    selectedBtn.classList.add(isCorrect ? 'correct' : 'incorrect');
    
    // Show feedback
    if (feedbackEl) {
      feedbackEl.classList.remove('hidden');
      feedbackEl.className = `quiz-feedback ${isCorrect ? 'correct' : 'incorrect'}`;
      feedbackEl.innerHTML = isCorrect 
        ? '✅ Correct! Well done.'
        : `❌ Not quite. ${quizData.explanation || ''}`;
    }
    
    // Update score
    if (isCorrect) {
      this.quiz.score++;
    }
    this.quiz.totalQuestions++;
    
    // Record response
    this.quiz.responses.push({
      quizId: this.quiz.currentQuiz?.id,
      question: quizData.question,
      answerIndex: parseInt(selectedBtn.dataset.index),
      correct: isCorrect,
      timestamp: Date.now()
    });
    
    // Send response to server
    this.sendQuizResponse(this.quiz.currentQuiz?.id, selectedBtn.dataset.index, isCorrect);
    
    console.log(`[Player] Quiz answer: ${isCorrect ? 'CORRECT' : 'INCORRECT'} (Score: ${this.quiz.score}/${this.quiz.totalQuestions})`);
    
    // Auto-continue after delay
    setTimeout(() => {
      this.closeQuiz(overlay);
    }, isCorrect ? 1500 : 2500);
  },

  /**
   * Send quiz response to API server
   */
  async sendQuizResponse(quizId, answer, correct) {
    try {
      const serverUrl = this.config.apiEndpoint.replace('/playlist', '/quiz-response');
      
      await fetch(serverUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: this.session.id,
          quizId,
          answer,
          correct
        })
      });
    } catch (e) {
      console.warn('[Player] Could not send quiz response:', e.message);
    }
  },

  /**
   * Close quiz overlay and resume playback
   */
  closeQuiz(overlay) {
    if (overlay) {
      overlay.classList.add('fade-out');
      setTimeout(() => {
        overlay.remove();
      }, 300);
    }
    
    this.quiz.active = false;
    this.quiz.currentQuiz = null;
    
    // Resume playback or play next
    if (this.playback.currentClip) {
      this.video.play().catch(e => console.warn('[Player] Resume blocked:', e));
    } else {
      this.playNext();
    }
  },

  /**
   * Get quiz progress
   */
  getQuizProgress() {
    return {
      score: this.quiz.score,
      total: this.quiz.totalQuestions,
      percentage: this.quiz.totalQuestions > 0 
        ? Math.round((this.quiz.score / this.quiz.totalQuestions) * 100) 
        : 0,
      responses: this.quiz.responses
    };
  },

  /**
   * Escape HTML for safe display
   */
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
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

      // Enhanced buffer health monitoring with critical/warning thresholds
    if (this.playback.currentEndTime) {
      const timeRemaining = this.playback.currentEndTime - currentTime;
        const queueLength = this.playback.queue.length;
        
        this.debug('Buffer health:', {
          timeRemaining: timeRemaining.toFixed(1),
          queueLength,
          hasPreload: !!this.preloadedVideo,
          isFetching: this.playback.isFetching
        });
        
        // CRITICAL: Less than 3 seconds and no queue - emergency fetch
        if (timeRemaining <= 3 && queueLength === 0 && !this.playback.isFetching && !this.playback.endSignaled) {
          console.warn('[Player] CRITICAL: Buffer almost empty! Emergency fetch...');
          this.ui.thinking.classList.remove('hidden'); // Show loading indicator
          this.checkPrefetch();
        }
        // WARNING: Less than prefetch threshold - normal prefetch
        else if (timeRemaining <= this.config.prefetchThreshold) {
          this.debug('Prefetch threshold reached');
        this.checkPrefetch();
          
          // Hide loading indicator if we have clips in queue
          if (queueLength > 0) {
            this.ui.thinking.classList.add('hidden');
          }
        }
        
        // HEALTHY: More than 10 seconds remaining or queue has clips
        if (timeRemaining > 10 || queueLength > 1) {
          this.ui.thinking.classList.add('hidden');
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
