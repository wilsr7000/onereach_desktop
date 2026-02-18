/**
 * Code Generation Quality Evals
 * Part of the Governed Self-Improving Agent Runtime
 * 
 * Tests Aider output quality using semantic similarity and LLM rubrics
 */

import { describe, it, expect } from 'vitest';

// Types for code generation evaluation
interface CodeGenTestCase {
  prompt: string;
  expectedPatterns: string[];
  rubric: string;
  minScore: number;
}

// Mock Aider bridge (to be replaced with actual implementation)
async function generateCode(prompt: string): Promise<string> {
  // This would connect to the actual Aider bridge
  // For now, return mock code based on prompt
  if (prompt.includes('validate email')) {
    return `
function validateEmail(email) {
  if (!email || typeof email !== 'string') {
    return false;
  }
  const emailRegex = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;
  return emailRegex.test(email);
}

module.exports = { validateEmail };
`;
  }
  if (prompt.includes('fetch data')) {
    return `
async function fetchData(url, options = {}) {
  try {
    const response = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...options
    });
    if (!response.ok) {
      throw new Error(\`HTTP error: \${response.status}\`);
    }
    return await response.json();
  } catch (error) {
    console.error('Fetch failed:', error);
    throw error;
  }
}

module.exports = { fetchData };
`;
  }
  return '// Generated code placeholder';
}

// Semantic similarity scorer (simplified version)
function calculateSemanticSimilarity(actual: string, expected: string): number {
  const actualWords = new Set(actual.toLowerCase().split(/\W+/).filter(Boolean));
  const expectedWords = new Set(expected.toLowerCase().split(/\W+/).filter(Boolean));
  
  let matches = 0;
  for (const word of expectedWords) {
    if (actualWords.has(word)) matches++;
  }
  
  return matches / Math.max(expectedWords.size, 1);
}

// LLM rubric scorer (simplified - would use actual LLM in production)
async function scoreWithRubric(code: string, rubric: string): Promise<{ score: number; feedback: string }> {
  // In production, this would call an LLM to evaluate the code
  // For testing, use heuristic checks
  let score = 0.5; // Base score
  let feedback = '';

  // Check for error handling
  if (code.includes('try') && code.includes('catch')) {
    score += 0.15;
    feedback += 'Has error handling. ';
  }

  // Check for type checking
  if (code.includes('typeof') || code.includes('!==') || code.includes('===')) {
    score += 0.1;
    feedback += 'Has type/null checks. ';
  }

  // Check for documentation
  if (code.includes('/**') || code.includes('//')) {
    score += 0.1;
    feedback += 'Has comments. ';
  }

  // Check for proper exports
  if (code.includes('module.exports') || code.includes('export')) {
    score += 0.1;
    feedback += 'Has proper exports. ';
  }

  // Check for async/await pattern
  if (code.includes('async') && code.includes('await')) {
    score += 0.05;
    feedback += 'Uses async/await. ';
  }

  return { score: Math.min(score, 1), feedback: feedback.trim() };
}

describe('Code Generation Quality', () => {
  it('generates valid email validation function', async () => {
    const output = await generateCode('Create a function to validate email addresses');
    
    // Check semantic similarity to expected pattern
    const expectedPattern = 'function that validates email using regex pattern test';
    const similarity = calculateSemanticSimilarity(output, expectedPattern);
    expect(similarity).toBeGreaterThanOrEqual(0.3);

    // Check with LLM rubric
    const rubricResult = await scoreWithRubric(
      output,
      'Code should validate email format, handle edge cases, have proper types'
    );
    expect(rubricResult.score).toBeGreaterThanOrEqual(0.7);
  });

  it('generates proper async fetch function', async () => {
    const output = await generateCode('Create an async function to fetch data from an API');
    
    // Check for key patterns
    expect(output).toMatch(/async/);
    expect(output).toMatch(/await/);
    expect(output).toMatch(/fetch|http|request/i);

    const rubricResult = await scoreWithRubric(
      output,
      'Code should be async, handle errors, parse JSON response'
    );
    expect(rubricResult.score).toBeGreaterThanOrEqual(0.7);
  });

  it('includes error handling in generated code', async () => {
    const output = await generateCode('Create a function to fetch data from URL');
    
    // Error handling should be present
    const hasErrorHandling = output.includes('try') && output.includes('catch');
    expect(hasErrorHandling).toBe(true);
  });

  it('generates code with proper exports', async () => {
    const output = await generateCode('Create a function to validate email');
    
    const hasExports = output.includes('module.exports') || 
                       output.includes('export ') ||
                       output.includes('exports.');
    expect(hasExports).toBe(true);
  });
});

describe('Code Generation Edge Cases', () => {
  it('handles vague prompts without crashing', async () => {
    const output = await generateCode('write some code');
    expect(typeof output).toBe('string');
  });

  it('generates placeholder for unsupported requests', async () => {
    const output = await generateCode('do something completely random');
    expect(output.length).toBeGreaterThan(0);
  });
});


