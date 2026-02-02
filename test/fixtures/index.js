/**
 * Test Fixtures
 * Part of the Governed Self-Improving Agent Runtime Testing Infrastructure
 * 
 * Factory functions for test data
 */

export * from './spaces.js';
export * from './aider-responses.js';
export * from './plans.js';
export * from './errors.js';

// Re-export defaults for convenience
import spaces from './spaces.js';
import aiderResponses from './aider-responses.js';
import plans from './plans.js';
import errors from './errors.js';

export default {
  ...spaces,
  ...aiderResponses,
  ...plans,
  ...errors
};
