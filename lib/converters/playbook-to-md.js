/**
 * PlaybookToMdAgent
 *
 * @description Converts a structured Playbook object into Markdown, with
 *   configurable strategies for embedding the framework metadata.
 *
 * @extends BaseConverterAgent
 * @module lib/converters/playbook-to-md
 *
 * @agent converter:playbook-to-md
 * @from playbook
 * @to   md, markdown
 *
 * @modes symbolic
 *
 * @strategies
 *   - frontmatter : YAML frontmatter header with framework, then content body
 *   - inline      : Framework woven into prose as contextual annotations
 *   - structured  : Framework as a dedicated Markdown section with tables
 *
 * @evaluation
 *   Structural: output must be a non-empty string containing valid Markdown.
 *
 * @input  {Object} Playbook object with title, content, framework, doFramework.
 * @output {string} Markdown document.
 *
 * @example
 *   const { PlaybookToMdAgent } = require('./playbook-to-md');
 *   const agent = new PlaybookToMdAgent();
 *   const result = await agent.convert(playbookObj);
 *   // result.output => '---\ntitle: ...\n---\n# ...'
 *
 * @dependencies
 *   - js-yaml (for frontmatter serialization)
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');

class PlaybookToMdAgent extends BaseConverterAgent {
  /**
   * @param {Object} [config] - Configuration options passed to BaseConverterAgent
   * @param {Object} [config.ai] - AI service instance (for testing, inject mock)
   * @param {number} [config.maxAttempts] - Max retry attempts
   * @param {number} [config.minPassScore] - Minimum score to pass evaluation
   */
  constructor(config = {}) {
    super(config);

    this.id = 'converter:playbook-to-md';
    this.name = 'Playbook to Markdown';
    this.description = 'Converts a structured Playbook object into Markdown';
    this.from = ['playbook'];
    this.to = ['md', 'markdown'];
    this.modes = ['symbolic'];

    this.strategies = [
      {
        id: 'frontmatter',
        description: 'YAML frontmatter header containing framework, followed by content body',
        when: 'Output will be consumed by static-site generators or Markdown toolchains that parse frontmatter',
        engine: 'js-yaml + string concatenation',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Clean separation of metadata and content; machine-parseable',
      },
      {
        id: 'inline',
        description: 'Framework woven into prose as contextual annotations and callouts',
        when: 'Output is intended for human reading with framework context inline',
        engine: 'string templating',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Readable narrative flow with integrated framework insights',
      },
      {
        id: 'structured',
        description: 'Framework as a dedicated Markdown section with formatted tables',
        when: 'Document needs a clear framework reference section alongside content',
        engine: 'string templating',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Comprehensive framework display in tabular Markdown format',
      },
    ];
  }

  // ===========================================================================
  // EXECUTE
  // ===========================================================================

  /**
   * Convert a Playbook object into Markdown.
   *
   * @param {Object} input - Playbook object
   * @param {string} strategy - Strategy ID: 'frontmatter' | 'inline' | 'structured'
   * @param {Object} [options] - Additional options
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy, _options = {}) {
    const startTime = Date.now();

    if (!input || typeof input !== 'object') {
      throw new Error('Input must be a Playbook object');
    }

    const title = input.title || 'Untitled Playbook';
    const content = input.content || '';
    const framework = input.framework || {};
    const doFramework = input.doFramework || {};
    const keywords = input.keywords || [];

    let output;

    switch (strategy) {
      case 'frontmatter':
        output = this._buildFrontmatter(title, content, framework, doFramework, keywords);
        break;
      case 'inline':
        output = this._buildInline(title, content, framework, doFramework, keywords);
        break;
      case 'structured':
        output = this._buildStructured(title, content, framework, doFramework, keywords);
        break;
      default:
        output = this._buildFrontmatter(title, content, framework, doFramework, keywords);
    }

    return {
      output,
      metadata: {
        strategy,
        title,
        inputType: 'playbook',
        outputLength: output.length,
        hasFramework: !!input.framework,
        keywordCount: keywords.length,
      },
      duration: Date.now() - startTime,
      strategy,
    };
  }

  // ===========================================================================
  // STRUCTURAL CHECKS
  // ===========================================================================

  /**
   * Validate Markdown output.
   *
   * @param {Object} input - Original Playbook
   * @param {string} output - Markdown string
   * @param {string} strategy - Strategy used
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
        message: 'Markdown output is empty',
        fixable: true,
      });
      return issues;
    }

    // Check for frontmatter in frontmatter strategy
    if (strategy === 'frontmatter') {
      if (!output.startsWith('---')) {
        issues.push({
          code: 'MISSING_FRONTMATTER',
          severity: 'warning',
          message: 'Frontmatter strategy output does not start with YAML delimiter',
          fixable: true,
        });
      }
    }

    // Check for heading
    if (!/^#{1,6}\s/m.test(output)) {
      issues.push({
        code: 'MISSING_HEADING',
        severity: 'warning',
        message: 'Markdown output contains no headings',
        fixable: false,
      });
    }

    return issues;
  }

  // ===========================================================================
  // STRATEGY BUILDERS
  // ===========================================================================

  /**
   * Build Markdown with YAML frontmatter.
   * @private
   */
  _buildFrontmatter(title, content, framework, doFramework, keywords) {
    let yaml;
    try {
      const jsYaml = require('js-yaml');
      const frontmatterData = {
        title,
        keywords,
        framework,
      };
      if (doFramework && doFramework.personas && doFramework.personas.length > 0) {
        frontmatterData.doFramework = doFramework;
      }
      yaml = jsYaml.dump(frontmatterData, { lineWidth: 120, noRefs: true });
    } catch (_e) {
      // Fallback: manual YAML-like serialization
      yaml = `title: "${title.replace(/"/g, '\\"')}"\nkeywords: [${keywords.map((k) => `"${k}"`).join(', ')}]\n`;
    }

    const lines = ['---', yaml.trimEnd(), '---', '', `# ${title}`, '', content];

    return lines.join('\n');
  }

  /**
   * Build Markdown with framework woven inline as callouts.
   * @private
   */
  _buildInline(title, content, framework, doFramework, keywords) {
    const lines = [`# ${title}`, ''];

    // Audience context
    if (framework.who?.primary) {
      lines.push(`> **Audience**: ${framework.who.primary}`);
      if (framework.who.context) {
        lines.push(`> *${framework.who.context}*`);
      }
      lines.push('');
    }

    // Value proposition
    if (framework.why?.coreValue) {
      lines.push(`> **Value**: ${framework.why.coreValue}`);
      lines.push('');
    }

    // Main content
    lines.push(content);
    lines.push('');

    // Key action
    if (framework.what?.primaryAction) {
      lines.push('---');
      lines.push('');
      lines.push(`**Key Action**: ${framework.what.primaryAction}`);
      if (framework.what.successLooksLike) {
        lines.push(`**Success**: ${framework.what.successLooksLike}`);
      }
      lines.push('');
    }

    // Keywords
    if (keywords.length > 0) {
      lines.push(`*Tags: ${keywords.join(', ')}*`);
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Build Markdown with framework as a dedicated section.
   * @private
   */
  _buildStructured(title, content, framework, doFramework, keywords) {
    const lines = [`# ${title}`, ''];

    // Keywords
    if (keywords.length > 0) {
      lines.push(`**Keywords**: ${keywords.join(', ')}`, '');
    }

    // Content
    lines.push(content, '');

    // Framework section
    lines.push('---', '', '## Framework', '');

    // WHO
    lines.push('### WHO');
    lines.push('');
    lines.push('| Field | Value |');
    lines.push('|-------|-------|');
    lines.push(`| Primary Audience | ${framework.who?.primary || 'N/A'} |`);
    lines.push(`| Characteristics | ${(framework.who?.characteristics || []).join(', ') || 'N/A'} |`);
    lines.push(`| Context | ${framework.who?.context || 'N/A'} |`);
    lines.push(`| Not For | ${(framework.who?.notFor || []).join(', ') || 'N/A'} |`);
    lines.push('');

    // WHY
    lines.push('### WHY');
    lines.push('');
    lines.push('| Field | Value |');
    lines.push('|-------|-------|');
    lines.push(`| Core Value | ${framework.why?.coreValue || 'N/A'} |`);
    lines.push(`| Emotional Hook | ${framework.why?.emotionalHook || 'N/A'} |`);
    lines.push(`| Practical Benefit | ${framework.why?.practicalBenefit || 'N/A'} |`);
    lines.push(`| Unique Angle | ${framework.why?.uniqueAngle || 'N/A'} |`);
    lines.push('');

    // WHAT
    lines.push('### WHAT');
    lines.push('');
    lines.push('| Field | Value |');
    lines.push('|-------|-------|');
    lines.push(`| Primary Action | ${framework.what?.primaryAction || 'N/A'} |`);
    lines.push(`| Secondary Actions | ${(framework.what?.secondaryActions || []).join(', ') || 'N/A'} |`);
    lines.push(`| Success Looks Like | ${framework.what?.successLooksLike || 'N/A'} |`);
    lines.push(`| Failure Looks Like | ${framework.what?.failureLooksLike || 'N/A'} |`);
    lines.push('');

    // WHERE
    lines.push('### WHERE');
    lines.push('');
    lines.push('| Field | Value |');
    lines.push('|-------|-------|');
    lines.push(`| Platform | ${framework.where?.platform || 'N/A'} |`);
    lines.push(`| Format | ${framework.where?.format || 'N/A'} |`);
    lines.push(`| Distribution | ${framework.where?.distribution || 'N/A'} |`);
    lines.push(`| Consumption Context | ${framework.where?.consumptionContext || 'N/A'} |`);
    lines.push(`| Constraints | ${(framework.where?.constraints || []).join(', ') || 'N/A'} |`);
    lines.push('');

    // WHEN
    if (framework.when?.raw) {
      lines.push('### WHEN');
      lines.push('');
      lines.push(`**Timing**: ${framework.when.raw}`);
      lines.push('');
    }

    // DO Framework / Personas
    if (doFramework?.personas?.length > 0) {
      lines.push('## Personas', '');
      for (const persona of doFramework.personas) {
        lines.push(`### ${persona.name}${persona.isPrimary ? ' (Primary)' : ''}`);
        lines.push('');
        if (persona.description) lines.push(persona.description);
        lines.push('');
        if (persona.background?.length > 0) {
          lines.push('**Background**:');
          for (const bg of persona.background) {
            lines.push(`- ${bg}`);
          }
          lines.push('');
        }
        if (persona.context) {
          lines.push(`**Context**: ${persona.context}`);
          lines.push('');
        }
      }
    }

    // Action
    if (doFramework?.action?.primary) {
      lines.push('## Action', '');
      lines.push(`**Primary**: ${doFramework.action.primary}`);
      if (doFramework.action.success) lines.push(`**Success**: ${doFramework.action.success}`);
      if (doFramework.action.failure) lines.push(`**Failure**: ${doFramework.action.failure}`);
      lines.push('');
    }

    return lines.join('\n');
  }
}

module.exports = { PlaybookToMdAgent };
