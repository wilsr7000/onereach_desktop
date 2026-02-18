const { getSettingsManager } = require('./settings-manager');
const ai = require('./lib/ai-service');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ipcMain } = require('electron');
const WebStyleAnalyzer = require('./web-style-analyzer');
const ContentStyleAnalyzer = require('./content-style-analyzer');
const { getLogQueue } = require('./lib/log-event-queue');
const log = getLogQueue();

class SmartExport {
  constructor() {
    this.settingsManager = getSettingsManager();
    // Rough token estimation (4 chars ≈ 1 token)
    this.CHARS_PER_TOKEN = 4;
    this.MAX_TOKENS = 180000; // Leave some buffer from the 200k limit
    this.MAX_ITEMS_PER_REQUEST = 100; // Limit items to prevent token overflow
    this.styleGuideCSS = this.loadStyleGuideCSS();
    this.styleAnalyzer = new WebStyleAnalyzer();
    this.contentAnalyzer = new ContentStyleAnalyzer();
    // setupIpcHandlers is now called from main.js after instantiation
  }

  loadStyleGuideCSS() {
    try {
      const cssPath = path.join(__dirname, 'smart-export-styles.css');
      return fs.readFileSync(cssPath, 'utf8');
    } catch (error) {
      log.error('app', 'Error loading style guide CSS', { error: error.message || error });
      // Return a minimal fallback CSS if file can't be loaded
      return `
        :root {
          --bg-primary: #F5F2ED;
          --text-primary: #2C2C2C;
          --text-secondary: #5A5A5A;
          --accent-line: #D4D4D4;
          --accent-dot: #8B8B8B;
        }
        .smart-export-document {
          background-color: var(--bg-primary);
          color: var(--text-primary);
          font-family: serif;
          padding: 3rem;
        }
      `;
    }
  }

  setupIpcHandlers() {
    ipcMain.handle('smart-export:extract-styles', async (event, urls, options = {}) => {
      try {
        log.info('app', 'Extracting CSS styles from URLs', { urls });

        // Enable LLM enhancement by default unless explicitly disabled
        const analyzerOptions = {
          ...options,
          useLLMEnhancement: options.useLLMEnhancement !== false, // Default to true
        };

        return await this.styleAnalyzer.analyzeStyles(urls, analyzerOptions);
      } catch (error) {
        log.error('app', 'Style extraction error', { error: error.message || error });
        throw error;
      }
    });

    ipcMain.handle('smart-export:extract-content-guidelines', async (event, url, options) => {
      try {
        log.info('app', 'Extracting content guidelines from URL', { url });
        const result = await this.contentAnalyzer.analyzeContentStyle(url, options);

        if (result.success) {
          // Format guidelines for easier use
          const formattedGuidelines = this.formatContentGuidelines(result.guidelines);
          return {
            success: true,
            url: url,
            content: result.content,
            guidelines: formattedGuidelines,
            rawGuidelines: result.guidelines,
          };
        } else {
          return result;
        }
      } catch (error) {
        log.error('app', 'Content guideline extraction error', { error: error.message || error });
        return {
          success: false,
          error: error.message,
        };
      }
    });

    ipcMain.handle('smart-export:generate-with-guidelines', async (event, data) => {
      try {
        const { template, guidelines, userContent } = data;

        // Generate content that follows the extracted guidelines
        const enhancedPrompt = this.buildEnhancedPrompt(template, guidelines, userContent);

        // Here you would integrate with your AI service
        // For now, return a structured response
        return {
          success: true,
          content: enhancedPrompt,
          appliedGuidelines: guidelines,
        };
      } catch (error) {
        log.error('app', 'Generation with guidelines error', { error: error.message || error });
        return {
          success: false,
          error: error.message,
        };
      }
    });
  }

