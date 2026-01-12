/**
 * Aider Response Fixtures
 * Part of the Governed Self-Improving Agent Runtime Testing Infrastructure
 */

/**
 * Create a successful Aider response
 */
export function createAiderResponse(overrides = {}) {
  return {
    success: true,
    response: overrides.response || '// Generated code\nfunction example() {\n  return true;\n}',
    filesChanged: overrides.filesChanged || ['src/example.js'],
    tokensUsed: overrides.tokensUsed || { input: 200, output: 100 },
    model: overrides.model || 'claude-3-opus',
    duration: overrides.duration || 1500,
    ...overrides
  };
}

/**
 * Create a failed Aider response
 */
export function createAiderError(overrides = {}) {
  return {
    success: false,
    error: overrides.error || 'Failed to generate code',
    errorType: overrides.errorType || 'generation_error',
    tokensUsed: overrides.tokensUsed || { input: 200, output: 0 },
    ...overrides
  };
}

/**
 * Create a code generation response
 */
export function createCodeGenResponse(language = 'javascript', overrides = {}) {
  const codeByLanguage = {
    javascript: `function processData(input) {
  if (!input) {
    throw new Error('Input is required');
  }
  return input.map(item => item.toUpperCase());
}

module.exports = { processData };`,
    typescript: `interface DataItem {
  id: string;
  value: number;
}

export function processData(input: DataItem[]): DataItem[] {
  if (!input?.length) {
    throw new Error('Input is required');
  }
  return input.filter(item => item.value > 0);
}`,
    python: `def process_data(input_data):
    """Process input data and return transformed result."""
    if not input_data:
        raise ValueError("Input is required")
    return [item.upper() for item in input_data]`
  };

  return createAiderResponse({
    response: codeByLanguage[language] || codeByLanguage.javascript,
    filesChanged: [`src/processor.${language === 'python' ? 'py' : language === 'typescript' ? 'ts' : 'js'}`],
    ...overrides
  });
}

/**
 * Create a refactoring response
 */
export function createRefactorResponse(overrides = {}) {
  return createAiderResponse({
    response: `// Refactored code with improved structure
class DataProcessor {
  constructor(options = {}) {
    this.options = options;
  }

  process(input) {
    this.validate(input);
    return this.transform(input);
  }

  validate(input) {
    if (!input) throw new Error('Input required');
  }

  transform(input) {
    return input.map(i => i.toUpperCase());
  }
}

module.exports = { DataProcessor };`,
    filesChanged: ['src/processor.js'],
    ...overrides
  });
}

/**
 * Create a test generation response
 */
export function createTestGenResponse(overrides = {}) {
  return createAiderResponse({
    response: `import { describe, it, expect } from 'vitest';
import { processData } from './processor';

describe('processData', () => {
  it('should process valid input', () => {
    const result = processData(['hello', 'world']);
    expect(result).toEqual(['HELLO', 'WORLD']);
  });

  it('should throw on empty input', () => {
    expect(() => processData(null)).toThrow('Input is required');
  });
});`,
    filesChanged: ['src/processor.test.js'],
    ...overrides
  });
}

export default {
  createAiderResponse,
  createAiderError,
  createCodeGenResponse,
  createRefactorResponse,
  createTestGenResponse
};


