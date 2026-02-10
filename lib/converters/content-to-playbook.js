/**
 * ContentToPlaybookAgent
 *
 * @description Converts raw content (text, markdown, HTML) into a structured
 *   Playbook object with full WHO/WHY/WHAT/WHERE/WHEN framework analysis.
 *   This is the most critical converter agent — it produces the canonical
 *   playbook data model consumed by all downstream playbook-to-* converters.
 *
 * @extends BaseConverterAgent
 * @module lib/converters/content-to-playbook
 *
 * @agent converter:content-to-playbook
 * @from text, md, html
 * @to   playbook
 *
 * @modes generative
 *
 * @strategies
 *   - full-analysis : Deep framework extraction with detailed pillar analysis
 *   - quick         : Minimal LLM inference for speed; fills framework stubs
 *   - template      : Domain-specific template matching before LLM refinement
 *
 * @evaluation
 *   Structural: Every framework pillar must have a non-empty primary field.
 *   LLM spot-check: Verifies coherence between content and framework pillars.
 *
 * @input  {string} Plain text, Markdown, or HTML content.
 * @output {Object} Full playbook object with framework, doFramework, metadata.
 *
 * @example
 *   const { ContentToPlaybookAgent } = require('./content-to-playbook');
 *   const agent = new ContentToPlaybookAgent();
 *   const result = await agent.convert('# My Article\nContent here...');
 *   // result.output => { title, content, keywords, framework, doFramework, ... }
 *
 * @dependencies
 *   - lib/ai-service.js (json method — structured LLM output)
 */

'use strict';

const { BaseConverterAgent } = require('./base-converter-agent');

/**
 * Template for the WHO/WHY/WHAT/WHERE/WHEN framework.
 * Used as fallback structure and schema reference.
 * @private
 */
const EMPTY_FRAMEWORK = {
  who: {
    primary: '',
    characteristics: [],
    context: '',
    notFor: [],
  },
  why: {
    coreValue: '',
    emotionalHook: '',
    practicalBenefit: '',
    uniqueAngle: '',
  },
  what: {
    primaryAction: '',
    secondaryActions: [],
    successLooksLike: '',
    failureLooksLike: '',
  },
  where: {
    platform: '',
    format: '',
    distribution: '',
    consumptionContext: '',
    constraints: [],
  },
  when: {
    raw: '',
    parsed: { type: 'none', display: '' },
    confirmed: false,
  },
};

/**
 * Template for the DO framework.
 * @private
 */
const EMPTY_DO_FRAMEWORK = {
  personas: [],
  action: {
    primary: '',
    success: '',
    failure: '',
  },
};

/**
 * Domain templates for common playbook types.
 * Used by the 'template' strategy to prime the LLM.
 * @private
 */
const DOMAIN_TEMPLATES = {
  marketing: {
    who: { context: 'marketing campaign', characteristics: ['brand-aware', 'conversion-focused'] },
    where: { platform: 'multi-channel', format: 'campaign brief' },
  },
  education: {
    who: { context: 'educational content', characteristics: ['learning-oriented', 'structured'] },
    where: { platform: 'LMS / classroom', format: 'lesson plan' },
  },
  technical: {
    who: { context: 'technical documentation', characteristics: ['developer-audience', 'detail-oriented'] },
    where: { platform: 'documentation site', format: 'technical guide' },
  },
  business: {
    who: { context: 'business strategy', characteristics: ['stakeholder-facing', 'outcome-driven'] },
    where: { platform: 'internal / boardroom', format: 'strategic brief' },
  },
};

class ContentToPlaybookAgent extends BaseConverterAgent {
  /**
   * @param {Object} [config] - Configuration options passed to BaseConverterAgent
   * @param {Object} [config.ai] - AI service instance (for testing, inject mock)
   * @param {number} [config.maxAttempts] - Max retry attempts
   * @param {number} [config.minPassScore] - Minimum score to pass evaluation
   */
  constructor(config = {}) {
    super(config);

    this.id = 'converter:content-to-playbook';
    this.name = 'Content to Playbook';
    this.description = 'Converts raw content into a structured Playbook with WHO/WHY/WHAT/WHERE/WHEN framework';
    this.from = ['text', 'md', 'html'];
    this.to = ['playbook'];
    this.modes = ['generative'];

    this.strategies = [
      {
        id: 'full-analysis',
        description: 'Deep framework extraction with detailed pillar analysis and persona generation',
        when: 'Content is rich, nuanced, or long-form; quality is paramount',
        engine: 'llm-json',
        mode: 'generative',
        speed: 'slow',
        quality: 'Highest fidelity framework extraction; thorough persona modeling',
      },
      {
        id: 'quick',
        description: 'Minimal LLM inference for fast playbook scaffolding',
        when: 'Speed is more important than depth; quick drafts or previews',
        engine: 'llm-json',
        mode: 'generative',
        speed: 'fast',
        quality: 'Adequate framework stubs; may lack nuance in pillars',
      },
      {
        id: 'template',
        description: 'Domain-specific template matching with LLM refinement',
        when: 'Content clearly belongs to a known domain (marketing, education, technical, business)',
        engine: 'llm-json + templates',
        mode: 'generative',
        speed: 'medium',
        quality: 'Strong domain-specific defaults; LLM fills gaps and refines',
      },
    ];
  }

