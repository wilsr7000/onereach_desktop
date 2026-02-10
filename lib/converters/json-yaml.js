/**
 * JsonYamlAgent
 *
 * @description Bidirectional converter between JSON and YAML formats. Detects
 *   input format automatically and converts to the other. Supports direct
 *   conversion, AI-commented output, and alphabetically sorted keys.
 *
 * @extends BaseConverterAgent
 * @module lib/converters/json-yaml
 *
 * @strategies
 *   - standard  : Direct conversion between JSON and YAML
 *   - commented : AI adds explanatory comments to the YAML output
 *   - ordered   : Sorts all keys alphabetically before conversion
 *
 * @example
 *   const { JsonYamlAgent } = require('./json-yaml');
 *   const agent = new JsonYamlAgent();
 *   const result = await agent.convert('{"name": "Alice", "age": 30}');
 *   // result.output => 'name: Alice\nage: 30\n'
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');
const { getLogQueue } = require('./../log-event-queue');
const log = getLogQueue();

class JsonYamlAgent extends BaseConverterAgent {
  /**
   * @param {Object} [config] - Configuration options passed to BaseConverterAgent
   * @param {Object} [config.ai] - AI service instance (for testing, inject mock)
   * @param {number} [config.maxAttempts] - Max retry attempts
   * @param {number} [config.minPassScore] - Minimum score to pass evaluation
   */
  constructor(config = {}) {
    super(config);

    this.id = 'converter:json-yaml';
    this.name = 'JSON / YAML';
    this.description = 'Bidirectional JSON and YAML converter with commenting and key ordering';
    this.from = ['json', 'yaml', 'yml'];
    this.to = ['json', 'yaml', 'yml'];
    this.modes = ['symbolic'];

    this.strategies = [
      {
        id: 'standard',
        description: 'Direct conversion between JSON and YAML formats',
        when: 'Simple format conversion with no additional processing needed',
        engine: 'js-yaml',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Accurate one-to-one format conversion',
      },
      {
        id: 'commented',
        description: 'AI adds explanatory inline comments to the YAML output',
        when: 'Output will be read by humans who need context on what each field means',
        engine: 'js-yaml + ai',
        mode: 'symbolic',
        speed: 'medium',
        quality: 'High readability with AI-generated annotations',
      },
      {
        id: 'ordered',
        description: 'Sorts all object keys alphabetically before conversion',
        when: 'Consistent key ordering is needed for diffs, version control, or readability',
        engine: 'js-yaml',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Deterministic output with sorted keys',
      },
    ];
  }

  /**
   * Execute the JSON/YAML conversion.
   *
   * @param {string} input - JSON or YAML content to convert
   * @param {string} strategy - Strategy ID: 'standard' | 'commented' | 'ordered'
   * @param {Object} [options] - Additional conversion options
   * @param {string} [options.targetFormat] - Force target format: 'json' | 'yaml'
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy, options = {}) {
    const start = Date.now();
    const yaml = require('js-yaml');

    // Detect input format
    const trimmed = input.trim();
    const isJson = trimmed.startsWith('{') || trimmed.startsWith('[');
    const sourceFormat = isJson ? 'json' : 'yaml';
    const targetFormat = options.targetFormat || (isJson ? 'yaml' : 'json');

    // Parse input to a JS object
    let data;
    if (isJson) {
      data = JSON.parse(trimmed);
    } else {
      data = yaml.load(trimmed);
    }

    // Apply key ordering if requested
    if (strategy === 'ordered') {
      data = this._sortKeys(data);
    }

    // Convert to target format
    let output;
    if (targetFormat === 'json') {
      output = JSON.stringify(data, null, 2);
    } else {
      output = yaml.dump(data, {
        indent: 2,
        lineWidth: 120,
        noRefs: true,
        sortKeys: strategy === 'ordered',
      });
    }

    // Add AI comments for 'commented' strategy (only for YAML output)
    if (strategy === 'commented' && targetFormat !== 'json') {
      if (this._ai) {
        try {
          const result = await this._ai.chat({
            profile: 'fast',
            feature: 'converter-yaml-comment',
            temperature: 0.3,
            messages: [
              {
                role: 'user',
                content: `Add brief, helpful inline YAML comments to explain each top-level key and any non-obvious nested fields. Return ONLY the commented YAML with no extra text or code fences.

Input YAML:
${output}`,
              },
            ],
          });

          if (result && result.content && result.content.trim().length > 0) {
            output = result.content.trim();
          }
        } catch (err) {
          console.warn('[json-yaml] AI commenting failed, returning uncommented output:', err.message);
        }
      }
    }

    return {
      output,
      metadata: {
        strategy,
        sourceFormat,
        targetFormat,
        inputLength: input.length,
        outputLength: output.length,
      },
      duration: Date.now() - start,
      strategy,
    };
  }

  /**
   * Recursively sort object keys alphabetically.
   *
   * @param {*} data - Data to sort
   * @returns {*} Data with sorted keys
   * @private
   */
  _sortKeys(data) {
    if (Array.isArray(data)) {
      return data.map(item => this._sortKeys(item));
    }

    if (data !== null && typeof data === 'object') {
      const sorted = {};
      Object.keys(data).sort().forEach(key => {
        sorted[key] = this._sortKeys(data[key]);
      });
      return sorted;
    }

    return data;
  }

  /**
   * Structural checks for JSON/YAML conversion output.
   *
   * Validates that the output is valid JSON or YAML depending on the
   * target format inferred from the input.
   *
   * @param {string} input - Original input
   * @param {*} output - Conversion output to validate
   * @param {string} strategy - Strategy that was used
   * @returns {Promise<import('./base-converter-agent').EvaluationIssue[]>}
   */
  async _structuralChecks(input, output, strategy) {
    const issues = [];

    if (typeof output !== 'string') {
      issues.push({
        code: 'OUTPUT_NOT_STRING',
        severity: 'error',
        message: `Expected string output, got ${typeof output}`,
        fixable: true,
      });
      return issues;
    }

    if (output.trim().length === 0) {
      issues.push({
        code: 'OUTPUT_EMPTY',
        severity: 'error',
        message: 'Output is empty',
        fixable: true,
      });
      return issues;
    }

    // Determine expected target format
    const trimmedInput = input.trim();
    const inputIsJson = trimmedInput.startsWith('{') || trimmedInput.startsWith('[');
    const trimmedOutput = output.trim();
    const outputLooksJson = trimmedOutput.startsWith('{') || trimmedOutput.startsWith('[');

    if (outputLooksJson) {
      // Validate as JSON
      try {
        JSON.parse(trimmedOutput);
      } catch (e) {
        issues.push({
          code: 'INVALID_JSON',
          severity: 'error',
          message: `Output looks like JSON but fails to parse: ${e.message}`,
          fixable: true,
        });
      }
    } else {
      // Validate as YAML
      try {
        const yaml = require('js-yaml');
        const parsed = yaml.load(trimmedOutput);
        if (parsed === undefined || parsed === null) {
          issues.push({
            code: 'YAML_EMPTY_PARSE',
            severity: 'warning',
            message: 'YAML parses to null/undefined',
            fixable: true,
          });
        }
      } catch (e) {
        issues.push({
          code: 'INVALID_YAML',
          severity: 'error',
          message: `Output is not valid YAML: ${e.message}`,
          fixable: true,
        });
      }
    }

    // Warn if input and output are the same format
    if (inputIsJson === outputLooksJson) {
      issues.push({
        code: 'SAME_FORMAT',
        severity: 'warning',
        message: 'Input and output appear to be the same format; no conversion occurred',
        fixable: true,
      });
    }

    return issues;
  }
}

module.exports = { JsonYamlAgent };
