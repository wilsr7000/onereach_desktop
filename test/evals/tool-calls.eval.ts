/**
 * Tool Call Validation Evals
 * Part of the Governed Self-Improving Agent Runtime
 * 
 * Tests that GSX Create selects the correct tools for various prompts
 */

import { describe, it, expect } from 'vitest';

// Types for tool call evaluation
interface ToolCall {
  name: string;
  arguments?: Record<string, unknown>;
}

interface ToolCallTestCase {
  input: string;
  expectedTools: Array<{
    name: string | RegExp;
    arguments?: Record<string, unknown | RegExp>;
  }>;
  description: string;
}

// Mock GSX Create tool selection (to be replaced with actual implementation)
async function getToolCalls(prompt: string): Promise<ToolCall[]> {
  // This would connect to the actual GSX Create tool selection logic
  // For now, return mock data based on prompt patterns
  if (prompt.toLowerCase().includes('create') && prompt.toLowerCase().includes('component')) {
    return [{ name: 'aider:add-file', arguments: { path: 'src/components/Button.tsx' } }];
  }
  if (prompt.toLowerCase().includes('run') && prompt.toLowerCase().includes('lint')) {
    return [{ name: 'terminal:run', arguments: { command: 'npm run lint' } }];
  }
  if (prompt.toLowerCase().includes('read') && prompt.toLowerCase().includes('file')) {
    return [{ name: 'file:read', arguments: { path: 'src/index.js' } }];
  }
  if (prompt.toLowerCase().includes('search')) {
    return [{ name: 'search:codebase', arguments: { query: prompt } }];
  }
  return [];
}

// Tool call scorer
function scoreToolCalls(
  actual: ToolCall[],
  expected: Array<{ name: string | RegExp; arguments?: Record<string, unknown | RegExp> }>
): { score: number; matches: boolean[]; details: string[] } {
  const details: string[] = [];
  const matches: boolean[] = [];

  for (const exp of expected) {
    const found = actual.find(tool => {
      const nameMatch = exp.name instanceof RegExp 
        ? exp.name.test(tool.name)
        : tool.name === exp.name;
      
      if (!nameMatch) return false;
      
      if (exp.arguments) {
        for (const [key, value] of Object.entries(exp.arguments)) {
          const actualValue = tool.arguments?.[key];
          if (value instanceof RegExp) {
            if (!value.test(String(actualValue))) return false;
          } else if (actualValue !== value) {
            return false;
          }
        }
      }
      return true;
    });

    if (found) {
      matches.push(true);
      details.push(`✓ Found expected tool: ${exp.name}`);
    } else {
      matches.push(false);
      details.push(`✗ Missing expected tool: ${exp.name}`);
    }
  }

  const score = matches.filter(Boolean).length / Math.max(matches.length, 1);
  return { score, matches, details };
}

describe('GSX Create Tool Selection', () => {
  const testCases: ToolCallTestCase[] = [
    {
      input: 'Create a new React component called Button',
      expectedTools: [
        { name: /aider/, arguments: { path: /Button/ } }
      ],
      description: 'should select file creation tool for component creation'
    },
    {
      input: 'Run the linter on src/',
      expectedTools: [
        { name: /terminal/, arguments: { command: /lint/ } }
      ],
      description: 'should select terminal tool for linting'
    },
    {
      input: 'Read the contents of src/index.js',
      expectedTools: [
        { name: /file:read/ }
      ],
      description: 'should select file read tool'
    },
    {
      input: 'Search for all uses of useState in the codebase',
      expectedTools: [
        { name: /search/ }
      ],
      description: 'should select search tool for codebase queries'
    }
  ];

  for (const testCase of testCases) {
    it(testCase.description, async () => {
      const tools = await getToolCalls(testCase.input);
      const result = scoreToolCalls(tools, testCase.expectedTools);
      
      expect(result.score).toBeGreaterThanOrEqual(0.9);
      
      if (result.score < 1) {
        console.log('Tool call details:', result.details.join('\n'));
      }
    });
  }
});

describe('Tool Selection Edge Cases', () => {
  it('should handle ambiguous prompts gracefully', async () => {
    const tools = await getToolCalls('Do something with the code');
    // Should not crash, may return empty or default tools
    expect(Array.isArray(tools)).toBe(true);
  });

  it('should handle empty prompts', async () => {
    const tools = await getToolCalls('');
    expect(Array.isArray(tools)).toBe(true);
  });
});

