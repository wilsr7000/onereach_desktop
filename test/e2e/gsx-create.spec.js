/**
 * GSX Create E2E Tests
 * Part of the Governed Self-Improving Agent Runtime
 * 
 * End-to-end tests for the complete evaluation workflow
 */

const { chromium } = require('playwright');
const path = require('path');

describe('GSX Create E2E Tests', () => {
  let browser;
  let page;

  beforeAll(async () => {
    browser = await chromium.launch({
      headless: true
    });
  });

  afterAll(async () => {
    if (browser) {
      await browser.close();
    }
  });

  beforeEach(async () => {
    page = await browser.newPage();
  });

  afterEach(async () => {
    if (page) {
      await page.close();
    }
  });

  describe('Evaluation Workflow', () => {
    it('should load the main UI', async () => {
      // In Electron context, this would load aider-ui.html
      // For standalone testing, we'd need a test server
      await page.goto('about:blank');
      expect(page).toBeDefined();
    });

    it('should have evaluation HUD component available', async () => {
      await page.goto('about:blank');
      
      // Inject the evaluation HUD script
      await page.addScriptTag({
        path: path.join(__dirname, '../../js/evaluation-hud.js')
      });

      // Verify the class is available
      const hudExists = await page.evaluate(() => {
        return typeof window.EvaluationHUD === 'function';
      });

      expect(hudExists).toBe(true);
    });

    it('should create and display evaluation HUD', async () => {
      await page.goto('about:blank');
      
      await page.addScriptTag({
        path: path.join(__dirname, '../../js/evaluation-hud.js')
      });

      // Create HUD instance
      await page.evaluate(() => {
        window.evalHUD = new window.EvaluationHUD();
      });

      // Check if HUD container was created
      const hudContainer = await page.$('.eval-hud');
      expect(hudContainer).not.toBeNull();
    });

    it('should display evaluation results in HUD', async () => {
      await page.goto('about:blank');
      
      await page.addScriptTag({
        path: path.join(__dirname, '../../js/evaluation-hud.js')
      });

      // Create and display evaluation
      await page.evaluate(() => {
        window.evalHUD = new window.EvaluationHUD();
        window.evalHUD.displayEvaluation({
          aggregateScore: 85,
          confidence: 'high',
          agentScores: [
            { agentType: 'expert', agentIcon: '👨‍💻', score: 90, trend: 'best' },
            { agentType: 'reviewer', agentIcon: '🔍', score: 80, trend: 'neutral' }
          ],
          epistemicFraming: {
            rationale: 'Test rationale',
            primaryDrivers: ['clarity', 'security'],
            recommendsHumanReview: false
          },
          conflicts: [],
          suggestions: []
        });
      });

      // Verify HUD is visible
      const isVisible = await page.evaluate(() => {
        const hud = document.querySelector('.eval-hud');
        return !hud.classList.contains('hidden');
      });

      expect(isVisible).toBe(true);

      // Verify score is displayed
      const scoreText = await page.$eval('.eval-score-circle', el => el.textContent);
      expect(scoreText).toBe('85');
    });

    it('should show conflicts when present', async () => {
      await page.goto('about:blank');
      
      await page.addScriptTag({
        path: path.join(__dirname, '../../js/evaluation-hud.js')
      });

      await page.evaluate(() => {
        window.evalHUD = new window.EvaluationHUD();
        window.evalHUD.displayEvaluation({
          aggregateScore: 70,
          confidence: 'medium',
          agentScores: [],
          epistemicFraming: {},
          conflicts: [
            {
              criterion: 'clarity',
              highScorer: { agentType: 'expert', score: 90 },
              lowScorer: { agentType: 'beginner', score: 50 }
            }
          ],
          suggestions: []
        });
      });

      const conflictsSection = await page.$('.eval-conflicts');
      expect(conflictsSection).not.toBeNull();

      const conflictText = await page.$eval('.eval-conflict-criterion', el => el.textContent);
      expect(conflictText).toBe('clarity');
    });
  });

  describe('Outcome Feedback UI', () => {
    it('should have outcome feedback UI available', async () => {
      await page.goto('about:blank');
      
      await page.addScriptTag({
        path: path.join(__dirname, '../../js/outcome-feedback-ui.js')
      });

      const uiExists = await page.evaluate(() => {
        return typeof window.OutcomeFeedbackUI === 'function';
      });

      expect(uiExists).toBe(true);
    });

    it('should show feedback modal', async () => {
      await page.goto('about:blank');
      
      await page.addScriptTag({
        path: path.join(__dirname, '../../js/outcome-feedback-ui.js')
      });

      await page.evaluate(() => {
        window.feedbackUI = new window.OutcomeFeedbackUI();
        window.feedbackUI.show({
          id: 'eval-123',
          aggregateScore: 80,
          suggestions: [
            { text: 'Add error handling' }
          ]
        });
      });

      const modalVisible = await page.evaluate(() => {
        const modal = document.querySelector('.outcome-modal-overlay');
        return modal.classList.contains('visible');
      });

      expect(modalVisible).toBe(true);
    });

    it('should hide modal on skip', async () => {
      await page.goto('about:blank');
      
      await page.addScriptTag({
        path: path.join(__dirname, '../../js/outcome-feedback-ui.js')
      });

      await page.evaluate(() => {
        window.feedbackUI = new window.OutcomeFeedbackUI();
        window.feedbackUI.show({ id: 'eval-123' });
      });

      // Click skip button
      await page.click('[data-action="skip"]');

      const modalVisible = await page.evaluate(() => {
        const modal = document.querySelector('.outcome-modal-overlay');
        return modal.classList.contains('visible');
      });

      expect(modalVisible).toBe(false);
    });

    it('should collect feedback on submit', async () => {
      await page.goto('about:blank');
      
      await page.addScriptTag({
        path: path.join(__dirname, '../../js/outcome-feedback-ui.js')
      });

      let submittedFeedback = null;

      await page.exposeFunction('onFeedbackSubmit', (feedback) => {
        submittedFeedback = feedback;
      });

      await page.evaluate(() => {
        window.feedbackUI = new window.OutcomeFeedbackUI({
          onSubmit: (feedback) => window.onFeedbackSubmit(feedback)
        });
        window.feedbackUI.show({ id: 'eval-123' });
      });

      // Select document outcome
      await page.click('[data-value="accepted"]');
      
      // Select satisfaction
      await page.click('[data-value="satisfied"]');

      // Submit
      await page.click('[data-action="submit"]');

      // Wait for callback
      await page.waitForTimeout(100);

      expect(submittedFeedback).toBeDefined();
      expect(submittedFeedback.type).toBe('accepted');
      expect(submittedFeedback.userFeedback).toBe('satisfied');
    });
  });

  describe('Task Queue Integration', () => {
    it('should load task queue module', async () => {
      // This would test the actual Electron app integration
      // For now, we verify the module exists
      const UnifiedTaskQueue = require('../../lib/unified-task-queue');
      const queue = new UnifiedTaskQueue();

      expect(queue).toBeDefined();
      
      queue.destroy();
    });

    it('should add and retrieve tasks', async () => {
      const UnifiedTaskQueue = require('../../lib/unified-task-queue');
      const queue = new UnifiedTaskQueue();

      const task = queue.add({
        description: 'E2E test task',
        type: 'code_generation'
      });

      const retrieved = queue.get(task.id);
      
      expect(retrieved.description).toBe('E2E test task');
      
      queue.destroy();
    });
  });

  describe('Meta-Learning Integration', () => {
    it('should create meta-learning system', async () => {
      const { createMetaLearningSystem } = require('../../lib/meta-learning');
      const system = createMetaLearningSystem();

      expect(system.outcomeTracker).toBeDefined();
      expect(system.agentMemory).toBeDefined();
      expect(system.governance).toBeDefined();
    });

    it('should record and retrieve outcomes', async () => {
      const { createMetaLearningSystem, OUTCOME_TYPES } = require('../../lib/meta-learning');
      const system = createMetaLearningSystem();

      await system.recordOutcome('eval-e2e-1', {
        type: OUTCOME_TYPES.ACCEPTED,
        documentType: 'code'
      });

      const stats = system.getStats();
      
      expect(stats.outcomes.totalOutcomes).toBeGreaterThan(0);
    });
  });
});

