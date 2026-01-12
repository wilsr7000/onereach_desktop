/**
 * RatingDashboard - Visual display panel for project ratings
 * 
 * Features:
 * - Overall score with trend indicator
 * - Per-criterion breakdown with progress bars
 * - Improvement suggestions with action items
 * - Historical comparison across projects
 */

export class RatingDashboard {
  constructor(appContext) {
    this.app = appContext;
    this.panelElement = null;
    this.isVisible = false;
    
    // Current rating data
    this.currentRating = null;
    this.history = [];
  }

  /**
   * Initialize the dashboard
   */
  init() {
    this._createPanel();
    this._addStyles();
  }

  /**
   * Create the panel DOM structure
   */
  _createPanel() {
    // Check if panel exists
    this.panelElement = document.getElementById('ratingDashboardPanel');
    
    if (!this.panelElement) {
      this.panelElement = document.createElement('div');
      this.panelElement.id = 'ratingDashboardPanel';
      this.panelElement.className = 'rating-dashboard-overlay';
      document.body.appendChild(this.panelElement);
    }
    
    this._setupEventListeners();
  }

  /**
   * Add component styles
   */
  _addStyles() {
    if (document.getElementById('ratingDashboardStyles')) return;
    
    const styles = document.createElement('style');
    styles.id = 'ratingDashboardStyles';
    styles.textContent = `
      .rating-dashboard-overlay {
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
        visibility: hidden;
        transition: opacity 0.2s, visibility 0.2s;
      }
      
      .rating-dashboard-overlay.visible {
        opacity: 1;
        visibility: visible;
      }
      
      .rating-dashboard {
        background: var(--bg-primary, #1a1a2e);
        border-radius: 12px;
        width: 90%;
        max-width: 700px;
        max-height: 85vh;
        display: flex;
        flex-direction: column;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
        border: 1px solid var(--border-color, #333);
      }
      
      .rating-dashboard-header {
        padding: 16px 20px;
        border-bottom: 1px solid var(--border-color, #333);
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      
      .rating-dashboard-title {
        font-size: 18px;
        font-weight: 600;
        color: var(--text-primary, #fff);
        display: flex;
        align-items: center;
        gap: 8px;
      }
      
      .rating-dashboard-close {
        background: none;
        border: none;
        font-size: 24px;
        color: var(--text-secondary, #888);
        cursor: pointer;
        padding: 4px 8px;
        border-radius: 4px;
      }
      
      .rating-dashboard-close:hover {
        background: var(--bg-hover, #333);
        color: var(--text-primary, #fff);
      }
      
      .rating-dashboard-content {
        flex: 1;
        overflow-y: auto;
        padding: 20px;
      }
      
      /* Overall Score Section */
      .rating-overall-section {
        text-align: center;
        padding: 24px;
        background: var(--bg-secondary, #252540);
        border-radius: 12px;
        margin-bottom: 24px;
      }
      
      .rating-score-display {
        position: relative;
        width: 120px;
        height: 120px;
        margin: 0 auto 16px;
      }
      
      .rating-score-circle {
        width: 100%;
        height: 100%;
        transform: rotate(-90deg);
      }
      
      .rating-score-track {
        fill: none;
        stroke: var(--bg-primary, #1a1a2e);
        stroke-width: 8;
      }
      
      .rating-score-progress {
        fill: none;
        stroke-width: 8;
        stroke-linecap: round;
        transition: stroke-dashoffset 0.5s ease;
      }
      
      .rating-score-value {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        font-size: 32px;
        font-weight: bold;
        color: var(--text-primary, #fff);
      }
      
      .rating-score-max {
        font-size: 14px;
        color: var(--text-secondary, #888);
      }
      
      .rating-trend {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        font-size: 14px;
      }
      
      .trend-up {
        color: #10b981;
      }
      
      .trend-down {
        color: #ef4444;
      }
      
      .trend-flat {
        color: var(--text-secondary, #888);
      }
      
      .rating-grade {
        margin-top: 8px;
        font-size: 14px;
        color: var(--text-secondary, #888);
      }
      
      /* Criteria Breakdown */
      .rating-criteria-section {
        margin-bottom: 24px;
      }
      
      .rating-section-title {
        font-size: 14px;
        font-weight: 600;
        color: var(--text-primary, #fff);
        margin-bottom: 12px;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      
      .rating-criteria-list {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      
      .rating-criterion {
        background: var(--bg-secondary, #252540);
        border-radius: 8px;
        padding: 12px 16px;
      }
      
      .criterion-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 8px;
      }
      
      .criterion-name {
        font-weight: 500;
        color: var(--text-primary, #fff);
        display: flex;
        align-items: center;
        gap: 6px;
      }
      
      .criterion-score {
        font-weight: bold;
        color: var(--text-primary, #fff);
      }
      
      .criterion-bar {
        height: 6px;
        background: var(--bg-primary, #1a1a2e);
        border-radius: 3px;
        overflow: hidden;
      }
      
      .criterion-bar-fill {
        height: 100%;
        border-radius: 3px;
        transition: width 0.5s ease;
      }
      
      .criterion-description {
        font-size: 12px;
        color: var(--text-secondary, #888);
        margin-top: 6px;
      }
      
      /* Improvements Section */
      .rating-improvements-section {
        margin-bottom: 24px;
      }
      
      .improvement-item {
        display: flex;
        gap: 12px;
        padding: 12px;
        background: var(--bg-secondary, #252540);
        border-radius: 8px;
        margin-bottom: 8px;
        border-left: 3px solid;
      }
      
      .improvement-item.immediate {
        border-color: #ef4444;
      }
      
      .improvement-item.content {
        border-color: #f59e0b;
      }
      
      .improvement-item.next-time {
        border-color: #3b82f6;
      }
      
      .improvement-icon {
        font-size: 20px;
      }
      
      .improvement-content {
        flex: 1;
      }
      
      .improvement-title {
        font-weight: 500;
        color: var(--text-primary, #fff);
        margin-bottom: 4px;
      }
      
      .improvement-description {
        font-size: 13px;
        color: var(--text-secondary, #888);
        line-height: 1.4;
      }
      
      .improvement-type-badge {
        font-size: 10px;
        padding: 2px 8px;
        border-radius: 4px;
        text-transform: uppercase;
        margin-bottom: 4px;
        display: inline-block;
      }
      
      .improvement-type-badge.immediate {
        background: rgba(239, 68, 68, 0.2);
        color: #ef4444;
      }
      
      .improvement-type-badge.content {
        background: rgba(245, 158, 11, 0.2);
        color: #f59e0b;
      }
      
      .improvement-type-badge.next-time {
        background: rgba(59, 130, 246, 0.2);
        color: #3b82f6;
      }
      
      /* History Section */
      .rating-history-section {
        margin-bottom: 24px;
      }
      
      .history-chart {
        height: 100px;
        background: var(--bg-secondary, #252540);
        border-radius: 8px;
        padding: 16px;
        position: relative;
      }
      
      .history-chart-bars {
        display: flex;
        align-items: flex-end;
        height: 100%;
        gap: 8px;
      }
      
      .history-bar {
        flex: 1;
        min-width: 30px;
        border-radius: 4px 4px 0 0;
        position: relative;
        transition: height 0.3s ease;
      }
      
      .history-bar.current {
        border: 2px solid white;
      }
      
      .history-bar-label {
        position: absolute;
        bottom: -20px;
        left: 50%;
        transform: translateX(-50%);
        font-size: 10px;
        color: var(--text-secondary, #888);
        white-space: nowrap;
      }
      
      .history-bar-score {
        position: absolute;
        top: -16px;
        left: 50%;
        transform: translateX(-50%);
        font-size: 11px;
        font-weight: bold;
        color: var(--text-primary, #fff);
      }
      
      .history-empty {
        text-align: center;
        padding: 24px;
        color: var(--text-secondary, #888);
      }
      
      /* Footer */
      .rating-dashboard-footer {
        padding: 16px 20px;
        border-top: 1px solid var(--border-color, #333);
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      
      .rating-footer-actions {
        display: flex;
        gap: 12px;
      }
      
      .rating-btn {
        padding: 8px 16px;
        border-radius: 6px;
        font-size: 13px;
        cursor: pointer;
        transition: background 0.2s;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      
      .rating-btn-secondary {
        background: var(--bg-secondary, #252540);
        border: 1px solid var(--border-color, #333);
        color: var(--text-primary, #fff);
      }
      
      .rating-btn-primary {
        background: var(--accent-color, #4a9eff);
        border: none;
        color: white;
      }
      
      .rating-btn:hover {
        opacity: 0.9;
      }
      
      /* Empty state */
      .rating-empty {
        text-align: center;
        padding: 48px;
        color: var(--text-secondary, #888);
      }
      
      .rating-empty-icon {
        font-size: 48px;
        margin-bottom: 16px;
        opacity: 0.5;
      }
    `;
    document.head.appendChild(styles);
  }

