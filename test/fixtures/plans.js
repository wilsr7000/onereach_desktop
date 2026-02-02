/**
 * Plan Fixtures
 * Part of the Governed Self-Improving Agent Runtime Testing Infrastructure
 */

let planCounter = 0;

/**
 * Create a test plan
 */
export function createPlan(overrides = {}) {
  const id = overrides.id || `plan-${++planCounter}`;
  return {
    id,
    name: overrides.name || 'Test Plan',
    description: overrides.description || 'A test plan for unit testing',
    phases: overrides.phases || ['research', 'plan', 'execute', 'test', 'improve'],
    steps: overrides.steps || [
      { phase: 'research', description: 'Research requirements', status: 'pending' },
      { phase: 'plan', description: 'Create implementation plan', status: 'pending' },
      { phase: 'execute', description: 'Implement changes', status: 'pending' },
      { phase: 'test', description: 'Run tests', status: 'pending' },
      { phase: 'improve', description: 'Address issues', status: 'pending' }
    ],
    createdAt: overrides.createdAt || new Date().toISOString(),
    status: overrides.status || 'pending',
    metadata: overrides.metadata || {},
    ...overrides
  };
}

/**
 * Create a plan in progress
 */
export function createInProgressPlan(currentPhase = 'execute', overrides = {}) {
  const phaseOrder = ['research', 'plan', 'execute', 'test', 'improve'];
  const currentIndex = phaseOrder.indexOf(currentPhase);
  
  const steps = phaseOrder.map((phase, index) => ({
    phase,
    description: `${phase.charAt(0).toUpperCase() + phase.slice(1)} step`,
    status: index < currentIndex ? 'completed' : index === currentIndex ? 'in_progress' : 'pending'
  }));

  return createPlan({
    steps,
    status: 'in_progress',
    currentPhase,
    ...overrides
  });
}

/**
 * Create a completed plan
 */
export function createCompletedPlan(overrides = {}) {
  return createPlan({
    status: 'completed',
    completedAt: new Date().toISOString(),
    steps: [
      { phase: 'research', description: 'Research requirements', status: 'completed' },
      { phase: 'plan', description: 'Create implementation plan', status: 'completed' },
      { phase: 'execute', description: 'Implement changes', status: 'completed' },
      { phase: 'test', description: 'Run tests', status: 'completed' },
      { phase: 'improve', description: 'Address issues', status: 'completed' }
    ],
    results: {
      testsRun: 10,
      testsPassed: 10,
      filesChanged: 3,
      linesAdded: 150,
      linesRemoved: 30
    },
    ...overrides
  });
}

/**
 * Create a feature plan (more detailed)
 */
export function createFeaturePlan(featureName = 'New Feature', overrides = {}) {
  return createPlan({
    name: `Implement ${featureName}`,
    description: `Plan to implement ${featureName} with full test coverage`,
    phases: ['evaluate', 'research', 'plan', 'execute', 'test', 'improve', 'finalize'],
    steps: [
      { phase: 'evaluate', description: 'Evaluate requirements', status: 'pending', details: [] },
      { phase: 'research', description: 'Research existing solutions', status: 'pending', details: [] },
      { phase: 'plan', description: 'Design architecture', status: 'pending', details: [] },
      { phase: 'execute', description: 'Implement feature', status: 'pending', details: [] },
      { phase: 'test', description: 'Write and run tests', status: 'pending', details: [] },
      { phase: 'improve', description: 'Optimize and refactor', status: 'pending', details: [] },
      { phase: 'finalize', description: 'Documentation and cleanup', status: 'pending', details: [] }
    ],
    metadata: {
      feature: featureName,
      priority: 'high',
      estimatedHours: 8
    },
    ...overrides
  });
}

/**
 * Reset the plan counter (call between tests)
 */
export function resetPlanCounter() {
  planCounter = 0;
}

export default {
  createPlan,
  createInProgressPlan,
  createCompletedPlan,
  createFeaturePlan,
  resetPlanCounter
};


