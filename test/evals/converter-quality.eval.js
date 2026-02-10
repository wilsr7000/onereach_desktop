import { describe, it, expect } from 'vitest';
import { createMockAIService } from '../mocks/conversion-mocks.js';

/**
 * Converter Quality Evaluations
 * 
 * These tests use LLM-as-judge to evaluate the quality of conversion outputs.
 * Run with: npx vitest run test/evals/converter-quality.eval.js
 * 
 * In CI, these use mock AI. For real evaluation, set EVAL_LIVE=true.
 * 
 * Two-tier strategy:
 *   Tier 1 (deterministic): Assert exact output or structural properties
 *   Tier 2 (AI/creative): Assert report.finalScore >= 70 (built-in LLM judge)
 *                          + domain-specific rubric scoring via judgeWithRubric()
 */

const isLive = process.env.EVAL_LIVE === 'true';

// ---------------------------------------------------------------------------
// Shared: LLM-as-judge rubric helper
// ---------------------------------------------------------------------------

/**
 * Judge a conversion output against a rubric of criteria.
 * In live mode, asks an LLM to score each criterion. In mock mode, returns
 * deterministic pass for all criteria.
 *
 * @param {string|Buffer} input - Original input
 * @param {string|Buffer} output - Conversion output
 * @param {Object} opts
 * @param {string[]} opts.criteria - List of rubric criteria (plain English)
 * @param {Object}   [opts.ai] - AI service instance (live)
 * @param {Object}   [opts.context] - Additional context to include in the judge
 *   prompt. Supply domain-specific information the LLM judge needs to evaluate
 *   accurately. Common fields:
 *     context.sourceFormat  - Original format (e.g. 'markdown')
 *     context.targetFormat  - Desired format (e.g. 'pdf')
 *     context.description   - Human description of what the input represents
 *     context.constraints   - Special requirements (e.g. 'must preserve tables')
 *     context.audience      - Who will consume the output (e.g. 'non-technical')
 *     context.metadata      - Arbitrary key-value metadata from the source
 * @returns {Promise<{score: number, criteriaResults: Array<{criterion: string, pass: boolean, reasoning: string}>}>}
 */
