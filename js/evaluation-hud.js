/**
 * Evaluation HUD Component
 * Part of the Governed Self-Improving Agent Runtime
 * 
 * Multi-agent evaluation panel with epistemic framing
 * 
 * @version 2.0.0 - Added learning visibility, weighting selector, A/B comparison
 */

(function() {
  'use strict';

  const EVAL_HUD_VERSION = '2.0.0';

  /**
   * EvaluationHUD Class
   * Creates and manages the evaluation HUD panel
   */
  class EvaluationHUD {
    constructor(options = {}) {
      this.version = EVAL_HUD_VERSION;
      this.container = null;
      this.isVisible = false;
      this.isMinimized = false;
      this.currentEvaluation = null;
      this.position = options.position || { bottom: 20, right: 340 };
      this.previouslyFocusedElement = null;
      
      // Learning state
      this.learningSummary = null;
      this.isLearningPanelExpanded = localStorage.getItem('eval.showLearningPanel') !== 'false';
      this.weightingMode = localStorage.getItem('eval.weightingMode') || 'contextual';
      this.selectedProfile = localStorage.getItem('eval.profile') || 'standard';
      
      console.log(`[EvaluationHUD] v${EVAL_HUD_VERSION} initializing...`);
      this.init();
    }

    /**
     * Initialize the HUD
     */
    init() {
      this.createStyles();
      this.createContainer();
      this.setupEventListeners();
      this.setupLiveRegion();
    }

    /**
     * Create live region for screen reader announcements
     */
    setupLiveRegion() {
      if (document.getElementById('eval-hud-live')) return;
      
      const liveRegion = document.createElement('div');
      liveRegion.id = 'eval-hud-live';
      liveRegion.setAttribute('role', 'status');
      liveRegion.setAttribute('aria-live', 'polite');
      liveRegion.setAttribute('aria-atomic', 'true');
      liveRegion.className = 'sr-only';
      document.body.appendChild(liveRegion);
    }

    /**
     * Announce to screen readers
     */
    announce(message) {
      const liveRegion = document.getElementById('eval-hud-live');
      if (liveRegion) {
        liveRegion.textContent = '';
        setTimeout(() => {
          liveRegion.textContent = message;
        }, 100);
      }
    }

    /**
     * Create HUD styles
     */
    createStyles() {
      if (document.getElementById('eval-hud-styles')) return;
      
      const styles = document.createElement('style');
      styles.id = 'eval-hud-styles';
      styles.textContent = `
        /* Screen reader only utility */
        .sr-only {
          position: absolute;
          width: 1px;
          height: 1px;
          padding: 0;
          margin: -1px;
          overflow: hidden;
          clip: rect(0, 0, 0, 0);
          white-space: nowrap;
          border: 0;
        }
        
        .eval-hud {
          position: fixed;
          bottom: ${this.position.bottom}px;
          right: ${this.position.right}px;
          width: 360px;
          max-height: 500px;
          background: linear-gradient(165deg, rgba(28, 28, 38, 0.95) 0%, rgba(18, 18, 26, 0.98) 100%);
          backdrop-filter: blur(20px);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 16px;
          box-shadow: 
            0 8px 32px rgba(0, 0, 0, 0.3),
            inset 0 1px 0 rgba(255, 255, 255, 0.1);
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          color: #e0e0e0;
          overflow: hidden;
          z-index: 9998;
          transition: all 0.3s ease;
        }
        
        .eval-hud:focus {
          outline: 2px solid #6366f1;
          outline-offset: 2px;
        }
        
        .eval-hud.hidden {
          opacity: 0;
          pointer-events: none;
          transform: translateY(20px);
        }
        
        .eval-hud.minimized {
          width: 200px;
          max-height: 44px;
        }
        
        /* Responsive styles */
        @media (max-width: 768px) {
          .eval-hud {
            width: 320px;
            right: 16px;
            bottom: 16px;
          }
        }
        
        @media (max-width: 480px) {
          .eval-hud {
            width: 100%;
            right: 0;
            bottom: 0;
            border-radius: 16px 16px 0 0;
            max-height: 60vh;
          }
          
          .eval-hud.minimized {
            width: 100%;
            max-height: 44px;
          }
        }
        
        .eval-hud-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 12px 16px;
          background: rgba(255, 255, 255, 0.03);
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
          cursor: move;
        }
        
        .eval-hud-title {
          display: flex;
          align-items: center;
          gap: 8px;
          font-weight: 600;
          font-size: 13px;
          color: #fff;
        }
        
        .eval-hud-title-icon {
          font-size: 16px;
        }
        
        .eval-hud-controls {
          display: flex;
          gap: 8px;
        }
        
        .eval-hud-btn {
          width: 24px;
          height: 24px;
          border: none;
          background: rgba(255, 255, 255, 0.1);
          border-radius: 6px;
          color: #aaa;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 0.2s;
        }
        
        .eval-hud-btn:hover {
          background: rgba(255, 255, 255, 0.2);
          color: #fff;
        }
        
        .eval-hud-btn:focus {
          outline: 2px solid #6366f1;
          outline-offset: 1px;
        }
        
        .eval-hud-content {
          padding: 12px 16px;
          max-height: 400px;
          overflow-y: auto;
        }
        
        .eval-hud.minimized .eval-hud-content {
          display: none;
        }
        
        /* Loading state */
        .eval-loading {
          padding: 20px;
          text-align: center;
        }
        
        .eval-loading-spinner {
          display: inline-block;
          width: 32px;
          height: 32px;
          border: 3px solid rgba(99, 102, 241, 0.2);
          border-top-color: #6366f1;
          border-radius: 50%;
          animation: eval-spin 0.8s linear infinite;
          margin-bottom: 12px;
        }
        
        @keyframes eval-spin {
          to { transform: rotate(360deg); }
        }
        
        .eval-loading-text {
          font-size: 13px;
          color: #a0a0a0;
          margin-bottom: 8px;
        }
        
        .eval-loading-agents {
          font-size: 11px;
          color: #666;
        }
        
        /* Loading skeleton */
        .eval-skeleton {
          animation: eval-shimmer 1.5s infinite;
          background: linear-gradient(
            90deg,
            rgba(255, 255, 255, 0.03) 0%,
            rgba(255, 255, 255, 0.08) 50%,
            rgba(255, 255, 255, 0.03) 100%
          );
          background-size: 200% 100%;
          border-radius: 8px;
        }
        
        @keyframes eval-shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
        
        .eval-skeleton-score {
          width: 64px;
          height: 64px;
          border-radius: 50%;
          margin-bottom: 12px;
        }
        
        .eval-skeleton-text {
          height: 14px;
          margin-bottom: 8px;
        }
        
        .eval-skeleton-text.short { width: 60%; }
        .eval-skeleton-text.medium { width: 80%; }
        .eval-skeleton-text.full { width: 100%; }
        
        .eval-skeleton-card {
          width: 70px;
          height: 70px;
          border-radius: 8px;
        }
        
        /* Error state */
        .eval-error {
          padding: 20px;
          text-align: center;
        }
        
        .eval-error-icon {
          font-size: 32px;
          margin-bottom: 8px;
        }
        
        .eval-error-title {
          font-size: 14px;
          font-weight: 600;
          color: #ef4444;
          margin-bottom: 4px;
        }
        
        .eval-error-message {
          font-size: 12px;
          color: #a0a0a0;
          margin-bottom: 16px;
        }
        
        .eval-error-retry {
          padding: 8px 16px;
          background: rgba(239, 68, 68, 0.15);
          border: 1px solid rgba(239, 68, 68, 0.3);
          border-radius: 8px;
          color: #ef4444;
          font-size: 12px;
          cursor: pointer;
          transition: all 0.2s;
        }
        
        .eval-error-retry:hover {
          background: rgba(239, 68, 68, 0.25);
        }
        
        .eval-error-retry:focus {
          outline: 2px solid #ef4444;
          outline-offset: 2px;
        }
        
        .eval-error-dismiss {
          display: block;
          margin-top: 8px;
          padding: 4px;
          background: none;
          border: none;
          color: #666;
          font-size: 11px;
          cursor: pointer;
        }
        
        .eval-error-dismiss:hover {
          color: #a0a0a0;
        }
        
        /* Score Display */
        .eval-score-container {
          display: flex;
          align-items: center;
          gap: 16px;
          margin-bottom: 16px;
          padding: 12px;
          background: rgba(255, 255, 255, 0.03);
          border-radius: 12px;
          animation: eval-pulse 0.5s ease-out;
        }
        
        @keyframes eval-pulse {
          0% { transform: scale(0.98); opacity: 0.8; }
          50% { transform: scale(1.01); }
          100% { transform: scale(1); opacity: 1; }
        }
        
        .eval-score-circle {
          width: 64px;
          height: 64px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 20px;
          font-weight: 700;
        }
        
        .eval-score-circle.high { background: linear-gradient(135deg, #22c55e, #16a34a); color: #fff; }
        .eval-score-circle.medium { background: linear-gradient(135deg, #eab308, #ca8a04); color: #000; }
        .eval-score-circle.low { background: linear-gradient(135deg, #ef4444, #dc2626); color: #fff; }
        
        .eval-score-meta {
          flex: 1;
        }
        
        .eval-confidence {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 12px;
          color: #a0a0a0;
          margin-bottom: 4px;
        }
        
        .eval-confidence-badge {
          padding: 2px 8px;
          border-radius: 10px;
          font-size: 10px;
          font-weight: 600;
          text-transform: uppercase;
        }
        
        .eval-confidence-badge.high { background: rgba(34, 197, 94, 0.2); color: #22c55e; }
        .eval-confidence-badge.medium { background: rgba(234, 179, 8, 0.2); color: #eab308; }
        .eval-confidence-badge.low { background: rgba(239, 68, 68, 0.2); color: #ef4444; }
        
        /* Rationale */
        .eval-rationale {
          font-size: 12px;
          color: #b0b0b0;
          line-height: 1.5;
          margin-bottom: 16px;
          padding: 10px;
          background: rgba(100, 100, 255, 0.05);
          border-left: 3px solid rgba(100, 100, 255, 0.3);
          border-radius: 0 8px 8px 0;
        }
        
        /* Agent Cards */
        .eval-agents-title {
          font-size: 11px;
          font-weight: 600;
          text-transform: uppercase;
          color: #808080;
          margin-bottom: 8px;
          letter-spacing: 0.5px;
        }
        
        .eval-agents-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(70px, 1fr));
          gap: 8px;
          margin-bottom: 16px;
        }
        
        .eval-agent-card {
          display: flex;
          flex-direction: column;
          align-items: center;
          padding: 8px;
          background: rgba(255, 255, 255, 0.03);
          border-radius: 8px;
          border: 1px solid rgba(255, 255, 255, 0.05);
          transition: all 0.2s;
          cursor: pointer;
          opacity: 0;
          animation: eval-card-in 0.3s ease forwards;
        }
        
        .eval-agent-card:nth-child(1) { animation-delay: 0ms; }
        .eval-agent-card:nth-child(2) { animation-delay: 50ms; }
        .eval-agent-card:nth-child(3) { animation-delay: 100ms; }
        .eval-agent-card:nth-child(4) { animation-delay: 150ms; }
        .eval-agent-card:nth-child(5) { animation-delay: 200ms; }
        .eval-agent-card:nth-child(6) { animation-delay: 250ms; }
        
        @keyframes eval-card-in {
          from {
            opacity: 0;
            transform: translateY(8px) scale(0.95);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }
        
        .eval-agent-card:hover {
          background: rgba(255, 255, 255, 0.08);
          border-color: rgba(255, 255, 255, 0.15);
        }
        
        .eval-agent-card:focus {
          outline: 2px solid #6366f1;
          outline-offset: 1px;
        }
        
        .eval-agent-card.best {
          border-color: rgba(34, 197, 94, 0.3);
          background: rgba(34, 197, 94, 0.1);
        }
        
        .eval-agent-card.concern {
          border-color: rgba(239, 68, 68, 0.3);
          background: rgba(239, 68, 68, 0.1);
        }
        
        .eval-agent-icon {
          font-size: 20px;
          margin-bottom: 4px;
        }
        
        .eval-agent-score {
          font-size: 14px;
          font-weight: 600;
        }
        
        .eval-agent-type {
          font-size: 9px;
          color: #a0a0a0;
          text-transform: capitalize;
        }
        
        /* Primary Drivers */
        .eval-drivers {
          margin-bottom: 16px;
        }
        
        .eval-driver-tag {
          display: inline-block;
          padding: 3px 8px;
          margin: 2px;
          background: rgba(100, 100, 255, 0.15);
          border-radius: 10px;
          font-size: 11px;
          color: #8888ff;
        }
        
        /* Conflicts Section */
        .eval-conflicts {
          margin-bottom: 16px;
        }
        
        .eval-conflict-item {
          padding: 8px 10px;
          background: rgba(239, 68, 68, 0.1);
          border-left: 3px solid rgba(239, 68, 68, 0.5);
          border-radius: 0 8px 8px 0;
          margin-bottom: 6px;
          font-size: 11px;
        }
        
        .eval-conflict-item.resolved {
          background: rgba(34, 197, 94, 0.1);
          border-left-color: rgba(34, 197, 94, 0.5);
        }
        
        .eval-conflict-criterion {
          font-weight: 600;
          color: #ef4444;
          margin-bottom: 2px;
        }
        
        .eval-conflict-item.resolved .eval-conflict-criterion {
          color: #22c55e;
        }
        
        .eval-conflict-agents {
          color: #a0a0a0;
        }
        
        .eval-conflict-resolution {
          margin-top: 4px;
          padding-top: 4px;
          border-top: 1px solid rgba(255, 255, 255, 0.05);
          color: #b0b0b0;
        }
        
        .eval-conflict-learned {
          display: inline-block;
          padding: 2px 6px;
          background: rgba(34, 197, 94, 0.2);
          border-radius: 8px;
          font-size: 10px;
          color: #22c55e;
          margin-left: 4px;
        }
        
        .eval-conflict-actions {
          display: flex;
          gap: 6px;
          margin-top: 8px;
        }
        
        .eval-conflict-btn {
          flex: 1;
          padding: 6px 8px;
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 6px;
          background: rgba(255, 255, 255, 0.05);
          color: #ccc;
          font-size: 10px;
          cursor: pointer;
          transition: all 0.2s;
        }
        
        .eval-conflict-btn:hover {
          background: rgba(255, 255, 255, 0.1);
          border-color: rgba(255, 255, 255, 0.2);
        }
        
        .eval-conflict-btn:focus {
          outline: 2px solid #6366f1;
          outline-offset: 1px;
        }
        
        .eval-conflict-btn.accept-high {
          border-color: rgba(34, 197, 94, 0.3);
        }
        
        .eval-conflict-btn.accept-high:hover {
          background: rgba(34, 197, 94, 0.15);
          border-color: rgba(34, 197, 94, 0.5);
        }
        
        .eval-conflict-btn.accept-low {
          border-color: rgba(234, 179, 8, 0.3);
        }
        
        .eval-conflict-btn.accept-low:hover {
          background: rgba(234, 179, 8, 0.15);
          border-color: rgba(234, 179, 8, 0.5);
        }
        
        /* Suggestions */
        .eval-suggestions {
          margin-bottom: 12px;
        }
        
        .eval-suggestion-item {
          display: flex;
          align-items: flex-start;
          gap: 8px;
          padding: 8px;
          background: rgba(255, 255, 255, 0.03);
          border-radius: 8px;
          margin-bottom: 6px;
          font-size: 12px;
        }
        
        .eval-suggestion-priority {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          margin-top: 5px;
          flex-shrink: 0;
        }
        
        .eval-suggestion-priority.high { background: #ef4444; }
        .eval-suggestion-priority.medium { background: #eab308; }
        .eval-suggestion-priority.low { background: #22c55e; }
        
        .eval-suggestion-text {
          flex: 1;
          color: #ccc;
        }
        
        .eval-suggestion-agents {
          font-size: 10px;
          color: #808080;
          margin-top: 2px;
        }
        
        .eval-suggestion-apply {
          padding: 4px 10px;
          background: rgba(100, 100, 255, 0.2);
          border: none;
          border-radius: 6px;
          color: #8888ff;
          cursor: pointer;
          font-size: 11px;
          transition: all 0.2s;
        }
        
        .eval-suggestion-apply:hover {
          background: rgba(100, 100, 255, 0.4);
        }
        
        .eval-suggestion-apply:focus {
          outline: 2px solid #6366f1;
          outline-offset: 1px;
        }
        
        /* Weighting Mode */
        .eval-weighting {
          font-size: 10px;
          color: #808080;
          text-align: center;
          padding: 8px;
          background: rgba(255, 255, 255, 0.02);
          border-radius: 8px;
          margin-top: 8px;
        }
        
        /* Empty State */
        .eval-empty {
          text-align: center;
          padding: 32px 24px;
          color: #808080;
        }
        
        .eval-empty-icon {
          font-size: 48px;
          margin-bottom: 12px;
          opacity: 0.6;
        }
        
        .eval-empty-title {
          font-size: 14px;
          font-weight: 600;
          color: #a0a0a0;
          margin-bottom: 4px;
        }
        
        .eval-empty-text {
          font-size: 12px;
          color: #666;
          margin-bottom: 16px;
          line-height: 1.4;
        }
        
        .eval-empty-cta {
          padding: 10px 20px;
          background: #6366f1;
          border: none;
          border-radius: 8px;
          color: #fff;
          font-size: 13px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s;
        }
        
        .eval-empty-cta:hover {
          background: #5558dd;
          transform: translateY(-1px);
        }
        
        .eval-empty-cta:focus {
          outline: 2px solid #6366f1;
          outline-offset: 2px;
        }
        
        .eval-empty-cta:active {
          transform: translateY(0);
        }
        
        /* Learning Status Badge */
        .eval-learning-badge {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 4px 10px;
          background: rgba(139, 92, 246, 0.15);
          border-radius: 12px;
          font-size: 10px;
          color: #a78bfa;
          margin-left: 8px;
        }
        
        .eval-learning-badge.active {
          background: rgba(34, 197, 94, 0.15);
          color: #22c55e;
        }
        
        .eval-learning-badge.inactive {
          background: rgba(255, 255, 255, 0.05);
          color: #808080;
        }
        
        .eval-learning-trend {
          font-size: 12px;
        }
        
        /* Weighting Mode Selector */
        .eval-weighting-select {
          padding: 4px 8px;
          background: rgba(255, 255, 255, 0.08);
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 6px;
          color: #e0e0e0;
          font-size: 10px;
          cursor: pointer;
          outline: none;
          transition: all 0.2s;
        }
        
        .eval-weighting-select:hover {
          background: rgba(255, 255, 255, 0.12);
          border-color: rgba(255, 255, 255, 0.2);
        }
        
        .eval-weighting-select:focus {
          border-color: #6366f1;
          box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.2);
        }
        
        .eval-weighting-select option {
          background: #1a1a2e;
          color: #e0e0e0;
        }
        
        /* Header Controls Row */
        .eval-hud-header-row {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
        }
        
        /* Learning Dashboard Panel */
        .eval-learning-panel {
          margin: 12px 0;
          background: rgba(139, 92, 246, 0.05);
          border: 1px solid rgba(139, 92, 246, 0.15);
          border-radius: 10px;
          overflow: hidden;
        }
        
        .eval-learning-panel-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 10px 12px;
          background: rgba(255, 255, 255, 0.02);
          cursor: pointer;
          transition: background 0.2s;
        }
        
        .eval-learning-panel-header:hover {
          background: rgba(255, 255, 255, 0.04);
        }
        
        .eval-learning-panel-header:focus {
          outline: 2px solid #6366f1;
          outline-offset: -2px;
        }
        
        .eval-learning-panel-title {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 12px;
          font-weight: 600;
          color: #a78bfa;
        }
        
        .eval-learning-panel-toggle {
          font-size: 12px;
          color: #808080;
          transition: transform 0.2s;
        }
        
        .eval-learning-panel.collapsed .eval-learning-panel-toggle {
          transform: rotate(-90deg);
        }
        
        .eval-learning-panel-content {
          padding: 12px;
          border-top: 1px solid rgba(139, 92, 246, 0.1);
        }
        
        .eval-learning-panel.collapsed .eval-learning-panel-content {
          display: none;
        }
        
        .eval-learning-stat {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 8px;
          font-size: 11px;
        }
        
        .eval-learning-stat-label {
          color: #a0a0a0;
        }
        
        .eval-learning-stat-value {
          font-weight: 600;
          color: #e0e0e0;
        }
        
        .eval-learning-stat-value.active {
          color: #22c55e;
        }
        
        .eval-learning-stat-value.inactive {
          color: #eab308;
        }
        
        /* Agent Performance Table */
        .eval-agent-perf {
          margin-top: 12px;
        }
        
        .eval-agent-perf-title {
          font-size: 10px;
          font-weight: 600;
          text-transform: uppercase;
          color: #808080;
          margin-bottom: 8px;
          letter-spacing: 0.5px;
        }
        
        .eval-agent-perf-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 6px 8px;
          background: rgba(255, 255, 255, 0.03);
          border-radius: 6px;
          margin-bottom: 4px;
          font-size: 11px;
        }
        
        .eval-agent-perf-name {
          color: #e0e0e0;
          min-width: 70px;
        }
        
        .eval-agent-perf-accuracy {
          color: #a0a0a0;
          min-width: 50px;
          text-align: right;
        }
        
        .eval-agent-perf-trend {
          font-size: 12px;
          min-width: 20px;
          text-align: center;
        }
        
        .eval-agent-perf-trend.improving { color: #22c55e; }
        .eval-agent-perf-trend.declining { color: #ef4444; }
        .eval-agent-perf-trend.stable { color: #808080; }
        
        /* A/B Comparison View */
        .eval-ab-comparison {
          margin-top: 16px;
          padding-top: 12px;
          border-top: 1px solid rgba(139, 92, 246, 0.1);
        }
        
        .eval-ab-title {
          font-size: 10px;
          font-weight: 600;
          text-transform: uppercase;
          color: #808080;
          margin-bottom: 10px;
          letter-spacing: 0.5px;
        }
        
        .eval-ab-columns {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 12px;
        }
        
        .eval-ab-column {
          padding: 10px;
          background: rgba(255, 255, 255, 0.03);
          border-radius: 8px;
        }
        
        .eval-ab-column-title {
          font-size: 10px;
          font-weight: 600;
          color: #a0a0a0;
          margin-bottom: 8px;
        }
        
        .eval-ab-column.learned .eval-ab-column-title {
          color: #a78bfa;
        }
        
        .eval-ab-weight-row {
          display: flex;
          justify-content: space-between;
          font-size: 10px;
          margin-bottom: 4px;
        }
        
        .eval-ab-weight-name {
          color: #b0b0b0;
        }
        
        .eval-ab-weight-value {
          color: #e0e0e0;
        }
        
        .eval-ab-weight-diff {
          font-size: 9px;
          padding: 1px 4px;
          border-radius: 4px;
          margin-left: 4px;
        }
        
        .eval-ab-weight-diff.positive {
          background: rgba(34, 197, 94, 0.15);
          color: #22c55e;
        }
        
        .eval-ab-weight-diff.negative {
          background: rgba(239, 68, 68, 0.15);
          color: #ef4444;
        }
        
        .eval-ab-weight-diff.neutral {
          background: rgba(255, 255, 255, 0.05);
          color: #808080;
        }
        
        .eval-ab-prediction {
          margin-top: 12px;
          padding: 8px 10px;
          background: rgba(139, 92, 246, 0.1);
          border-radius: 6px;
          font-size: 11px;
          text-align: center;
          color: #c4b5fd;
        }
        
        .eval-ab-prediction-value {
          font-weight: 700;
          font-size: 14px;
        }
        
        .eval-ab-prediction-value.positive { color: #22c55e; }
        .eval-ab-prediction-value.negative { color: #ef4444; }
        
        /* Full Dashboard Button */
        .eval-dashboard-btn {
          display: block;
          width: 100%;
          margin-top: 12px;
          padding: 8px 12px;
          background: rgba(139, 92, 246, 0.15);
          border: 1px solid rgba(139, 92, 246, 0.25);
          border-radius: 6px;
          color: #a78bfa;
          font-size: 11px;
          text-align: center;
          cursor: pointer;
          transition: all 0.2s;
        }
        
        .eval-dashboard-btn:hover {
          background: rgba(139, 92, 246, 0.25);
          border-color: rgba(139, 92, 246, 0.4);
        }
        
        .eval-dashboard-btn:focus {
          outline: 2px solid #6366f1;
          outline-offset: 2px;
        }
      `;
      document.head.appendChild(styles);
    }

    /**
     * Create the HUD container
     */
    createContainer() {
      this.container = document.createElement('div');
      this.container.className = 'eval-hud hidden';
      this.container.setAttribute('role', 'dialog');
      this.container.setAttribute('aria-modal', 'false');
      this.container.setAttribute('aria-labelledby', 'eval-hud-title');
      this.container.setAttribute('tabindex', '-1');
      this.container.innerHTML = `
        <div class="eval-hud-header">
          <div class="eval-hud-header-row">
            <div class="eval-hud-title" id="eval-hud-title">
              <span class="eval-hud-title-icon" aria-hidden="true">🎯</span>
              <span>Evaluation</span>
              <span style="font-size: 9px; color: #666; margin-left: 4px;">v${EVAL_HUD_VERSION}</span>
            </div>
            <div class="eval-learning-badge inactive" id="eval-learning-badge" title="Learning status">
              <span>🧠</span>
              <span id="eval-learning-status">Learning: Inactive</span>
              <span class="eval-learning-trend" id="eval-learning-trend"></span>
            </div>
          </div>
          <div class="eval-hud-controls">
            <select class="eval-weighting-select" id="evalWeightingMode" title="Weighting mode" aria-label="Select weighting mode">
              <option value="contextual">Contextual</option>
              <option value="uniform">Uniform</option>
              <option value="learned">Learned</option>
              <option value="user_biased">Custom</option>
            </select>
            <button class="eval-hud-btn" data-action="minimize" title="Minimize" aria-label="Minimize evaluation panel">−</button>
            <button class="eval-hud-btn" data-action="close" title="Close" aria-label="Close evaluation panel">×</button>
          </div>
        </div>
        <div class="eval-hud-content" role="region" aria-label="Evaluation results">
          <div class="eval-empty">
            <div class="eval-empty-icon" aria-hidden="true">📋</div>
            <div class="eval-empty-title">No evaluation yet</div>
            <div class="eval-empty-text">Run an evaluation to see multi-agent analysis and suggestions for your document.</div>
            <button class="eval-empty-cta" data-action="run-eval">Run Evaluation</button>
          </div>
        </div>
      `;
      document.body.appendChild(this.container);
      
      // Set initial weighting mode from localStorage
      const select = this.container.querySelector('#evalWeightingMode');
      if (select) {
        select.value = this.weightingMode;
      }
      
      // Fetch and display initial learning status
      this.fetchLearningSummary();
    }

    /**
     * Set up event listeners
     */
    setupEventListeners() {
      // Control buttons
      this.container.querySelector('[data-action="minimize"]').addEventListener('click', () => {
        this.toggleMinimize();
      });
      
      this.container.querySelector('[data-action="close"]').addEventListener('click', () => {
        this.hide();
      });

      // Weighting mode selector
      this.container.querySelector('#evalWeightingMode').addEventListener('change', (e) => {
        this.weightingMode = e.target.value;
        localStorage.setItem('eval.weightingMode', this.weightingMode);
        
        // Dispatch event for parent to handle
        const event = new CustomEvent('eval:weighting-change', {
          detail: { mode: this.weightingMode }
        });
        document.dispatchEvent(event);
        
        this.announce(`Weighting mode changed to ${this.weightingMode}`);
      });

      // Run evaluation CTA
      this.container.addEventListener('click', (e) => {
        if (e.target.closest('[data-action="run-eval"]')) {
          const event = new CustomEvent('eval:run', { 
            bubbles: true,
            detail: { weightingMode: this.weightingMode }
          });
          document.dispatchEvent(event);
        }
      });

      // Keyboard navigation
      this.container.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          this.hide();
        }
        
        // Arrow key navigation for agent cards
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          const cards = Array.from(this.container.querySelectorAll('.eval-agent-card'));
          if (cards.length === 0) return;
          
          const currentIndex = cards.indexOf(document.activeElement);
          if (currentIndex === -1) return;
          
          let nextIndex;
          if (e.key === 'ArrowRight') {
            nextIndex = (currentIndex + 1) % cards.length;
          } else {
            nextIndex = (currentIndex - 1 + cards.length) % cards.length;
          }
          cards[nextIndex].focus();
          e.preventDefault();
        }
      });

      // Drag to reposition
      let isDragging = false;
      let startX, startY, startRight, startBottom;
      
      const header = this.container.querySelector('.eval-hud-header');
      
      header.addEventListener('mousedown', (e) => {
        if (e.target.closest('.eval-hud-btn')) return; // Don't drag from buttons
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        startRight = parseInt(this.container.style.right) || this.position.right;
        startBottom = parseInt(this.container.style.bottom) || this.position.bottom;
        this.container.style.transition = 'none';
      });

      document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const dx = startX - e.clientX;
        const dy = startY - e.clientY;
        this.container.style.right = (startRight + dx) + 'px';
        this.container.style.bottom = (startBottom + dy) + 'px';
      });

      document.addEventListener('mouseup', () => {
        isDragging = false;
        this.container.style.transition = '';
      });
    }

    /**
     * Show the HUD
     */
    show() {
      this.previouslyFocusedElement = document.activeElement;
      this.container.classList.remove('hidden');
      this.isVisible = true;
      this.container.focus();
    }

    /**
     * Hide the HUD
     */
    hide() {
      this.container.classList.add('hidden');
      this.isVisible = false;
      if (this.previouslyFocusedElement) {
        this.previouslyFocusedElement.focus();
      }
    }

    /**
     * Toggle minimize state
     */
    toggleMinimize() {
      this.isMinimized = !this.isMinimized;
      this.container.classList.toggle('minimized', this.isMinimized);
      const btn = this.container.querySelector('[data-action="minimize"]');
      btn.setAttribute('aria-label', this.isMinimized ? 'Expand evaluation panel' : 'Minimize evaluation panel');
      btn.textContent = this.isMinimized ? '+' : '−';
    }

    /**
     * Display loading state
     * @param {Object} options - Loading options
     */
    displayLoading(options = {}) {
      const content = this.container.querySelector('.eval-hud-content');
      const agentCount = options.agentCount || 'multiple';
      
      content.innerHTML = `
        <div class="eval-loading" role="status" aria-label="Loading evaluation">
          <div class="eval-loading-spinner" aria-hidden="true"></div>
          <div class="eval-loading-text">Evaluating document...</div>
          <div class="eval-loading-agents">Running with ${agentCount} agents</div>
          
          <div style="margin-top: 20px;">
            <div class="eval-score-container" style="animation: none; margin-bottom: 12px;">
              <div class="eval-skeleton eval-skeleton-score"></div>
              <div style="flex: 1;">
                <div class="eval-skeleton eval-skeleton-text medium"></div>
                <div class="eval-skeleton eval-skeleton-text short"></div>
              </div>
            </div>
            
            <div class="eval-agents-grid">
              <div class="eval-skeleton eval-skeleton-card"></div>
              <div class="eval-skeleton eval-skeleton-card"></div>
              <div class="eval-skeleton eval-skeleton-card"></div>
              <div class="eval-skeleton eval-skeleton-card"></div>
            </div>
          </div>
        </div>
      `;
      
      this.announce('Evaluation in progress');
      this.show();
    }

    /**
     * Display error state
     * @param {Object} error - Error details
     */
    displayError(error) {
      const content = this.container.querySelector('.eval-hud-content');
      const message = error?.message || 'An unexpected error occurred';
      
      content.innerHTML = `
        <div class="eval-error" role="alert">
          <div class="eval-error-icon" aria-hidden="true">⚠️</div>
          <div class="eval-error-title">Evaluation Failed</div>
          <div class="eval-error-message">${this.escapeHtml(message)}</div>
          <button class="eval-error-retry" data-action="retry">
            Try Again
          </button>
          <button class="eval-error-dismiss" data-action="dismiss">
            Dismiss
          </button>
        </div>
      `;
      
      // Set up handlers
      content.querySelector('[data-action="retry"]').addEventListener('click', () => {
        const event = new CustomEvent('eval:retry', { bubbles: true });
        document.dispatchEvent(event);
      });
      
      content.querySelector('[data-action="dismiss"]').addEventListener('click', () => {
        this.clear();
      });
      
      this.announce('Evaluation failed: ' + message);
      this.show();
    }

    /**
     * Escape HTML to prevent XSS
     */
    escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    /**
     * Animate score counter
     */
    animateScore(element, targetScore) {
      const duration = 600;
      const startTime = performance.now();
      const startScore = 0;
      
      const animate = (currentTime) => {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);
        
        // Ease out cubic
        const eased = 1 - Math.pow(1 - progress, 3);
        const currentScore = Math.round(startScore + (targetScore - startScore) * eased);
        
        element.textContent = currentScore;
        
        if (progress < 1) {
          requestAnimationFrame(animate);
        }
      };
      
      requestAnimationFrame(animate);
    }

    /**
     * Display evaluation result
     * @param {Object} evaluation - Consolidated evaluation result
     */
    displayEvaluation(evaluation) {
      this.currentEvaluation = evaluation;
      const content = this.container.querySelector('.eval-hud-content');
      
      const scoreClass = evaluation.aggregateScore >= 70 ? 'high' : 
                         evaluation.aggregateScore >= 50 ? 'medium' : 'low';
      
      content.innerHTML = `
        <!-- Score Display -->
        <div class="eval-score-container" role="region" aria-label="Evaluation score">
          <div class="eval-score-circle ${scoreClass}" id="eval-score-value" aria-live="polite">0</div>
          <div class="eval-score-meta">
            <div class="eval-confidence">
              Confidence: 
              <span class="eval-confidence-badge ${evaluation.confidence}">${evaluation.confidence}</span>
            </div>
            ${evaluation.epistemicFraming?.recommendsHumanReview ? 
              '<div style="font-size: 10px; color: #eab308;">⚠️ Human review recommended</div>' : ''}
          </div>
        </div>
        
        <!-- Epistemic Rationale -->
        ${evaluation.epistemicFraming?.rationale ? `
          <div class="eval-rationale" role="note">
            💡 ${this.escapeHtml(evaluation.epistemicFraming.rationale)}
          </div>
        ` : ''}
        
        <!-- Agent Cards -->
        <div class="eval-agents-title" id="eval-agents-heading">Evaluating Agents (${evaluation.agentScores?.length || 0})</div>
        <div class="eval-agents-grid" role="list" aria-labelledby="eval-agents-heading">
          ${(evaluation.agentScores || []).map((agent, index) => `
            <div class="eval-agent-card ${agent.trend}" 
                 role="listitem" 
                 tabindex="0"
                 aria-label="${agent.agentType} agent scored ${Math.round(agent.score)}">
              <span class="eval-agent-icon" aria-hidden="true">${agent.agentIcon || '🤖'}</span>
              <span class="eval-agent-score">${Math.round(agent.score)}</span>
              <span class="eval-agent-type">${this.escapeHtml(agent.agentType)}</span>
            </div>
          `).join('')}
        </div>
        
        <!-- Primary Drivers -->
        ${evaluation.epistemicFraming?.primaryDrivers?.length ? `
          <div class="eval-drivers" role="region" aria-label="Primary evaluation drivers">
            <div class="eval-agents-title">Primary Drivers</div>
            ${evaluation.epistemicFraming.primaryDrivers.map(d => 
              `<span class="eval-driver-tag">${this.escapeHtml(d)}</span>`
            ).join('')}
          </div>
        ` : ''}
        
        <!-- Conflicts -->
        ${evaluation.conflicts?.length ? `
          <div class="eval-conflicts" role="region" aria-label="Agent conflicts">
            <div class="eval-agents-title">⚡ Conflicts (${evaluation.conflicts.length})</div>
            ${evaluation.conflicts.slice(0, 3).map((c, index) => `
              <div class="eval-conflict-item" data-conflict-index="${index}">
                <div class="eval-conflict-criterion">${this.escapeHtml(c.criterion)}</div>
                <div class="eval-conflict-agents">
                  ${this.escapeHtml(c.highScorer?.agentType)} (${c.highScorer?.score}) vs 
                  ${this.escapeHtml(c.lowScorer?.agentType)} (${c.lowScorer?.score})
                </div>
                ${c.learnedResolution?.confidence === 'high' ? `
                  <div class="eval-conflict-resolution">
                    ${this.escapeHtml(c.learnedResolution.recommendation)} typically correct
                    <span class="eval-conflict-learned">Learned</span>
                  </div>
                ` : `
                  <div class="eval-conflict-actions">
                    <button class="eval-conflict-btn accept-high" 
                            data-action="resolve-conflict" 
                            data-index="${index}" 
                            data-choice="high"
                            aria-label="Accept ${this.escapeHtml(c.highScorer?.agentType)}'s evaluation">
                      Accept ${this.escapeHtml(c.highScorer?.agentType)}
                    </button>
                    <button class="eval-conflict-btn accept-low" 
                            data-action="resolve-conflict" 
                            data-index="${index}" 
                            data-choice="low"
                            aria-label="Accept ${this.escapeHtml(c.lowScorer?.agentType)}'s evaluation">
                      Accept ${this.escapeHtml(c.lowScorer?.agentType)}
                    </button>
                  </div>
                `}
              </div>
            `).join('')}
          </div>
        ` : ''}
        
        <!-- Top Suggestions -->
        ${evaluation.suggestions?.length ? `
          <div class="eval-suggestions" role="region" aria-label="Improvement suggestions">
            <div class="eval-agents-title">💡 Suggestions</div>
            ${evaluation.suggestions.slice(0, 5).map(s => `
              <div class="eval-suggestion-item">
                <span class="eval-suggestion-priority ${s.priority}" aria-label="${s.priority} priority"></span>
                <div class="eval-suggestion-text">
                  ${this.escapeHtml(s.text)}
                  <div class="eval-suggestion-agents">
                    From: ${(s.originatingAgents || ['Unknown']).map(a => this.escapeHtml(a)).join(', ')} 
                    (${Math.round(s.confidence * 100)}% conf)
                  </div>
                </div>
                ${s.applySuggestion ? `
                  <button class="eval-suggestion-apply" 
                          data-apply="${encodeURIComponent(s.applySuggestion)}"
                          aria-label="Apply this suggestion">
                    Apply
                  </button>
                ` : ''}
              </div>
            `).join('')}
          </div>
        ` : ''}
        
        <!-- Learning Dashboard Panel -->
        ${this.renderLearningPanel()}
        
        <!-- Weighting Mode -->
        <div class="eval-weighting">
          ${this.escapeHtml(evaluation.epistemicFraming?.weightingMode || this.weightingMode)} weighting • 
          ${evaluation.agentCount || 0} agents • v${this.version}
        </div>
      `;

      // Animate score counter
      const scoreElement = content.querySelector('#eval-score-value');
      if (scoreElement) {
        this.animateScore(scoreElement, Math.round(evaluation.aggregateScore));
      }

      // Add click handlers for apply buttons
      content.querySelectorAll('.eval-suggestion-apply').forEach(btn => {
        btn.addEventListener('click', () => {
          const suggestion = decodeURIComponent(btn.dataset.apply);
          this.applySuggestion(suggestion);
        });
      });

      // Add conflict resolution handlers
      content.querySelectorAll('[data-action="resolve-conflict"]').forEach(btn => {
        btn.addEventListener('click', () => {
          const index = parseInt(btn.dataset.index);
          const choice = btn.dataset.choice;
          this.resolveConflict(index, choice);
        });
      });

      // Learning panel toggle
      const learningPanelHeader = content.querySelector('[data-action="toggle-learning-panel"]');
      if (learningPanelHeader) {
        learningPanelHeader.addEventListener('click', () => this.toggleLearningPanel());
        learningPanelHeader.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            this.toggleLearningPanel();
          }
        });
      }

      // Full dashboard button
      const dashboardBtn = content.querySelector('[data-action="view-full-dashboard"]');
      if (dashboardBtn) {
        dashboardBtn.addEventListener('click', () => {
          const event = new CustomEvent('eval:view-dashboard', { bubbles: true });
          document.dispatchEvent(event);
        });
      }

      // Announce to screen readers
      this.announce(`Evaluation complete. Score: ${Math.round(evaluation.aggregateScore)} with ${evaluation.confidence} confidence`);
      
      this.show();
    }

    /**
     * Resolve a conflict
     * @param {number} index - Conflict index
     * @param {string} choice - 'high' or 'low'
     */
    resolveConflict(index, choice) {
      const conflict = this.currentEvaluation?.conflicts?.[index];
      if (!conflict) return;
      
      // Mark as resolved visually
      const conflictItem = this.container.querySelector(`[data-conflict-index="${index}"]`);
      if (conflictItem) {
        conflictItem.classList.add('resolved');
        const actionsDiv = conflictItem.querySelector('.eval-conflict-actions');
        if (actionsDiv) {
          const winner = choice === 'high' ? conflict.highScorer : conflict.lowScorer;
          actionsDiv.innerHTML = `
            <div class="eval-conflict-resolution">
              Resolved: ${this.escapeHtml(winner.agentType)} accepted
              <span class="eval-conflict-learned">✓</span>
            </div>
          `;
        }
      }
      
      // Emit event
      const event = new CustomEvent('eval:resolve-conflict', {
        detail: { 
          conflictIndex: index, 
          conflict,
          choice,
          winner: choice === 'high' ? conflict.highScorer : conflict.lowScorer
        }
      });
      document.dispatchEvent(event);
      
      this.announce(`Conflict resolved: accepted ${choice === 'high' ? conflict.highScorer?.agentType : conflict.lowScorer?.agentType}`);
    }

    /**
     * Apply a suggestion
     * @param {string} suggestion - Suggestion to apply
     */
    applySuggestion(suggestion) {
      // Emit event for parent to handle
      const event = new CustomEvent('eval:apply-suggestion', {
        detail: { suggestion }
      });
      document.dispatchEvent(event);
    }

    /**
     * Clear the HUD
     */
    clear() {
      this.currentEvaluation = null;
      const content = this.container.querySelector('.eval-hud-content');
      content.innerHTML = `
        <div class="eval-empty">
          <div class="eval-empty-icon" aria-hidden="true">📋</div>
          <div class="eval-empty-title">No evaluation yet</div>
          <div class="eval-empty-text">Run an evaluation to see multi-agent analysis and suggestions for your document.</div>
          <button class="eval-empty-cta" data-action="run-eval">Run Evaluation</button>
        </div>
      `;
    }

    /**
     * Fetch learning summary from backend
     */
    async fetchLearningSummary() {
      try {
        if (window.electronAPI?.invoke) {
          const result = await window.electronAPI.invoke('meta:get-learning-summary');
          if (result.success) {
            this.learningSummary = result;
            this.updateLearningBadge(result);
          }
        }
      } catch (error) {
        console.warn('[EvaluationHUD] Could not fetch learning summary:', error);
      }
    }

    /**
     * Update the learning status badge in header
     */
    updateLearningBadge(summary) {
      const badge = this.container.querySelector('#eval-learning-badge');
      const statusText = this.container.querySelector('#eval-learning-status');
      const trendEl = this.container.querySelector('#eval-learning-trend');
      
      if (!badge || !statusText) return;
      
      badge.classList.remove('active', 'inactive');
      badge.classList.add(summary.isLearningActive ? 'active' : 'inactive');
      
      statusText.textContent = summary.isLearningActive 
        ? `Active (${summary.totalSamples})`
        : `${summary.totalSamples}/${summary.minSamplesRequired}`;
      
      // Calculate overall trend
      if (summary.agentPerformance && summary.agentPerformance.length > 0) {
        const improvingCount = summary.agentPerformance.filter(a => a.trend === 'improving').length;
        const decliningCount = summary.agentPerformance.filter(a => a.trend === 'declining').length;
        
        if (improvingCount > decliningCount) {
          trendEl.textContent = '▲';
          trendEl.style.color = '#22c55e';
        } else if (decliningCount > improvingCount) {
          trendEl.textContent = '▼';
          trendEl.style.color = '#ef4444';
        } else {
          trendEl.textContent = '●';
          trendEl.style.color = '#808080';
        }
      }
    }

    /**
     * Render the learning dashboard panel
     */
    renderLearningPanel() {
      if (!this.learningSummary) return '';
      
      const summary = this.learningSummary;
      const isCollapsed = !this.isLearningPanelExpanded ? 'collapsed' : '';
      
      return `
        <div class="eval-learning-panel ${isCollapsed}" id="eval-learning-panel">
          <div class="eval-learning-panel-header" 
               role="button" 
               tabindex="0"
               aria-expanded="${this.isLearningPanelExpanded}"
               aria-controls="eval-learning-panel-content"
               data-action="toggle-learning-panel">
            <div class="eval-learning-panel-title">
              <span>🧠</span>
              <span>Learning Status</span>
            </div>
            <span class="eval-learning-panel-toggle" aria-hidden="true">▼</span>
          </div>
          <div class="eval-learning-panel-content" id="eval-learning-panel-content">
            <div class="eval-learning-stat">
              <span class="eval-learning-stat-label">Samples collected:</span>
              <span class="eval-learning-stat-value">${summary.totalSamples}</span>
            </div>
            <div class="eval-learning-stat">
              <span class="eval-learning-stat-label">Learning active:</span>
              <span class="eval-learning-stat-value ${summary.isLearningActive ? 'active' : 'inactive'}">
                ${summary.isLearningActive ? 'Yes' : `No (need ${summary.minSamplesRequired - summary.totalSamples} more)`}
              </span>
            </div>
            
            ${summary.agentPerformance && summary.agentPerformance.length > 0 ? `
              <div class="eval-agent-perf">
                <div class="eval-agent-perf-title">Agent Performance</div>
                ${summary.agentPerformance.map(agent => `
                  <div class="eval-agent-perf-row">
                    <span class="eval-agent-perf-name">${this.escapeHtml(agent.type)}</span>
                    <span class="eval-agent-perf-accuracy">${agent.accuracy}%</span>
                    <span class="eval-agent-perf-trend ${agent.trend}">${agent.trendIcon}</span>
                  </div>
                `).join('')}
              </div>
            ` : ''}
            
            ${this.renderABComparison()}
            
            <button class="eval-dashboard-btn" data-action="view-full-dashboard">
              📊 View Full Dashboard
            </button>
          </div>
        </div>
      `;
    }

    /**
     * Render A/B comparison view
     */
    renderABComparison() {
      if (!this.learningSummary || !this.learningSummary.weightComparison) return '';
      
      const weights = this.learningSummary.weightComparison;
      const agents = Object.entries(weights);
      
      if (agents.length === 0) return '';
      
      const predDiff = this.learningSummary.predictedScoreDifference || 0;
      const predClass = predDiff > 0 ? 'positive' : predDiff < 0 ? 'negative' : '';
      const predSign = predDiff > 0 ? '+' : '';
      
      return `
        <div class="eval-ab-comparison">
          <div class="eval-ab-title">Before/After Learning</div>
          <div class="eval-ab-columns">
            <div class="eval-ab-column default">
              <div class="eval-ab-column-title">Without Learning</div>
              ${agents.slice(0, 4).map(([type]) => `
                <div class="eval-ab-weight-row">
                  <span class="eval-ab-weight-name">${this.escapeHtml(type)}</span>
                  <span class="eval-ab-weight-value">1.00</span>
                </div>
              `).join('')}
            </div>
            <div class="eval-ab-column learned">
              <div class="eval-ab-column-title">With Learning</div>
              ${agents.slice(0, 4).map(([type, data]) => {
                const diff = parseFloat(data.difference);
                const diffClass = diff > 0 ? 'positive' : diff < 0 ? 'negative' : 'neutral';
                const diffSign = diff > 0 ? '+' : '';
                return `
                  <div class="eval-ab-weight-row">
                    <span class="eval-ab-weight-name">${this.escapeHtml(type)}</span>
                    <span class="eval-ab-weight-value">
                      ${data.learnedWeight.toFixed(2)}
                      <span class="eval-ab-weight-diff ${diffClass}">${diffSign}${diff}%</span>
                    </span>
                  </div>
                `;
              }).join('')}
            </div>
          </div>
          <div class="eval-ab-prediction">
            Predicted score difference: 
            <span class="eval-ab-prediction-value ${predClass}">${predSign}${predDiff}</span>
          </div>
        </div>
      `;
    }

    /**
     * Toggle learning panel expansion
     */
    toggleLearningPanel() {
      this.isLearningPanelExpanded = !this.isLearningPanelExpanded;
      localStorage.setItem('eval.showLearningPanel', String(this.isLearningPanelExpanded));
      
      const panel = this.container.querySelector('#eval-learning-panel');
      const header = panel?.querySelector('.eval-learning-panel-header');
      
      if (panel) {
        panel.classList.toggle('collapsed', !this.isLearningPanelExpanded);
      }
      if (header) {
        header.setAttribute('aria-expanded', String(this.isLearningPanelExpanded));
      }
    }

    /**
     * Get current weighting mode
     */
    getWeightingMode() {
      return this.weightingMode;
    }

    /**
     * Get current evaluation profile
     */
    getProfile() {
      return this.selectedProfile;
    }

    /**
     * Set evaluation profile
     */
    setProfile(profile) {
      this.selectedProfile = profile;
      localStorage.setItem('eval.profile', profile);
    }

    /**
     * Refresh learning data
     */
    async refreshLearningData() {
      await this.fetchLearningSummary();
      // Re-render if showing evaluation
      if (this.currentEvaluation) {
        this.displayEvaluation(this.currentEvaluation);
      }
    }
  }

  // Export to global scope
  window.EvaluationHUD = EvaluationHUD;
})();