  /**
   * Setup event listeners
   */
  _setupEventListeners() {
    // Close on backdrop click
    this.panelElement?.addEventListener('click', (e) => {
      if (e.target === this.panelElement) {
        this.hide();
      }
    });
    
    // Escape to close
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isVisible) {
        this.hide();
      }
    });
  }

  /**
   * Show the dashboard
   * @param {Object} rating - Rating data to display
   * @param {Array} history - Historical ratings
   */
  show(rating = null, history = []) {
    this.currentRating = rating || this.app.projectRating?.currentRating;
    this.history = history;
    
    // Load history if not provided
    if (history.length === 0 && this.app.projectRating?.storage) {
      this._loadHistory();
    }
    
    this.render();
    
    this.panelElement.classList.add('visible');
    this.isVisible = true;
  }

  /**
   * Hide the dashboard
   */
  hide() {
    this.panelElement.classList.remove('visible');
    this.isVisible = false;
  }

  /**
   * Load rating history
   */
  async _loadHistory() {
    try {
      const templateId = this.currentRating?.templateId || 'generic';
      this.history = await this.app.projectRating?.getProjectHistory?.(templateId) || [];
    } catch (error) {
      console.error('[RatingDashboard] Failed to load history:', error);
      this.history = [];
    }
  }

  /**
   * Render the dashboard
   */
  render() {
    if (!this.panelElement) return;
    
    if (!this.currentRating) {
      this.panelElement.innerHTML = this._renderEmptyState();
      return;
    }
    
    const { overallScore, criteriaScores, trend, improvements, nextTime, projectName } = this.currentRating;
    
    this.panelElement.innerHTML = `
      <div class="rating-dashboard">
        <div class="rating-dashboard-header">
          <div class="rating-dashboard-title">
            📊 Project Rating: ${this._escapeHtml(projectName || 'Untitled')}
          </div>
          <button class="rating-dashboard-close" onclick="app.ratingDashboard?.hide()">&times;</button>
        </div>
        
        <div class="rating-dashboard-content">
          ${this._renderOverallScore(overallScore, trend)}
          ${this._renderCriteriaBreakdown(criteriaScores)}
          ${this._renderImprovements(improvements, nextTime)}
          ${this._renderHistory()}
        </div>
        
        <div class="rating-dashboard-footer">
          <div class="rating-date">
            Rated: ${new Date(this.currentRating.ratedAt).toLocaleString()}
          </div>
          <div class="rating-footer-actions">
            <button class="rating-btn rating-btn-secondary" onclick="app.ratingDashboard?.exportRating()">
              📤 Export
            </button>
            <button class="rating-btn rating-btn-secondary" onclick="app.ratingDashboard?.hide()">
              Close
            </button>
            <button class="rating-btn rating-btn-primary" onclick="app.ratingDashboard?.reRate()">
              🔄 Re-rate
            </button>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Render empty state
   */
  _renderEmptyState() {
    return `
      <div class="rating-dashboard">
        <div class="rating-dashboard-header">
          <div class="rating-dashboard-title">📊 Project Rating</div>
          <button class="rating-dashboard-close" onclick="app.ratingDashboard?.hide()">&times;</button>
        </div>
        
        <div class="rating-empty">
          <div class="rating-empty-icon">📊</div>
          <div>No rating available</div>
          <div style="margin-top: 8px;">Rate your project to see insights and improvements</div>
          <button class="rating-btn rating-btn-primary" style="margin-top: 16px;" onclick="app.projectRating?.openRatingModal?.()">
            Rate Project
          </button>
        </div>
      </div>
    `;
  }

  /**
   * Render overall score section
   */
  _renderOverallScore(score, trend) {
    const scoreColor = this._getScoreColor(score);
    const circumference = 2 * Math.PI * 54; // r=54
    const progress = (score / 10) * circumference;
    const dashoffset = circumference - progress;
    
    const trendIcon = trend > 0 ? '↑' : trend < 0 ? '↓' : '→';
    const trendClass = trend > 0 ? 'trend-up' : trend < 0 ? 'trend-down' : 'trend-flat';
    const trendText = trend !== 0 ? `${Math.abs(trend).toFixed(1)} from last` : 'No change';
    
    const grade = this._scoreToGrade(score);
    
    return `
      <div class="rating-overall-section">
        <div class="rating-score-display">
          <svg class="rating-score-circle" viewBox="0 0 120 120">
            <circle class="rating-score-track" cx="60" cy="60" r="54" />
            <circle class="rating-score-progress" cx="60" cy="60" r="54"
                    stroke="${scoreColor}"
                    stroke-dasharray="${circumference}"
                    stroke-dashoffset="${dashoffset}" />
          </svg>
          <div class="rating-score-value">
            ${score.toFixed(1)}<span class="rating-score-max">/10</span>
          </div>
        </div>
        
        <div class="rating-trend ${trendClass}">
          <span>${trendIcon}</span>
          <span>${trendText}</span>
        </div>
        
        <div class="rating-grade">Grade: ${grade}</div>
      </div>
    `;
  }

  /**
   * Render criteria breakdown
   */
  _renderCriteriaBreakdown(criteriaScores) {
    if (!criteriaScores || criteriaScores.length === 0) {
      return '';
    }
    
    return `
      <div class="rating-criteria-section">
        <div class="rating-section-title">
          <span>📋</span>
          <span>Score Breakdown</span>
        </div>
        
        <div class="rating-criteria-list">
          ${criteriaScores.map(criterion => {
            const scoreColor = this._getScoreColor(criterion.score);
            const percentage = (criterion.score / 10) * 100;
            
            return `
              <div class="rating-criterion">
                <div class="criterion-header">
                  <span class="criterion-name">
                    <span>${criterion.icon || '📌'}</span>
                    <span>${this._escapeHtml(criterion.name)}</span>
                  </span>
                  <span class="criterion-score" style="color: ${scoreColor}">${criterion.score.toFixed(1)}</span>
                </div>
                <div class="criterion-bar">
                  <div class="criterion-bar-fill" style="width: ${percentage}%; background: ${scoreColor}"></div>
                </div>
                ${criterion.description ? `
                  <div class="criterion-description">${this._escapeHtml(criterion.description)}</div>
                ` : ''}
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  /**
   * Render improvements section
   */
  _renderImprovements(improvements = [], nextTime = []) {
    if ((!improvements || improvements.length === 0) && (!nextTime || nextTime.length === 0)) {
      return '';
    }
    
    const allItems = [
      ...(improvements || []).map(i => ({ ...i, category: i.type || 'content' })),
      ...(nextTime || []).map(n => ({ ...n, category: 'next-time' }))
    ];
    
    return `
      <div class="rating-improvements-section">
        <div class="rating-section-title">
          <span>💡</span>
          <span>Suggestions & Improvements</span>
        </div>
        
        ${allItems.map(item => `
          <div class="improvement-item ${item.category}">
            <div class="improvement-icon">${this._getImprovementIcon(item.category)}</div>
            <div class="improvement-content">
              <span class="improvement-type-badge ${item.category}">${this._getImprovementLabel(item.category)}</span>
              <div class="improvement-title">${this._escapeHtml(item.title || item.criterion || 'Improvement')}</div>
              <div class="improvement-description">${this._escapeHtml(item.suggestion || item.description || '')}</div>
            </div>
          </div>
        `).join('')}
      </div>
    `;
  }

  /**
   * Render history chart
   */
  _renderHistory() {
    if (!this.history || this.history.length === 0) {
      return '';
    }
    
    // Get last 8 ratings
    const recentHistory = this.history.slice(-8);
    const maxScore = 10;
    
    return `
      <div class="rating-history-section">
        <div class="rating-section-title">
          <span>📈</span>
          <span>Rating History</span>
        </div>
        
        <div class="history-chart">
          <div class="history-chart-bars">
            ${recentHistory.map((item, index) => {
              const height = (item.overallScore / maxScore) * 100;
              const color = this._getScoreColor(item.overallScore);
              const isCurrent = index === recentHistory.length - 1 && 
                               item.projectId === this.currentRating?.projectId;
              
              return `
                <div class="history-bar ${isCurrent ? 'current' : ''}"
                     style="height: ${height}%; background: ${color};"
                     title="${item.projectName}: ${item.overallScore.toFixed(1)}">
                  <span class="history-bar-score">${item.overallScore.toFixed(1)}</span>
                  <span class="history-bar-label">${this._formatDate(item.ratedAt)}</span>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Get color for score
   */
  _getScoreColor(score) {
    if (score >= 8) return '#10b981';      // Green - Excellent
    if (score >= 6) return '#f59e0b';      // Yellow - Good
    if (score >= 4) return '#f97316';      // Orange - Needs work
    return '#ef4444';                       // Red - Poor
  }

  /**
   * Convert score to letter grade
   */
  _scoreToGrade(score) {
    if (score >= 9.5) return 'A+';
    if (score >= 9) return 'A';
    if (score >= 8.5) return 'A-';
    if (score >= 8) return 'B+';
    if (score >= 7.5) return 'B';
    if (score >= 7) return 'B-';
    if (score >= 6.5) return 'C+';
    if (score >= 6) return 'C';
    if (score >= 5.5) return 'C-';
    if (score >= 5) return 'D+';
    if (score >= 4.5) return 'D';
    if (score >= 4) return 'D-';
    return 'F';
  }

  /**
   * Get improvement icon
   */
  _getImprovementIcon(category) {
    switch (category) {
      case 'immediate': return '🚨';
      case 'content': return '✏️';
      case 'next-time': return '💡';
      default: return '📌';
    }
  }

  /**
   * Get improvement label
   */
  _getImprovementLabel(category) {
    switch (category) {
      case 'immediate': return 'Fix Now';
      case 'content': return 'Content';
      case 'next-time': return 'Next Time';
      default: return 'Suggestion';
    }
  }

  /**
   * Format date for display
   */
  _formatDate(dateString) {
    const date = new Date(dateString);
    return `${date.getMonth() + 1}/${date.getDate()}`;
  }

  /**
   * Export rating to JSON/PDF
   */
  exportRating() {
    if (!this.currentRating) {
      this.app.showToast?.('error', 'No rating to export');
      return;
    }
    
    const json = JSON.stringify(this.currentRating, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `rating_${this.currentRating.projectName || 'project'}_${Date.now()}.json`;
    a.click();
    
    URL.revokeObjectURL(url);
    this.app.showToast?.('success', 'Rating exported');
  }

  /**
   * Re-rate the project
   */
  async reRate() {
    this.hide();
    
    // Open rating modal
    if (this.app.projectRating?.openRatingModal) {
      await this.app.projectRating.openRatingModal();
    } else {
      this.app.showToast?.('info', 'Rating system not available');
    }
  }

  /**
   * Escape HTML
   */
  _escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
  }
}

export default RatingDashboard;