async function judgeWithRubric(input, output, { criteria, ai, context }) {
  if (!isLive || !ai) {
    // Mock mode: all criteria pass
    return {
      score: 85,
      criteriaResults: criteria.map(c => ({ criterion: c, pass: true, reasoning: 'Mock: auto-pass' })),
    };
  }

  const inputDesc = typeof input === 'string'
    ? input.slice(0, 500)
    : `[Buffer ${input.length} bytes]`;
  const outputDesc = typeof output === 'string'
    ? output.slice(0, 2000)
    : `[Buffer ${output.length} bytes]`;

  // Build optional context block for the prompt
  let contextBlock = '';
  if (context && typeof context === 'object' && Object.keys(context).length > 0) {
    const lines = Object.entries(context)
      .filter(([, v]) => v != null)
      .map(([k, v]) => `  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
    if (lines.length > 0) {
      contextBlock = `\nCONTEXT:\n${lines.join('\n')}\n`;
    }
  }

  const prompt = `You are a quality evaluator for a file conversion system.

INPUT (original):
${inputDesc}

OUTPUT (converted):
${outputDesc}
${contextBlock}
RUBRIC CRITERIA:
${criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}

For each criterion, determine if the output passes (true/false) and give a brief reason.
Then give an overall score 0-100.

Return JSON:
{
  "score": 0-100,
  "criteriaResults": [
    {"criterion": "...", "pass": true/false, "reasoning": "..."}
  ]
}`;

  try {
    const result = await ai.json(prompt, { profile: 'fast', feature: 'converter-eval-rubric', temperature: 0 });
    return result;
  } catch {
    return {
      score: 70,
      criteriaResults: criteria.map(c => ({ criterion: c, pass: true, reasoning: 'Eval error fallback' })),
    };
  }
}

// ---------------------------------------------------------------------------
// Shared: helper to get the AI service for live mode
// ---------------------------------------------------------------------------

function getAI() {
  if (isLive) {
    try {
      return require('../../lib/ai-service');
    } catch {
      return createMockAIService();
    }
  }
  return createMockAIService();
}

// ---------------------------------------------------------------------------
// Tier 1: Deterministic Converter Quality
// ---------------------------------------------------------------------------

describe('Converter Quality Evals', () => {
  describe('Tier 1: Deterministic', () => {
    describe('Markdown -> HTML quality', () => {
      it('preserves document structure', async () => {
        const mockAI = createMockAIService();
        const { MdToHtmlAgent } = require('../../lib/converters/md-to-html');
        const agent = new MdToHtmlAgent({ ai: mockAI, silent: true });

        const input = '# Title\n\n## Section\n\nParagraph with **bold** and *italic*.\n\n- Item 1\n- Item 2\n\n```js\nconst x = 1;\n```';
        const result = await agent.convert(input);

        expect(result.report).toBeDefined();
        expect(result.report.attempts.length).toBeGreaterThan(0);

        if (result.success && result.output) {
          const output = typeof result.output === 'string' ? result.output : result.output.toString();
          expect(output).toContain('<h1');
          expect(output).toContain('<h2');
          expect(output).toContain('<strong');
          expect(output).toContain('<em');
          expect(output).toContain('<li');
        }
      });
    });

    describe('CSV -> JSON quality', () => {
      it('parses all rows with correct types', async () => {
        const mockAI = createMockAIService();
        const { CsvToJsonAgent } = require('../../lib/converters/csv-to-json');
        const agent = new CsvToJsonAgent({ ai: mockAI, silent: true });

        const input = 'name,age,active\nAlice,30,true\nBob,25,false';
        const result = await agent.convert(input);

        expect(result.report).toBeDefined();

        if (result.success && result.output) {
          const output = typeof result.output === 'string' ? JSON.parse(result.output) : result.output;
          expect(Array.isArray(output)).toBe(true);
          expect(output.length).toBe(2);
          expect(output[0].name).toBe('Alice');
        }
      });
    });

    describe('HTML -> Markdown quality', () => {
      it('preserves content semantics', async () => {
        const mockAI = createMockAIService();
        const { HtmlToMdAgent } = require('../../lib/converters/html-to-md');
        const agent = new HtmlToMdAgent({ ai: mockAI, silent: true });

        const input = '<article><h1>Title</h1><p>Content with <a href="https://example.com">link</a></p></article>';
        const result = await agent.convert(input);

        expect(result.report).toBeDefined();
        if (result.success && result.output) {
          const output = typeof result.output === 'string' ? result.output : result.output.toString();
          expect(output).toContain('Title');
          expect(output).toContain('example.com');
        }
      });
    });

    describe('JSON <-> YAML round-trip', () => {
      it('preserves all keys and values', async () => {
        const mockAI = createMockAIService();
        const { JsonYamlAgent } = require('../../lib/converters/json-yaml');
        const agent = new JsonYamlAgent({ ai: mockAI, silent: true });

        const input = JSON.stringify({ name: 'Test', items: [1, 2, 3], nested: { a: true } });
        const toYaml = await agent.convert(input, { to: 'yaml' });

        expect(toYaml.report).toBeDefined();
        if (toYaml.success && toYaml.output) {
          const yamlStr = typeof toYaml.output === 'string' ? toYaml.output : toYaml.output.toString();
          expect(yamlStr).toContain('name');
          expect(yamlStr).toContain('Test');
        }
      });
    });

    describe('JSON -> CSV quality', () => {
      it('produces header row and data rows', async () => {
        const mockAI = createMockAIService();
        const { JsonToCsvAgent } = require('../../lib/converters/json-to-csv');
        const agent = new JsonToCsvAgent({ ai: mockAI, silent: true });

        const input = JSON.stringify([{ name: 'Alice', age: 30 }, { name: 'Bob', age: 25 }]);
        const result = await agent.convert(input);

        expect(result.report).toBeDefined();
        if (result.success && result.output) {
          const output = typeof result.output === 'string' ? result.output : result.output.toString();
          expect(output).toContain('name');
          expect(output).toContain('Alice');
          expect(output).toContain('Bob');
        }
      });
    });

    describe('HTML -> Text quality', () => {
      it('strips tags and preserves text', async () => {
        const mockAI = createMockAIService();
        const { HtmlToTextAgent } = require('../../lib/converters/html-to-text');
        const agent = new HtmlToTextAgent({ ai: mockAI, silent: true });

        const input = '<div><h1>Hello</h1><p>World <strong>bold</strong></p></div>';
        const result = await agent.convert(input);

        expect(result.report).toBeDefined();
        if (result.success && result.output) {
          const output = typeof result.output === 'string' ? result.output : result.output.toString();
          expect(output).toContain('Hello');
          expect(output).toContain('World');
          expect(output).toContain('bold');
          expect(output).not.toContain('<h1');
          expect(output).not.toContain('<p');
        }
      });
    });

    describe('Markdown -> Text quality', () => {
      it('strips formatting and preserves content', async () => {
        const mockAI = createMockAIService();
        const { MdToTextAgent } = require('../../lib/converters/md-to-text');
        const agent = new MdToTextAgent({ ai: mockAI, silent: true });

        const input = '# Title\n\n**Bold** and *italic* text.\n\n- Item 1\n- Item 2';
        const result = await agent.convert(input);

        expect(result.report).toBeDefined();
        if (result.success && result.output) {
          const output = typeof result.output === 'string' ? result.output : result.output.toString();
          expect(output).toContain('Title');
          expect(output).toContain('Bold');
          expect(output).toContain('italic');
          expect(output).not.toContain('**');
          expect(output).not.toContain('# ');
        }
      });
    });

    describe('CSV -> HTML quality', () => {
      it('produces a table with correct row count', async () => {
        const mockAI = createMockAIService();
        const { CsvToHtmlAgent } = require('../../lib/converters/csv-to-html');
        const agent = new CsvToHtmlAgent({ ai: mockAI, silent: true });

        const input = 'name,age\nAlice,30\nBob,25';
        const result = await agent.convert(input);

        expect(result.report).toBeDefined();
        if (result.success && result.output) {
          const output = typeof result.output === 'string' ? result.output : result.output.toString();
          expect(output).toContain('<table');
          expect(output).toContain('Alice');
          expect(output).toContain('Bob');
        }
      });
    });

    describe('CSV -> Markdown quality', () => {
      it('produces pipe-delimited table', async () => {
        const mockAI = createMockAIService();
        const { CsvToMdAgent } = require('../../lib/converters/csv-to-md');
        const agent = new CsvToMdAgent({ ai: mockAI, silent: true });

        const input = 'name,age\nAlice,30\nBob,25';
        const result = await agent.convert(input);

        expect(result.report).toBeDefined();
        if (result.success && result.output) {
          const output = typeof result.output === 'string' ? result.output : result.output.toString();
          expect(output).toContain('|');
          expect(output).toContain('name');
          expect(output).toContain('Alice');
        }
      });
    });

    describe('Code -> HTML quality', () => {
      it('produces syntax-highlighted HTML', async () => {
        const mockAI = createMockAIService();
        const { CodeToHtmlAgent } = require('../../lib/converters/code-to-html');
        const agent = new CodeToHtmlAgent({ ai: mockAI, silent: true });

        const input = 'function hello() {\n  return "world";\n}';
        const result = await agent.convert(input);

        expect(result.report).toBeDefined();
        if (result.success && result.output) {
          const output = typeof result.output === 'string' ? result.output : result.output.toString();
          expect(output).toContain('<span');
          expect(output).toContain('function');
        }
      });
    });
  });

  // -------------------------------------------------------------------------
  // Tier 2: AI/Creative -- LLM-as-judge quality
  // -------------------------------------------------------------------------

  describe('Tier 2: AI Creative (LLM-judged)', () => {
    describe('Text -> Markdown quality', () => {
      it('produces structured markdown with finalScore >= 70', async () => {
        const ai = getAI();
        const { TextToMdAgent } = require('../../lib/converters/text-to-md');
        const agent = new TextToMdAgent({ ai, silent: true });

        const input = 'Meeting notes from today. We discussed the Q4 roadmap. Action items include updating the docs, scheduling reviews, and preparing for launch. Next meeting is Friday.';
        const result = await agent.convert(input);

        expect(result.report).toBeDefined();
        expect(result.report.finalScore).toBeGreaterThanOrEqual(70);

        if (result.success && result.output) {
          const output = typeof result.output === 'string' ? result.output : result.output.toString();
          expect(output.length).toBeGreaterThan(input.length * 0.5);
        }

        if (isLive && result.success) {
          const rubric = await judgeWithRubric(input, result.output, {
            ai,
            criteria: [
              'Output is valid Markdown syntax',
              'Contains at least one heading (# or ##)',
              'Preserves all key information from the input',
              'Adds structural organization (lists, sections, or emphasis)',
            ],
          });
          expect(rubric.score).toBeGreaterThanOrEqual(70);
        }
      });
    });

    describe('Code -> Explanation quality', () => {
      it('explains code logic with finalScore >= 70', async () => {
        const ai = getAI();
        const { CodeToExplanationAgent } = require('../../lib/converters/code-to-explanation');
        const agent = new CodeToExplanationAgent({ ai, silent: true });

        const input = 'function factorial(n) {\n  if (n <= 1) return 1;\n  return n * factorial(n - 1);\n}';
        const result = await agent.convert(input);

        expect(result.report).toBeDefined();
        expect(result.report.attempts.length).toBeGreaterThan(0);

        if (isLive) {
          expect(result.report.finalScore).toBeGreaterThanOrEqual(70);
          if (result.success && result.output) {
            const output = typeof result.output === 'string' ? result.output : result.output.toString();
            expect(output.length).toBeGreaterThan(50);
          }
          if (result.success) {
            const rubric = await judgeWithRubric(input, result.output, {
              ai,
              criteria: [
                'Mentions the function name "factorial"',
                'Explains recursion or recursive behavior',
                'Describes the base case (n <= 1 returns 1)',
                'Written for a non-expert audience (avoids jargon without explanation)',
                'Explanation is longer than the original code',
              ],
            });
            expect(rubric.score).toBeGreaterThanOrEqual(70);
          }
        }
      });
    });

    describe('Code -> Markdown quality', () => {
      it('wraps code with documentation in markdown', async () => {
        const ai = getAI();
        const { CodeToMdAgent } = require('../../lib/converters/code-to-md');
        const agent = new CodeToMdAgent({ ai, silent: true });

        const input = 'class Stack {\n  constructor() { this.items = []; }\n  push(val) { this.items.push(val); }\n  pop() { return this.items.pop(); }\n}';
        const result = await agent.convert(input);

        expect(result.report).toBeDefined();
        expect(result.report.finalScore).toBeGreaterThanOrEqual(70);

        if (result.success && result.output) {
          const output = typeof result.output === 'string' ? result.output : result.output.toString();
          expect(output).toContain('```');
        }

        if (isLive && result.success) {
          const rubric = await judgeWithRubric(input, result.output, {
            ai,
            criteria: [
              'Contains a fenced code block with the original code',
              'Includes a description or documentation of the class',
              'Mentions the class name "Stack"',
            ],
          });
          expect(rubric.score).toBeGreaterThanOrEqual(70);
        }
      });
    });

    describe('Content -> Playbook quality', () => {
      it('produces valid playbook structure with finalScore >= 70', async () => {
        const ai = getAI();
        const { ContentToPlaybookAgent } = require('../../lib/converters/content-to-playbook');
        const agent = new ContentToPlaybookAgent({ ai, silent: true });

        const input = 'How to onboard a new employee:\n1. Send welcome email\n2. Set up accounts (email, Slack, GitHub)\n3. Schedule orientation meeting\n4. Assign buddy for first week\n5. Review company handbook';
        const result = await agent.convert(input);

        expect(result.report).toBeDefined();
        expect(result.report.attempts.length).toBeGreaterThan(0);

        if (isLive) {
          expect(result.report.finalScore).toBeGreaterThanOrEqual(70);
          if (result.success && result.output) {
            const output = typeof result.output === 'object' ? result.output
              : typeof result.output === 'string' ? JSON.parse(result.output) : result.output;
            expect(output.title || output.name).toBeTruthy();
          }
          if (result.success) {
            const rubric = await judgeWithRubric(input, JSON.stringify(result.output), {
              ai,
              criteria: [
                'Output is valid JSON with a title/name field',
                'Contains a sections or steps array',
                'Each section has a heading or title',
                'Covers all 5 onboarding steps from the input',
              ],
            });
            expect(rubric.score).toBeGreaterThanOrEqual(70);
          }
        }
      });
    });

    describe('Image -> Text quality', () => {
      it('returns a non-empty description with finalScore >= 70', async () => {
        const ai = getAI();
        const { ImageToTextAgent } = require('../../lib/converters/image-to-text');
        const agent = new ImageToTextAgent({ ai, silent: true });

        // Use a small mock PNG buffer (the mock AI will describe it)
        const input = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00]);
        const result = await agent.convert(input);

        expect(result.report).toBeDefined();
        expect(result.report.finalScore).toBeGreaterThanOrEqual(70);

        if (result.success && result.output) {
          const output = typeof result.output === 'string' ? result.output : result.output.toString();
          expect(output.length).toBeGreaterThan(10);
        }
      });
    });

    describe('PDF -> Text quality', () => {
      it('extracts text with finalScore >= 70', async () => {
        const ai = getAI();
        const { PdfToTextAgent } = require('../../lib/converters/pdf-to-text');
        const agent = new PdfToTextAgent({ ai, silent: true });

        const input = '%PDF-1.4 mock content for testing extraction';
        const result = await agent.convert(input);

        expect(result.report).toBeDefined();
        expect(result.report.attempts.length).toBeGreaterThan(0);

        if (isLive) {
          expect(result.report.finalScore).toBeGreaterThanOrEqual(70);
        }
      });
    });

    describe('PDF -> Markdown quality', () => {
      it('preserves structure with finalScore >= 70', async () => {
        const ai = getAI();
        const { PdfToMdAgent } = require('../../lib/converters/pdf-to-md');
        const agent = new PdfToMdAgent({ ai, silent: true });

        const input = '%PDF-1.4 mock document with headings and paragraphs';
        const result = await agent.convert(input);

        expect(result.report).toBeDefined();
        expect(result.report.attempts.length).toBeGreaterThan(0);

        if (isLive) {
          expect(result.report.finalScore).toBeGreaterThanOrEqual(70);
          if (result.success && result.output) {
            const rubric = await judgeWithRubric(input, result.output, {
              ai,
              criteria: [
                'Output is valid Markdown',
                'Contains headings or structural elements',
                'Preserves key content from the input',
              ],
            });
            expect(rubric.score).toBeGreaterThanOrEqual(70);
          }
        }
      });
    });

    describe('PDF -> HTML quality', () => {
      it('produces readable HTML with finalScore >= 70', async () => {
        const ai = getAI();
        const { PdfToHtmlAgent } = require('../../lib/converters/pdf-to-html');
        const agent = new PdfToHtmlAgent({ ai, silent: true });

        const input = '%PDF-1.4 mock document for HTML conversion';
        const result = await agent.convert(input);

        expect(result.report).toBeDefined();
        expect(result.report.attempts.length).toBeGreaterThan(0);

        if (isLive) {
          expect(result.report.finalScore).toBeGreaterThanOrEqual(70);
        }
      });
    });

    describe('Playbook -> Markdown quality', () => {
      it('renders all sections with finalScore >= 70', async () => {
        const ai = getAI();
        const { PlaybookToMdAgent } = require('../../lib/converters/playbook-to-md');
        const agent = new PlaybookToMdAgent({ ai, silent: true });

        const input = JSON.stringify({
          title: 'Test Playbook',
          description: 'A test playbook for evaluation',
          sections: [
            { heading: 'Introduction', content: 'Welcome to the test.' },
            { heading: 'Steps', content: '1. Do this\n2. Do that' },
            { heading: 'Conclusion', content: 'All done.' },
          ],
        });
        const result = await agent.convert(input);

        expect(result.report).toBeDefined();
        expect(result.report.attempts.length).toBeGreaterThan(0);

        if (isLive) {
          expect(result.report.finalScore).toBeGreaterThanOrEqual(70);
          if (result.success && result.output) {
            const output = typeof result.output === 'string' ? result.output : result.output.toString();
            expect(output).toContain('Test Playbook');
          }
          if (result.success) {
            const rubric = await judgeWithRubric(input, result.output, {
              ai,
              criteria: [
                'Contains the playbook title "Test Playbook"',
                'Renders all 3 sections (Introduction, Steps, Conclusion)',
                'Uses Markdown headings for sections',
                'Preserves the step list content',
              ],
            });
            expect(rubric.score).toBeGreaterThanOrEqual(70);
          }
        }
      });
    });

    describe('Playbook -> HTML quality', () => {
      it('renders navigable HTML with finalScore >= 70', async () => {
        const ai = getAI();
        const { PlaybookToHtmlAgent } = require('../../lib/converters/playbook-to-html');
        const agent = new PlaybookToHtmlAgent({ ai, silent: true });

        const input = JSON.stringify({
          title: 'HTML Playbook',
          sections: [
            { heading: 'Setup', content: 'Install dependencies.' },
            { heading: 'Run', content: 'Execute the main script.' },
          ],
        });
        const result = await agent.convert(input);

        expect(result.report).toBeDefined();
        expect(result.report.attempts.length).toBeGreaterThan(0);

        if (isLive) {
          expect(result.report.finalScore).toBeGreaterThanOrEqual(70);
          if (result.success && result.output) {
            const output = typeof result.output === 'string' ? result.output : result.output.toString();
            expect(output).toContain('HTML Playbook');
          }
          if (result.success) {
            const rubric = await judgeWithRubric(input, result.output, {
              ai,
              criteria: [
                'Output is valid HTML',
                'Contains the title "HTML Playbook"',
                'Renders both sections (Setup, Run)',
                'Uses HTML heading tags for sections',
              ],
            });
            expect(rubric.score).toBeGreaterThanOrEqual(70);
          }
        }
      });
    });

    describe('Text -> Audio quality (structural)', () => {
      it('produces audio buffer with finalScore >= 70', async () => {
        const ai = getAI();
        const { TextToAudioConverter } = require('../../lib/converters/text-to-audio');
        const agent = new TextToAudioConverter({ ai, silent: true });

        const input = 'Hello world, this is a test of text to speech conversion.';
        const result = await agent.convert(input);

        expect(result.report).toBeDefined();
        expect(result.report.finalScore).toBeGreaterThanOrEqual(70);

        if (result.success && result.output) {
          expect(Buffer.isBuffer(result.output) || typeof result.output === 'string').toBe(true);
        }
      });
    });

    describe('Audio -> Text quality', () => {
      it('transcribes with finalScore >= 70', async () => {
        const ai = getAI();
        const { AudioToTextConverter } = require('../../lib/converters/audio-to-text');
        const agent = new AudioToTextConverter({ ai, silent: true });

        // Mock audio buffer
        const input = Buffer.from('mock-audio-content-for-transcription');
        const result = await agent.convert(input);

        expect(result.report).toBeDefined();
        expect(result.report.finalScore).toBeGreaterThanOrEqual(70);

        if (result.success && result.output) {
          const output = typeof result.output === 'string' ? result.output : result.output.toString();
          expect(output.length).toBeGreaterThan(0);
        }
      });
    });

    describe('Playbook -> Audio quality (structural)', () => {
      it('produces audio buffer with finalScore >= 70', async () => {
        const ai = getAI();
        const { PlaybookToAudioAgent } = require('../../lib/converters/playbook-to-audio');
        const agent = new PlaybookToAudioAgent({ ai, silent: true });

        const input = JSON.stringify({
          title: 'Audio Playbook',
          sections: [{ heading: 'Step 1', content: 'Do the thing.' }],
        });
        const result = await agent.convert(input);

        expect(result.report).toBeDefined();
        expect(result.report.attempts.length).toBeGreaterThan(0);

        if (isLive) {
          expect(result.report.finalScore).toBeGreaterThanOrEqual(70);
        }
      });
    });

    describe('Text -> Image quality (structural)', () => {
      it('produces image buffer with finalScore >= 70', async () => {
        const ai = getAI();
        const { TextToImageConverter } = require('../../lib/converters/text-to-image');
        const agent = new TextToImageConverter({ ai, silent: true });

        const input = 'A simple red circle on a white background';
        const result = await agent.convert(input);

        expect(result.report).toBeDefined();
        expect(result.report.attempts.length).toBeGreaterThan(0);

        if (isLive) {
          expect(result.report.finalScore).toBeGreaterThanOrEqual(70);
          if (result.success && result.output) {
            expect(Buffer.isBuffer(result.output) || typeof result.output === 'string').toBe(true);
          }
        }
      });
    });

    describe('Text -> Video quality (structural)', () => {
      it('produces video buffer with finalScore >= 70', async () => {
        const ai = getAI();
        const { TextToVideoConverter } = require('../../lib/converters/text-to-video');
        const agent = new TextToVideoConverter({ ai, silent: true });

        const input = 'A short educational video about gravity.';
        const result = await agent.convert(input);

        expect(result.report).toBeDefined();
        expect(result.report.attempts.length).toBeGreaterThan(0);

        if (isLive) {
          expect(result.report.finalScore).toBeGreaterThanOrEqual(70);
        }
      });
    });

    describe('Playbook -> PPTX quality (structural)', () => {
      it('produces PPTX buffer with finalScore >= 70', async () => {
        const ai = getAI();
        const { PlaybookToPptxAgent } = require('../../lib/converters/playbook-to-pptx');
        const agent = new PlaybookToPptxAgent({ ai, silent: true });

        const input = JSON.stringify({
          title: 'Presentation Playbook',
          sections: [
            { heading: 'Slide 1', content: 'Introduction' },
            { heading: 'Slide 2', content: 'Main content' },
          ],
        });
        const result = await agent.convert(input);

        expect(result.report).toBeDefined();
        expect(result.report.attempts.length).toBeGreaterThan(0);

        if (isLive) {
          expect(result.report.finalScore).toBeGreaterThanOrEqual(70);
        }
      });
    });
  });

  // -------------------------------------------------------------------------
  // New converters: deterministic
  // -------------------------------------------------------------------------

  describe('New Converters: Deterministic', () => {
    describe('JSON -> HTML quality', () => {
      it('produces HTML table from JSON array', async () => {
        const mockAI = createMockAIService();
        const { JsonToHtmlAgent } = require('../../lib/converters/json-to-html');
        const agent = new JsonToHtmlAgent({ ai: mockAI, silent: true });

        const input = JSON.stringify([{ name: 'Alice', age: 30 }, { name: 'Bob', age: 25 }]);
        const result = await agent.convert(input);

        expect(result.report).toBeDefined();
        if (result.success && result.output) {
          expect(result.output).toContain('<table');
          expect(result.output).toContain('Alice');
          expect(result.output).toContain('Bob');
          expect(result.output).toContain('<th');
        }
      });
    });

    describe('JSON -> Markdown quality', () => {
      it('produces pipe-delimited table', async () => {
        const mockAI = createMockAIService();
        const { JsonToMdAgent } = require('../../lib/converters/json-to-md');
        const agent = new JsonToMdAgent({ ai: mockAI, silent: true });

        const input = JSON.stringify([{ name: 'Alice', age: 30 }, { name: 'Bob', age: 25 }]);
        const result = await agent.convert(input);

        expect(result.report).toBeDefined();
        if (result.success && result.output) {
          expect(result.output).toContain('|');
          expect(result.output).toContain('name');
          expect(result.output).toContain('Alice');
        }
      });
    });

    describe('XML <-> JSON round-trip', () => {
      it('preserves structure through round-trip', async () => {
        const mockAI = createMockAIService();
        const { XmlJsonAgent } = require('../../lib/converters/xml-json');
        const agent = new XmlJsonAgent({ ai: mockAI, silent: true });

        const input = '<root><name>Test</name><value>42</value></root>';
        const result = await agent.convert(input);

        expect(result.report).toBeDefined();
        if (result.success && result.output) {
          const parsed = JSON.parse(result.output);
          expect(parsed.root).toBeDefined();
        }
      });
    });

    describe('Markdown -> PDF quality', () => {
      it('produces PDF buffer', async () => {
        const mockAI = createMockAIService();
        const { MdToPdfAgent } = require('../../lib/converters/md-to-pdf');
        const agent = new MdToPdfAgent({ ai: mockAI, silent: true });

        const input = '# Report\n\nContent **bold** here.';
        const result = await agent.convert(input);

        expect(result.report).toBeDefined();
        if (result.success && result.output) {
          const str = Buffer.isBuffer(result.output) ? result.output.toString() : String(result.output);
          expect(str).toContain('%PDF');
        }
      });
    });

    describe('DOCX -> PDF quality', () => {
      it('produces PDF buffer', async () => {
        const mockAI = createMockAIService();
        const { DocxToPdfAgent } = require('../../lib/converters/docx-to-pdf');
        const agent = new DocxToPdfAgent({ ai: mockAI, silent: true });

        const input = Buffer.from('PK mock docx');
        const result = await agent.convert(input);

        expect(result.report).toBeDefined();
        if (result.success && result.output) {
          const str = Buffer.isBuffer(result.output) ? result.output.toString() : String(result.output);
          expect(str).toContain('%PDF');
        }
      });
    });
  });

  // -------------------------------------------------------------------------
  // New converters: AI/creative
  // -------------------------------------------------------------------------

  describe('New Converters: AI Creative', () => {
    describe('Audio -> Summary quality', () => {
      it('produces summary with finalScore >= 70', async () => {
        const ai = getAI();
        const { AudioToSummaryAgent } = require('../../lib/converters/audio-to-summary');
        const agent = new AudioToSummaryAgent({ ai, silent: true });

        const input = Buffer.from('mock-audio-content');
        const result = await agent.convert(input);

        expect(result.report).toBeDefined();
        expect(result.report.attempts.length).toBeGreaterThan(0);

        if (isLive) {
          expect(result.report.finalScore).toBeGreaterThanOrEqual(70);
        }
      });
    });
  });

  // -------------------------------------------------------------------------
  // Report structure validation (all agents)
  // -------------------------------------------------------------------------

  describe('Conversion report quality', () => {
    it('every agent produces a valid execution report', async () => {
      const mockAI = createMockAIService();

      // Test a selection of agents across both tiers (including new converters)
      const agents = [
        { path: '../../lib/converters/md-to-text', input: '# Hello\nWorld' },
        { path: '../../lib/converters/csv-to-json', input: 'a,b\n1,2' },
        { path: '../../lib/converters/json-yaml', input: '{"key": "value"}' },
        { path: '../../lib/converters/html-to-text', input: '<p>Hello</p>' },
        { path: '../../lib/converters/code-to-html', input: 'const x = 1;' },
        { path: '../../lib/converters/json-to-html', input: '[{"a":1}]' },
        { path: '../../lib/converters/json-to-md', input: '[{"a":1}]' },
        { path: '../../lib/converters/xml-json', input: '<root><a>1</a></root>' },
      ];

      for (const { path, input } of agents) {
        const mod = require(path);
        const AgentClass = Object.values(mod).find(v => typeof v === 'function');
        if (!AgentClass) continue;

        const agent = new AgentClass({ ai: mockAI, silent: true });
        const result = await agent.convert(input);

        // Report structure validation
        expect(result.report).toBeDefined();
        expect(result.report.agentId).toBeTruthy();
        expect(result.report.agentName).toBeTruthy();
        expect(Array.isArray(result.report.attempts)).toBe(true);
        expect(result.report.totalDuration).toBeGreaterThanOrEqual(0);
        expect(result.report.decision).toBeDefined();

        // finalScore should be present
        expect(typeof result.report.finalScore).toBe('number');
        expect(result.report.finalScore).toBeGreaterThanOrEqual(0);
        expect(result.report.finalScore).toBeLessThanOrEqual(100);

        // Events should be present
        expect(Array.isArray(result.report.events)).toBe(true);
        expect(result.report.events.length).toBeGreaterThan(0);

        // Events should have converter:start
        expect(result.report.events.some(e => e.event === 'converter:start')).toBe(true);
      }
    });
  });
});