  // ===========================================================================
  // EXECUTE
  // ===========================================================================

  /**
   * Convert raw content into a structured Playbook object.
   *
   * @param {string} input - Raw text, Markdown, or HTML content
   * @param {string} strategy - Strategy ID: 'full-analysis' | 'quick' | 'template'
   * @param {Object} [options] - Additional conversion options
   * @param {string} [options.domain] - Domain hint for 'template' strategy
   * @param {string} [options.title] - Override title
   * @returns {Promise<import('./base-converter-agent').ExecuteResult>}
   */
  async execute(input, strategy, options = {}) {
    const startTime = Date.now();

    if (!this._ai) {
      throw new Error('AI service is required for content-to-playbook conversion');
    }

    if (typeof input !== 'string' || input.trim().length === 0) {
      throw new Error('Input must be a non-empty string');
    }

    // Strip HTML tags if input is HTML
    const cleanContent = this._cleanInput(input);

    let playbook;

    switch (strategy) {
      case 'full-analysis':
        playbook = await this._fullAnalysis(cleanContent, options);
        break;
      case 'quick':
        playbook = await this._quickAnalysis(cleanContent, options);
        break;
      case 'template':
        playbook = await this._templateAnalysis(cleanContent, options);
        break;
      default:
        playbook = await this._fullAnalysis(cleanContent, options);
    }

    // Apply overrides
    if (options.title) {
      playbook.title = options.title;
    }

    // Ensure metadata fields
    playbook.status = playbook.status || 'draft';
    playbook.stage = playbook.stage || 'not_submitted';
    playbook.createdInWiser = playbook.createdInWiser === true;
    playbook.creationSource = 'import';
    playbook.createdAt = playbook.createdAt || new Date().toISOString();
    playbook.updatedAt = new Date().toISOString();

    return {
      output: playbook,
      metadata: {
        strategy,
        inputLength: input.length,
        inputType: this._detectInputType(input),
        title: playbook.title,
        keywordCount: (playbook.keywords || []).length,
        personaCount: (playbook.doFramework?.personas || []).length,
        frameworkComplete: this._isFrameworkComplete(playbook.framework),
      },
      duration: Date.now() - startTime,
      strategy,
    };
  }

  // ===========================================================================
  // STRATEGY IMPLEMENTATIONS
  // ===========================================================================

