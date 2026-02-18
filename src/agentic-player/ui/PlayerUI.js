/**
 * PlayerUI - Player UI updates
 * @module src/agentic-player/ui/PlayerUI
 */

/**
 * Player UI class
 */
export class PlayerUI {
  constructor() {
    this.elements = {};
    this.cacheElements();
  }

  /**
   * Cache DOM elements
   */
  cacheElements() {
    this.elements = {
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
      npDesc: document.getElementById('npDescription'),
    };
  }

  /**
   * Show session started UI
   */
  showSessionStarted() {
    this.elements.status.textContent = 'Active';
    this.elements.status.classList.add('active');
    this.elements.setupSection.classList.add('hidden');
    this.elements.nowPlaying.classList.remove('hidden');
    this.elements.controls.classList.remove('hidden');
    this.elements.overlay.classList.add('hidden');

    if (this.elements.showReasoning?.checked) {
      this.elements.reasoningSection.classList.remove('hidden');
      this.elements.reasoningLog.innerHTML = '';
    }
  }

  /**
   * Show session ended UI
   */
  showSessionEnded() {
    this.elements.status.textContent = 'Ended';
    this.elements.status.classList.remove('active');

    setTimeout(() => {
      this.elements.setupSection.classList.remove('hidden');
      this.elements.controls.classList.add('hidden');
    }, 2000);
  }

  /**
   * Update now playing info
   * @param {Object} clip - Current clip
   * @param {number} index - Clip index
   * @param {number} queueLength - Queue length
   * @param {boolean} endSignaled - End signaled
   */
  updateNowPlaying(clip, index, queueLength, endSignaled) {
    this.elements.sceneNumber.textContent = index;
    this.elements.sceneName.textContent = clip.name || 'Untitled';
    this.elements.sceneInfo.classList.remove('hidden');

    this.elements.npName.textContent = clip.name || 'Untitled';
    this.elements.npTime.textContent = `${this.formatTime(clip.inTime || 0)} - ${this.formatTime(clip.outTime || 0)}`;
    this.elements.npDesc.textContent = clip.description || '';

    this.elements.sceneIndex.textContent = index;
    this.elements.totalScenes.textContent =
      queueLength > 0 ? `${index}+${queueLength}` : endSignaled ? index : `${index}+`;
  }

  /**
   * Update progress bar
   * @param {number} currentTime - Current time
   * @param {number} duration - Total duration
   */
  updateProgress(currentTime, duration) {
    if (duration > 0) {
      this.elements.progress.style.width = `${(currentTime / duration) * 100}%`;
    }
    this.elements.currentTime.textContent = this.formatTime(currentTime);
    this.elements.totalTime.textContent = this.formatTime(duration);
  }

  /**
   * Update play/pause button
   * @param {boolean} isPlaying - Playing state
   */
  updatePlayPauseBtn(isPlaying) {
    this.elements.playPauseBtn.textContent = isPlaying ? '⏸️' : '▶️';
  }

  /**
   * Update mute button
   * @param {boolean} isMuted - Muted state
   */
  updateMuteBtn(isMuted) {
    this.elements.muteBtn.textContent = isMuted ? '🔇' : '🔊';
  }

  /**
   * Show/hide thinking indicator
   * @param {boolean} show - Show or hide
   */
  showThinking(show) {
    this.elements.thinking.classList.toggle('hidden', !show);
  }

  /**
   * Format time helper
   * @param {number} seconds - Seconds
   * @returns {string} Formatted time
   */
  formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  /**
   * Get prompt value
   */
  get promptValue() {
    return this.elements.prompt?.value.trim() || '';
  }

  /**
   * Get time limit value
   */
  get timeLimitValue() {
    return parseInt(this.elements.timeLimit?.value) || 0;
  }
}
