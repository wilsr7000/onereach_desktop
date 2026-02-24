/**
 * Browsing Agent
 *
 * Meta-agent for the Browsing API. Routes web research tasks to
 * specialized browsing agent templates or the LLM task runner.
 *
 * This agent replaces ad-hoc web scraping with a structured,
 * resilient browsing service. It:
 * - Tries fast-path (search API + HTTP) first for read-only queries
 * - Falls back to full BrowserWindow sessions for JS-heavy pages
 * - Supports site-specific agent templates with recipes
 * - Handles HITL promotion for CAPTCHAs, logins, etc.
 */

const BaseAgent = require('./base-agent');
const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();

let browsingAPI, fastPath, taskRunner, templates;

function getBrowsingAPI() {
  if (!browsingAPI) browsingAPI = require('../../lib/browsing-api');
  return browsingAPI;
}

function getFastPath() {
  if (!fastPath) fastPath = require('../../lib/browse-fast-path');
  return fastPath;
}

function getTaskRunner() {
  if (!taskRunner) taskRunner = require('../../lib/browsing-task-runner');
  return taskRunner;
}

function getTemplates() {
  if (!templates) {
    const { loadAgents } = require('../../lib/browsing-agent-template');
    templates = loadAgents(STARTER_TEMPLATES);
  }
  return templates;
}

const STARTER_TEMPLATES = [
  {
    id: 'browse-weather',
    name: 'Weather Lookup',
    description: 'Get current weather conditions for any location',
    categories: ['browser', 'weather'],
    bidding: { keywords: ['weather', 'forecast', 'temperature'] },
    fastPath: { type: 'search', query: 'current weather {location}', deepExtract: false },
    fallback: { strategy: 'llm', profile: 'fast', maxActions: 8, prompt: 'Go to wttr.in/{location} and extract the current temperature, conditions, and humidity.' },
    retry: { maxAttempts: 2, backoff: 'exponential', retryOn: ['timeout'] },
    session: { mode: 'auto-promote' },
  },
  {
    id: 'browse-web-search',
    name: 'Web Search',
    description: 'Search the web and summarize findings from multiple sources',
    categories: ['browser', 'search', 'research'],
    bidding: { keywords: ['search', 'look up', 'find', 'research'] },
    fastPath: { type: 'search', query: '{query}', deepExtract: true, maxSources: 3 },
    fallback: { strategy: 'llm', profile: 'fast', maxActions: 10, prompt: 'Search DuckDuckGo for "{query}" and extract the top results with summaries.' },
    retry: { maxAttempts: 2, backoff: 'exponential', retryOn: ['timeout', 'empty-result'] },
    session: { mode: 'auto-promote' },
  },
  {
    id: 'browse-page-reader',
    name: 'Page Reader',
    description: 'Read and extract content from a specific URL',
    categories: ['browser', 'extraction'],
    bidding: { keywords: ['read page', 'extract', 'scrape', 'get content'] },
    fastPath: { type: 'url', url: '{url}' },
    fallback: { strategy: 'llm', profile: 'fast', maxActions: 5, prompt: 'Navigate to {url} and extract the main content.' },
    retry: { maxAttempts: 3, backoff: 'exponential', retryOn: ['timeout', 'network-error'] },
    session: { mode: 'auto-promote' },
  },
  {
    id: 'browse-news',
    name: 'News Reader',
    description: 'Fetch latest news headlines on a topic',
    categories: ['browser', 'news'],
    bidding: { keywords: ['news', 'headlines', 'latest', 'breaking'] },
    fastPath: { type: 'search', query: '{topic} latest news today', deepExtract: true, maxSources: 3 },
    fallback: {
      strategy: 'llm', profile: 'fast', maxActions: 10,
      prompt: 'Search for "{topic} latest news" and extract the top 5 headlines with brief summaries and sources.',
    },
    retry: { maxAttempts: 2, backoff: 'exponential', retryOn: ['timeout'] },
    session: { mode: 'auto-promote' },
  },
  {
    id: 'browse-github',
    name: 'GitHub Reader',
    description: 'Browse GitHub repositories, issues, pull requests, and README files',
    categories: ['browser', 'github', 'development'],
    bidding: { keywords: ['github', 'repo', 'repository', 'pull request', 'issue'] },
    fastPath: { type: 'url', url: '{url}', maxLength: 12000 },
    recipe: {
      steps: [
        { action: 'navigate', url: '{url}' },
        { action: 'extract', opts: { mode: 'readability', maxLength: 12000, includeLinks: true } },
      ],
    },
    errorHandlers: {
      'login-prompt': {
        detect: { textContains: 'sign in' },
        action: 'hitl',
        message: 'GitHub requires login. Please sign in to continue.',
      },
    },
    retry: { maxAttempts: 2, backoff: 'exponential', retryOn: ['timeout'] },
    session: { mode: 'auto-promote', persistent: true, partition: 'github' },
  },
  {
    id: 'browse-form-filler',
    name: 'Form Filler',
    description: 'Navigate to a page and fill out a form with provided data',
    categories: ['browser', 'forms', 'automation'],
    bidding: { keywords: ['fill form', 'submit form', 'fill out', 'enter data'] },
    fallback: {
      strategy: 'llm', profile: 'standard', maxActions: 20,
      prompt: 'Navigate to {url} and fill out the form with the following data: {data}. Submit the form when complete.',
    },
    retry: { maxAttempts: 2, backoff: 'exponential', retryOn: ['timeout'] },
    session: { mode: 'auto-promote' },
  },
  {
    id: 'browse-page-monitor',
    name: 'Page Monitor',
    description: 'Check a page for specific content and report findings',
    categories: ['browser', 'monitoring'],
    bidding: { keywords: ['check page', 'monitor', 'watch', 'alert'] },
    recipe: {
      steps: [
        { action: 'navigate', url: '{url}' },
        {
          action: 'extract',
          rules: {
            pageTitle: { selector: 'title', type: 'text' },
            mainContent: { selector: 'main, article, .content, body', type: 'text' },
            lastModified: { selector: 'time, [datetime], .date, .timestamp', type: 'text' },
          },
        },
      ],
    },
    retry: { maxAttempts: 3, backoff: 'exponential', retryOn: ['timeout', 'network-error'] },
    session: { mode: 'auto-promote' },
  },
];