  /**
   * Full-analysis strategy: deep, thorough framework extraction.
   * @private
   */
  async _fullAnalysis(content, options) {
    const systemPrompt = `You are an expert content strategist and framework analyst.
Your task is to analyze the provided content and produce a comprehensive Playbook object.

A Playbook captures the strategic essence of content through the WHO/WHY/WHAT/WHERE/WHEN framework.

Analyze the content deeply and produce ALL of the following fields:

1. "title" (string): A concise, compelling title that captures the content's purpose.
2. "content" (string): The original content, cleaned and restructured as well-formed Markdown. Fix formatting issues, add headers if missing, ensure readability.
3. "keywords" (array of strings): 5-15 relevant keywords/tags extracted from the content.
4. "framework": {
     "who": {
       "primary" (string): The primary audience or persona this content serves,
       "characteristics" (array of strings): 3-5 defining traits of the audience,
       "context" (string): The situation or environment the audience is in,
       "notFor" (array of strings): Who this content is NOT suitable for
     },
     "why": {
       "coreValue" (string): The fundamental value proposition,
       "emotionalHook" (string): The emotional driver or appeal,
       "practicalBenefit" (string): The tangible practical benefit,
       "uniqueAngle" (string): What makes this perspective unique
     },
     "what": {
       "primaryAction" (string): The main action or takeaway,
       "secondaryActions" (array of strings): Supporting actions or steps,
       "successLooksLike" (string): Description of successful outcome,
       "failureLooksLike" (string): Description of what failure looks like
     },
     "where": {
       "platform" (string): Where this content is best distributed,
       "format" (string): The ideal content format,
       "distribution" (string): Distribution channel or method,
       "consumptionContext" (string): How the audience will consume this,
       "constraints" (array of strings): Any constraints or limitations
     },
     "when": {
       "raw" (string): Any time-related information found in the content (or empty string),
       "parsed": { "type": "none", "display": "" },
       "confirmed": false
     }
   }
5. "doFramework": {
     "personas" (array): [{
       "name" (string): Persona name,
       "description" (string): Brief description,
       "background" (array of strings): Key background details,
       "context" (string): Persona's current situation,
       "isPrimary" (boolean): Whether this is the primary persona
     }],
     "action": {
       "primary" (string): The primary action to take,
       "success" (string): What success looks like,
       "failure" (string): What failure looks like
     }
   }

Be thorough and specific. Every field must be populated with meaningful content derived from the source material. Do not use generic placeholders.

Return a single JSON object with all fields above.`;

    const result = await this._ai.json(
      `${systemPrompt}\n\n---\n\nContent to analyze:\n\n${content}`,
      {
        profile: 'standard',
        feature: 'converter-content-to-playbook',
        temperature: 0.3,
        maxTokens: 4000,
      }
    );

    return this._normalizePlaybook(result);
  }

  /**
   * Quick strategy: minimal inference, fast scaffolding.
   * @private
   */
  async _quickAnalysis(content, options) {
    const systemPrompt = `Quickly analyze this content and produce a Playbook JSON object with these fields:
- "title": Concise title
- "content": The content as clean Markdown
- "keywords": 3-8 keywords
- "framework": { "who": {"primary":"","characteristics":[],"context":"","notFor":[]}, "why": {"coreValue":"","emotionalHook":"","practicalBenefit":"","uniqueAngle":""}, "what": {"primaryAction":"","secondaryActions":[],"successLooksLike":"","failureLooksLike":""}, "where": {"platform":"","format":"","distribution":"","consumptionContext":"","constraints":[]}, "when": {"raw":"","parsed":{"type":"none","display":""},"confirmed":false} }
- "doFramework": { "personas": [{"name":"","description":"","background":[],"context":"","isPrimary":true}], "action": {"primary":"","success":"","failure":""} }

Fill in what you can. Be concise. Return JSON only.`;

    const result = await this._ai.json(
      `${systemPrompt}\n\n${content.substring(0, 3000)}`,
      {
        profile: 'fast',
        feature: 'converter-content-to-playbook-quick',
        temperature: 0.2,
        maxTokens: 2000,
      }
    );

    return this._normalizePlaybook(result);
  }

  /**
   * Template strategy: detect domain, apply template, then refine with LLM.
   * @private
   */
  async _templateAnalysis(content, options) {
    // Detect or use provided domain
    const domain = options.domain || await this._detectDomain(content);
    const template = DOMAIN_TEMPLATES[domain] || {};

    const systemPrompt = `You are creating a Playbook for ${domain || 'general'} content.

Start from this domain template and refine based on the actual content:
${JSON.stringify(template, null, 2)}

Produce the full Playbook JSON with:
- "title", "content" (clean Markdown), "keywords"
- "framework": full WHO/WHY/WHAT/WHERE/WHEN object (see template for starting structure)
- "doFramework": { "personas": [...], "action": { "primary", "success", "failure" } }

The framework fields:
- who: { primary, characteristics:[], context, notFor:[] }
- why: { coreValue, emotionalHook, practicalBenefit, uniqueAngle }
- what: { primaryAction, secondaryActions:[], successLooksLike, failureLooksLike }
- where: { platform, format, distribution, consumptionContext, constraints:[] }
- when: { raw:"", parsed:{type:"none",display:""}, confirmed:false }

Return JSON only. Be specific to the content provided.`;

    const result = await this._ai.json(
      `${systemPrompt}\n\n---\n\n${content}`,
      {
        profile: 'standard',
        feature: 'converter-content-to-playbook-template',
        temperature: 0.3,
        maxTokens: 3500,
      }
    );

    return this._normalizePlaybook(result);
  }

  // ===========================================================================
  // STRUCTURAL CHECKS
  // ===========================================================================