  formatContentGuidelines(guidelines) {
    const formatted = {
      tone: [],
      formatting: [],
      terminology: [],
      structure: [],
      citations: [],
    };

    // Format tone guidelines
    if (guidelines.tone && guidelines.tone.length > 0) {
      formatted.tone = guidelines.tone.map((g) => ({
        rule: g.type === 'tone' ? `Use ${g.value} tone` : `Use ${g.value}`,
        confidence: g.confidence,
      }));
    }

    // Format formatting guidelines
    if (guidelines.formatting && guidelines.formatting.length > 0) {
      formatted.formatting = guidelines.formatting.map((g) => {
        let rule = '';
        switch (g.type) {
          case 'heading-case':
            rule = `Use ${g.value} case for headings`;
            break;
          case 'list-punctuation':
            rule = `End list items with ${g.value}s`;
            break;
          case 'oxford-comma':
            rule = g.value ? 'Use Oxford comma' : 'Do not use Oxford comma';
            break;
          case 'dash-style':
            rule = `Use ${g.value}s`;
            break;
          default:
            rule = `${g.type}: ${g.value}`;
        }
        return { rule, confidence: g.confidence };
      });
    }

    // Format terminology
    if (guidelines.terminology && guidelines.terminology.length > 0) {
      formatted.terminology = guidelines.terminology
        .filter((t) => t.term)
        .map((t) => ({
          term: t.term,
          usage: `Use consistently (appears ${t.frequency || 0} times)`,
          confidence: t.confidence,
        }));
    }

    // Format structure guidelines
    if (guidelines.structure && guidelines.structure.length > 0) {
      formatted.structure = guidelines.structure.map((g) => ({
        rule: g.type === 'section' ? `Include ${g.value} section` : `Use ${g.value} document structure`,
        confidence: g.confidence,
      }));
    }

    // Format citation guidelines
    if (guidelines.citations && guidelines.citations.length > 0) {
      const citationStyle = guidelines.citations.find((c) => c.style);
      if (citationStyle) {
        formatted.citations.push({
          rule: `Use ${citationStyle.style.toUpperCase()} citation style`,
          confidence: citationStyle.confidence,
        });
      }

      const hasRefs = guidelines.citations.find((c) => c.hasReferences);
      if (hasRefs) {
        formatted.citations.push({
          rule: `Include ${hasRefs.heading} section`,
          confidence: hasRefs.confidence,
        });
      }
    }

    return formatted;
  }

  buildEnhancedPrompt(template, guidelines, userContent) {
    let prompt = `Generate content for: ${template.name}\n\n`;

    // Add style guidelines
    prompt += 'Please follow these style guidelines:\n\n';

    if (guidelines.tone && guidelines.tone.length > 0) {
      prompt += 'TONE AND VOICE:\n';
      guidelines.tone.forEach((g) => {
        prompt += `- ${g.rule}\n`;
      });
      prompt += '\n';
    }

    if (guidelines.formatting && guidelines.formatting.length > 0) {
      prompt += 'FORMATTING:\n';
      guidelines.formatting.forEach((g) => {
        prompt += `- ${g.rule}\n`;
      });
      prompt += '\n';
    }

    if (guidelines.terminology && guidelines.terminology.length > 0) {
      prompt += 'TERMINOLOGY:\n';
      guidelines.terminology.forEach((g) => {
        prompt += `- "${g.term}": ${g.usage}\n`;
      });
      prompt += '\n';
    }

    if (guidelines.structure && guidelines.structure.length > 0) {
      prompt += 'DOCUMENT STRUCTURE:\n';
      guidelines.structure.forEach((g) => {
        prompt += `- ${g.rule}\n`;
      });
      prompt += '\n';
    }

    if (guidelines.citations && guidelines.citations.length > 0) {
      prompt += 'CITATIONS:\n';
      guidelines.citations.forEach((g) => {
        prompt += `- ${g.rule}\n`;
      });
      prompt += '\n';
    }

    // Add user content
    prompt += 'USER CONTENT:\n';
    prompt += userContent + '\n\n';

    // Add template-specific instructions
    prompt += 'TEMPLATE REQUIREMENTS:\n';
    prompt += JSON.stringify(template, null, 2);

    return prompt;
  }

