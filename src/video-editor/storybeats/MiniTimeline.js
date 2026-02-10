/**
 * MiniTimeline - Compact timeline preview showing edit impacts
 * 
 * Displays:
 * - Keep segments (blue/normal)
 * - Cut/deleted segments (red, strikethrough)
 * - Gap/insert segments (green, dashed)
 * - Duration comparison (original vs new)
 */
const { getLogQueue } = require('../../../lib/log-event-queue');
const log = getLogQueue();
export class MiniTimeline {
  constructor(appContext) {
    this.app = appContext;
    
    // State
    this.segments = [];
    this.originalDuration = 0;
    this.newDuration = 0;
    
    // DOM reference
    this.container = null;
    this.canvas = null;
  }

  /**
   * Initialize the mini timeline
   */
  init() {
    this.container = document.getElementById('storyBeatsMiniTimeline');
    if (!this.container) {
      log.warn('video', '[MiniTimeline] Container not found');
      return;
    }
    
    this.render();
  }

  /**
   * Update preview with new segments
   */
  updatePreview(segments, newDuration) {
    this.segments = segments || [];
    this.newDuration = newDuration || this.originalDuration;
    this.render();
  }

  /**
   * Set original video duration
   */
  setOriginalDuration(duration) {
    this.originalDuration = duration;
    this.newDuration = duration;
    this.render();
  }

