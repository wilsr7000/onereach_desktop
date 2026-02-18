/**
 * JsonToMdAgent
 *
 * @description Converts JSON data to Markdown. Supports table rendering for
 *   arrays of objects, YAML code block rendering, and nested list rendering
 *   for deep structures.
 *
 * @extends BaseConverterAgent
 * @module lib/converters/json-to-md
 *
 * @agent converter:json-to-md
 * @from json
 * @to   md, markdown
 * @modes symbolic
 *
 * @strategies
 *   - table      : Render JSON array as pipe-delimited Markdown table
 *   - yaml-block : Render JSON as YAML inside a fenced code block
 *   - list       : Render key-value pairs as nested Markdown list
 *
 * @input  {string} JSON content
 * @output {string} Markdown content
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');
const { getLogQueue } = require('./../log-event-queue');
const _log = getLogQueue();

class JsonToMdAgent extends BaseConverterAgent {
  constructor(config = {}) {
    super(config);

    this.id = 'converter:json-to-md';
    this.name = 'JSON to Markdown';
    this.description = 'Converts JSON data to Markdown tables, YAML blocks, or nested lists';
    this.from = ['json'];
    this.to = ['md', 'markdown'];
    this.modes = ['symbolic'];

    this.strategies = [
      {
        id: 'table',
        description: 'Render JSON array of objects as a pipe-delimited Markdown table',
        when: 'Input is an array of flat objects suitable for tabular display',
        engine: 'manual-builder',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Clean Markdown table with proper alignment',
      },
      {
        id: 'yaml-block',
        description: 'Render JSON as YAML inside a fenced code block',
        when: 'Human-readable YAML representation is preferred over table format',
        engine: 'js-yaml',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Readable YAML fenced code block',
      },
      {
        id: 'list',
        description: 'Render JSON key-value pairs as nested Markdown bullet list',
        when: 'Input has nested objects and a tree-like display is preferred',
        engine: 'manual-builder',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Hierarchical Markdown list representation',
      },
    ];
  }

  /**
   * @param {string} input - JSON content
   * @param {string} strategy - 'table' | 'yaml-block' | 'list'
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy) {
    const start = Date.now();
    const data = typeof input === 'string' ? JSON.parse(input) : input;
    let output;

    switch (strategy) {
      case 'table':
        output = this._buildTable(data);
        break;
      case 'yaml-block':
        output = this._buildYamlBlock(data);
        break;
      default: // list
        output = this._buildList(data);
        break;
    }

    return { output, duration: Date.now() - start };
  }

  _buildTable(data) {
    const items = Array.isArray(data) ? data : [data];
    if (items.length === 0) return '*Empty array*\n';

    const allKeys = new Set();
    for (const item of items) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        Object.keys(item).forEach((k) => allKeys.add(k));
      }
    }
    const headers = [...allKeys];
    if (headers.length === 0) return '```json\n' + JSON.stringify(data, null, 2) + '\n```\n';

    const headerRow = '| ' + headers.join(' | ') + ' |';
    const separatorRow = '| ' + headers.map(() => '---').join(' | ') + ' |';
    const dataRows = items.map((item) => {
      const cells = headers.map((h) => {
        const val = item && typeof item === 'object' ? item[h] : '';
        if (val === null || val === undefined) return '';
        if (typeof val === 'object') return JSON.stringify(val);
        return String(val);
      });
      return '| ' + cells.join(' | ') + ' |';
    });

    return [headerRow, separatorRow, ...dataRows].join('\n') + '\n';
  }

  _buildYamlBlock(data) {
    let yaml;
    try {
      yaml = require('js-yaml');
      const yamlStr = yaml.dump(data, { indent: 2, lineWidth: 120 });
      return '```yaml\n' + yamlStr + '```\n';
    } catch {
      // Fallback to JSON if js-yaml not available
      return '```json\n' + JSON.stringify(data, null, 2) + '\n```\n';
    }
  }

  _buildList(data, depth = 0) {
    const indent = '  '.repeat(depth);
    const lines = [];

    if (data === null || data === undefined) {
      lines.push(`${indent}- *null*`);
    } else if (typeof data !== 'object') {
      lines.push(`${indent}- ${String(data)}`);
    } else if (Array.isArray(data)) {
      for (const item of data) {
        if (typeof item === 'object' && item !== null) {
          lines.push(`${indent}-`);
          lines.push(this._buildList(item, depth + 1));
        } else {
          lines.push(`${indent}- ${item == null ? '*null*' : String(item)}`);
        }
      }
    } else {
      for (const [key, value] of Object.entries(data)) {
        if (typeof value === 'object' && value !== null) {
          lines.push(`${indent}- **${key}**:`);
          lines.push(this._buildList(value, depth + 1));
        } else {
          lines.push(`${indent}- **${key}**: ${value == null ? '*null*' : String(value)}`);
        }
      }
    }

    return lines.join('\n');
  }

  async _structuralChecks(input, output) {
    const issues = [];
    if (typeof output !== 'string' || output.trim().length === 0) {
      issues.push({
        code: 'EMPTY_OUTPUT',
        severity: 'error',
        message: 'Output Markdown is empty',
        fixable: false,
      });
    }
    return issues;
  }
}

module.exports = { JsonToMdAgent };
