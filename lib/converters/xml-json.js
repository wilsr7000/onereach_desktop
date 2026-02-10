/**
 * XmlJsonAgent
 *
 * @description Bidirectional converter between XML and JSON formats. Detects
 *   input format automatically and converts to the other. Uses fast-xml-parser
 *   for reliable XML parsing and building.
 *
 * @extends BaseConverterAgent
 * @module lib/converters/xml-json
 *
 * @agent converter:xml-json
 * @from xml, json
 * @to   json, xml
 * @modes symbolic
 *
 * @strategies
 *   - default  : Standard conversion with reasonable defaults
 *   - compact  : Flatten XML attributes into values for simpler JSON
 *   - verbose  : Preserve all attributes, namespaces, and text nodes
 *
 * @example
 *   const { XmlJsonAgent } = require('./xml-json');
 *   const agent = new XmlJsonAgent();
 *   const result = await agent.convert('<root><item id="1">Hello</item></root>');
 *   // result.output => '{"root":{"item":{"@_id":"1","#text":"Hello"}}}'
 *
 * @dependencies fast-xml-parser
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');
const { getLogQueue } = require('./../log-event-queue');
const log = getLogQueue();

class XmlJsonAgent extends BaseConverterAgent {
  constructor(config = {}) {
    super(config);

    this.id = 'converter:xml-json';
    this.name = 'XML / JSON';
    this.description = 'Bidirectional XML and JSON converter with attribute handling options';
    this.from = ['xml', 'json'];
    this.to = ['json', 'xml'];
    this.modes = ['symbolic'];

    this.strategies = [
      {
        id: 'default',
        description: 'Standard conversion with balanced attribute handling',
        when: 'General-purpose XML/JSON conversion with reasonable defaults',
        engine: 'fast-xml-parser',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Accurate conversion preserving structure and attributes',
      },
      {
        id: 'compact',
        description: 'Flatten XML attributes into element values for simpler JSON',
        when: 'Simpler JSON structure is preferred over preserving XML attribute semantics',
        engine: 'fast-xml-parser',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Simplified flat JSON without attribute prefixes',
      },
      {
        id: 'verbose',
        description: 'Preserve all attributes, namespaces, CDATA, and text nodes',
        when: 'Full XML fidelity is needed for round-trip conversion',
        engine: 'fast-xml-parser',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Maximum fidelity with full XML structure preservation',
      },
    ];
  }

  /**
   * @param {string} input - XML or JSON content
   * @param {string} strategy - 'default' | 'compact' | 'verbose'
   * @param {Object} [options]
   * @param {string} [options.targetFormat] - Force target: 'json' | 'xml'
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy, options = {}) {
    const start = Date.now();
    const { XMLParser, XMLBuilder } = require('fast-xml-parser');

    const trimmed = input.trim();
    const isXml = trimmed.startsWith('<');
    const sourceFormat = isXml ? 'xml' : 'json';
    const targetFormat = options.targetFormat || (isXml ? 'json' : 'xml');

    let output;

    if (sourceFormat === 'xml') {
      // XML -> JSON
      const parserOpts = this._getParserOptions(strategy);
      const parser = new XMLParser(parserOpts);
      const jsonObj = parser.parse(trimmed);
      output = JSON.stringify(jsonObj, null, 2);
    } else {
      // JSON -> XML
      const data = JSON.parse(trimmed);
      const builderOpts = this._getBuilderOptions(strategy);
      const builder = new XMLBuilder(builderOpts);
      output = builder.build(data);
    }

    return { output, duration: Date.now() - start };
  }

  _getParserOptions(strategy) {
    const base = {
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      textNodeName: '#text',
      trimValues: true,
    };

    switch (strategy) {
      case 'compact':
        return {
          ...base,
          ignoreAttributes: false,
          attributeNamePrefix: '',
          textNodeName: '_text',
          isArray: () => false,
        };
      case 'verbose':
        return {
          ...base,
          preserveOrder: false,
          parseTagValue: true,
          parseAttributeValue: true,
          allowBooleanAttributes: true,
          cdataPropName: '__cdata',
          commentPropName: '__comment',
        };
      default:
        return base;
    }
  }

  _getBuilderOptions(strategy) {
    const base = {
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      textNodeName: '#text',
      format: true,
      indentBy: '  ',
    };

    switch (strategy) {
      case 'compact':
        return {
          ...base,
          attributeNamePrefix: '',
          textNodeName: '_text',
        };
      case 'verbose':
        return {
          ...base,
          cdataPropName: '__cdata',
          commentPropName: '__comment',
          format: true,
        };
      default:
        return base;
    }
  }

  async _structuralChecks(input, output) {
    const issues = [];
    if (typeof output !== 'string' || output.trim().length === 0) {
      issues.push({
        code: 'EMPTY_OUTPUT',
        severity: 'error',
        message: 'Output is empty',
        fixable: false,
      });
      return issues;
    }

    // Check that output is valid JSON or XML
    const trimmed = output.trim();
    const isXml = trimmed.startsWith('<');
    if (isXml) {
      if (!trimmed.includes('>')) {
        issues.push({
          code: 'INVALID_XML',
          severity: 'error',
          message: 'Output does not appear to be valid XML',
          fixable: false,
        });
      }
    } else {
      try {
        JSON.parse(trimmed);
      } catch {
        issues.push({
          code: 'INVALID_JSON',
          severity: 'error',
          message: 'Output is not valid JSON',
          fixable: false,
        });
      }
    }
    return issues;
  }
}

module.exports = { XmlJsonAgent };