  /**
   * Generate a smart export using Claude 4 Opus
   * @param {Object} space - The space object
   * @param {Array} items - Array of space items
   * @param {Object} options - Export options
   * @returns {Promise<Object>} Generated HTML and metadata
   */
  async generateSmartExport(space, items, options = {}) {
    // Check content size and handle large spaces
    const processedItems = this.preprocessItems(items);

    // Log image items to debug
    const imageItems = processedItems.filter(
      (item) => item.type === 'image' || (item.type === 'file' && item.fileType === 'image')
    );
    log.info('app', 'Image items after processing', {
      detail: imageItems.map((item) => ({
        id: item.id,
        type: item.type,
        content: item.content,
        imagePath: item.imagePath,
        imageDataUrl: item.imageDataUrl,
        hasOriginalDataUrl: !!item.originalDataUrl,
        fileName: item.metadata?.filename || item.fileName,
      })),
    });

    // Prepare the content for Claude
    const prompt = this.buildPrompt(space, processedItems, options);

    // Estimate tokens
    const estimatedTokens = this.estimateTokens(prompt);
    log.info('app', 'Prompt size: ... characters, estimated ... tokens', {
      promptCount: prompt.length,
      estimatedTokens,
    });

    if (estimatedTokens > this.MAX_TOKENS) {
      log.warn('app', 'Content too large (... tokens). Using summarized version.', { estimatedTokens });
      // Further reduce content if still too large
      const summaryItems = this.createSummaryItems(processedItems);
      return this.generateSmartExport(space, summaryItems, { ...options, isSummary: true });
    }

    // Get Claude 4 specific settings
    const _thinkingMode = this.settingsManager.getClaude4ThinkingMode();
    const thinkingLevel = this.settingsManager.getClaude4ThinkingLevel();

    // Enhance prompt based on thinking level
    const enhancedPrompt = this.enhancePromptForThinkingLevel(prompt, thinkingLevel);

    try {
      const result = await ai.chat({
        profile: 'powerful', // smart export uses powerful models for document generation
        messages: [{ role: 'user', content: enhancedPrompt }],
        maxTokens: 8000,
        temperature: 0.3,
        feature: 'smart-export',
      });

      log.info('app', 'AI service response structure', {
        detail: {
          model: result.model,
          provider: result.provider,
          contentLength: result.content?.length || 0,
          cost: result.cost || 0,
          usedFallback: result.usedFallback || false,
        },
      });

      // Response content is always in result.content
      let htmlContent = result.content || '';

      if (!htmlContent) {
        throw new Error('No HTML content generated');
      }

      // Remove markdown code block formatting if present
      // Claude sometimes wraps HTML in ```html ... ``` blocks
      htmlContent = htmlContent.trim();

      // Check for markdown code blocks with various formats
      const codeBlockRegex = /^```(?:html|HTML)?\s*\n([\s\S]*?)\n?```\s*$/;
      const match = htmlContent.match(codeBlockRegex);

      if (match) {
        log.info('app', 'Stripping markdown code block formatting from HTML');
        htmlContent = match[1].trim();
      } else if (htmlContent.startsWith('```') && htmlContent.includes('```')) {
        // Fallback for any other code block format
        log.info('app', 'Stripping generic code block formatting from HTML');
        const start = htmlContent.indexOf('\n') + 1;
        const end = htmlContent.lastIndexOf('```');
        if (start > 0 && end > start) {
          htmlContent = htmlContent.slice(start, end).trim();
        }
      }

      // Extract thinking summary if available (ai-service doesn't expose this yet)
      let thinkingSummary = null;
      // Note: thinking_summary is not currently exposed by ai-service
      // This would need to be added to the adapter if needed

      // Post-process HTML to inject data URLs back
      log.info('app', 'HTML before post-processing length', { htmlContentCount: htmlContent.length });
      const finalHTML = this.postProcessHTML(htmlContent, processedItems);
      log.info('app', 'HTML after post-processing length', { finalHTMLCount: finalHTML.length });

      return {
        html: finalHTML,
        thinkingSummary,
        metadata: {
          model: result.model,
          timestamp: new Date().toISOString(),
          itemCount: items.length,
          processedItemCount: processedItems.length,
          spaceName: space.name,
          isSummary: options.isSummary || false,
          cost: result.cost || 0,
          usedFallback: result.usedFallback || false,
        },
      };
    } catch (error) {
      log.error('app', 'Error generating smart export', { error: error.message || error });
      throw error;
    }
  }

