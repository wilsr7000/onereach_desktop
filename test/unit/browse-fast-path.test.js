import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../lib/browser-stealth', () => ({
  getUserAgent: vi.fn().mockReturnValue('Mozilla/5.0 Chrome/125.0.0.0'),
  getSecChUa: vi.fn().mockReturnValue('"Chromium";v="125"'),
}));

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('BrowseFastPath', () => {
  let fastPath;

  function makeHeaders(obj) {
    return { get: (key) => obj[key.toLowerCase()] || null };
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    mockFetch.mockReset();
    fastPath = await import('../../lib/browse-fast-path.js');
    fastPath.clearCache();
  });

  describe('searchDuckDuckGo()', () => {
    it('should return search results from DuckDuckGo API', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          AbstractText: 'Austin is the capital of Texas.',
          AbstractSource: 'Wikipedia',
          AbstractURL: 'https://en.wikipedia.org/wiki/Austin',
          RelatedTopics: [
            { Text: 'Austin weather is warm', FirstURL: 'https://example.com/weather' },
            { Text: 'Austin population is 1M', FirstURL: 'https://example.com/population' },
          ],
        }),
      });

      const result = await fastPath.searchDuckDuckGo('Austin Texas');

      expect(result.results.length).toBeGreaterThan(0);
      expect(result.results[0].title).toBe('Wikipedia');
      expect(result.results[0].snippet).toContain('Austin');
      expect(result.source).toBe('duckduckgo');
    });

    it('should handle API errors gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const result = await fastPath.searchDuckDuckGo('test query');

      expect(result.results).toEqual([]);
      expect(result.error).toBe('Network error');
    });

    it('should handle non-200 responses', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 429 });

      const result = await fastPath.searchDuckDuckGo('test');
      expect(result.results).toEqual([]);
      expect(result.error).toContain('429');
    });

    it('should limit results to maxResults', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          AbstractText: '',
          RelatedTopics: Array.from({ length: 20 }, (_, i) => ({
            Text: `Topic ${i}`, FirstURL: `https://example.com/${i}`,
          })),
        }),
      });

      const result = await fastPath.searchDuckDuckGo('test', 3);
      expect(result.results.length).toBeLessThanOrEqual(3);
    });
  });

  describe('fetchAndExtract()', () => {
    it('should fetch and extract HTML content', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: makeHeaders({ 'content-type': 'text/html' }),
        text: () => Promise.resolve(`
          <html>
            <head><title>Test Page</title>
              <meta name="description" content="A test page">
            </head>
            <body>
              <nav>Navigation stuff</nav>
              <article>
                <h1>Hello World</h1>
                <p>This is the main content of the page.</p>
              </article>
              <footer>Footer stuff</footer>
            </body>
          </html>
        `),
      });

      const result = await fastPath.fetchAndExtract('https://example.com/article');

      expect(result.text).toContain('Hello World');
      expect(result.text).toContain('main content');
      expect(result.metadata.title).toBe('Test Page');
      expect(result.metadata.description).toBe('A test page');
      expect(result.extractionMethod).toBe('http');
    });

    it('should strip navigation, header, and footer', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: makeHeaders({ 'content-type': 'text/html' }),
        text: () => Promise.resolve(`
          <html><body>
            <nav>Menu items here</nav>
            <header>Header content</header>
            <main>Real content here</main>
            <footer>Footer links</footer>
          </body></html>
        `),
      });

      const result = await fastPath.fetchAndExtract('https://example.com');
      expect(result.text).not.toContain('Menu items here');
      expect(result.text).not.toContain('Header content');
      expect(result.text).not.toContain('Footer links');
      expect(result.text).toContain('Real content here');
    });

    it('should extract JSON-LD structured data', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: makeHeaders({ 'content-type': 'text/html' }),
        text: () => Promise.resolve(`
          <html><head>
            <title>Product</title>
            <script type="application/ld+json">{"@type":"Product","name":"Widget","price":"$9.99"}</script>
          </head><body><p>This is a product page with enough content to not be flagged as insufficient.</p></body></html>
        `),
      });

      const result = await fastPath.fetchAndExtract('https://example.com/product');
      expect(result.metadata.structuredData).toBeDefined();
      expect(result.metadata.structuredData[0]).toHaveProperty('name', 'Widget');
    });

    it('should truncate content exceeding maxLength', async () => {
      const longText = 'A'.repeat(20000);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: makeHeaders({ 'content-type': 'text/html' }),
        text: () => Promise.resolve(`<html><body><p>${longText}</p></body></html>`),
      });

      const result = await fastPath.fetchAndExtract('https://example.com', { maxLength: 500 });
      expect(result.text.length).toBeLessThan(600);
      expect(result.text).toContain('[...truncated]');
    });

    it('should flag pages with insufficient content as needsBrowser', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: makeHeaders({ 'content-type': 'text/html' }),
        text: () => Promise.resolve('<html><body><script>app.init()</script></body></html>'),
      });

      const result = await fastPath.fetchAndExtract('https://spa-app.com');
      expect(result.needsBrowser).toBe(true);
    });

    it('should handle fetch errors', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

      const result = await fastPath.fetchAndExtract('https://down.example.com');
      expect(result.text).toBe('');
      expect(result.error).toBe('Connection refused');
      expect(result.needsBrowser).toBe(true);
    });

    it('should handle non-200 responses', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 403 });

      const result = await fastPath.fetchAndExtract('https://blocked.example.com');
      expect(result.error).toContain('403');
      expect(result.status).toBe(403);
    });
  });

  describe('Content Caching', () => {
    it('should cache extracted content', async () => {
      const longContent = 'A'.repeat(200);
      mockFetch.mockResolvedValue({
        ok: true,
        headers: makeHeaders({ 'content-type': 'text/html' }),
        text: () => Promise.resolve(`<html><head><title>Cached</title></head><body><article>${longContent}</article></body></html>`),
      });

      const uniqueUrl = 'https://example.com/cached-' + Date.now();
      const first = await fastPath.fetchAndExtract(uniqueUrl);
      expect(first.fromCache).toBeUndefined();

      const second = await fastPath.fetchAndExtract(uniqueUrl);
      expect(second.fromCache).toBe(true);
    });

    it('should clear cache on demand', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        headers: makeHeaders({ 'content-type': 'text/html' }),
        text: () => Promise.resolve('<html><body><p>Content long enough to be cached properly.</p></body></html>'),
      });

      await fastPath.fetchAndExtract('https://example.com/clear');
      fastPath.clearCache();

      const stats = fastPath.getCacheStats();
      expect(stats.size).toBe(0);
    });
  });

  describe('query()', () => {
    it('should perform a search and return results', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          AbstractText: 'The weather in Austin is sunny.',
          AbstractSource: 'Weather.com',
          AbstractURL: 'https://weather.com/austin',
          RelatedTopics: [],
        }),
      });

      const result = await fastPath.query('weather in Austin');

      expect(result.sources.length).toBeGreaterThan(0);
      expect(result.path).toBe('search-api');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('should perform deep extraction when requested', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            AbstractText: 'Summary',
            AbstractURL: 'https://example.com/page',
            RelatedTopics: [],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: makeHeaders({ 'content-type': 'text/html' }),
          text: () => Promise.resolve('<html><body><p>Deep extracted content that is long enough.</p></body></html>'),
        });

      const result = await fastPath.query('test query', { deepExtract: true });
      expect(result.path).toBe('http-fetch');
      expect(result.sources[0]).toHaveProperty('extractedText');
    });

    it('should handle no results', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ AbstractText: '', RelatedTopics: [] }),
      });

      const result = await fastPath.query('obscure query nobody would search');
      expect(result.sources).toEqual([]);
      expect(result.error).toContain('No results');
    });
  });

  describe('extractUrl()', () => {
    it('should extract URL content via HTTP', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: makeHeaders({ 'content-type': 'text/html' }),
        text: () => Promise.resolve('<html><body><article>Article content here which is long enough.</article></body></html>'),
      });

      const result = await fastPath.extractUrl('https://example.com/article');
      expect(result.text).toContain('Article content');
    });

    it('should indicate when browser fallback is needed', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: makeHeaders({ 'content-type': 'text/html' }),
        text: () => Promise.resolve('<html><body></body></html>'),
      });

      const result = await fastPath.extractUrl('https://spa.example.com', { fallbackToBrowser: true });
      expect(result.fallbackNeeded).toBe(true);
    });
  });
});
