const { BrowserWindow } = require('electron');

class ContentStyleAnalyzer {
  constructor() {
    this.window = null;
  }

  async analyzeContentStyle(url, options = {}) {
    console.log('[ContentStyleAnalyzer] Analyzing content style from:', url);

    try {
      // Create a hidden window for content fetching
      this.window = new BrowserWindow({
        width: 1280,
        height: 800,
        show: false,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          webSecurity: false,
        },
      });

      await this.window.loadURL(url);

      // Wait for page to load
      await new Promise((resolve) => {
        setTimeout(resolve, 3000);
      });

      // Extract page content
      const pageContent = await this.window.webContents.executeJavaScript(`
        (() => {
          // Remove script and style tags for cleaner content
          const scripts = document.querySelectorAll('script, style, noscript');
          scripts.forEach(el => el.remove());
          
          // Extract main content areas
          const contentSelectors = [
            'main', 'article', '[role="main"]', 
            '.content', '#content', '.style-guide',
            '.guidelines', '.documentation'
          ];
          
          let mainContent = '';
          
          for (const selector of contentSelectors) {
            const element = document.querySelector(selector);
            if (element) {
              mainContent = element.innerText || element.textContent;
              break;
            }
          }
          
          // If no main content found, get body text
          if (!mainContent) {
            mainContent = document.body.innerText || document.body.textContent;
          }
          
          // Also extract any meta information
          const metaDescription = document.querySelector('meta[name="description"]')?.content || '';
          const title = document.title;
          
          // Look for specific style guide sections
          const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4'))
            .map(h => ({
              level: h.tagName,
              text: h.innerText.trim()
            }));
          
          // Extract lists that might contain guidelines
          const lists = Array.from(document.querySelectorAll('ul, ol'))
            .map(list => ({
              items: Array.from(list.querySelectorAll('li'))
                .map(li => li.innerText.trim())
                .filter(text => text.length > 0)
            }))
            .filter(list => list.items.length > 0);
          
          // Extract any code examples or formatted blocks
          const codeBlocks = Array.from(document.querySelectorAll('pre, code, .code-block'))
            .map(block => block.innerText.trim())
            .filter(text => text.length > 0);
          
          return {
            url: window.location.href,
            title: title,
            metaDescription: metaDescription,
            content: mainContent.substring(0, 50000), // Limit content size
            headings: headings,
            lists: lists.slice(0, 20), // Limit number of lists
            codeExamples: codeBlocks.slice(0, 10), // Limit code examples
            wordCount: mainContent.split(/\\s+/).length
          };
        })();
      `);

      // Close the window
      if (this.window && !this.window.isDestroyed()) {
        this.window.close();
      }

      // Analyze the content for style guidelines
      const styleGuidelines = await this.extractStyleGuidelines(pageContent, options);

      return {
        success: true,
        content: pageContent,
        guidelines: styleGuidelines,
      };
    } catch (error) {
      console.error('[ContentStyleAnalyzer] Error:', error);

      if (this.window && !this.window.isDestroyed()) {
        this.window.close();
      }

      return {
        success: false,
        error: error.message,
      };
    }
  }

  async extractStyleGuidelines(pageContent, _options) {
    // This would normally use AI to analyze the content
    // For now, we'll extract key patterns

    const guidelines = {
      tone: this.extractToneGuidelines(pageContent),
      formatting: this.extractFormattingGuidelines(pageContent),
      terminology: this.extractTerminology(pageContent),
      structure: this.extractStructureGuidelines(pageContent),
      citations: this.extractCitationStyle(pageContent),
    };

    return guidelines;
  }

  extractToneGuidelines(content) {
    const toneKeywords = {
      formal: ['formal', 'professional', 'academic', 'scholarly'],
      casual: ['casual', 'conversational', 'friendly', 'informal'],
      technical: ['technical', 'precise', 'detailed', 'specific'],
      persuasive: ['persuasive', 'compelling', 'convincing', 'authoritative'],
    };

    const guidelines = [];
    const lowerContent = content.content.toLowerCase();

    // Look for tone indicators
    for (const [tone, keywords] of Object.entries(toneKeywords)) {
      for (const keyword of keywords) {
        if (
          lowerContent.includes(keyword + ' tone') ||
          lowerContent.includes(keyword + ' voice') ||
          lowerContent.includes(keyword + ' style')
        ) {
          guidelines.push({
            type: 'tone',
            value: tone,
            confidence: 'high',
          });
          break;
        }
      }
    }

    // Look for specific voice guidelines
    const voicePatterns = [
      { pattern: /first person/i, value: 'first-person' },
      { pattern: /third person/i, value: 'third-person' },
      { pattern: /active voice/i, value: 'active-voice' },
      { pattern: /passive voice/i, value: 'passive-voice' },
    ];

    voicePatterns.forEach(({ pattern, value }) => {
      if (pattern.test(content.content)) {
        guidelines.push({
          type: 'voice',
          value: value,
          confidence: 'high',
        });
      }
    });

    return guidelines;
  }

  extractFormattingGuidelines(content) {
    const guidelines = [];

    // Look for formatting rules in lists
    content.lists.forEach((list) => {
      list.items.forEach((item) => {
        // Check for heading formatting
        if (/heading|title|header/i.test(item)) {
          if (/sentence case/i.test(item)) {
            guidelines.push({
              type: 'heading-case',
              value: 'sentence',
              confidence: 'high',
            });
          } else if (/title case/i.test(item)) {
            guidelines.push({
              type: 'heading-case',
              value: 'title',
              confidence: 'high',
            });
          }
        }

        // Check for list formatting
        if (/bullet|list/i.test(item)) {
          if (/period|full stop/i.test(item)) {
            guidelines.push({
              type: 'list-punctuation',
              value: 'period',
              confidence: 'medium',
            });
          }
        }
      });
    });

    // Look for specific formatting patterns
    const formattingPatterns = [
      { pattern: /oxford comma/i, type: 'oxford-comma', value: true },
      { pattern: /no oxford comma/i, type: 'oxford-comma', value: false },
      { pattern: /em dash|—/g, type: 'dash-style', value: 'em-dash' },
      { pattern: /en dash|–/g, type: 'dash-style', value: 'en-dash' },
    ];

    formattingPatterns.forEach(({ pattern, type, value }) => {
      if (pattern.test(content.content)) {
        guidelines.push({
          type: type,
          value: value,
          confidence: 'medium',
        });
      }
    });

    return guidelines;
  }

  extractTerminology(content) {
    const terminology = [];

    // Look for glossary or terminology sections
    content.headings.forEach((heading, _index) => {
      if (/glossary|terminology|terms|definitions/i.test(heading.text)) {
        // Extract terms from the following content
        // This is simplified - would need more sophisticated extraction
        terminology.push({
          section: heading.text,
          confidence: 'high',
        });
      }
    });

    // Look for consistent capitalization patterns
    const properNouns = content.content.match(/[A-Z][a-z]+(?:\s[A-Z][a-z]+)*/g) || [];
    const frequentTerms = {};

    properNouns.forEach((term) => {
      if (term.length > 3) {
        // Skip short words
        frequentTerms[term] = (frequentTerms[term] || 0) + 1;
      }
    });

    // Extract frequently used terms
    Object.entries(frequentTerms)
      .filter(([_term, count]) => count > 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .forEach(([term, count]) => {
        terminology.push({
          term: term,
          frequency: count,
          confidence: 'medium',
        });
      });

    return terminology;
  }

  extractStructureGuidelines(content) {
    const guidelines = [];

    // Analyze heading structure
    const headingLevels = {};
    content.headings.forEach((heading) => {
      headingLevels[heading.level] = (headingLevels[heading.level] || 0) + 1;
    });

    // Determine document structure preferences
    if (headingLevels.H1 > 0 && headingLevels.H2 > headingLevels.H1) {
      guidelines.push({
        type: 'hierarchy',
        value: 'standard',
        confidence: 'high',
      });
    }

    // Look for section patterns
    const sectionPatterns = [
      { pattern: /introduction|overview/i, type: 'section', value: 'introduction' },
      { pattern: /conclusion|summary/i, type: 'section', value: 'conclusion' },
      { pattern: /methodology|methods/i, type: 'section', value: 'methodology' },
      { pattern: /results|findings/i, type: 'section', value: 'results' },
    ];

    content.headings.forEach((heading) => {
      sectionPatterns.forEach(({ pattern, type, value }) => {
        if (pattern.test(heading.text)) {
          guidelines.push({
            type: type,
            value: value,
            level: heading.level,
            confidence: 'high',
          });
        }
      });
    });

    return guidelines;
  }

  extractCitationStyle(content) {
    const citations = [];

    // Look for citation patterns
    const citationPatterns = [
      { pattern: /\(([A-Z][a-z]+(?:\s+&\s+[A-Z][a-z]+)*,?\s+\d{4})\)/g, style: 'apa' },
      { pattern: /\[(\d+)\]/g, style: 'numbered' },
      { pattern: /\(([A-Z][a-z]+\s+\d{4}:\s*\d+)\)/g, style: 'chicago' },
    ];

    citationPatterns.forEach(({ pattern, style }) => {
      const matches = content.content.match(pattern) || [];
      if (matches.length > 0) {
        citations.push({
          style: style,
          count: matches.length,
          confidence: matches.length > 3 ? 'high' : 'medium',
        });
      }
    });

    // Look for bibliography or references section
    content.headings.forEach((heading) => {
      if (/references|bibliography|works cited/i.test(heading.text)) {
        citations.push({
          hasReferences: true,
          heading: heading.text,
          confidence: 'high',
        });
      }
    });

    return citations;
  }
}

module.exports = ContentStyleAnalyzer;
