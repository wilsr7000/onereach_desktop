/**
 * Claude Code Templates
 *
 * Template definitions for the Claude Code UI component.
 * Templates define different AI-assisted tasks with their
 * backend (API or CLI), prompts, and configuration.
 */

/**
 * Template backends
 * - api: Uses Claude API directly (Phase 1)
 * - cli: Uses bundled Claude Code CLI (Phase 2)
 */
const BACKEND = {
  API: 'api',
  CLI: 'cli',
};

/**
 * Template definitions
 */
const TEMPLATES = {
  // ==================== Phase 1 Templates (Claude API) ====================

  'create-agent': {
    id: 'create-agent',
    name: 'Create Voice Agent',
    description: 'Generate a voice agent from natural language description',
    icon: 'agent',
    backend: BACKEND.API,
    placeholder: 'Describe what the agent should do...',
    examples: [
      'An agent that helps me write professional emails',
      'A research assistant that summarizes articles and papers',
      'An agent that helps with meeting notes and action items',
      'A coding helper that explains error messages',
    ],
    minInputLength: 10,
    maxInputLength: 1000,
  },

  // ==================== Phase 2 Templates (Claude Code CLI) ====================

  'refactor-code': {
    id: 'refactor-code',
    name: 'Refactor Code',
    description: 'Improve code quality, structure, and maintainability',
    icon: 'code',
    backend: BACKEND.CLI,
    requiresWorkingDir: true,
    placeholder: 'What needs refactoring? Be specific about files or patterns...',
    examples: [
      'Extract the validation logic from user-service.js into a separate module',
      'Convert callback-based functions to async/await in the api folder',
      'Add TypeScript types to the utils directory',
    ],
    systemPrompt: `You are an expert code refactoring assistant. Your goal is to improve code quality while maintaining functionality.

Guidelines:
- Preserve existing behavior unless explicitly asked to change it
- Follow the project's existing coding style and conventions
- Add comments explaining significant changes
- Run tests after refactoring if available
- Create small, focused commits`,
    minInputLength: 10,
    maxInputLength: 2000,
  },

  'build-feature': {
    id: 'build-feature',
    name: 'Build Feature',
    description: 'Implement a new feature from description',
    icon: 'plus',
    backend: BACKEND.CLI,
    requiresWorkingDir: true,
    placeholder: 'Describe the feature you want to build...',
    examples: [
      'Add a dark mode toggle to the settings page',
      'Implement user authentication with email/password',
      'Create a REST API endpoint for managing todos',
    ],
    systemPrompt: `You are an expert software developer. Build features following best practices.

Guidelines:
- Understand the existing codebase structure before making changes
- Follow existing patterns and conventions
- Write clean, maintainable code
- Include error handling and edge cases
- Add basic tests if a test framework is present`,
    minInputLength: 10,
    maxInputLength: 2000,
  },

  'fix-bug': {
    id: 'fix-bug',
    name: 'Fix Bug',
    description: 'Debug and fix issues in your code',
    icon: 'warning',
    backend: BACKEND.CLI,
    requiresWorkingDir: true,
    placeholder: 'Describe the bug or paste the error message...',
    examples: [
      'TypeError: Cannot read property "map" of undefined in Dashboard.jsx',
      'The login form submits twice when clicking the button',
      'API calls fail with CORS errors in production',
    ],
    systemPrompt: `You are an expert debugger. Your goal is to identify and fix bugs efficiently.

Guidelines:
- First understand what the code is supposed to do
- Identify the root cause, not just symptoms
- Fix the bug with minimal changes
- Add safeguards to prevent similar bugs
- Explain what caused the bug and how you fixed it`,
    minInputLength: 10,
    maxInputLength: 3000,
  },

  'write-tests': {
    id: 'write-tests',
    name: 'Write Tests',
    description: 'Generate tests for your code',
    icon: 'check',
    backend: BACKEND.CLI,
    requiresWorkingDir: true,
    placeholder: 'Which code should be tested? Specify files or functions...',
    examples: [
      'Write unit tests for the UserService class',
      'Add integration tests for the checkout API endpoints',
      'Create tests for the form validation utilities',
    ],
    systemPrompt: `You are an expert at writing comprehensive tests.

Guidelines:
- Use the project's existing test framework and patterns
- Test both happy paths and edge cases
- Write clear test descriptions
- Mock external dependencies appropriately
- Aim for good coverage without excessive tests`,
    minInputLength: 10,
    maxInputLength: 2000,
  },

  'explain-code': {
    id: 'explain-code',
    name: 'Explain Code',
    description: 'Get explanations of how code works',
    icon: 'info',
    backend: BACKEND.CLI,
    requiresWorkingDir: true,
    placeholder: 'What code do you want explained?',
    examples: [
      'Explain how the authentication middleware works',
      'What does the useReducer hook do in CartContext.js?',
      'Walk me through the payment processing flow',
    ],
    systemPrompt: `You are a patient teacher explaining code to developers.

Guidelines:
- Start with a high-level overview
- Break down complex logic into understandable steps
- Explain the "why" not just the "what"
- Point out any potential issues or improvements
- Use analogies when helpful`,
    minInputLength: 5,
    maxInputLength: 1000,
  },
};

/**
 * Get all templates
 * @param {Object} options - Filter options
 * @param {string} options.backend - Filter by backend type ('api' or 'cli')
 * @returns {Object[]} Array of templates
 */
function getTemplates(options = {}) {
  let templates = Object.values(TEMPLATES);

  if (options.backend) {
    templates = templates.filter((t) => t.backend === options.backend);
  }

  return templates;
}

/**
 * Get a template by ID
 * @param {string} id - Template ID
 * @returns {Object|undefined} Template or undefined if not found
 */
function getTemplate(id) {
  return TEMPLATES[id];
}

/**
 * Get templates available for Phase 1 (API-based)
 * @returns {Object[]} Array of API templates
 */
function getPhase1Templates() {
  return getTemplates({ backend: BACKEND.API });
}

/**
 * Get templates available for Phase 2 (CLI-based)
 * @returns {Object[]} Array of CLI templates
 */
function getPhase2Templates() {
  return getTemplates({ backend: BACKEND.CLI });
}

/**
 * Check if a template requires CLI backend
 * @param {string} templateId - Template ID
 * @returns {boolean}
 */
function requiresCLI(templateId) {
  const template = getTemplate(templateId);
  return template?.backend === BACKEND.CLI;
}

module.exports = {
  TEMPLATES,
  BACKEND,
  getTemplates,
  getTemplate,
  getPhase1Templates,
  getPhase2Templates,
  requiresCLI,
};