  /**
   * Preprocess items to handle large content
   * @param {Array} items - Original items
   * @returns {Array} Processed items
   */
  preprocessItems(items) {
    // Sort by timestamp (newest first)
    const sortedItems = [...items].sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));

    // Take only the most recent items if there are too many
    if (sortedItems.length > this.MAX_ITEMS_PER_REQUEST) {
      log.info('app', 'Limiting to ... most recent items out of ...', {
        MAX_ITEMS_PER_REQUEST: this.MAX_ITEMS_PER_REQUEST,
        sortedItemsCount: sortedItems.length,
      });
      return sortedItems.slice(0, this.MAX_ITEMS_PER_REQUEST);
    }

    // Clean items - remove binary data and truncate long content
    return sortedItems.map((item) => {
      const cleanedItem = { ...item };

      // Handle different types of content
      if (item.type === 'image' || (item.type === 'file' && item.fileType === 'image')) {
        // For images, preserve the path/URL but remove binary data
        cleanedItem.content = `[Image: ${item.metadata?.filename || 'Untitled'}]`;

        // Preserve image source information
        if (item.filePath) {
          // Convert absolute path to file:// URL for HTML (cross-platform)
          cleanedItem.imagePath = pathToFileURL(item.filePath).href;
        } else if (item.metadata?.path) {
          cleanedItem.imagePath = pathToFileURL(item.metadata.path).href;
        } else if (item.content && item.content.startsWith('data:')) {
          // For base64 images, keep reference for post-processing
          cleanedItem.imageDataUrl = '[DATA_URL_PLACEHOLDER]';
          cleanedItem.originalDataUrl = item.content;
        } else if (item.dataUrl && item.dataUrl.startsWith('data:')) {
          // Alternative property name for data URLs
          cleanedItem.imageDataUrl = '[DATA_URL_PLACEHOLDER]';
          cleanedItem.originalDataUrl = item.dataUrl;
        } else if (item.imageData && item.imageData.startsWith('data:')) {
          // Another alternative property name
          cleanedItem.imageDataUrl = '[DATA_URL_PLACEHOLDER]';
          cleanedItem.originalDataUrl = item.imageData;
        }

        // Keep dimensions and other metadata
        if (item.metadata?.dimensions) {
          cleanedItem.dimensions = item.metadata.dimensions;
        }

        delete cleanedItem.imageData;
        delete cleanedItem.base64;
        delete cleanedItem.dataUrl;
      } else if (item.type === 'file') {
        // For files, keep only metadata
        cleanedItem.content = `[File: ${item.metadata?.filename || item.fileName || 'Untitled'}, ${item.fileType || 'Unknown type'}]`;
        delete cleanedItem.fileData;
        delete cleanedItem.base64;
        delete cleanedItem.dataUrl;
      } else if (item.content) {
        // For text content, check if it looks like base64 or binary
        if (item.content.startsWith('data:') || item.content.match(/^[A-Za-z0-9+/]{100,}={0,2}$/)) {
          cleanedItem.content = '[Binary data removed]';
        } else if (item.content.length > 5000) {
          // Truncate very long text content
          cleanedItem.content = item.content.substring(0, 5000) + '... [content truncated]';
          cleanedItem.wasTruncated = true;
        }
      }

      // Remove any fields that might contain binary data
      const binaryFields = ['imageData', 'fileData', 'base64', 'dataUrl', 'buffer', 'blob'];
      binaryFields.forEach((field) => {
        delete cleanedItem[field];
      });

      return cleanedItem;
    });
  }

  /**
   * Create summary items for very large spaces
   * @param {Array} items - Items to summarize
   * @returns {Array} Summary items
   */
  createSummaryItems(items) {
    const itemsByType = {};

    // Group items by type
    items.forEach((item) => {
      const type = item.type || 'text';
      if (!itemsByType[type]) {
        itemsByType[type] = [];
      }
      itemsByType[type].push(item);
    });

    // Create summary items for each type
    const summaryItems = [];

    Object.entries(itemsByType).forEach(([type, typeItems]) => {
      // Take only first 10 items of each type
      const samples = typeItems.slice(0, 10);

      summaryItems.push({
        id: `summary-${type}`,
        type: 'summary',
        content: `Type: ${type}\nTotal: ${typeItems.length} items\nShowing: ${samples.length} samples`,
        metadata: {
          originalType: type,
          totalCount: typeItems.length,
          sampleCount: samples.length,
        },
        timestamp: new Date().toISOString(),
      });

      // Add the sample items with cleaned content
      samples.forEach((item) => {
        const cleanedItem = { ...item };

        // Apply same cleaning logic as preprocessItems
        if (item.type === 'image' || (item.type === 'file' && item.fileType === 'image')) {
          cleanedItem.content = `[Image: ${item.metadata?.filename || 'Untitled'}]`;

          // Preserve image source information (cross-platform)
          if (item.filePath) {
            cleanedItem.imagePath = pathToFileURL(item.filePath).href;
          } else if (item.metadata?.path) {
            cleanedItem.imagePath = pathToFileURL(item.metadata.path).href;
          } else if (item.content && item.content.startsWith('data:')) {
            cleanedItem.imageDataUrl = '[DATA_URL_PLACEHOLDER]';
            cleanedItem.originalDataUrl = item.content;
          } else if (item.dataUrl && item.dataUrl.startsWith('data:')) {
            cleanedItem.imageDataUrl = '[DATA_URL_PLACEHOLDER]';
            cleanedItem.originalDataUrl = item.dataUrl;
          } else if (item.imageData && item.imageData.startsWith('data:')) {
            cleanedItem.imageDataUrl = '[DATA_URL_PLACEHOLDER]';
            cleanedItem.originalDataUrl = item.imageData;
          }

          if (item.metadata?.dimensions) {
            cleanedItem.dimensions = item.metadata.dimensions;
          }

          delete cleanedItem.imageData;
          delete cleanedItem.base64;
          delete cleanedItem.dataUrl;
        } else if (item.type === 'file') {
          cleanedItem.content = `[File: ${item.metadata?.filename || item.fileName || 'Untitled'}]`;
          delete cleanedItem.fileData;
          delete cleanedItem.base64;
          delete cleanedItem.dataUrl;
        } else if (item.content) {
          if (item.content.startsWith('data:') || item.content.match(/^[A-Za-z0-9+/]{100,}={0,2}$/)) {
            cleanedItem.content = '[Binary data removed]';
          } else {
            cleanedItem.content = item.content.substring(0, 1000) + (item.content.length > 1000 ? '...' : '');
          }
        }

        // Remove binary fields
        const binaryFields = ['imageData', 'fileData', 'base64', 'dataUrl', 'buffer', 'blob'];
        binaryFields.forEach((field) => {
          delete cleanedItem[field];
        });

        summaryItems.push(cleanedItem);
      });
    });

    return summaryItems;
  }

  /**
   * Estimate token count for a string
   * @param {string} text - Text to estimate
   * @returns {number} Estimated token count
   */
  estimateTokens(text) {
    return Math.ceil(text.length / this.CHARS_PER_TOKEN);
  }

  buildPrompt(space, items, options) {
    // Group items by type
    const itemsByType = this.groupItemsByType(items);

    const summaryNote = options.isSummary
      ? '\nNOTE: This is a SUMMARIZED export due to size constraints. Not all items are included.\n'
      : '';

    // Check if a template is provided
    if (options.template) {
      const template = options.template;

      // Build template-specific prompt
      let templatePrompt = template.prompt || '';

      // Add template-specific system context
      if (template.systemPrompt) {
        templatePrompt = template.systemPrompt + '\n\n' + templatePrompt;
      }

      // Add space and items information
      templatePrompt += `\n\nCONTENT TO FORMAT:
${summaryNote}
SPACE INFORMATION:
- Name: ${space.name}
- Description: ${space.description || 'No description'}
- Created: ${new Date(space.createdAt).toLocaleDateString()}
- Total Items: ${items.length}

ITEMS BY TYPE:
${Object.entries(itemsByType)
  .map(([type, count]) => `- ${type}: ${count} items`)
  .join('\n')}

ITEMS:
${JSON.stringify(
  items.map((item) => ({
    id: item.id,
    type: item.type,
    content: item.content || item.text,
    metadata: item.metadata,
    timestamp: item.timestamp,
    tags: item.tags,
    wasTruncated: item.wasTruncated || false,
    imagePath: item.imagePath,
    imageDataUrl: item.imageDataUrl,
    dimensions: item.dimensions,
  })),
  null,
  2
)}`;

      // Add styling requirements with COMPLETE CSS
      templatePrompt += `\n\nIMPORTANT STYLING REQUIREMENTS:
You MUST use the following CSS classes and embed the complete CSS in the HTML. 

COMPLETE CSS TO EMBED:
\`\`\`css
${this.styleGuideCSS}
\`\`\`

HTML STRUCTURE:
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${space.name} - Export</title>
    <link href="https://fonts.googleapis.com/css2?family=Crimson+Text:ital,wght@0,400;0,600;1,400;1,600&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
    <style>
    /* Embed the COMPLETE CSS from above here */
    ${this.styleGuideCSS}
    </style>
</head>
<body>
    <div class="smart-export-document">
        <header class="document-header">
            <h1 class="document-title">${space.name}</h1>
            <div class="document-meta">
                <span class="document-date">${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                <span class="document-context">Context: ${space.description || 'Knowledge Space Export'}</span>
            </div>
        </header>
        
        <!-- Your content here using the CSS classes -->
        
    </div>
</body>
</html>

KEY CSS CLASSES TO USE:
- .smart-export-document - main container with warm beige background
- .document-header - header with space-between layout
- .document-title - uppercase serif title
- .document-meta - right-aligned metadata
- .section-header - section headings with underline accent
- .body-text - serif paragraph text
- .content-card - bordered content boxes
- .card-title - uppercase card headings
- .styled-list - lists with custom bullets
- .timeline-container, .journey-stages - for journey maps
- .emotion-curve - for emotional journey visualization
- .thought-annotation - italicized user thoughts
- .quote-block - bordered quotes
- .styled-table - professional tables
- .insight-card - for key findings
- .metric-display - large numbers display

DESIGN PRINCIPLES:
- The CSS provides a warm beige (#F5F2ED) background
- Typography uses Crimson Text serif font
- Maintain generous white space
- Use subtle gray lines (#D4D4D4)
- Keep the design minimal and sophisticated`;

      // Add example if provided
      if (template.example) {
        templatePrompt += `\n\nEXAMPLE STRUCTURE:
${JSON.stringify(template.example, null, 2)}`;
      }

      templatePrompt += `\n\nOUTPUT FORMAT:
1. Return ONLY the complete HTML document - do NOT wrap it in markdown code blocks or any other formatting
2. Include the COMPLETE CSS from above in the <style> tag (don't summarize or shorten it)
3. Use the CSS classes appropriately throughout your content
4. For images, use the imagePath as src if provided, or create placeholder with data-item-id attribute
5. ALWAYS wrap the main content in a div with class="smart-export-document"
6. The document must be self-contained and portable with all styles embedded
7. Start directly with <!DOCTYPE html> or <html> - no markdown formatting`;

      return templatePrompt;
    }

    // Default prompt (no template) - UPDATED
    const prompt = `You are an expert document formatter. Create a beautiful, well-organized HTML document for a knowledge space export using a sophisticated journey map design aesthetic.
${summaryNote}
SPACE INFORMATION:
- Name: ${space.name}
- Description: ${space.description || 'No description'}
- Created: ${new Date(space.createdAt).toLocaleDateString()}
- Total Items: ${items.length}

ITEMS BY TYPE:
${Object.entries(itemsByType)
  .map(([type, count]) => `- ${type}: ${count} items`)
  .join('\n')}

ITEMS TO FORMAT:
${JSON.stringify(
  items.map((item) => ({
    id: item.id,
    type: item.type,
    content: item.content || item.text,
    metadata: item.metadata,
    timestamp: item.timestamp,
    tags: item.tags,
    wasTruncated: item.wasTruncated || false,
    imagePath: item.imagePath,
    imageDataUrl: item.imageDataUrl,
    dimensions: item.dimensions,
  })),
  null,
  2
)}

REQUIREMENTS:
1. Use the CSS classes from the complete style guide below
2. Create this HTML structure with the COMPLETE EMBEDDED STYLES:

COMPLETE CSS TO EMBED IN YOUR HTML:
\`\`\`css
${this.styleGuideCSS}
\`\`\`
   
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${space.name} - Export</title>
    <link href="https://fonts.googleapis.com/css2?family=Crimson+Text:ital,wght@0,400;0,600;1,400;1,600&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
    <style>
      /* Copy the COMPLETE CSS from above here - ALL OF IT */
      ${this.styleGuideCSS}
    </style>
</head>
<body>
    <div class="smart-export-document">
        <header class="document-header">
            <h1 class="document-title">${space.name}</h1>
            <div class="document-meta">
                <span class="document-date">${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                <span class="document-context">User Persona: ${space.description || 'Knowledge Worker'}</span>
            </div>
        </header>
        
        <!-- Content sections here -->
        
    </div>
</body>
</html>

3. Use these CSS classes throughout:
   - .section-header for all section headings
   - .body-text for paragraphs
   - .emphasized-text for important quotes or insights
   - .content-card for grouping related items
   - .card-title for card headings
   - .styled-list for any lists
   - .timeline-container, .timeline-stages for chronological content
   - .quote-block for quotes or important excerpts
   - .insight-card for key findings or insights
   - .styled-table for any tabular data

4. Format each item type appropriately:
   - Text: Use .body-text or .emphasized-text
   - Code: Use .content-card with <pre><code> inside
   - Images: Wrap in .content-card with proper styling
   - Links: Use .content-card with .card-title
   - Files: Use .insight-card with file details

5. For images:
   - Wrap in a .content-card
   - Use imagePath as src or create placeholder with data-item-id
   - Add proper alt text and styling

6. Group items logically using:
   - .section-header for major sections
   - .timeline-container for chronological organization
   - .opportunity-grid for comparing multiple items

7. Add a table of contents using .styled-list

8. Include page navigation at bottom using .document-navigation

OUTPUT FORMAT:
1. Return ONLY the complete HTML document - do NOT wrap it in markdown code blocks or any other formatting
2. CRITICAL: Copy the ENTIRE CSS from above into your <style> tag - don't leave anything out
3. Use the CSS classes correctly throughout your content:
   - Start with <div class="smart-export-document">
   - Use proper headers, sections, cards, lists, etc.
4. The document must be completely self-contained with all styles embedded
5. Follow the warm, sophisticated journey map aesthetic
6. Start directly with <!DOCTYPE html> or <html> - no markdown formatting`;

    return prompt;
  }

  enhancePromptForThinkingLevel(prompt, level) {
    switch (level) {
      case 'think':
        return `Please think about the best way to organize this content before formatting.\n\n${prompt}`;
      case 'think-hard':
        return `Please think hard about the optimal structure, visual hierarchy, and user experience for this document.\n\n${prompt}`;
      case 'ultrathink':
        return `Please use ultra-deep thinking to create the most sophisticated, well-organized document possible. Consider information architecture, visual design principles, and optimal reading flow.\n\n${prompt}`;
      default:
        return prompt;
    }
  }

  groupItemsByType(items) {
    const groups = {};
    items.forEach((item) => {
      const type = item.type || 'text';
      groups[type] = (groups[type] || 0) + 1;
    });
    return groups;
  }

  /**
   * Post-process the generated HTML
   * @param {string} html - The generated HTML
   * @param {Array} items - The processed items with original data
   * @returns {string} Processed HTML
   */
  postProcessHTML(html, items) {
    let processedHTML = html;

    log.info('app', 'Post-processing HTML for', { arg1: items.length, arg2: 'items' });

    // Count images that need data URL injection
    const imagesToInject = items.filter((item) => item.originalDataUrl);
    log.info('app', 'Images needing data URL injection', { imagesToInjectCount: imagesToInject.length });

    // Inject data URLs back for images that had them
    items.forEach((item) => {
      if (item.originalDataUrl) {
        log.info('app', 'Processing image', { arg1: item.id, arg2: item.metadata?.filename || item.fileName });
        // Create patterns to find image references
        const patterns = [];

        // If item has an ID, look for it
        if (item.id) {
          patterns.push(
            // img tag with data-item-id attribute
            new RegExp(`<img[^>]*data-item-id="${item.id}"[^>]*>`, 'gi'),
            // img tag with ID in alt text
            new RegExp(`<img[^>]*alt="[^"]*\\b${item.id}\\b[^"]*"[^>]*>`, 'gi')
          );
        }

        // If item has filename, look for it
        if (item.metadata?.filename || item.fileName) {
          const filename = item.metadata?.filename || item.fileName;
          const escapedFilename = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          patterns.push(
            // img tag with filename in alt
            new RegExp(`<img[^>]*alt="[^"]*${escapedFilename}[^"]*"[^>]*>`, 'gi'),
            // img tag with filename in title
            new RegExp(`<img[^>]*title="[^"]*${escapedFilename}[^"]*"[^>]*>`, 'gi')
          );
        }

        // Look for placeholder text
        patterns.push(new RegExp(`\\[DATA_URL_PLACEHOLDER\\]`, 'g'), new RegExp(`src="[^"]*placeholder[^"]*"`, 'gi'));

        patterns.forEach((pattern) => {
          const matches = processedHTML.match(pattern);
          if (matches) {
            log.info('app', 'Found matches for pattern', { pattern, arg2: 'Matches:', matchesCount: matches.length });
          }

          processedHTML = processedHTML.replace(pattern, (match) => {
            log.info('app', 'Replacing match', { detail: match.substring(0, 100) + '...' });

            // For img tags, always replace the src if we have a data URL
            if (match.includes('<img') && match.includes('src=')) {
              const replaced = match.replace(/src="[^"]*"/, `src="${item.originalDataUrl}"`);
              log.info('app', 'Replaced with', { detail: replaced.substring(0, 100) + '...' });
              return replaced;
            } else if (match === '[DATA_URL_PLACEHOLDER]') {
              return item.originalDataUrl;
            }
            return match;
          });
        });
      }
    });

    return processedHTML;
  }
}

module.exports = SmartExport;
