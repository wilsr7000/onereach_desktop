/**
 * PlaybookToHtmlAgent
 *
 * @description Converts a structured Playbook object into an HTML document,
 *   rendering both the content (via Markdown-to-HTML) and the framework
 *   metadata as styled HTML cards and sections.
 *
 * @extends BaseConverterAgent
 * @module lib/converters/playbook-to-html
 *
 * @agent converter:playbook-to-html
 * @from playbook
 * @to   html
 *
 * @modes symbolic
 *
 * @strategies
 *   - document  : Single-page HTML document with full framework display
 *   - dashboard : Card-based layout with framework pillars as visual cards
 *   - print     : Print-optimized HTML with clean typography and page breaks
 *
 * @evaluation
 *   Structural: output must be a non-empty string containing HTML elements.
 *
 * @input  {Object} Playbook object with title, content, framework, doFramework.
 * @output {string} Complete HTML document.
 *
 * @example
 *   const { PlaybookToHtmlAgent } = require('./playbook-to-html');
 *   const agent = new PlaybookToHtmlAgent();
 *   const result = await agent.convert(playbookObj, { strategy: 'dashboard' });
 *   // result.output => '<!DOCTYPE html>...'
 *
 * @dependencies
 *   - marked (Markdown-to-HTML parsing)
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');

class PlaybookToHtmlAgent extends BaseConverterAgent {
  /**
   * @param {Object} [config] - Configuration options passed to BaseConverterAgent
   * @param {Object} [config.ai] - AI service instance (for testing, inject mock)
   * @param {number} [config.maxAttempts] - Max retry attempts
   * @param {number} [config.minPassScore] - Minimum score to pass evaluation
   */
  constructor(config = {}) {
    super(config);

    this.id = 'converter:playbook-to-html';
    this.name = 'Playbook to HTML';
    this.description = 'Converts a structured Playbook object into a styled HTML document';
    this.from = ['playbook'];
    this.to = ['html'];
    this.modes = ['symbolic'];

    this.strategies = [
      {
        id: 'document',
        description: 'Single-page HTML document with header, framework display, and content',
        when: 'Output is a standalone page for viewing or sharing',
        engine: 'marked + html-template',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Complete document with modern styling; good for web viewing',
      },
      {
        id: 'dashboard',
        description: 'Card-based dashboard layout with framework pillars as visual cards',
        when: 'Presenting framework data visually; executive overview or analysis UI',
        engine: 'marked + html-template',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Visual, card-based layout highlighting framework pillars',
      },
      {
        id: 'print',
        description: 'Print-optimized HTML with clean typography and page break hints',
        when: 'Output will be printed or exported to PDF',
        engine: 'marked + html-template',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Print-ready layout with serif typography and proper page breaks',
      },
    ];
  }

  // ===========================================================================
  // EXECUTE
  // ===========================================================================

  /**
   * Convert a Playbook object into HTML.
   *
   * @param {Object} input - Playbook object
   * @param {string} strategy - Strategy ID: 'document' | 'dashboard' | 'print'
   * @param {Object} [options] - Additional options
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy, options = {}) {
    const startTime = Date.now();

    if (!input || typeof input !== 'object') {
      throw new Error('Input must be a Playbook object');
    }

    const title = input.title || 'Untitled Playbook';
    const content = input.content || '';
    const framework = input.framework || {};
    const doFramework = input.doFramework || {};
    const keywords = input.keywords || [];

    // Parse Markdown content to HTML
    const contentHtml = this._parseMarkdown(content);

    let output;

    switch (strategy) {
      case 'document':
        output = this._buildDocument(title, contentHtml, framework, doFramework, keywords);
        break;
      case 'dashboard':
        output = this._buildDashboard(title, contentHtml, framework, doFramework, keywords);
        break;
      case 'print':
        output = this._buildPrint(title, contentHtml, framework, doFramework, keywords);
        break;
      default:
        output = this._buildDocument(title, contentHtml, framework, doFramework, keywords);
    }

    return {
      output,
      metadata: {
        strategy,
        title,
        outputLength: output.length,
        hasFramework: !!input.framework,
        isFullDocument: true,
      },
      duration: Date.now() - startTime,
      strategy,
    };
  }

  // ===========================================================================
  // STRUCTURAL CHECKS
  // ===========================================================================

  /**
   * Validate HTML output.
   *
   * @param {Object} input - Original Playbook
   * @param {string} output - HTML string
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
        message: 'HTML output is empty',
        fixable: true,
      });
      return issues;
    }

    // Check for HTML structure
    const htmlTagPattern = /<[a-z][a-z0-9]*[\s>]/i;
    if (!htmlTagPattern.test(output)) {
      issues.push({
        code: 'NO_HTML_TAGS',
        severity: 'error',
        message: 'Output does not contain any HTML tags',
        fixable: true,
      });
    }

    // Check for DOCTYPE
    if (!output.includes('<!DOCTYPE html>') && !output.includes('<html')) {
      issues.push({
        code: 'MISSING_DOCTYPE',
        severity: 'warning',
        message: 'HTML output missing DOCTYPE or html element',
        fixable: true,
      });
    }

    // Check for CSS
    if (!output.includes('<style') && !output.includes('style=')) {
      issues.push({
        code: 'MISSING_STYLES',
        severity: 'warning',
        message: 'HTML output has no embedded styles',
        fixable: false,
      });
    }

    return issues;
  }

  // ===========================================================================
  // STRATEGY BUILDERS
  // ===========================================================================

  /**
   * Build a single-page document layout.
   * @private
   */
  _buildDocument(title, contentHtml, framework, doFramework, keywords) {
    const frameworkSection = this._frameworkToSections(framework);
    const personaSection = this._personasToHtml(doFramework);
    const keywordTags = keywords.map(k => `<span class="keyword">${this._esc(k)}</span>`).join(' ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${this._esc(title)}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; max-width: 900px; margin: 0 auto; padding: 2rem; color: #1a1a2e; background: #fafafa; }
  h1 { font-size: 2em; margin-bottom: 0.3em; color: #16213e; }
  h2 { font-size: 1.4em; margin-top: 2em; color: #0f3460; border-bottom: 2px solid #e2e8f0; padding-bottom: 0.3em; }
  h3 { font-size: 1.1em; color: #1a1a2e; }
  .keywords { margin-bottom: 2em; }
  .keyword { display: inline-block; background: #e2e8f0; color: #4a5568; padding: 0.15em 0.6em; border-radius: 12px; font-size: 0.85em; margin: 0.15em; }
  .framework-section { margin: 1.5em 0; padding: 1.2em; background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; }
  .framework-section h3 { margin-top: 0; color: #0f3460; }
  .framework-field { margin: 0.5em 0; }
  .framework-field strong { color: #2d3748; }
  .content-body { margin-top: 2em; }
  .content-body p { margin: 0.5em 0 1em; }
  .content-body code { background: #edf2f7; padding: 0.15em 0.4em; border-radius: 3px; font-size: 0.9em; }
  .content-body pre { background: #2d3748; color: #e2e8f0; padding: 1em; border-radius: 6px; overflow-x: auto; }
  .content-body pre code { background: none; color: inherit; }
  .content-body blockquote { border-left: 4px solid #cbd5e0; margin: 0; padding: 0 1em; color: #718096; }
  .content-body table { border-collapse: collapse; width: 100%; margin: 1em 0; }
  .content-body th, .content-body td { border: 1px solid #e2e8f0; padding: 0.5em 1em; text-align: left; }
  .content-body th { background: #edf2f7; }
  .persona { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 1em; margin: 1em 0; }
  .persona h4 { margin-top: 0; }
  .persona .badge { font-size: 0.75em; background: #0f3460; color: #fff; padding: 0.1em 0.5em; border-radius: 4px; margin-left: 0.5em; }
</style>
</head>
<body>
<h1>${this._esc(title)}</h1>
${keywords.length > 0 ? `<div class="keywords">${keywordTags}</div>` : ''}

<h2>Framework</h2>
${frameworkSection}

${personaSection}

<h2>Content</h2>
<div class="content-body">
${contentHtml}
</div>
</body>
</html>`;
  }

  /**
   * Build a card-based dashboard layout.
   * @private
   */
  _buildDashboard(title, contentHtml, framework, doFramework, keywords) {
    const cards = this._frameworkToCards(framework);
    const personaSection = this._personasToHtml(doFramework);

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${this._esc(title)} - Dashboard</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 2rem; color: #1a1a2e; background: #f0f2f5; }
  .header { text-align: center; margin-bottom: 2rem; }
  .header h1 { font-size: 1.8em; color: #16213e; margin-bottom: 0.3em; }
  .header .subtitle { color: #718096; font-size: 0.95em; }
  .card-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1.2rem; margin-bottom: 2rem; }
  .card { background: #fff; border-radius: 10px; padding: 1.4em; box-shadow: 0 1px 3px rgba(0,0,0,0.08); border-top: 4px solid #0f3460; }
  .card.who { border-top-color: #2196F3; }
  .card.why { border-top-color: #4CAF50; }
  .card.what { border-top-color: #FF9800; }
  .card.where { border-top-color: #9C27B0; }
  .card.when { border-top-color: #607D8B; }
  .card h3 { margin-top: 0; font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.08em; color: #718096; }
  .card .primary { font-size: 1.1em; font-weight: 600; color: #1a1a2e; margin: 0.5em 0; }
  .card .detail { font-size: 0.9em; color: #4a5568; margin: 0.3em 0; }
  .card .tags { margin-top: 0.8em; }
  .card .tag { display: inline-block; background: #edf2f7; padding: 0.1em 0.5em; border-radius: 4px; font-size: 0.8em; color: #4a5568; margin: 0.1em; }
  .content-section { background: #fff; border-radius: 10px; padding: 2em; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  .content-section h2 { margin-top: 0; color: #16213e; }
  .content-body p { margin: 0.5em 0 1em; }
  .content-body code { background: #edf2f7; padding: 0.15em 0.4em; border-radius: 3px; }
  .content-body pre { background: #2d3748; color: #e2e8f0; padding: 1em; border-radius: 6px; overflow-x: auto; }
  .content-body pre code { background: none; color: inherit; }
  .persona { background: #fff; border-radius: 10px; padding: 1.2em; box-shadow: 0 1px 3px rgba(0,0,0,0.08); margin: 1em 0; }
  .persona h4 { margin-top: 0; }
  .persona .badge { font-size: 0.75em; background: #0f3460; color: #fff; padding: 0.1em 0.5em; border-radius: 4px; margin-left: 0.5em; }
</style>
</head>
<body>
<div class="header">
  <h1>${this._esc(title)}</h1>
  <div class="subtitle">Playbook Framework Dashboard</div>
</div>

<div class="card-grid">
${cards}
</div>

${personaSection}

<div class="content-section">
  <h2>Content</h2>
  <div class="content-body">
  ${contentHtml}
  </div>
</div>
</body>
</html>`;
  }

  /**
   * Build a print-optimized layout.
   * @private
   */
  _buildPrint(title, contentHtml, framework, doFramework, keywords) {
    const frameworkTable = this._frameworkToTable(framework);
    const personaSection = this._personasToHtml(doFramework);

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${this._esc(title)}</title>
<style>
  @media print { .page-break { page-break-before: always; } }
  body { font-family: Georgia, 'Times New Roman', serif; max-width: 700px; margin: 0 auto; padding: 2cm; color: #222; line-height: 1.7; }
  h1 { font-size: 2em; border-bottom: 2px solid #222; padding-bottom: 0.3em; margin-bottom: 0.5em; }
  h2 { font-size: 1.3em; margin-top: 2em; color: #333; }
  h3 { font-size: 1.1em; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; font-size: 0.95em; }
  th, td { border: 1px solid #ccc; padding: 0.5em 0.8em; text-align: left; }
  th { background: #f5f5f5; font-weight: 600; width: 30%; }
  .keywords { color: #666; font-style: italic; margin-bottom: 1.5em; }
  .content-body p { margin: 0.5em 0 1em; text-align: justify; }
  .content-body code { background: #f0f0f0; padding: 0.1em 0.3em; font-size: 0.9em; }
  .content-body pre { background: #f5f5f5; padding: 1em; border: 1px solid #ddd; overflow-x: auto; }
  .content-body pre code { background: none; }
  .content-body blockquote { border-left: 3px solid #999; margin: 0; padding: 0 1em; color: #555; }
  .persona { border: 1px solid #ddd; padding: 1em; margin: 1em 0; }
  .persona h4 { margin-top: 0; }
  .persona .badge { font-size: 0.8em; border: 1px solid #333; padding: 0.05em 0.4em; margin-left: 0.5em; }
</style>
</head>
<body>
<h1>${this._esc(title)}</h1>
${keywords.length > 0 ? `<div class="keywords">${keywords.join(', ')}</div>` : ''}

<h2>Framework Analysis</h2>
${frameworkTable}

${personaSection}

<div class="page-break"></div>

<h2>Content</h2>
<div class="content-body">
${contentHtml}
</div>
</body>
</html>`;
  }

  // ===========================================================================
  // PRIVATE HELPERS
  // ===========================================================================

  /**
   * Parse Markdown to HTML using marked.
   * @private
   */
  _parseMarkdown(md) {
    try {
      const { marked } = require('marked');
      marked.setOptions({ gfm: true, tables: true, breaks: true });
      return marked.parse(md || '');
    } catch (e) {
      // Fallback: wrap in <p> tags
      return (md || '').split('\n\n').map(p => `<p>${p}</p>`).join('\n');
    }
  }

  /**
   * Build framework as styled sections.
   * @private
   */
  _frameworkToSections(fw) {
    const sections = [];

    if (fw.who) {
      sections.push(`<div class="framework-section">
  <h3>WHO</h3>
  <div class="framework-field"><strong>Primary Audience:</strong> ${this._esc(fw.who.primary || 'N/A')}</div>
  <div class="framework-field"><strong>Characteristics:</strong> ${(fw.who.characteristics || []).map(c => this._esc(c)).join(', ') || 'N/A'}</div>
  <div class="framework-field"><strong>Context:</strong> ${this._esc(fw.who.context || 'N/A')}</div>
  <div class="framework-field"><strong>Not For:</strong> ${(fw.who.notFor || []).map(n => this._esc(n)).join(', ') || 'N/A'}</div>
</div>`);
    }

    if (fw.why) {
      sections.push(`<div class="framework-section">
  <h3>WHY</h3>
  <div class="framework-field"><strong>Core Value:</strong> ${this._esc(fw.why.coreValue || 'N/A')}</div>
  <div class="framework-field"><strong>Emotional Hook:</strong> ${this._esc(fw.why.emotionalHook || 'N/A')}</div>
  <div class="framework-field"><strong>Practical Benefit:</strong> ${this._esc(fw.why.practicalBenefit || 'N/A')}</div>
  <div class="framework-field"><strong>Unique Angle:</strong> ${this._esc(fw.why.uniqueAngle || 'N/A')}</div>
</div>`);
    }

    if (fw.what) {
      sections.push(`<div class="framework-section">
  <h3>WHAT</h3>
  <div class="framework-field"><strong>Primary Action:</strong> ${this._esc(fw.what.primaryAction || 'N/A')}</div>
  <div class="framework-field"><strong>Secondary Actions:</strong> ${(fw.what.secondaryActions || []).map(a => this._esc(a)).join(', ') || 'N/A'}</div>
  <div class="framework-field"><strong>Success Looks Like:</strong> ${this._esc(fw.what.successLooksLike || 'N/A')}</div>
  <div class="framework-field"><strong>Failure Looks Like:</strong> ${this._esc(fw.what.failureLooksLike || 'N/A')}</div>
</div>`);
    }

    if (fw.where) {
      sections.push(`<div class="framework-section">
  <h3>WHERE</h3>
  <div class="framework-field"><strong>Platform:</strong> ${this._esc(fw.where.platform || 'N/A')}</div>
  <div class="framework-field"><strong>Format:</strong> ${this._esc(fw.where.format || 'N/A')}</div>
  <div class="framework-field"><strong>Distribution:</strong> ${this._esc(fw.where.distribution || 'N/A')}</div>
  <div class="framework-field"><strong>Consumption Context:</strong> ${this._esc(fw.where.consumptionContext || 'N/A')}</div>
  <div class="framework-field"><strong>Constraints:</strong> ${(fw.where.constraints || []).map(c => this._esc(c)).join(', ') || 'N/A'}</div>
</div>`);
    }

    return sections.join('\n');
  }

  /**
   * Build framework as dashboard cards.
   * @private
   */
  _frameworkToCards(fw) {
    const cards = [];

    if (fw.who) {
      const chars = (fw.who.characteristics || []).map(c => `<span class="tag">${this._esc(c)}</span>`).join(' ');
      cards.push(`<div class="card who">
  <h3>WHO</h3>
  <div class="primary">${this._esc(fw.who.primary || 'N/A')}</div>
  <div class="detail">${this._esc(fw.who.context || '')}</div>
  ${chars ? `<div class="tags">${chars}</div>` : ''}
</div>`);
    }

    if (fw.why) {
      cards.push(`<div class="card why">
  <h3>WHY</h3>
  <div class="primary">${this._esc(fw.why.coreValue || 'N/A')}</div>
  <div class="detail">${this._esc(fw.why.emotionalHook || '')}</div>
  <div class="detail">${this._esc(fw.why.practicalBenefit || '')}</div>
</div>`);
    }

    if (fw.what) {
      const actions = (fw.what.secondaryActions || []).map(a => `<span class="tag">${this._esc(a)}</span>`).join(' ');
      cards.push(`<div class="card what">
  <h3>WHAT</h3>
  <div class="primary">${this._esc(fw.what.primaryAction || 'N/A')}</div>
  <div class="detail">${this._esc(fw.what.successLooksLike || '')}</div>
  ${actions ? `<div class="tags">${actions}</div>` : ''}
</div>`);
    }

    if (fw.where) {
      const constraints = (fw.where.constraints || []).map(c => `<span class="tag">${this._esc(c)}</span>`).join(' ');
      cards.push(`<div class="card where">
  <h3>WHERE</h3>
  <div class="primary">${this._esc(fw.where.platform || 'N/A')}</div>
  <div class="detail">${this._esc(fw.where.format || '')} / ${this._esc(fw.where.distribution || '')}</div>
  ${constraints ? `<div class="tags">${constraints}</div>` : ''}
</div>`);
    }

    if (fw.when?.raw) {
      cards.push(`<div class="card when">
  <h3>WHEN</h3>
  <div class="primary">${this._esc(fw.when.raw)}</div>
</div>`);
    }

    return cards.join('\n');
  }

  /**
   * Build framework as a print-friendly table.
   * @private
   */
  _frameworkToTable(fw) {
    const rows = [];
    if (fw.who) {
      rows.push(`<tr><th>WHO</th><td><strong>${this._esc(fw.who.primary || 'N/A')}</strong><br>${this._esc(fw.who.context || '')}<br>Traits: ${(fw.who.characteristics || []).join(', ') || 'N/A'}</td></tr>`);
    }
    if (fw.why) {
      rows.push(`<tr><th>WHY</th><td><strong>${this._esc(fw.why.coreValue || 'N/A')}</strong><br>Hook: ${this._esc(fw.why.emotionalHook || 'N/A')}<br>Benefit: ${this._esc(fw.why.practicalBenefit || 'N/A')}</td></tr>`);
    }
    if (fw.what) {
      rows.push(`<tr><th>WHAT</th><td><strong>${this._esc(fw.what.primaryAction || 'N/A')}</strong><br>Success: ${this._esc(fw.what.successLooksLike || 'N/A')}<br>Failure: ${this._esc(fw.what.failureLooksLike || 'N/A')}</td></tr>`);
    }
    if (fw.where) {
      rows.push(`<tr><th>WHERE</th><td><strong>${this._esc(fw.where.platform || 'N/A')}</strong> / ${this._esc(fw.where.format || 'N/A')}<br>${this._esc(fw.where.distribution || '')}<br>Constraints: ${(fw.where.constraints || []).join(', ') || 'none'}</td></tr>`);
    }
    if (fw.when?.raw) {
      rows.push(`<tr><th>WHEN</th><td>${this._esc(fw.when.raw)}</td></tr>`);
    }

    return `<table>${rows.join('\n')}</table>`;
  }

  /**
   * Build persona HTML.
   * @private
   */
  _personasToHtml(doFramework) {
    if (!doFramework?.personas?.length) return '';

    const personas = doFramework.personas.map(p => {
      const bgList = (p.background || []).map(b => `<li>${this._esc(b)}</li>`).join('');
      return `<div class="persona">
  <h4>${this._esc(p.name || 'Unnamed Persona')}${p.isPrimary ? '<span class="badge">Primary</span>' : ''}</h4>
  <p>${this._esc(p.description || '')}</p>
  ${bgList ? `<ul>${bgList}</ul>` : ''}
  ${p.context ? `<p><em>${this._esc(p.context)}</em></p>` : ''}
</div>`;
    }).join('\n');

    return `<h2>Personas</h2>\n${personas}`;
  }

  /**
   * HTML-escape a string.
   * @private
   */
  _esc(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}

module.exports = { PlaybookToHtmlAgent };
