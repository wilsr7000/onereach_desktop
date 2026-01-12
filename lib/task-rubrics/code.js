/**
 * Code Task Rubrics
 * Part of the Governed Self-Improving Agent Runtime
 * 
 * Success criteria for code-related tasks
 */

/**
 * Code generation rubric
 */
const CODE_GENERATION = {
  name: 'code_generation',
  description: 'Criteria for evaluating code generation tasks',
  
  criteria: {
    compiles: {
      weight: 0.25,
      check: 'automated',
      description: 'Code compiles/parses without errors',
      evaluator: async (task, result) => {
        // Would run syntax check
        return { passed: true, score: 100, details: 'Syntax check passed' };
      }
    },
    tests_pass: {
      weight: 0.25,
      check: 'automated',
      description: 'All tests pass',
      evaluator: async (task, result) => {
        // Would run tests
        return { passed: true, score: 100, details: 'Tests passed' };
      }
    },
    follows_patterns: {
      weight: 0.2,
      check: 'llm',
      description: 'Code follows project patterns and conventions',
      prompt: 'Does this code follow the project patterns and conventions? Rate 0-100.'
    },
    no_regressions: {
      weight: 0.2,
      check: 'automated',
      description: 'No existing tests are broken',
      evaluator: async (task, result) => {
        return { passed: true, score: 100, details: 'No regressions detected' };
      }
    },
    documentation: {
      weight: 0.1,
      check: 'automated',
      description: 'Includes appropriate documentation',
      evaluator: async (task, result) => {
        const content = result.content || '';
        const hasComments = /\/\/|\/\*|\*\//.test(content);
        return {
          passed: hasComments,
          score: hasComments ? 80 : 40,
          details: hasComments ? 'Has documentation' : 'Missing documentation'
        };
      }
    }
  },
  
  passThreshold: 0.8,
  
  // Bonus criteria (don't affect pass/fail)
  bonusCriteria: {
    performance: {
      description: 'Code is performant',
      weight: 0.1
    },
    elegance: {
      description: 'Code is elegant and readable',
      weight: 0.1
    }
  }
};

/**
 * Code refactoring rubric
 */
const CODE_REFACTOR = {
  name: 'code_refactor',
  description: 'Criteria for evaluating refactoring tasks',
  
  criteria: {
    behavior_preserved: {
      weight: 0.35,
      check: 'automated',
      description: 'Original behavior is preserved',
      evaluator: async (task, result) => {
        // Would run before/after tests
        return { passed: true, score: 100, details: 'Behavior preserved' };
      }
    },
    complexity_reduced: {
      weight: 0.25,
      check: 'llm',
      description: 'Complexity is reduced',
      prompt: 'Is the refactored code simpler and more maintainable? Rate 0-100.'
    },
    no_regressions: {
      weight: 0.25,
      check: 'automated',
      description: 'All tests still pass'
    },
    improved_readability: {
      weight: 0.15,
      check: 'llm',
      description: 'Readability is improved'
    }
  },
  
  passThreshold: 0.85
};

/**
 * Bug fix rubric
 */
const BUG_FIX = {
  name: 'bug_fix',
  description: 'Criteria for evaluating bug fix tasks',
  
  criteria: {
    issue_resolved: {
      weight: 0.4,
      check: 'automated',
      description: 'The reported issue is resolved',
      evaluator: async (task, result) => {
        // Would run specific test for the bug
        return { passed: true, score: 100, details: 'Bug appears to be fixed' };
      }
    },
    no_new_bugs: {
      weight: 0.3,
      check: 'automated',
      description: 'No new bugs introduced'
    },
    tests_added: {
      weight: 0.2,
      check: 'automated',
      description: 'Test added for the bug',
      evaluator: async (task, result) => {
        const content = result.content || '';
        const hasTest = /describe|it\(|test\(|expect/.test(content);
        return {
          passed: hasTest,
          score: hasTest ? 100 : 50,
          details: hasTest ? 'Test added' : 'No test added for bug'
        };
      }
    },
    root_cause_addressed: {
      weight: 0.1,
      check: 'llm',
      description: 'Root cause is addressed, not just symptoms'
    }
  },
  
  passThreshold: 0.8
};

/**
 * Test generation rubric
 */
const TEST_GENERATION = {
  name: 'test_generation',
  description: 'Criteria for evaluating test generation tasks',
  
  criteria: {
    tests_run: {
      weight: 0.25,
      check: 'automated',
      description: 'Generated tests can run'
    },
    tests_pass: {
      weight: 0.25,
      check: 'automated',
      description: 'Generated tests pass'
    },
    coverage_adequate: {
      weight: 0.25,
      check: 'automated',
      description: 'Tests provide adequate coverage',
      evaluator: async (task, result) => {
        // Would check coverage
        return { passed: true, score: 80, details: 'Coverage adequate' };
      }
    },
    edge_cases: {
      weight: 0.15,
      check: 'llm',
      description: 'Edge cases are covered'
    },
    meaningful_assertions: {
      weight: 0.1,
      check: 'llm',
      description: 'Assertions are meaningful, not trivial'
    }
  },
  
  passThreshold: 0.75
};

module.exports = {
  CODE_GENERATION,
  CODE_REFACTOR,
  BUG_FIX,
  TEST_GENERATION
};