function classifyTask(input) {
  const lower = (typeof input === 'string' ? input : input.query || input.task || '').toLowerCase();

  const urlMatch = lower.match(/https?:\/\/[^\s]+/);
  if (urlMatch) {
    const url = urlMatch[0];
    if (url.includes('github.com')) return { templateId: 'browse-github', params: { url } };
    return { templateId: 'browse-page-reader', params: { url } };
  }

  if (lower.includes('weather') || lower.includes('forecast') || lower.includes('temperature')) {
    const location = lower.replace(/\b(weather|forecast|temperature|in|for|the|what|is|whats|what's)\b/g, '').trim();
    return { templateId: 'browse-weather', params: { location: location || 'current location' } };
  }

  if (lower.includes('news') || lower.includes('headlines') || lower.includes('latest')) {
    const topic = lower.replace(/\b(news|headlines|latest|breaking|get|me|the|about|on)\b/g, '').trim();
    return { templateId: 'browse-news', params: { topic: topic || 'world news' } };
  }

  if (lower.includes('fill') && lower.includes('form')) {
    return { templateId: 'browse-form-filler', params: typeof input === 'object' ? input : { data: input } };
  }

  if (lower.includes('check') || lower.includes('monitor')) {
    return { templateId: 'browse-page-monitor', params: typeof input === 'object' ? input : { url: lower } };
  }

  return { templateId: 'browse-web-search', params: { query: typeof input === 'string' ? input : input.query || input.task || String(input) } };
}

module.exports = BaseAgent.create({
  id: 'browsing-agent',
  name: 'Browsing Agent',
  description: 'Web browsing and research agent. Reads pages, searches the web, fills forms, monitors sites. Resilient to CAPTCHAs, login walls, and bot detection. Tries fast HTTP extraction first, falls back to full browser when needed.',
  categories: ['system', 'browser', 'research', 'web'],
  keywords: [
    'browse', 'web', 'search', 'scrape', 'extract', 'read page', 'website',
    'url', 'link', 'news', 'headlines', 'github', 'form', 'monitor',
    'weather online', 'lookup', 'check website',
  ],
  executionType: 'action',
  estimatedExecutionMs: 10000,

  prompt: `Browsing Agent handles any task that requires visiting or interacting with websites.

HIGH CONFIDENCE (0.85+) for:
- "Go to [URL] and extract the content"
- "Search the web for [topic]"
- "Read this page: [URL]"
- "Get the latest news about [topic]"
- "Fill out the form at [URL]"
- "Check if [URL] has been updated"
- "Browse GitHub repo [URL]"
- "What does [website] say about [topic]?"
- Any request involving a URL or web browsing

MEDIUM CONFIDENCE (0.5-0.8) for:
- General research questions that might need web data
- "Look up [fact] online"
- "Find information about [topic]"

LOW CONFIDENCE (0.0) for:
- Local app operations (use app-agent)
- File editing (use browser-agent for Playwright)
- Calendar/email/weather (dedicated agents handle those)
- General knowledge the LLM already knows`,

  async onExecute(task) {
    const input = task.input || task.content || '';
    const { templateId, params } = classifyTask(input);

    log.info('agent', 'Browsing agent routing', { v0: templateId, v1: JSON.stringify(params).slice(0, 100) });

    const agentTemplates = getTemplates();
    const template = agentTemplates.find((t) => t.id === templateId);

    if (template) {
      const result = await template.execute(params);
      return formatResult(result);
    }

    const fp = getFastPath();
    const searchResult = await fp.query(typeof input === 'string' ? input : params.query || '', { deepExtract: true });

    if (searchResult.sources && searchResult.sources.length > 0) {
      const summary = searchResult.sources
        .filter((s) => s.extractedText || s.snippet)
        .map((s) => `**${s.title}** (${s.url || 'no url'})\n${s.extractedText || s.snippet}`)
        .join('\n\n');

      return {
        success: true,
        message: summary || 'No content could be extracted from search results.',
      };
    }

    return { success: false, message: 'Could not find relevant information.' };
  },
});

function formatResult(result) {
  if (result.success && result.data) {
    if (typeof result.data === 'string') {
      return { success: true, message: result.data };
    }
    if (result.data.text) {
      return { success: true, message: result.data.text };
    }
    if (Array.isArray(result.data)) {
      const summary = result.data
        .filter((s) => s.snippet || s.extractedText || s.text)
        .map((s) => `**${s.title || 'Source'}**: ${s.extractedText || s.snippet || s.text}`)
        .join('\n\n');
      return { success: true, message: summary || JSON.stringify(result.data, null, 2) };
    }
    return { success: true, message: JSON.stringify(result.data, null, 2) };
  }

  if (result.partial) {
    return {
      success: true,
      message: `Partial result (${result.error}): ${typeof result.partial === 'string' ? result.partial : JSON.stringify(result.partial)}`,
    };
  }

  return {
    success: false,
    message: result.error || 'Browsing task did not return a result.',
  };
}