  /**
   * Format time as MM:SS
   */
  formatTimeShort(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  /**
   * Format duration change
   */
  formatDurationChange(change) {
    const sign = change >= 0 ? '+' : '';
    return `${sign}${this.formatTimeShort(Math.abs(change))}`;
  }

  /**
   * Render the mini timeline
   */
  render() {
    if (!this.container) return;
    
    const hasEdits = this.segments.some(s => s.type !== 'keep');
    const durationChange = this.newDuration - this.originalDuration;
    
    // Build timeline visualization
    let segmentsHtml = '';
    
    if (this.segments.length === 0 || this.originalDuration === 0) {
      // No segments or no video
      segmentsHtml = `
        <div class="mini-timeline-empty">
          <span>Load a video to see timeline</span>
        </div>
      `;
    } else {
      // Render each segment
      this.segments.forEach((segment, index) => {
        const widthPercent = segment.type === 'gap' 
          ? (segment.duration / this.originalDuration) * 100
          : (segment.duration / this.originalDuration) * 100;
        
        let className = 'mini-timeline-segment';
        let tooltip = '';
        
        switch (segment.type) {
          case 'keep':
            className += ' segment-keep';
            tooltip = `Keep: ${this.formatTimeShort(segment.startTime)} - ${this.formatTimeShort(segment.endTime)}`;
            break;
          case 'cut':
            className += ' segment-cut';
            tooltip = `Cut: ${this.formatTimeShort(segment.startTime)} - ${this.formatTimeShort(segment.endTime)} (${this.formatTimeShort(segment.duration)} removed)`;
            break;
          case 'gap':
            className += ' segment-gap';
            tooltip = `Gap: ${this.formatTimeShort(segment.duration)} for new content`;
            break;
        }
        
        segmentsHtml += `
          <div class="${className}" 
               style="width: ${Math.max(widthPercent, 1)}%;" 
               title="${tooltip}"
               data-segment-index="${index}">
            ${segment.type === 'cut' ? '<span class="segment-x">✕</span>' : ''}
            ${segment.type === 'gap' ? '<span class="segment-plus">+</span>' : ''}
          </div>
        `;
      });
    }
    
    // Build duration info
    const durationClass = durationChange === 0 ? '' : (durationChange > 0 ? 'duration-longer' : 'duration-shorter');
    const changeText = durationChange === 0 ? '' : `(${this.formatDurationChange(durationChange)})`;
    
    this.container.innerHTML = `
      <div class="mini-timeline-header">
        <span class="mini-timeline-label">Timeline Preview</span>
        <div class="mini-timeline-actions">
          ${hasEdits ? `
            <button class="mini-timeline-btn" onclick="app.videoSyncEngine?.undoLastEdit()" title="Undo last edit">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>
              </svg>
            </button>
            <button class="mini-timeline-btn" onclick="app.videoSyncEngine?.clearAllEdits()" title="Clear all edits">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
            </button>
          ` : ''}
        </div>
      </div>
      
      <div class="mini-timeline-track">
        <div class="mini-timeline-segments">
          ${segmentsHtml}
        </div>
        <div class="mini-timeline-playhead" id="miniTimelinePlayhead"></div>
      </div>
      
      <div class="mini-timeline-footer">
        <div class="mini-timeline-legend">
          <span class="legend-item legend-keep"><span class="legend-color"></span>Keep</span>
          <span class="legend-item legend-cut"><span class="legend-color"></span>Cut</span>
          <span class="legend-item legend-gap"><span class="legend-color"></span>Gap</span>
        </div>
        <div class="mini-timeline-duration ${durationClass}">
          <span>${this.formatTimeShort(this.newDuration)}</span>
          <span class="duration-change">${changeText}</span>
        </div>
      </div>
      
      ${hasEdits ? `
        <div class="mini-timeline-apply">
          <div class="mini-timeline-preview-controls">
            <button class="btn btn-secondary mini-timeline-preview-btn ${this.isPreviewActive() ? 'active' : ''}" 
                    onclick="app.storyBeatsMiniTimeline?.togglePreview()" 
                    title="${this.isPreviewActive() ? 'Stop Preview' : 'Preview Edits'}">
              ${this.isPreviewActive() ? '⏹ Stop Preview' : '▶ Preview Edits'}
            </button>
            <button class="btn btn-secondary mini-timeline-diff-btn" 
                    onclick="app.storyBeatsMiniTimeline?.showDiffView()"
                    title="Show before/after comparison">
              📊 Compare
            </button>
          </div>
          <button class="btn btn-primary mini-timeline-apply-btn" onclick="app.applyStoryBeatsEdits()">
            Apply ${this.segments.filter(s => s.type !== 'keep').length} Edit${this.segments.filter(s => s.type !== 'keep').length !== 1 ? 's' : ''}
          </button>
        </div>
      ` : ''}
    `;
    
    // Update playhead position if video is playing
    this.updatePlayhead();
  }

  /**
   * Check if preview mode is active
   */
  isPreviewActive() {
    return this.app.videoSyncEngine?.isPreviewActive() || false;
  }

  /**
   * Toggle preview mode
   */
  togglePreview() {
    if (this.app.videoSyncEngine) {
      this.app.videoSyncEngine.togglePreview();
      this.render(); // Re-render to update button state
    }
  }

  /**
   * Show visual diff between original and edited timeline
   */
  showDiffView() {
    // Create or show diff modal
    this._showDiffModal();
  }

  /**
   * Create and display diff comparison modal
   */
  _showDiffModal() {
    // Remove existing modal if any
    const existing = document.getElementById('timelineDiffModal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'timelineDiffModal';
    modal.className = 'modal-overlay timeline-diff-modal-overlay';
    
    const editSummary = this.app.videoSyncEngine?.getEditSummary() || {};
    const durationChange = editSummary.durationChange || 0;
    const changeSign = durationChange >= 0 ? '+' : '';
    const changeClass = durationChange > 0 ? 'longer' : durationChange < 0 ? 'shorter' : '';

    modal.innerHTML = `
      <div class="modal-content timeline-diff-modal">
        <div class="modal-header">
          <h3>📊 Edit Preview</h3>
          <button class="modal-close-btn" onclick="this.closest('.modal-overlay').remove()">&times;</button>
        </div>
        
        <div class="modal-body">
          <!-- Duration Comparison -->
          <div class="diff-duration-compare">
            <div class="diff-duration-box original">
              <div class="duration-label">Original</div>
              <div class="duration-value">${this.formatTimeShort(editSummary.originalDuration || 0)}</div>
            </div>
            <div class="diff-duration-arrow">→</div>
            <div class="diff-duration-box result ${changeClass}">
              <div class="duration-label">After Edits</div>
              <div class="duration-value">${this.formatTimeShort(editSummary.newDuration || 0)}</div>
              <div class="duration-change ${changeClass}">${changeSign}${this.formatTimeShort(Math.abs(durationChange))}</div>
            </div>
          </div>

          <!-- Timeline Comparison -->
          <div class="diff-timeline-compare">
            <div class="diff-timeline-section">
              <div class="diff-timeline-label">Before</div>
              <div class="diff-timeline-bar original">
                <div class="diff-bar-fill" style="width: 100%"></div>
              </div>
            </div>
            <div class="diff-timeline-section">
              <div class="diff-timeline-label">After</div>
              <div class="diff-timeline-bar result">
                ${this._renderDiffSegments()}
              </div>
            </div>
          </div>

          <!-- Edit Summary -->
          <div class="diff-summary">
            <div class="diff-summary-item">
              <span class="summary-icon">✂️</span>
              <span class="summary-label">Deletions</span>
              <span class="summary-value">${editSummary.deletionCount || 0}</span>
              <span class="summary-time">(${this.formatTimeShort(editSummary.totalCutTime || 0)} removed)</span>
            </div>
            <div class="diff-summary-item">
              <span class="summary-icon">➕</span>
              <span class="summary-label">Insertions</span>
              <span class="summary-value">${editSummary.gapCount || 0}</span>
              <span class="summary-time">(${this.formatTimeShort(editSummary.totalGapTime || 0)} added)</span>
            </div>
            <div class="diff-summary-item">
              <span class="summary-icon">🔄</span>
              <span class="summary-label">Replacements</span>
              <span class="summary-value">${editSummary.replacementCount || 0}</span>
              <span class="summary-time">(${this.formatTimeShort(editSummary.totalReplaceTime || 0)})</span>
            </div>
          </div>
        </div>

        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">Close</button>
          <button class="btn btn-secondary" onclick="app.videoSyncEngine?.togglePreview(); this.closest('.modal-overlay').remove()">
            ${this.isPreviewActive() ? '⏹ Stop Preview' : '▶ Preview'}
          </button>
          <button class="btn btn-primary" onclick="app.applyStoryBeatsEdits(); this.closest('.modal-overlay').remove()">
            ✓ Apply Edits
          </button>
        </div>
      </div>
    `;

    // Add styles for diff modal
    this._addDiffModalStyles();
    
    document.body.appendChild(modal);
    
    // Animate in
    requestAnimationFrame(() => modal.classList.add('visible'));
  }

  /**
   * Render diff segments for the result bar
   */
  _renderDiffSegments() {
    if (!this.segments || this.segments.length === 0) {
      return '<div class="diff-bar-fill" style="width: 100%"></div>';
    }

    const totalOriginal = this.originalDuration || 1;
    
    return this.segments.map(segment => {
      const widthPercent = (segment.duration / totalOriginal) * 100;
      let className = 'diff-segment';
      
      switch (segment.type) {
        case 'keep':
          className += ' diff-keep';
          break;
        case 'cut':
          return ''; // Don't show cuts in result
        case 'gap':
          className += ' diff-gap';
          break;
      }
      
      return `<div class="${className}" style="width: ${widthPercent}%"></div>`;
    }).join('');
  }

  /**
   * Add styles for diff modal
   */
  _addDiffModalStyles() {
    if (document.getElementById('timelineDiffModalStyles')) return;

    const styles = document.createElement('style');
    styles.id = 'timelineDiffModalStyles';
    styles.textContent = `
      .timeline-diff-modal-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.7);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10001;
        opacity: 0;
        transition: opacity 0.2s;
      }
      
      .timeline-diff-modal-overlay.visible {
        opacity: 1;
      }
      
      .timeline-diff-modal {
        background: var(--bg-primary, #1a1a2e);
        border-radius: 12px;
        width: 90%;
        max-width: 500px;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
        border: 1px solid var(--border-color, #333);
      }
      
      .timeline-diff-modal .modal-header {
        padding: 16px 20px;
        border-bottom: 1px solid var(--border-color, #333);
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      
      .timeline-diff-modal .modal-header h3 {
        margin: 0;
        font-size: 16px;
        color: var(--text-primary, #fff);
      }
      
      .timeline-diff-modal .modal-body {
        padding: 20px;
      }
      
      .diff-duration-compare {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 20px;
        margin-bottom: 24px;
      }
      
      .diff-duration-box {
        text-align: center;
        padding: 16px 24px;
        background: var(--bg-secondary, #252540);
        border-radius: 8px;
        border: 1px solid var(--border-color, #333);
      }
      
      .diff-duration-box.result.shorter {
        border-color: #10b981;
      }
      
      .diff-duration-box.result.longer {
        border-color: #f59e0b;
      }
      
      .duration-label {
        font-size: 12px;
        color: var(--text-secondary, #888);
        margin-bottom: 4px;
      }
      
      .duration-value {
        font-size: 24px;
        font-weight: bold;
        color: var(--text-primary, #fff);
      }
      
      .duration-change {
        font-size: 12px;
        margin-top: 4px;
      }
      
      .duration-change.shorter {
        color: #10b981;
      }
      
      .duration-change.longer {
        color: #f59e0b;
      }
      
      .diff-duration-arrow {
        font-size: 24px;
        color: var(--text-secondary, #888);
      }
      
      .diff-timeline-compare {
        margin-bottom: 24px;
      }
      
      .diff-timeline-section {
        margin-bottom: 12px;
      }
      
      .diff-timeline-label {
        font-size: 12px;
        color: var(--text-secondary, #888);
        margin-bottom: 4px;
      }
      
      .diff-timeline-bar {
        height: 24px;
        background: var(--bg-secondary, #252540);
        border-radius: 4px;
        overflow: hidden;
        display: flex;
      }
      
      .diff-bar-fill {
        background: #3b82f6;
        height: 100%;
      }
      
      .diff-segment.diff-keep {
        background: #3b82f6;
        height: 100%;
      }
      
      .diff-segment.diff-gap {
        background: #10b981;
        height: 100%;
        background-image: repeating-linear-gradient(
          45deg,
          transparent,
          transparent 4px,
          rgba(255,255,255,0.1) 4px,
          rgba(255,255,255,0.1) 8px
        );
      }
      
      .diff-summary {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      
      .diff-summary-item {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        background: var(--bg-secondary, #252540);
        border-radius: 6px;
      }
      
      .summary-icon {
        font-size: 16px;
      }
      
      .summary-label {
        flex: 1;
        color: var(--text-secondary, #888);
      }
      
      .summary-value {
        font-weight: bold;
        color: var(--text-primary, #fff);
        min-width: 24px;
        text-align: center;
      }
      
      .summary-time {
        font-size: 12px;
        color: var(--text-secondary, #888);
      }
      
      .timeline-diff-modal .modal-footer {
        padding: 16px 20px;
        border-top: 1px solid var(--border-color, #333);
        display: flex;
        justify-content: flex-end;
        gap: 12px;
      }
      
      .timeline-diff-modal .btn {
        padding: 8px 16px;
        border-radius: 6px;
        font-size: 13px;
        cursor: pointer;
      }
      
      .timeline-diff-modal .btn-secondary {
        background: var(--bg-secondary, #252540);
        border: 1px solid var(--border-color, #333);
        color: var(--text-primary, #fff);
      }
      
      .timeline-diff-modal .btn-primary {
        background: var(--accent-color, #4a9eff);
        border: none;
        color: white;
      }
      
      /* Mini timeline preview button styles */
      .mini-timeline-preview-controls {
        display: flex;
        gap: 8px;
        margin-bottom: 8px;
      }
      
      .mini-timeline-preview-btn,
      .mini-timeline-diff-btn {
        font-size: 11px;
        padding: 4px 8px;
      }
      
      .mini-timeline-preview-btn.active {
        background: #10b981;
        border-color: #10b981;
        color: white;
      }
    `;
    document.head.appendChild(styles);
  }

  /**
   * Update playhead position
   */
  updatePlayhead() {
    const video = document.getElementById('videoPlayer');
    const playhead = document.getElementById('miniTimelinePlayhead');
    
    if (!video || !playhead || this.originalDuration === 0) return;
    
    const percent = (video.currentTime / this.originalDuration) * 100;
    playhead.style.left = `${Math.min(percent, 100)}%`;
  }

  /**
   * Start playhead tracking
   */
  startPlayheadTracking() {
    const video = document.getElementById('videoPlayer');
    if (!video) return;
    
    video.addEventListener('timeupdate', () => this.updatePlayhead());
  }

  /**
   * Get summary text for current edits
   */
  getSummaryText() {
    const cuts = this.segments.filter(s => s.type === 'cut');
    const gaps = this.segments.filter(s => s.type === 'gap');
    
    const parts = [];
    
    if (cuts.length > 0) {
      const totalCutTime = cuts.reduce((sum, s) => sum + s.duration, 0);
      parts.push(`${cuts.length} cut${cuts.length !== 1 ? 's' : ''} (${this.formatTimeShort(totalCutTime)})`);
    }
    
    if (gaps.length > 0) {
      const totalGapTime = gaps.reduce((sum, s) => sum + s.duration, 0);
      parts.push(`${gaps.length} gap${gaps.length !== 1 ? 's' : ''} (${this.formatTimeShort(totalGapTime)})`);
    }
    
    if (parts.length === 0) {
      return 'No edits';
    }
    
    return parts.join(', ');
  }

  /**
   * Show the mini timeline
   */
  show() {
    if (this.container) {
      this.container.classList.remove('hidden');
    }
  }

  /**
   * Hide the mini timeline
   */
  hide() {
    if (this.container) {
      this.container.classList.add('hidden');
    }
  }
}


