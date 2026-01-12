/**
 * Plan Generation Quality Evals
 * Part of the Governed Self-Improving Agent Runtime
 * 
 * Tests the 7-phase workflow plan structure and quality
 */

import { describe, it, expect } from 'vitest';

// Types for plan evaluation
interface PlanStep {
  phase: string;
  description: string;
  status?: string;
  details?: string[];
}

interface Plan {
  id: string;
  name: string;
  phases: string[];
  steps: PlanStep[];
  metadata?: Record<string, unknown>;
}

interface PlanTestCase {
  input: string;
  expectedStructure: {
    phases?: string[];
    minSteps: number;
    requiredPhases?: string[];
  };
  description: string;
}

// The 7-phase workflow
const WORKFLOW_PHASES = ['evaluate', 'research', 'plan', 'execute', 'test', 'improve', 'finalize'];

// Mock plan generator (to be replaced with actual implementation)
async function generatePlan(prompt: string): Promise<Plan> {
  // This would connect to the actual plan generation logic
  // For now, return a structured plan based on the prompt
  const steps: PlanStep[] = [
    { phase: 'evaluate', description: 'Analyze requirements and scope', status: 'pending' },
    { phase: 'research', description: 'Research existing solutions and patterns', status: 'pending' },
    { phase: 'plan', description: 'Design implementation approach', status: 'pending' },
    { phase: 'execute', description: `Implement: ${prompt}`, status: 'pending' },
    { phase: 'test', description: 'Write and run tests', status: 'pending' },
    { phase: 'improve', description: 'Refactor and optimize', status: 'pending' },
    { phase: 'finalize', description: 'Documentation and cleanup', status: 'pending' }
  ];

  // Add specific steps based on prompt content
  if (prompt.includes('dark mode')) {
    steps[3].details = [
      'Add theme context/state',
      'Create toggle component',
      'Update CSS variables',
      'Persist preference'
    ];
  }

  return {
    id: `plan-${Date.now()}`,
    name: prompt.slice(0, 50),
    phases: WORKFLOW_PHASES,
    steps,
    metadata: { prompt, createdAt: new Date().toISOString() }
  };
}

// Plan structure scorer
function scorePlanStructure(
  plan: Plan,
  expected: { phases?: string[]; minSteps: number; requiredPhases?: string[] }
): { score: number; details: string[] } {
  const details: string[] = [];
  let score = 0;
  let checks = 0;

  // Check minimum steps
  checks++;
  if (plan.steps.length >= expected.minSteps) {
    score++;
    details.push(`✓ Has ${plan.steps.length} steps (min: ${expected.minSteps})`);
  } else {
    details.push(`✗ Only ${plan.steps.length} steps (need: ${expected.minSteps})`);
  }

  // Check required phases
  if (expected.requiredPhases) {
    for (const phase of expected.requiredPhases) {
      checks++;
      const hasPhase = plan.steps.some(s => s.phase === phase);
      if (hasPhase) {
        score++;
        details.push(`✓ Has required phase: ${phase}`);
      } else {
        details.push(`✗ Missing required phase: ${phase}`);
      }
    }
  }

  // Check phases array
  if (expected.phases) {
    checks++;
    const hasAllPhases = expected.phases.every(p => plan.phases.includes(p));
    if (hasAllPhases) {
      score++;
      details.push(`✓ Contains all expected phases`);
    } else {
      const missing = expected.phases.filter(p => !plan.phases.includes(p));
      details.push(`✗ Missing phases: ${missing.join(', ')}`);
    }
  }

  return { score: score / checks, details };
}

// Plan quality scorer (LLM-like evaluation)
async function scorePlanQuality(plan: Plan, prompt: string): Promise<{ score: number; feedback: string }> {
  let score = 0.5; // Base score
  let feedback = '';

  // Check if plan is actionable
  const hasDescriptions = plan.steps.every(s => s.description && s.description.length > 10);
  if (hasDescriptions) {
    score += 0.15;
    feedback += 'All steps have clear descriptions. ';
  }

  // Check if plan follows proper order
  const phaseOrder = plan.steps.map(s => WORKFLOW_PHASES.indexOf(s.phase));
  const isOrdered = phaseOrder.every((val, i, arr) => i === 0 || val >= arr[i - 1]);
  if (isOrdered) {
    score += 0.15;
    feedback += 'Phases are in correct order. ';
  }

  // Check if plan addresses the prompt
  const promptWords = prompt.toLowerCase().split(/\s+/);
  const planText = JSON.stringify(plan).toLowerCase();
  const relevance = promptWords.filter(w => planText.includes(w)).length / promptWords.length;
  if (relevance > 0.3) {
    score += 0.1;
    feedback += 'Plan addresses the prompt. ';
  }

  // Check for test phase
  const hasTest = plan.steps.some(s => s.phase === 'test');
  if (hasTest) {
    score += 0.1;
    feedback += 'Includes testing phase. ';
  }

  return { score: Math.min(score, 1), feedback: feedback.trim() };
}

describe('Plan Generation Structure', () => {
  const testCases: PlanTestCase[] = [
    {
      input: 'Add dark mode to the settings page',
      expectedStructure: {
        phases: ['research', 'plan', 'execute', 'test'],
        minSteps: 4,
        requiredPhases: ['execute', 'test']
      },
      description: 'should generate a complete plan for dark mode feature'
    },
    {
      input: 'Fix the login bug where users get stuck',
      expectedStructure: {
        minSteps: 3,
        requiredPhases: ['research', 'execute', 'test']
      },
      description: 'should generate a bug fix plan with investigation and testing'
    },
    {
      input: 'Refactor the authentication module for better security',
      expectedStructure: {
        phases: ['evaluate', 'research', 'plan', 'execute', 'test'],
        minSteps: 5,
        requiredPhases: ['research', 'execute', 'test']
      },
      description: 'should generate a refactoring plan with thorough phases'
    }
  ];

  for (const testCase of testCases) {
    it(testCase.description, async () => {
      const plan = await generatePlan(testCase.input);
      const result = scorePlanStructure(plan, testCase.expectedStructure);
      
      expect(result.score).toBeGreaterThanOrEqual(0.8);
      
      if (result.score < 1) {
        console.log('Plan structure details:', result.details.join('\n'));
      }
    });
  }
});

describe('Plan Generation Quality', () => {
  it('should generate actionable plans', async () => {
    const plan = await generatePlan('Add user profile editing feature');
    const result = await scorePlanQuality(plan, 'Add user profile editing feature');
    
    expect(result.score).toBeGreaterThanOrEqual(0.7);
  });

  it('should maintain correct phase order', async () => {
    const plan = await generatePlan('Implement new feature');
    
    const phaseIndices = plan.steps.map(s => WORKFLOW_PHASES.indexOf(s.phase));
    const isOrdered = phaseIndices.every((val, i, arr) => i === 0 || val >= arr[i - 1]);
    
    expect(isOrdered).toBe(true);
  });

  it('should include testing in all plans', async () => {
    const plan = await generatePlan('Quick fix for typo');
    const hasTest = plan.steps.some(s => s.phase === 'test');
    
    expect(hasTest).toBe(true);
  });
});

describe('Plan Generation Edge Cases', () => {
  it('handles vague requirements', async () => {
    const plan = await generatePlan('Make it better');
    expect(plan.steps.length).toBeGreaterThanOrEqual(3);
  });

  it('handles complex multi-part requests', async () => {
    const plan = await generatePlan(
      'Add authentication, implement user profiles, and create an admin dashboard'
    );
    expect(plan.steps.length).toBeGreaterThanOrEqual(5);
  });
});