  /**
   * Validate that the playbook has all required framework pillars populated.
   *
   * @param {string} input - Original content
   * @param {Object} output - Playbook object
   * @param {string} strategy - Strategy used
   * @returns {Promise<import('./base-converter-agent').EvaluationIssue[]>}
   */
  async _structuralChecks(input, output, strategy) {
    const issues = [];

    if (!output || typeof output !== 'object') {
      issues.push({
        code: 'OUTPUT_NOT_OBJECT',
        severity: 'error',
        message: 'Playbook output must be an object',
        fixable: true,
      });
      return issues;
    }

    // Title check
    if (!output.title || typeof output.title !== 'string' || output.title.trim().length === 0) {
      issues.push({
        code: 'FIELD_EMPTY',
        severity: 'error',
        message: 'Playbook title is missing or empty',
        fixable: true,
      });
    }

    // Content check
    if (!output.content || typeof output.content !== 'string' || output.content.trim().length === 0) {
      issues.push({
        code: 'FIELD_EMPTY',
        severity: 'error',
        message: 'Playbook content is missing or empty',
        fixable: true,
      });
    }

    // Framework existence
    if (!output.framework || typeof output.framework !== 'object') {
      issues.push({
        code: 'PILLAR_MISSING',
        severity: 'error',
        message: 'Framework object is missing entirely',
        fixable: true,
      });
      return issues;
    }

    const fw = output.framework;

    // WHO pillar
    if (!fw.who || !fw.who.primary || fw.who.primary.trim().length === 0) {
      issues.push({
        code: 'FIELD_EMPTY',
        severity: 'error',
        message: 'Framework WHO.primary is missing or empty',
        fixable: true,
      });
    }

    // WHY pillar
    if (!fw.why || !fw.why.coreValue || fw.why.coreValue.trim().length === 0) {
      issues.push({
        code: 'FIELD_EMPTY',
        severity: 'error',
        message: 'Framework WHY.coreValue is missing or empty',
        fixable: true,
      });
    }

    // WHAT pillar
    if (!fw.what || !fw.what.primaryAction || fw.what.primaryAction.trim().length === 0) {
      issues.push({
        code: 'FIELD_EMPTY',
        severity: 'error',
        message: 'Framework WHAT.primaryAction is missing or empty',
        fixable: true,
      });
    }

    // WHERE pillar
    if (!fw.where || !fw.where.platform || fw.where.platform.trim().length === 0) {
      issues.push({
        code: 'FIELD_EMPTY',
        severity: 'error',
        message: 'Framework WHERE.platform is missing or empty',
        fixable: true,
      });
    }

    // WHEN pillar (optional but check structure)
    if (!fw.when || typeof fw.when !== 'object') {
      issues.push({
        code: 'PILLAR_MISSING',
        severity: 'warning',
        message: 'Framework WHEN pillar is missing (non-critical)',
        fixable: true,
      });
    }

    // Keywords check
    if (!Array.isArray(output.keywords) || output.keywords.length === 0) {
      issues.push({
        code: 'FIELD_EMPTY',
        severity: 'warning',
        message: 'Keywords array is empty or missing',
        fixable: true,
      });
    }

    // doFramework check
    if (!output.doFramework || typeof output.doFramework !== 'object') {
      issues.push({
        code: 'PILLAR_MISSING',
        severity: 'warning',
        message: 'doFramework is missing',
        fixable: true,
      });
    } else if (!Array.isArray(output.doFramework.personas) || output.doFramework.personas.length === 0) {
      issues.push({
        code: 'FIELD_EMPTY',
        severity: 'warning',
        message: 'doFramework.personas is empty',
        fixable: true,
      });
    }

    return issues;
  }

  // ===========================================================================
  // PRIVATE HELPERS
  // ===========================================================================

  /**
   * Normalize LLM output into a consistent playbook structure.
   * Ensures all required fields exist with correct types.
   * @private
   */
  _normalizePlaybook(raw) {
    if (!raw || typeof raw !== 'object') {
      return {
        title: '',
        content: '',
        keywords: [],
        framework: { ...EMPTY_FRAMEWORK },
        doFramework: { ...EMPTY_DO_FRAMEWORK },
        status: 'draft',
        stage: 'not_submitted',
        createdInWiser: false,
        creationSource: 'import',
      };
    }

    return {
      title: typeof raw.title === 'string' ? raw.title : '',
      content: typeof raw.content === 'string' ? raw.content : '',
      keywords: Array.isArray(raw.keywords) ? raw.keywords.filter(k => typeof k === 'string') : [],
      framework: this._normalizeFramework(raw.framework),
      doFramework: this._normalizeDoFramework(raw.doFramework),
      status: 'draft',
      stage: 'not_submitted',
      createdInWiser: false,
      creationSource: 'import',
    };
  }

