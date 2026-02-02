/**
 * Outcome Feedback UI Component
 * Part of the Governed Self-Improving Agent Runtime
 * 
 * Post-evaluation feedback capture for meta-learning
 * 
 * @version 2.0.0 - Added learning progress bar on feedback submit
 */

(function() {
  'use strict';

  const FEEDBACK_UI_VERSION = '2.0.0';

  /**
   * OutcomeFeedbackUI Class
   * Creates a feedback dialog for capturing real-world outcomes
   */
  class OutcomeFeedbackUI {
    constructor(options = {}) {
      this.version = FEEDBACK_UI_VERSION;
      this.modal = null;
      this.currentEvaluationId = null;
      this.onSubmit = options.onSubmit || (() => {});
      this.previouslyFocusedElement = null;
      this.focusableElements = [];
      
      console.log(`[OutcomeFeedbackUI] v${FEEDBACK_UI_VERSION} initializing...`);
      this.init();
    }

    /**
     * Initialize the UI
     */
    init() {
      this.createStyles();
      this.createModal();
    }

    /**
     * Create styles
     */
    createStyles() {
      if (document.getElementById('outcome-feedback-styles')) return;
      
      const styles = document.createElement('style');
      styles.id = 'outcome-feedback-styles';
      styles.textContent = `
        /* Screen reader only utility */
        .outcome-sr-only {
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
        
        .outcome-modal-overlay {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0, 0, 0, 0.7);
          backdrop-filter: blur(4px);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 10000;
          opacity: 0;
          pointer-events: none;
          transition: opacity 0.2s ease;
        }
        
        .outcome-modal-overlay.visible {
          opacity: 1;
          pointer-events: auto;
        }
        
        .outcome-modal {
          width: 420px;
          max-width: 90%;
          max-height: 90vh;
          overflow-y: auto;
          background: linear-gradient(165deg, rgba(28, 28, 38, 0.98) 0%, rgba(18, 18, 26, 1) 100%);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 16px;
          box-shadow: 0 24px 64px rgba(0, 0, 0, 0.5);
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          color: #e0e0e0;
          transform: scale(0.95) translateY(10px);
          transition: transform 0.25s ease, opacity 0.25s ease;
          opacity: 0;
        }
        
        .outcome-modal-overlay.visible .outcome-modal {
          transform: scale(1) translateY(0);
          opacity: 1;
        }
        
        .outcome-modal:focus {
          outline: 2px solid #6366f1;
          outline-offset: 2px;
        }
        
        /* Responsive */
        @media (max-width: 480px) {
          .outcome-modal {
            width: 100%;
            max-width: 100%;
            max-height: 85vh;
            border-radius: 16px 16px 0 0;
            position: absolute;
            bottom: 0;
          }
          
          .outcome-modal-overlay.visible .outcome-modal {
            transform: translateY(0);
          }
        }
        
        .outcome-modal-header {
          padding: 20px 24px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        }
        
        .outcome-modal-title {
          font-size: 18px;
          font-weight: 600;
          margin: 0 0 4px 0;
        }
        
        .outcome-modal-subtitle {
          font-size: 13px;
          color: #a0a0a0;
        }
        
        .outcome-modal-body {
          padding: 20px 24px;
        }
        
        .outcome-section {
          margin-bottom: 20px;
        }
        
        .outcome-section-title {
          font-size: 12px;
          font-weight: 600;
          text-transform: uppercase;
          color: #a0a0a0;
          margin-bottom: 10px;
          letter-spacing: 0.5px;
        }
        
        .outcome-options {
          display: grid;
          grid-template-columns: 1fr 1fr 1fr;
          gap: 8px;
        }
        
        .outcome-option {
          padding: 12px;
          background: rgba(255, 255, 255, 0.03);
          border: 2px solid rgba(255, 255, 255, 0.1);
          border-radius: 10px;
          text-align: center;
          cursor: pointer;
          transition: all 0.2s;
        }
        
        .outcome-option:hover {
          background: rgba(255, 255, 255, 0.08);
          border-color: rgba(255, 255, 255, 0.2);
        }
        
        .outcome-option:focus {
          outline: 2px solid #6366f1;
          outline-offset: 2px;
        }
        
        .outcome-option:focus:not(:focus-visible) {
          outline: none;
        }
        
        .outcome-option:focus-visible {
          outline: 2px solid #6366f1;
          outline-offset: 2px;
        }
        
        .outcome-option.selected {
          border-color: #6366f1;
          background: rgba(99, 102, 241, 0.15);
        }
        
        .outcome-option.selected .outcome-option-icon {
          animation: outcome-bounce 0.3s ease;
        }
        
        @keyframes outcome-bounce {
          0% { transform: scale(1); }
          50% { transform: scale(1.2); }
          100% { transform: scale(1); }
        }
        
        .outcome-option-icon {
          font-size: 24px;
          margin-bottom: 4px;
          transition: transform 0.2s;
        }
        
        .outcome-option-label {
          font-size: 11px;
          color: #b0b0b0;
        }
        
        /* Two-column layout for some options */
        .outcome-options.two-col {
          grid-template-columns: 1fr 1fr;
        }
        
        /* Suggestion outcomes */
        .outcome-suggestions-list {
          max-height: 150px;
          overflow-y: auto;
        }
        
        .outcome-suggestion-item {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 8px 10px;
          background: rgba(255, 255, 255, 0.02);
          border-radius: 8px;
          margin-bottom: 6px;
          font-size: 12px;
        }
        
        .outcome-suggestion-text {
          flex: 1;
          color: #ccc;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        
        .outcome-suggestion-toggle {
          display: flex;
          gap: 4px;
        }
        
        .outcome-toggle-btn {
          width: 28px;
          height: 24px;
          border: none;
          background: rgba(255, 255, 255, 0.1);
          border-radius: 4px;
          cursor: pointer;
          font-size: 12px;
          transition: all 0.2s;
          color: #a0a0a0;
        }
        
        .outcome-toggle-btn:hover {
          background: rgba(255, 255, 255, 0.2);
        }
        
        .outcome-toggle-btn:focus {
          outline: 2px solid #6366f1;
          outline-offset: 1px;
        }
        
        .outcome-toggle-btn.selected {
          background: #6366f1;
          color: #fff;
        }
        
        /* Comments */
        .outcome-comments {
          width: 100%;
          min-height: 60px;
          padding: 10px;
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 8px;
          color: #e0e0e0;
          font-size: 13px;
          resize: vertical;
          font-family: inherit;
        }
        
        .outcome-comments:focus {
          outline: none;
          border-color: rgba(99, 102, 241, 0.5);
          box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.15);
        }
        
        .outcome-comments::placeholder {
          color: #666;
        }
        
        /* Footer */
        .outcome-modal-footer {
          display: flex;
          justify-content: flex-end;
          gap: 10px;
          padding: 16px 24px;
          border-top: 1px solid rgba(255, 255, 255, 0.08);
        }
        
        .outcome-btn {
          padding: 10px 20px;
          border: none;
          border-radius: 8px;
          font-size: 13px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s;
        }
        
        .outcome-btn:focus {
          outline: 2px solid #6366f1;
          outline-offset: 2px;
        }
        
        .outcome-btn-secondary {
          background: rgba(255, 255, 255, 0.1);
          color: #b0b0b0;
        }
        
        .outcome-btn-secondary:hover {
          background: rgba(255, 255, 255, 0.15);
          color: #fff;
        }
        
        .outcome-btn-primary {
          background: #6366f1;
          color: #fff;
          position: relative;
          overflow: hidden;
        }
        
        .outcome-btn-primary:hover {
          background: #5558dd;
        }
        
        .outcome-btn-primary:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        
        .outcome-btn-primary.submitting {
          color: transparent;
        }
        
        .outcome-btn-primary.submitting::after {
          content: '';
          position: absolute;
          width: 16px;
          height: 16px;
          top: 50%;
          left: 50%;
          margin: -8px 0 0 -8px;
          border: 2px solid rgba(255, 255, 255, 0.3);
          border-top-color: #fff;
          border-radius: 50%;
          animation: outcome-spin 0.6s linear infinite;
        }
        
        @keyframes outcome-spin {
          to { transform: rotate(360deg); }
        }
        
        /* Success state */
        .outcome-success {
          text-align: center;
          padding: 40px 24px;
          animation: outcome-fade-in 0.3s ease;
        }
        
        @keyframes outcome-fade-in {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
        
        .outcome-success-icon {
          font-size: 48px;
          margin-bottom: 12px;
          animation: outcome-checkmark 0.4s ease 0.1s both;
        }
        
        @keyframes outcome-checkmark {
          0% { transform: scale(0); }
          50% { transform: scale(1.2); }
          100% { transform: scale(1); }
        }
        
        .outcome-success-title {
          font-size: 18px;
          font-weight: 600;
          margin-bottom: 4px;
        }
        
        .outcome-success-text {
          font-size: 13px;
          color: #a0a0a0;
        }
        
        /* Sample Progress */
        .outcome-success-progress {
          margin-top: 16px;
          padding: 12px 16px;
          background: rgba(139, 92, 246, 0.1);
          border-radius: 10px;
        }
        
        .outcome-progress-label {
          font-size: 11px;
          color: #a0a0a0;
          margin-bottom: 8px;
        }
        
        .outcome-progress-bar-container {
          height: 8px;
          background: rgba(255, 255, 255, 0.1);
          border-radius: 4px;
          overflow: hidden;
        }
        
        .outcome-progress-bar {
          height: 100%;
          background: linear-gradient(90deg, #a78bfa, #6366f1);
          border-radius: 4px;
          transition: width 0.5s ease;
        }
        
        .outcome-progress-bar.full {
          background: linear-gradient(90deg, #22c55e, #16a34a);
        }
        
        .outcome-progress-text {
          display: flex;
          justify-content: space-between;
          font-size: 10px;
          color: #808080;
          margin-top: 6px;
        }
        
        .outcome-progress-status {
          color: #a78bfa;
          font-weight: 600;
        }
        
        .outcome-progress-status.active {
          color: #22c55e;
        }
      `;
      document.head.appendChild(styles);
    }

    /**
     * Create the modal
     */
    createModal() {
      this.modal = document.createElement('div');
      this.modal.className = 'outcome-modal-overlay';
      this.modal.setAttribute('role', 'dialog');
      this.modal.setAttribute('aria-modal', 'true');
      this.modal.setAttribute('aria-labelledby', 'outcome-modal-title');
      this.modal.setAttribute('aria-describedby', 'outcome-modal-subtitle');
      this.modal.innerHTML = `
        <div class="outcome-modal" tabindex="-1">
          <div class="outcome-modal-header">
            <div class="outcome-modal-title" id="outcome-modal-title">📊 How did it go?</div>
            <div class="outcome-modal-subtitle" id="outcome-modal-subtitle">Help the system learn from this evaluation</div>
          </div>
          <div class="outcome-modal-body">
            <!-- Document Outcome -->
            <div class="outcome-section">
              <div class="outcome-section-title" id="doc-outcome-label">Document Outcome</div>
              <div class="outcome-options" data-field="documentOutcome" role="radiogroup" aria-labelledby="doc-outcome-label">
                <div class="outcome-option" data-value="accepted" role="radio" aria-checked="false" tabindex="0">
                  <div class="outcome-option-icon" aria-hidden="true">✅</div>
                  <div class="outcome-option-label">Accepted</div>
                </div>
                <div class="outcome-option" data-value="rework_required" role="radio" aria-checked="false" tabindex="-1">
                  <div class="outcome-option-icon" aria-hidden="true">🔄</div>
                  <div class="outcome-option-label">Rework</div>
                </div>
                <div class="outcome-option" data-value="rejected" role="radio" aria-checked="false" tabindex="-1">
                  <div class="outcome-option-icon" aria-hidden="true">❌</div>
                  <div class="outcome-option-label">Rejected</div>
                </div>
              </div>
            </div>
            
            <!-- Satisfaction -->
            <div class="outcome-section">
              <div class="outcome-section-title" id="satisfaction-label">Were you satisfied with the evaluation?</div>
              <div class="outcome-options two-col" data-field="userSatisfaction" role="radiogroup" aria-labelledby="satisfaction-label">
                <div class="outcome-option" data-value="satisfied" role="radio" aria-checked="false" tabindex="0">
                  <div class="outcome-option-icon" aria-hidden="true">😊</div>
                  <div class="outcome-option-label">Satisfied</div>
                </div>
                <div class="outcome-option" data-value="unsatisfied" role="radio" aria-checked="false" tabindex="-1">
                  <div class="outcome-option-icon" aria-hidden="true">😕</div>
                  <div class="outcome-option-label">Unsatisfied</div>
                </div>
              </div>
            </div>
            
            <!-- Suggestions Applied -->
            <div class="outcome-section outcome-suggestions-section" style="display: none;">
              <div class="outcome-section-title" id="suggestions-label">Which suggestions did you apply?</div>
              <div class="outcome-suggestions-list" role="list" aria-labelledby="suggestions-label"></div>
            </div>
            
            <!-- Comments -->
            <div class="outcome-section">
              <div class="outcome-section-title"><label for="outcome-comments-input">Additional Comments (optional)</label></div>
              <textarea id="outcome-comments-input" class="outcome-comments" placeholder="Any feedback on the evaluation quality?" aria-describedby="comments-hint"></textarea>
              <span id="comments-hint" class="outcome-sr-only">Optional: Share any additional thoughts about the evaluation</span>
            </div>
          </div>
          <div class="outcome-modal-footer">
            <button class="outcome-btn outcome-btn-secondary" data-action="skip" aria-label="Skip feedback and close">Skip</button>
            <button class="outcome-btn outcome-btn-primary" data-action="submit">Submit Feedback</button>
          </div>
        </div>
      `;
      document.body.appendChild(this.modal);
      
      this.setupEventListeners();
    }

    /**
     * Get all focusable elements in the modal
     */
    getFocusableElements() {
      const modal = this.modal.querySelector('.outcome-modal');
      return Array.from(modal.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"]), .outcome-option[tabindex="0"]'
      )).filter(el => !el.disabled && el.offsetParent !== null);
    }

    /**
     * Trap focus within modal
     */
    trapFocus(e) {
      const focusable = this.getFocusableElements();
      if (focusable.length === 0) return;
      
      const firstElement = focusable[0];
      const lastElement = focusable[focusable.length - 1];
      
      if (e.shiftKey && document.activeElement === firstElement) {
        e.preventDefault();
        lastElement.focus();
      } else if (!e.shiftKey && document.activeElement === lastElement) {
        e.preventDefault();
        firstElement.focus();
      }
    }

    /**
     * Set up event listeners
     */
    setupEventListeners() {
      // Option selection with keyboard support
      this.modal.querySelectorAll('.outcome-options').forEach(group => {
        const options = group.querySelectorAll('.outcome-option');
        
        options.forEach(opt => {
          opt.addEventListener('click', () => {
            this.selectOption(group, opt);
          });
          
          opt.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              this.selectOption(group, opt);
            }
            
            // Arrow key navigation
            if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
              e.preventDefault();
              const optionsArray = Array.from(options);
              const currentIndex = optionsArray.indexOf(opt);
              const nextIndex = (currentIndex + 1) % optionsArray.length;
              this.selectOption(group, optionsArray[nextIndex]);
              optionsArray[nextIndex].focus();
            }
            
            if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
              e.preventDefault();
              const optionsArray = Array.from(options);
              const currentIndex = optionsArray.indexOf(opt);
              const prevIndex = (currentIndex - 1 + optionsArray.length) % optionsArray.length;
              this.selectOption(group, optionsArray[prevIndex]);
              optionsArray[prevIndex].focus();
            }
          });
        });
      });

      // Buttons
      this.modal.querySelector('[data-action="skip"]').addEventListener('click', () => {
        this.hide();
      });

      this.modal.querySelector('[data-action="submit"]').addEventListener('click', () => {
        this.submitFeedback();
      });

      // Close on overlay click
      this.modal.addEventListener('click', (e) => {
        if (e.target === this.modal) {
          this.hide();
        }
      });

      // Keyboard handling
      this.modal.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          this.hide();
        }
        
        if (e.key === 'Tab') {
          this.trapFocus(e);
        }
      });
    }

    /**
     * Select an option in a group
     */
    selectOption(group, opt) {
      group.querySelectorAll('.outcome-option').forEach(o => {
        o.classList.remove('selected');
        o.setAttribute('aria-checked', 'false');
        o.setAttribute('tabindex', '-1');
      });
      opt.classList.add('selected');
      opt.setAttribute('aria-checked', 'true');
      opt.setAttribute('tabindex', '0');
    }

    /**
     * Show the feedback modal
     * @param {Object} evaluation - The evaluation to get feedback on
     */
    show(evaluation) {
      this.previouslyFocusedElement = document.activeElement;
      this.currentEvaluationId = evaluation.id || Date.now().toString();
      this.currentEvaluation = evaluation;
      
      // Populate suggestions if any
      const suggestionsSection = this.modal.querySelector('.outcome-suggestions-section');
      const suggestionsList = this.modal.querySelector('.outcome-suggestions-list');
      
      if (evaluation.suggestions?.length > 0) {
        suggestionsSection.style.display = 'block';
        suggestionsList.innerHTML = evaluation.suggestions.slice(0, 5).map((s, i) => `
          <div class="outcome-suggestion-item" data-index="${i}" role="listitem">
            <span class="outcome-suggestion-text">${this.escapeHtml(s.text)}</span>
            <div class="outcome-suggestion-toggle" role="group" aria-label="Applied or ignored">
              <button class="outcome-toggle-btn" data-value="applied" title="Applied" aria-label="Mark as applied" aria-pressed="false">✓</button>
              <button class="outcome-toggle-btn" data-value="ignored" title="Ignored" aria-label="Mark as ignored" aria-pressed="false">✗</button>
            </div>
          </div>
        `).join('');
        
        // Set up toggle handlers
        suggestionsList.querySelectorAll('.outcome-toggle-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            const item = btn.closest('.outcome-suggestion-item');
            item.querySelectorAll('.outcome-toggle-btn').forEach(b => {
              b.classList.remove('selected');
              b.setAttribute('aria-pressed', 'false');
            });
            btn.classList.add('selected');
            btn.setAttribute('aria-pressed', 'true');
          });
        });
      } else {
        suggestionsSection.style.display = 'none';
      }

      // Reset selections
      this.modal.querySelectorAll('.outcome-option').forEach(o => {
        o.classList.remove('selected');
        o.setAttribute('aria-checked', 'false');
      });
      
      // Reset tabindex for first options
      this.modal.querySelectorAll('.outcome-options').forEach(group => {
        const options = group.querySelectorAll('.outcome-option');
        options.forEach((opt, i) => {
          opt.setAttribute('tabindex', i === 0 ? '0' : '-1');
        });
      });
      
      this.modal.querySelector('.outcome-comments').value = '';
      
      // Reset body content (in case showing success state)
      const body = this.modal.querySelector('.outcome-modal-body');
      if (body.querySelector('.outcome-success')) {
        // Recreate the body content
        this.modal.querySelector('.outcome-modal').innerHTML = this.getModalContent();
        this.setupEventListeners();
        
        // Re-populate suggestions
        if (evaluation.suggestions?.length > 0) {
          this.show(evaluation);
          return;
        }
      }
      
      // Show modal
      this.modal.classList.add('visible');
      
      // Focus the modal
      setTimeout(() => {
        const firstOption = this.modal.querySelector('.outcome-option');
        if (firstOption) {
          firstOption.focus();
        }
      }, 100);
    }

    /**
     * Get modal content HTML
     */
    getModalContent() {
      return `
        <div class="outcome-modal-header">
          <div class="outcome-modal-title" id="outcome-modal-title">📊 How did it go?</div>
          <div class="outcome-modal-subtitle" id="outcome-modal-subtitle">Help the system learn from this evaluation</div>
        </div>
        <div class="outcome-modal-body">
          <!-- Document Outcome -->
          <div class="outcome-section">
            <div class="outcome-section-title" id="doc-outcome-label">Document Outcome</div>
            <div class="outcome-options" data-field="documentOutcome" role="radiogroup" aria-labelledby="doc-outcome-label">
              <div class="outcome-option" data-value="accepted" role="radio" aria-checked="false" tabindex="0">
                <div class="outcome-option-icon" aria-hidden="true">✅</div>
                <div class="outcome-option-label">Accepted</div>
              </div>
              <div class="outcome-option" data-value="rework_required" role="radio" aria-checked="false" tabindex="-1">
                <div class="outcome-option-icon" aria-hidden="true">🔄</div>
                <div class="outcome-option-label">Rework</div>
              </div>
              <div class="outcome-option" data-value="rejected" role="radio" aria-checked="false" tabindex="-1">
                <div class="outcome-option-icon" aria-hidden="true">❌</div>
                <div class="outcome-option-label">Rejected</div>
              </div>
            </div>
          </div>
          
          <!-- Satisfaction -->
          <div class="outcome-section">
            <div class="outcome-section-title" id="satisfaction-label">Were you satisfied with the evaluation?</div>
            <div class="outcome-options two-col" data-field="userSatisfaction" role="radiogroup" aria-labelledby="satisfaction-label">
              <div class="outcome-option" data-value="satisfied" role="radio" aria-checked="false" tabindex="0">
                <div class="outcome-option-icon" aria-hidden="true">😊</div>
                <div class="outcome-option-label">Satisfied</div>
              </div>
              <div class="outcome-option" data-value="unsatisfied" role="radio" aria-checked="false" tabindex="-1">
                <div class="outcome-option-icon" aria-hidden="true">😕</div>
                <div class="outcome-option-label">Unsatisfied</div>
              </div>
            </div>
          </div>
          
          <!-- Suggestions Applied -->
          <div class="outcome-section outcome-suggestions-section" style="display: none;">
            <div class="outcome-section-title" id="suggestions-label">Which suggestions did you apply?</div>
            <div class="outcome-suggestions-list" role="list" aria-labelledby="suggestions-label"></div>
          </div>
          
          <!-- Comments -->
          <div class="outcome-section">
            <div class="outcome-section-title"><label for="outcome-comments-input">Additional Comments (optional)</label></div>
            <textarea id="outcome-comments-input" class="outcome-comments" placeholder="Any feedback on the evaluation quality?" aria-describedby="comments-hint"></textarea>
            <span id="comments-hint" class="outcome-sr-only">Optional: Share any additional thoughts about the evaluation</span>
          </div>
        </div>
        <div class="outcome-modal-footer">
          <button class="outcome-btn outcome-btn-secondary" data-action="skip" aria-label="Skip feedback and close">Skip</button>
          <button class="outcome-btn outcome-btn-primary" data-action="submit">Submit Feedback</button>
        </div>
      `;
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
     * Hide the modal
     */
    hide() {
      this.modal.classList.remove('visible');
      
      // Restore focus
      if (this.previouslyFocusedElement) {
        this.previouslyFocusedElement.focus();
      }
    }

    /**
     * Show success state with learning progress
     */
    async showSuccess() {
      const body = this.modal.querySelector('.outcome-modal-body');
      const footer = this.modal.querySelector('.outcome-modal-footer');
      
      // Fetch current learning status
      let learningSummary = null;
      try {
        if (window.electronAPI?.invoke) {
          const result = await window.electronAPI.invoke('meta:get-learning-summary');
          if (result.success) {
            learningSummary = result;
          }
        }
      } catch (error) {
        console.warn('[OutcomeFeedback] Could not fetch learning summary:', error);
      }
      
      const progressHtml = learningSummary ? this.renderLearningProgress(learningSummary) : '';
      
      body.innerHTML = `
        <div class="outcome-success" role="alert">
          <div class="outcome-success-icon" aria-hidden="true">✅</div>
          <div class="outcome-success-title">Thank you!</div>
          <div class="outcome-success-text">Your feedback helps improve future evaluations</div>
          ${progressHtml}
        </div>
      `;
      
      footer.innerHTML = `
        <button class="outcome-btn outcome-btn-primary" data-action="close">Done</button>
      `;
      
      footer.querySelector('[data-action="close"]').addEventListener('click', () => {
        this.hide();
      });
      
      footer.querySelector('[data-action="close"]').focus();
      
      // Trigger HUD refresh if available
      if (window.evaluationHUD?.refreshLearningData) {
        window.evaluationHUD.refreshLearningData();
      }
      
      // Auto-close after delay
      setTimeout(() => {
        if (this.modal.classList.contains('visible')) {
          this.hide();
        }
      }, 3000);
    }

    /**
     * Render learning progress bar
     */
    renderLearningProgress(summary) {
      const { totalSamples, minSamplesRequired, isLearningActive } = summary;
      const progress = Math.min(100, (totalSamples / minSamplesRequired) * 100);
      const remaining = Math.max(0, minSamplesRequired - totalSamples);
      
      return `
        <div class="outcome-success-progress">
          <div class="outcome-progress-label">Learning Progress</div>
          <div class="outcome-progress-bar-container">
            <div class="outcome-progress-bar ${isLearningActive ? 'full' : ''}" 
                 style="width: ${progress}%"></div>
          </div>
          <div class="outcome-progress-text">
            <span>${totalSamples} samples collected</span>
            <span class="outcome-progress-status ${isLearningActive ? 'active' : ''}">
              ${isLearningActive 
                ? 'Learning Active!' 
                : `${remaining} more needed`}
            </span>
          </div>
        </div>
      `;
    }

    /**
     * Collect and submit feedback
     */
    submitFeedback() {
      const submitBtn = this.modal.querySelector('[data-action="submit"]');
      submitBtn.classList.add('submitting');
      submitBtn.disabled = true;
      
      const documentOutcome = this.modal.querySelector('[data-field="documentOutcome"] .selected')?.dataset.value;
      const userSatisfaction = this.modal.querySelector('[data-field="userSatisfaction"] .selected')?.dataset.value;
      const comments = this.modal.querySelector('.outcome-comments').value.trim();
      
      // Collect suggestion outcomes
      const suggestionOutcomes = [];
      this.modal.querySelectorAll('.outcome-suggestion-item').forEach((item, i) => {
        const selected = item.querySelector('.outcome-toggle-btn.selected');
        if (selected) {
          suggestionOutcomes.push({
            index: i,
            applied: selected.dataset.value === 'applied',
            suggestion: this.currentEvaluation?.suggestions?.[i]
          });
        }
      });

      const outcome = {
        evaluationId: this.currentEvaluationId,
        type: documentOutcome,
        userFeedback: userSatisfaction,
        comments,
        suggestions: suggestionOutcomes,
        originalEvaluation: this.currentEvaluation,
        documentType: this.currentEvaluation?.documentType,
        submittedAt: new Date().toISOString()
      };

      // Simulate brief delay for feedback
      setTimeout(() => {
        submitBtn.classList.remove('submitting');
        submitBtn.disabled = false;
        
        // Call the callback
        this.onSubmit(outcome);
        
        // Show success state
        this.showSuccess();
      }, 300);
    }
  }

  // Export to global scope
  window.OutcomeFeedbackUI = OutcomeFeedbackUI;
})();