  /**
   * Normalize framework object, filling missing fields with defaults.
   * @private
   */
  _normalizeFramework(fw) {
    if (!fw || typeof fw !== 'object') return { ...EMPTY_FRAMEWORK };

    return {
      who: {
        primary: fw.who?.primary || '',
        characteristics: Array.isArray(fw.who?.characteristics) ? fw.who.characteristics : [],
        context: fw.who?.context || '',
        notFor: Array.isArray(fw.who?.notFor) ? fw.who.notFor : [],
      },
      why: {
        coreValue: fw.why?.coreValue || '',
        emotionalHook: fw.why?.emotionalHook || '',
        practicalBenefit: fw.why?.practicalBenefit || '',
        uniqueAngle: fw.why?.uniqueAngle || '',
      },
      what: {
        primaryAction: fw.what?.primaryAction || '',
        secondaryActions: Array.isArray(fw.what?.secondaryActions) ? fw.what.secondaryActions : [],
        successLooksLike: fw.what?.successLooksLike || '',
        failureLooksLike: fw.what?.failureLooksLike || '',
      },
      where: {
        platform: fw.where?.platform || '',
        format: fw.where?.format || '',
        distribution: fw.where?.distribution || '',
        consumptionContext: fw.where?.consumptionContext || '',
        constraints: Array.isArray(fw.where?.constraints) ? fw.where.constraints : [],
      },
      when: {
        raw: fw.when?.raw || '',
        parsed: {
          type: fw.when?.parsed?.type || 'none',
          display: fw.when?.parsed?.display || '',
        },
        confirmed: fw.when?.confirmed === true,
      },
    };
  }

  /**
   * Normalize doFramework object.
   * @private
   */
  _normalizeDoFramework(dofw) {
    if (!dofw || typeof dofw !== 'object') return { ...EMPTY_DO_FRAMEWORK };

    const personas = Array.isArray(dofw.personas)
      ? dofw.personas.map(p => ({
          name: p?.name || '',
          description: p?.description || '',
          background: Array.isArray(p?.background) ? p.background : [],
          context: p?.context || '',
          isPrimary: p?.isPrimary === true,
        }))
      : [];

    return {
      personas,
      action: {
        primary: dofw.action?.primary || '',
        success: dofw.action?.success || '',
        failure: dofw.action?.failure || '',
      },
    };
  }

  /**
   * Check if framework has all primary fields populated.
   * @private
   */
  _isFrameworkComplete(fw) {
    if (!fw) return false;
    return !!(
      fw.who?.primary &&
      fw.why?.coreValue &&
      fw.what?.primaryAction &&
      fw.where?.platform
    );
  }

  /**
   * Clean input content (strip HTML tags if HTML, normalize whitespace).
   * @private
   */
  _cleanInput(input) {
    let cleaned = input;

    // Strip HTML tags if the input appears to be HTML
    if (/<[a-z][a-z0-9]*[\s>]/i.test(input) && /<\/[a-z]+>/i.test(input)) {
      cleaned = cleaned
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<\/div>/gi, '\n')
        .replace(/<\/li>/gi, '\n')
        .replace(/<li[^>]*>/gi, '- ')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"');
    }

    // Normalize whitespace
    cleaned = cleaned.replace(/\r\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();

    return cleaned;
  }

  /**
   * Detect input type from content characteristics.
   * @private
   */
  _detectInputType(input) {
    if (/<html|<body|<div/i.test(input)) return 'html';
    if (/^#{1,6}\s|^\*\*|^\[.*\]\(.*\)|```/m.test(input)) return 'md';
    return 'text';
  }

  /**
   * Detect domain from content for template strategy.
   * @private
   */
  async _detectDomain(content) {
    if (!this._ai) return 'general';

    try {
      const sample = content.substring(0, 500);
      const result = await this._ai.json(
        `Classify this content into one domain: "marketing", "education", "technical", "business", or "general".

Content: "${sample}"

Return JSON: { "domain": "one_of_the_above" }`,
        { profile: 'fast', feature: 'converter-domain-detect', temperature: 0 }
      );
      return result?.domain || 'general';
    } catch {
      return 'general';
    }
  }
}

module.exports = { ContentToPlaybookAgent };
