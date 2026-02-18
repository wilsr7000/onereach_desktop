/**
 * Style Prompt Generator
 * Generates AI prompts from extracted style guides for consistent design/content creation
 */

class StylePromptGenerator {
  constructor() {
    this.templates = {
      // Design prompts
      webPage: 'web-page',
      component: 'component',
      landingPage: 'landing-page',
      email: 'email',
      socialMedia: 'social-media',

      // Copy prompts
      headline: 'headline',
      cta: 'cta',
      productDescription: 'product-description',
      blogPost: 'blog-post',
      emailCopy: 'email-copy',
      adCopy: 'ad-copy',
    };
  }

  /**
   * Generate a design prompt from a visual style guide
   */
  generateDesignPrompt(styleGuide, options = {}) {
    const {
      type = 'web-page',
      purpose = '',
      additionalContext = '',
      includeColors = true,
      includeTypography = true,
      includeButtons = true,
      includeSpacing = true,
    } = options;

    let prompt = `Create a ${type} design with the following style specifications:\n\n`;

    // Brand context
    if (styleGuide.url) {
      prompt += `## Reference\nBased on the visual style of: ${styleGuide.url}\n\n`;
    }

    // Purpose
    if (purpose) {
      prompt += `## Purpose\n${purpose}\n\n`;
    }

    // Typography
    if (includeTypography && styleGuide.typography) {
      prompt += `## Typography\n`;

      if (styleGuide.typography.fonts?.length > 0) {
        const primaryFont = styleGuide.typography.fonts[0];
        prompt += `- **Primary Font:** ${primaryFont.primary}\n`;
        if (styleGuide.typography.fonts[1]) {
          prompt += `- **Secondary Font:** ${styleGuide.typography.fonts[1].primary}\n`;
        }
      }

      if (styleGuide.typography.body) {
        prompt += `- **Body Text:** ${styleGuide.typography.body.fontSize} / ${styleGuide.typography.body.lineHeight}\n`;
      }

      if (styleGuide.typography.headings) {
        prompt += `- **Heading Sizes:**\n`;
        Object.entries(styleGuide.typography.headings).forEach(([tag, styles]) => {
          prompt += `  - ${tag.toUpperCase()}: ${styles.fontSize} (${styles.fontWeight})\n`;
        });
      }
      prompt += `\n`;
    }

    // Colors
    if (includeColors && styleGuide.colors) {
      prompt += `## Color Palette\n`;

      if (styleGuide.colors.backgrounds?.length > 0) {
        prompt += `- **Background Colors:**\n`;
        styleGuide.colors.backgrounds.slice(0, 5).forEach((c) => {
          prompt += `  - ${c.value} (${c.context})\n`;
        });
      }

      if (styleGuide.colors.text?.length > 0) {
        prompt += `- **Text Colors:**\n`;
        styleGuide.colors.text.slice(0, 3).forEach((c) => {
          prompt += `  - ${c.value} (${c.context})\n`;
        });
      }

      if (styleGuide.colors.accents?.length > 0) {
        prompt += `- **Accent/Brand Colors:**\n`;
        styleGuide.colors.accents.slice(0, 5).forEach((c) => {
          prompt += `  - ${c.value} (${c.context})\n`;
        });
      }
      prompt += `\n`;
    }

    // Buttons
    if (includeButtons && styleGuide.buttons?.length > 0) {
      prompt += `## Button Styles\n`;
      styleGuide.buttons.slice(0, 3).forEach((btn, i) => {
        prompt += `- **Button ${i + 1}:**\n`;
        prompt += `  - Background: ${btn.backgroundColor}\n`;
        prompt += `  - Text: ${btn.color}\n`;
        prompt += `  - Border Radius: ${btn.borderRadius}\n`;
        prompt += `  - Padding: ${btn.padding}\n`;
      });
      prompt += `\n`;
    }

    // Spacing & Layout
    if (includeSpacing) {
      if (styleGuide.borders?.radii?.length > 0) {
        prompt += `## Border Radii\n`;
        prompt += `Use these border radius values: ${styleGuide.borders.radii.slice(0, 4).join(', ')}\n\n`;
      }

      if (styleGuide.shadows?.length > 0) {
        prompt += `## Shadows\n`;
        styleGuide.shadows.slice(0, 2).forEach((s, i) => {
          prompt += `- Shadow ${i + 1}: \`${s}\`\n`;
        });
        prompt += `\n`;
      }
    }

    // CSS Variables if available
    if (styleGuide.cssVariables && Object.keys(styleGuide.cssVariables).length > 0) {
      prompt += `## CSS Variables (use these for consistency)\n\`\`\`css\n`;
      Object.entries(styleGuide.cssVariables)
        .slice(0, 15)
        .forEach(([name, value]) => {
          prompt += `${name}: ${value};\n`;
        });
      prompt += `\`\`\`\n\n`;
    }

    // Additional context
    if (additionalContext) {
      prompt += `## Additional Requirements\n${additionalContext}\n\n`;
    }

    // Instructions
    prompt += `## Instructions\n`;
    prompt += `- Maintain visual consistency with the style specifications above\n`;
    prompt += `- Use the exact color values provided\n`;
    prompt += `- Follow the typography hierarchy\n`;
    prompt += `- Apply consistent spacing and border radii\n`;

    return prompt;
  }

  /**
   * Generate a copy/content prompt from a copy style guide
   */
  generateCopyPrompt(copyGuide, options = {}) {
    const { type = 'general', topic = '', targetAudience = '', additionalContext = '', length = 'medium' } = options;

    let prompt = `Write ${type} content with the following brand voice and style:\n\n`;

    // Brand context
    if (copyGuide.brand?.name) {
      prompt += `## Brand\n`;
      prompt += `- **Name:** ${copyGuide.brand.name}\n`;
      if (copyGuide.brand.tagline) {
        prompt += `- **Tagline:** ${copyGuide.brand.tagline}\n`;
      }
      prompt += `\n`;
    }

    // Topic
    if (topic) {
      prompt += `## Topic\n${topic}\n\n`;
    }

    // Target audience
    if (targetAudience) {
      prompt += `## Target Audience\n${targetAudience}\n\n`;
    }

    // Voice & Tone
    if (copyGuide.toneIndicators) {
      const tones = Object.entries(copyGuide.toneIndicators)
        .filter(([_, v]) => v > 0)
        .sort((a, b) => b[1] - a[1]);

      if (tones.length > 0) {
        prompt += `## Voice & Tone\n`;
        prompt += `The brand voice is primarily:\n`;
        tones.slice(0, 3).forEach(([tone, score]) => {
          const intensity = score > 10 ? 'very' : score > 5 ? 'moderately' : 'slightly';
          prompt += `- **${intensity} ${tone}**\n`;
        });
        prompt += `\n`;
      }
    }

    // Writing style
    if (copyGuide.patterns) {
      prompt += `## Writing Style\n`;

      const avgLength = copyGuide.patterns.averageSentenceLength;
      if (avgLength) {
        if (avgLength < 12) {
          prompt += `- Use short, punchy sentences (around ${avgLength} words)\n`;
        } else if (avgLength > 20) {
          prompt += `- Use detailed, explanatory sentences (around ${avgLength} words)\n`;
        } else {
          prompt += `- Use medium-length sentences (around ${avgLength} words)\n`;
        }
      }

      if (copyGuide.patterns.punctuation) {
        if (copyGuide.patterns.punctuation.exclamations > 5) {
          prompt += `- Use exclamation points for energy and enthusiasm\n`;
        } else if (copyGuide.patterns.punctuation.exclamations === 0) {
          prompt += `- Avoid exclamation points (keep tone measured)\n`;
        }

        if (copyGuide.patterns.punctuation.questions > 3) {
          prompt += `- Use rhetorical questions to engage readers\n`;
        }
      }
      prompt += `\n`;
    }

    // Key vocabulary
    if (copyGuide.keyPhrases) {
      prompt += `## Vocabulary to Use\n`;

      if (copyGuide.keyPhrases.action?.length > 0) {
        prompt += `- **Action words:** ${copyGuide.keyPhrases.action.slice(0, 10).join(', ')}\n`;
      }

      if (copyGuide.keyPhrases.emotional?.length > 0) {
        prompt += `- **Benefit/emotional words:** ${copyGuide.keyPhrases.emotional.slice(0, 10).join(', ')}\n`;
      }

      if (copyGuide.keyPhrases.social?.length > 0) {
        prompt += `- **Social proof phrases:** ${copyGuide.keyPhrases.social.slice(0, 5).join(', ')}\n`;
      }
      prompt += `\n`;
    }

    // CTA patterns
    if (copyGuide.callsToAction?.length > 0) {
      prompt += `## CTA Patterns (use similar style)\n`;
      copyGuide.callsToAction.slice(0, 5).forEach((cta) => {
        prompt += `- "${cta.text}"\n`;
      });
      prompt += `\n`;
    }

    // Headline patterns
    if (copyGuide.headlines?.primary?.length > 0 || copyGuide.headlines?.secondary?.length > 0) {
      prompt += `## Headline Style Examples\n`;
      const headlines = [...(copyGuide.headlines.primary || []), ...(copyGuide.headlines.secondary || [])];
      headlines.slice(0, 5).forEach((h) => {
        prompt += `- "${h}"\n`;
      });
      prompt += `\n`;
    }

    // Product names to use
    if (copyGuide.productNames?.length > 0) {
      prompt += `## Product/Feature Names\n`;
      prompt += `Use these exact names: ${copyGuide.productNames.slice(0, 10).join(', ')}\n\n`;
    }

    // Length guidance
    prompt += `## Length\n`;
    switch (length) {
      case 'short':
        prompt += `Keep it brief and concise (1-2 paragraphs max)\n\n`;
        break;
      case 'long':
        prompt += `Provide comprehensive, detailed content (multiple sections)\n\n`;
        break;
      default:
        prompt += `Medium length (2-4 paragraphs)\n\n`;
    }

    // Additional context
    if (additionalContext) {
      prompt += `## Additional Requirements\n${additionalContext}\n\n`;
    }

    // Instructions
    prompt += `## Instructions\n`;
    prompt += `- Match the brand voice and tone described above\n`;
    prompt += `- Use the vocabulary patterns provided\n`;
    prompt += `- Follow the writing style guidelines\n`;
    prompt += `- Maintain consistency with the headline and CTA patterns\n`;

    return prompt;
  }

  /**
   * Generate a combined design + copy prompt
   */
  generateFullPrompt(styleGuide, copyGuide, options = {}) {
    const { type = 'landing-page', purpose = '', topic = '', targetAudience = '', additionalContext = '' } = options;

    let prompt = `Create a ${type} with the following design and content specifications:\n\n`;

    // Purpose
    if (purpose) {
      prompt += `## Purpose\n${purpose}\n\n`;
    }

    // Target audience
    if (targetAudience) {
      prompt += `## Target Audience\n${targetAudience}\n\n`;
    }

    // Brand
    if (copyGuide?.brand?.name) {
      prompt += `## Brand Identity\n`;
      prompt += `- **Brand:** ${copyGuide.brand.name}\n`;
      if (copyGuide.brand.tagline) {
        prompt += `- **Tagline:** ${copyGuide.brand.tagline}\n`;
      }
      prompt += `\n`;
    }

    // ===== VISUAL DESIGN =====
    prompt += `---\n# VISUAL DESIGN\n---\n\n`;

    // Typography
    if (styleGuide?.typography) {
      prompt += `## Typography\n`;
      if (styleGuide.typography.fonts?.[0]) {
        prompt += `- **Font Family:** ${styleGuide.typography.fonts[0].full}\n`;
      }
      if (styleGuide.typography.body) {
        prompt += `- **Body:** ${styleGuide.typography.body.fontSize}, ${styleGuide.typography.body.color}\n`;
      }
      if (styleGuide.typography.headings?.h1) {
        prompt += `- **H1:** ${styleGuide.typography.headings.h1.fontSize}, ${styleGuide.typography.headings.h1.fontWeight}\n`;
      }
      prompt += `\n`;
    }

    // Colors
    if (styleGuide?.colors) {
      prompt += `## Colors\n`;
      if (styleGuide.colors.backgrounds?.[0]) {
        prompt += `- **Primary Background:** ${styleGuide.colors.backgrounds[0].value}\n`;
      }
      if (styleGuide.colors.text?.[0]) {
        prompt += `- **Primary Text:** ${styleGuide.colors.text[0].value}\n`;
      }
      if (styleGuide.colors.accents?.length > 0) {
        prompt += `- **Accent Colors:** ${styleGuide.colors.accents
          .slice(0, 3)
          .map((c) => c.value)
          .join(', ')}\n`;
      }
      prompt += `\n`;
    }

    // Buttons
    if (styleGuide?.buttons?.[0]) {
      const btn = styleGuide.buttons[0];
      prompt += `## Button Style\n`;
      prompt += `- Background: ${btn.backgroundColor}\n`;
      prompt += `- Text: ${btn.color}\n`;
      prompt += `- Border Radius: ${btn.borderRadius}\n\n`;
    }

    // ===== CONTENT/COPY =====
    prompt += `---\n# CONTENT & COPY\n---\n\n`;

    // Voice
    if (copyGuide?.toneIndicators) {
      const dominantTone = Object.entries(copyGuide.toneIndicators)
        .filter(([_, v]) => v > 0)
        .sort((a, b) => b[1] - a[1])[0];

      if (dominantTone) {
        prompt += `## Voice\n`;
        prompt += `Primary tone: **${dominantTone[0]}**\n\n`;
      }
    }

    // Writing style
    if (copyGuide?.patterns?.averageSentenceLength) {
      prompt += `## Writing Style\n`;
      prompt += `Average sentence length: ${copyGuide.patterns.averageSentenceLength} words\n\n`;
    }

    // Vocabulary
    if (copyGuide?.keyPhrases) {
      prompt += `## Key Vocabulary\n`;
      if (copyGuide.keyPhrases.action?.length > 0) {
        prompt += `- Action: ${copyGuide.keyPhrases.action.slice(0, 5).join(', ')}\n`;
      }
      if (copyGuide.keyPhrases.emotional?.length > 0) {
        prompt += `- Emotional: ${copyGuide.keyPhrases.emotional.slice(0, 5).join(', ')}\n`;
      }
      prompt += `\n`;
    }

    // CTA style
    if (copyGuide?.callsToAction?.length > 0) {
      prompt += `## CTA Style\n`;
      prompt += `Examples: ${copyGuide.callsToAction
        .slice(0, 3)
        .map((c) => `"${c.text}"`)
        .join(', ')}\n\n`;
    }

    // Topic
    if (topic) {
      prompt += `## Content Topic\n${topic}\n\n`;
    }

    // Additional context
    if (additionalContext) {
      prompt += `## Additional Requirements\n${additionalContext}\n\n`;
    }

    return prompt;
  }

  /**
   * Generate specific prompt types
   */
  generateLandingPagePrompt(styleGuide, copyGuide, options = {}) {
    return this.generateFullPrompt(styleGuide, copyGuide, {
      type: 'landing page',
      ...options,
      additionalContext: `${options.additionalContext || ''}
Include these sections:
- Hero section with headline and CTA
- Features/benefits section
- Social proof/testimonials
- Final CTA section`,
    });
  }

  generateEmailPrompt(styleGuide, copyGuide, options = {}) {
    return this.generateFullPrompt(styleGuide, copyGuide, {
      type: 'email',
      ...options,
      additionalContext: `${options.additionalContext || ''}
Structure:
- Compelling subject line
- Personalized greeting
- Clear value proposition
- Single focused CTA
- Professional signature`,
    });
  }

  generateSocialPostPrompt(copyGuide, options = {}) {
    const { platform = 'general', topic = '' } = options;

    let prompt = `Write a ${platform} social media post:\n\n`;

    if (copyGuide?.brand?.name) {
      prompt += `Brand: ${copyGuide.brand.name}\n`;
    }

    if (topic) {
      prompt += `Topic: ${topic}\n\n`;
    }

    // Tone
    if (copyGuide?.toneIndicators) {
      const tones = Object.entries(copyGuide.toneIndicators)
        .filter(([_, v]) => v > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([t]) => t);
      prompt += `Tone: ${tones.join(', ')}\n`;
    }

    // Key phrases
    if (copyGuide?.keyPhrases?.action?.length > 0) {
      prompt += `Use words like: ${copyGuide.keyPhrases.action.slice(0, 5).join(', ')}\n`;
    }

    // Platform-specific
    switch (platform.toLowerCase()) {
      case 'twitter':
      case 'x':
        prompt += `\nLimit: 280 characters\nInclude relevant hashtags`;
        break;
      case 'linkedin':
        prompt += `\nTone: Professional\nInclude a hook and call-to-action`;
        break;
      case 'instagram':
        prompt += `\nInclude emojis and hashtags\nEngaging, visual language`;
        break;
      case 'facebook':
        prompt += `\nConversational tone\nEncourage engagement`;
        break;
    }

    return prompt;
  }

  generateHeadlinePrompt(copyGuide, options = {}) {
    const { topic = '', count = 5 } = options;

    let prompt = `Generate ${count} headline variations:\n\n`;

    if (topic) {
      prompt += `Topic: ${topic}\n\n`;
    }

    // Style from existing headlines
    if (copyGuide?.headlines?.primary?.length > 0) {
      prompt += `Match this headline style:\n`;
      copyGuide.headlines.primary.slice(0, 3).forEach((h) => {
        prompt += `- "${h}"\n`;
      });
      prompt += `\n`;
    }

    // Tone
    if (copyGuide?.toneIndicators) {
      const dominantTone = Object.entries(copyGuide.toneIndicators)
        .filter(([_, v]) => v > 0)
        .sort((a, b) => b[1] - a[1])[0];
      if (dominantTone) {
        prompt += `Tone: ${dominantTone[0]}\n`;
      }
    }

    // Key words
    if (copyGuide?.keyPhrases?.action?.length > 0) {
      prompt += `Consider using: ${copyGuide.keyPhrases.action.slice(0, 5).join(', ')}\n`;
    }

    return prompt;
  }

  generateCTAPrompt(copyGuide, options = {}) {
    const { action = '', count = 5 } = options;

    let prompt = `Generate ${count} call-to-action button text variations:\n\n`;

    if (action) {
      prompt += `Desired action: ${action}\n\n`;
    }

    // Existing CTA patterns
    if (copyGuide?.callsToAction?.length > 0) {
      prompt += `Match this CTA style:\n`;
      copyGuide.callsToAction.slice(0, 5).forEach((cta) => {
        prompt += `- "${cta.text}"\n`;
      });
      prompt += `\n`;
    }

    // Action words
    if (copyGuide?.keyPhrases?.action?.length > 0) {
      prompt += `Use action words like: ${copyGuide.keyPhrases.action.slice(0, 5).join(', ')}\n`;
    }

    prompt += `\nKeep CTAs short (2-4 words), action-oriented, and compelling.`;

    return prompt;
  }

  // ============================================
  // IMAGE/SCREENSHOT SUPPORT
  // ============================================

  /**
   * Generate a prompt package with images for multimodal AI
   * Returns both text prompt and image references
   *
   * @param {Object} options
   * @param {Object} options.styleGuide - Visual style guide data
   * @param {Object} options.copyGuide - Copy style guide data
   * @param {Array<Object>} options.images - Array of image objects {base64, path, description, type}
   * @param {string} options.type - Type of content to create
   * @param {string} options.purpose - Purpose description
   * @param {string} options.targetAudience - Target audience
   * @param {string} options.additionalContext - Extra context
   */
  generateMultimodalPrompt(options = {}) {
    const {
      styleGuide,
      copyGuide,
      images = [],
      type = 'web page',
      purpose = '',
      targetAudience = '',
      additionalContext = '',
    } = options;

    // Build the text prompt
    let textPrompt = `# Design Request\n\n`;
    textPrompt += `Create a ${type} that matches the visual style shown in the reference images.\n\n`;

    if (purpose) {
      textPrompt += `## Purpose\n${purpose}\n\n`;
    }

    if (targetAudience) {
      textPrompt += `## Target Audience\n${targetAudience}\n\n`;
    }

    // Image descriptions
    if (images.length > 0) {
      textPrompt += `## Reference Images\n`;
      textPrompt += `I'm providing ${images.length} reference image(s):\n\n`;

      images.forEach((img, i) => {
        const imgType = img.type || 'reference';
        const desc = img.description || `Image ${i + 1}`;
        textPrompt += `**Image ${i + 1}** (${imgType}): ${desc}\n`;
      });
      textPrompt += `\n`;
      textPrompt += `Please analyze these images for:\n`;
      textPrompt += `- Color palette and usage\n`;
      textPrompt += `- Typography style and hierarchy\n`;
      textPrompt += `- Layout patterns and spacing\n`;
      textPrompt += `- UI component styles (buttons, cards, etc.)\n`;
      textPrompt += `- Overall visual aesthetic\n\n`;
    }

    // Add extracted style data as supplementary info
    if (styleGuide) {
      textPrompt += `## Extracted Style Data\n`;
      textPrompt += `In addition to the images, here are the extracted style specifications:\n\n`;

      if (styleGuide.typography?.fonts?.[0]) {
        textPrompt += `- **Primary Font:** ${styleGuide.typography.fonts[0].full}\n`;
      }
      if (styleGuide.colors?.backgrounds?.[0]) {
        textPrompt += `- **Background:** ${styleGuide.colors.backgrounds[0].value}\n`;
      }
      if (styleGuide.colors?.text?.[0]) {
        textPrompt += `- **Text Color:** ${styleGuide.colors.text[0].value}\n`;
      }
      if (styleGuide.colors?.accents?.length > 0) {
        textPrompt += `- **Accent Colors:** ${styleGuide.colors.accents
          .slice(0, 3)
          .map((c) => c.value)
          .join(', ')}\n`;
      }
      if (styleGuide.buttons?.[0]) {
        textPrompt += `- **Button Style:** ${styleGuide.buttons[0].backgroundColor} bg, ${styleGuide.buttons[0].borderRadius} radius\n`;
      }
      textPrompt += `\n`;
    }

    // Add copy guide info
    if (copyGuide) {
      textPrompt += `## Brand Voice\n`;
      if (copyGuide.brand?.name) {
        textPrompt += `- **Brand:** ${copyGuide.brand.name}\n`;
      }
      if (copyGuide.toneIndicators) {
        const tones = Object.entries(copyGuide.toneIndicators)
          .filter(([_, v]) => v > 0)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 2)
          .map(([t]) => t);
        if (tones.length > 0) {
          textPrompt += `- **Tone:** ${tones.join(', ')}\n`;
        }
      }
      if (copyGuide.callsToAction?.length > 0) {
        textPrompt += `- **CTA Style:** "${copyGuide.callsToAction[0].text}"\n`;
      }
      textPrompt += `\n`;
    }

    // Additional context
    if (additionalContext) {
      textPrompt += `## Additional Requirements\n${additionalContext}\n\n`;
    }

    // Instructions
    textPrompt += `## Instructions\n`;
    textPrompt += `1. Match the visual style from the reference images as closely as possible\n`;
    textPrompt += `2. Use the extracted color values and typography\n`;
    textPrompt += `3. Maintain the same aesthetic and feel\n`;
    textPrompt += `4. Apply consistent spacing and component styles\n`;

    // Return both text and images for multimodal API calls
    return {
      text: textPrompt,
      images: images.map((img) => ({
        base64: img.base64,
        path: img.path,
        type: img.type || 'image/png',
        description: img.description,
      })),
      // For APIs that need a specific format
      messages: this._formatForAPI(textPrompt, images),
    };
  }

  /**
   * Capture screenshots and generate a complete prompt package
   * Convenience method that combines screenshot capture with prompt generation
   */
  async generatePromptWithScreenshots(url, options = {}) {
    const {
      styleGuide,
      copyGuide,
      captureOptions = {},
      type = 'web page',
      purpose = '',
      targetAudience = '',
      additionalContext = '',
      includeFullPage = true,
      includeResponsive = false,
      includeThumbnail = false,
    } = options;

    // This will be called from renderer with access to window.screenshot
    // Return the configuration for the caller to execute
    return {
      url,
      captures: {
        fullPage: includeFullPage ? { fullPage: true, ...captureOptions } : null,
        responsive: includeResponsive ? { viewports: ['desktop', 'tablet', 'mobile'] } : null,
        thumbnail: includeThumbnail ? { width: 400, height: 300 } : null,
      },
      promptOptions: {
        styleGuide,
        copyGuide,
        type,
        purpose,
        targetAudience,
        additionalContext,
      },
      // Instructions for the caller
      instructions: `
To generate the full prompt with screenshots:

1. Capture screenshots using window.screenshot:
   const fullPage = await window.screenshot.capture(url, { fullPage: true });
   
2. Build the images array:
   const images = [
     { base64: fullPage.base64, type: 'full-page', description: 'Full page screenshot' }
   ];
   
3. Generate the multimodal prompt:
   const result = generator.generateMultimodalPrompt({
     ...promptOptions,
     images
   });
   
4. Use with AI API:
   - For Claude: Pass images in the messages array
   - For GPT-4V: Include image_url in content
`,
    };
  }

  /**
   * Format prompt and images for different AI APIs
   */
  _formatForAPI(textPrompt, images) {
    // Claude/Anthropic format
    const claudeMessages = [
      {
        role: 'user',
        content: [
          // Add images first
          ...images.map((img) => ({
            type: 'image',
            source: {
              type: 'base64',
              media_type: img.type || 'image/png',
              data: img.base64,
            },
          })),
          // Then the text
          {
            type: 'text',
            text: textPrompt,
          },
        ],
      },
    ];

    // OpenAI/GPT-4V format
    const openaiMessages = [
      {
        role: 'user',
        content: [
          // Add images
          ...images.map((img) => ({
            type: 'image_url',
            image_url: {
              url: `data:${img.type || 'image/png'};base64,${img.base64}`,
              detail: 'high',
            },
          })),
          // Then text
          {
            type: 'text',
            text: textPrompt,
          },
        ],
      },
    ];

    return {
      claude: claudeMessages,
      openai: openaiMessages,
      // Generic format for other APIs
      generic: {
        text: textPrompt,
        images: images.map((img) => ({
          base64: img.base64,
          mimeType: img.type || 'image/png',
        })),
      },
    };
  }

  // ============================================
  // IMAGE GENERATION PROMPTS (DALL-E, Imagen)
  // ============================================

  /**
   * Generate an optimized prompt for OpenAI DALL-E image generation
   * DALL-E works best with concise, descriptive prompts
   */
  generateDALLEPrompt(styleGuide, options = {}) {
    const {
      subject = 'website hero section',
      style = 'modern',
      mood = 'professional',
      additionalDetails = '',
      size = '1792x1024', // DALL-E 3 sizes: 1024x1024, 1792x1024, 1024x1792
      quality = 'hd', // 'standard' or 'hd'
    } = options;

    // Build a concise but detailed prompt
    let prompt = '';

    // Subject
    prompt += `${subject}`;

    // Style from extracted data
    if (styleGuide?.colors?.backgrounds?.[0]) {
      const bgColor = this._colorToName(styleGuide.colors.backgrounds[0].value);
      prompt += `, ${bgColor} background`;
    }

    if (styleGuide?.colors?.accents?.length > 0) {
      const accentColors = styleGuide.colors.accents
        .slice(0, 2)
        .map((c) => this._colorToName(c.value))
        .filter((c) => c)
        .join(' and ');
      if (accentColors) {
        prompt += `, ${accentColors} accent colors`;
      }
    }

    // Typography hint
    if (styleGuide?.typography?.fonts?.[0]) {
      const fontStyle = this._fontToStyle(styleGuide.typography.fonts[0].primary);
      if (fontStyle) {
        prompt += `, ${fontStyle} typography`;
      }
    }

    // Style and mood
    prompt += `, ${style} design, ${mood} aesthetic`;

    // Additional details
    if (additionalDetails) {
      prompt += `, ${additionalDetails}`;
    }

    // Quality hints for DALL-E
    prompt += ', high quality, detailed, professional design';

    return {
      prompt: prompt,
      // DALL-E API parameters
      apiParams: {
        model: 'dall-e-3',
        prompt: prompt,
        n: 1,
        size: size,
        quality: quality,
        style: 'vivid', // 'vivid' or 'natural'
      },
      // Alternative variations
      variations: this._generateDALLEVariations(prompt, styleGuide),
    };
  }

  /**
   * Generate an optimized prompt for Google Imagen
   * Imagen excels at photorealistic and artistic images
   */
  generateImagenPrompt(styleGuide, options = {}) {
    const {
      subject = 'website design',
      imageType = 'digital art', // 'photograph', 'digital art', 'illustration', '3d render'
      aspectRatio = '16:9',
      mood = 'professional',
      additionalDetails = '',
    } = options;

    // Build structured prompt for Imagen
    let prompt = '';

    // Image type prefix (Imagen responds well to these)
    prompt += `${imageType} of ${subject}`;

    // Color palette from style guide
    if (styleGuide?.colors) {
      const colors = [];
      if (styleGuide.colors.backgrounds?.[0]) {
        colors.push(this._colorToName(styleGuide.colors.backgrounds[0].value));
      }
      if (styleGuide.colors.accents?.length > 0) {
        styleGuide.colors.accents.slice(0, 2).forEach((c) => {
          const name = this._colorToName(c.value);
          if (name) colors.push(name);
        });
      }
      if (colors.length > 0) {
        prompt += `, color palette: ${colors.join(', ')}`;
      }
    }

    // Style descriptors
    prompt += `, ${mood} mood`;

    // Additional context
    if (additionalDetails) {
      prompt += `, ${additionalDetails}`;
    }

    // Quality boosters for Imagen
    prompt += ', highly detailed, professional quality, sharp focus';

    return {
      prompt: prompt,
      // Google Imagen API parameters
      apiParams: {
        prompt: prompt,
        aspectRatio: aspectRatio,
        numberOfImages: 4,
        negativePrompt: 'blurry, low quality, distorted, ugly, bad composition',
        guidanceScale: 7.5,
        seed: null, // Set for reproducibility
      },
      // Structured prompt for Vertex AI
      vertexAI: {
        instances: [
          {
            prompt: prompt,
          },
        ],
        parameters: {
          sampleCount: 4,
          aspectRatio: aspectRatio,
          negativePrompt: 'blurry, low quality, distorted',
        },
      },
    };
  }

  /**
   * Generate prompts for multiple image generation services at once
   */
  generateImageGenPrompts(styleGuide, copyGuide, options = {}) {
    const {
      subject = 'landing page hero',
      purpose = '',
      _targetAudience = '',
      _includeText = false, // Whether to include text in the image
      _variations = 3,
    } = options;

    // Build context from guides
    let context = subject;
    if (copyGuide?.brand?.name) {
      context = `${copyGuide.brand.name} ${subject}`;
    }

    // Mood from copy guide
    let mood = 'professional';
    if (copyGuide?.toneIndicators) {
      const tones = Object.entries(copyGuide.toneIndicators)
        .filter(([_, v]) => v > 0)
        .sort((a, b) => b[1] - a[1]);
      if (tones[0]) {
        mood = tones[0][0];
      }
    }

    return {
      // OpenAI DALL-E 3
      dalle: this.generateDALLEPrompt(styleGuide, {
        subject: context,
        mood: mood,
        additionalDetails: purpose,
      }),

      // Google Imagen
      imagen: this.generateImagenPrompt(styleGuide, {
        subject: context,
        mood: mood,
        additionalDetails: purpose,
      }),

      // Midjourney-style prompt (can be used with various services)
      midjourney: this._generateMidjourneyStylePrompt(styleGuide, copyGuide, {
        subject: context,
        mood: mood,
        purpose: purpose,
      }),

      // Stable Diffusion optimized
      stableDiffusion: this._generateStableDiffusionPrompt(styleGuide, {
        subject: context,
        mood: mood,
        purpose: purpose,
      }),

      // Summary of all prompts
      summary: {
        subject: context,
        mood: mood,
        colors: this._extractColorSummary(styleGuide),
        fonts: styleGuide?.typography?.fonts?.[0]?.primary || 'modern sans-serif',
      },
    };
  }

  /**
   * Generate a Midjourney-style prompt (works with many services)
   */
  _generateMidjourneyStylePrompt(styleGuide, copyGuide, options = {}) {
    const { subject, mood, _purpose } = options;

    let prompt = subject;

    // Add style modifiers
    const modifiers = [];

    // Color scheme
    if (styleGuide?.colors?.backgrounds?.[0]) {
      const bg = this._colorToName(styleGuide.colors.backgrounds[0].value);
      if (bg) modifiers.push(`${bg} tones`);
    }

    // Mood
    modifiers.push(`${mood} atmosphere`);

    // Quality modifiers (Midjourney responds well to these)
    modifiers.push('sleek design');
    modifiers.push('professional');
    modifiers.push('high detail');

    prompt += ', ' + modifiers.join(', ');

    // Midjourney parameters
    prompt += ' --ar 16:9 --v 6 --q 2';

    return {
      prompt: prompt,
      promptWithoutParams: prompt.replace(/ --.*$/, ''),
      parameters: {
        aspectRatio: '16:9',
        version: '6',
        quality: '2',
      },
    };
  }

  /**
   * Generate a Stable Diffusion optimized prompt
   */
  _generateStableDiffusionPrompt(styleGuide, options = {}) {
    const { subject, mood, _purpose } = options;

    // Positive prompt
    let positive = `${subject}, ${mood}, modern design, professional, `;
    positive += 'high quality, detailed, sharp focus, ';
    positive += '8k resolution, trending on dribbble';

    // Add color info
    if (styleGuide?.colors?.accents?.length > 0) {
      const colors = styleGuide.colors.accents
        .slice(0, 2)
        .map((c) => this._colorToName(c.value))
        .filter((c) => c);
      if (colors.length > 0) {
        positive += `, ${colors.join(' and ')} color scheme`;
      }
    }

    // Negative prompt
    const negative =
      'blurry, low quality, distorted, ugly, bad anatomy, ' + 'bad composition, watermark, signature, text, logo';

    return {
      positive: positive,
      negative: negative,
      // Common SD parameters
      parameters: {
        steps: 30,
        cfg_scale: 7.5,
        sampler: 'DPM++ 2M Karras',
        width: 1024,
        height: 576,
      },
    };
  }

  /**
   * Generate DALL-E prompt variations
   */
  _generateDALLEVariations(basePrompt, _styleGuide) {
    const variations = [];

    // Variation 1: More minimal
    variations.push({
      name: 'minimal',
      prompt: basePrompt.replace('detailed', 'minimal clean'),
    });

    // Variation 2: More vibrant
    variations.push({
      name: 'vibrant',
      prompt: basePrompt + ', vibrant colors, dynamic composition',
    });

    // Variation 3: Dark mode
    variations.push({
      name: 'dark',
      prompt: basePrompt.replace(/light|white/gi, 'dark') + ', dark theme',
    });

    return variations;
  }

  /**
   * Convert RGB/hex color to descriptive name
   */
  _colorToName(colorValue) {
    if (!colorValue) return null;

    // Parse RGB
    let r, g, b;
    if (colorValue.startsWith('rgb')) {
      const match = colorValue.match(/(\d+),\s*(\d+),\s*(\d+)/);
      if (match) {
        [, r, g, b] = match.map(Number);
      }
    } else if (colorValue.startsWith('#')) {
      const hex = colorValue.slice(1);
      r = parseInt(hex.slice(0, 2), 16);
      g = parseInt(hex.slice(2, 4), 16);
      b = parseInt(hex.slice(4, 6), 16);
    }

    if (r === undefined) return null;

    // Determine color name
    const brightness = (r + g + b) / 3;

    if (brightness < 30) return 'black';
    if (brightness > 225) return 'white';
    if (brightness < 60) return 'dark';
    if (brightness > 200) return 'light';

    // Check for specific colors
    if (r > 200 && g < 100 && b < 100) return 'red';
    if (r < 100 && g > 200 && b < 100) return 'green';
    if (r < 100 && g < 100 && b > 200) return 'blue';
    if (r > 200 && g > 200 && b < 100) return 'yellow';
    if (r > 200 && g < 150 && b > 200) return 'purple';
    if (r < 150 && g > 200 && b > 200) return 'cyan';
    if (r > 200 && g > 150 && b < 100) return 'orange';

    // Gray scale
    if (Math.abs(r - g) < 20 && Math.abs(g - b) < 20) {
      if (brightness < 100) return 'charcoal';
      if (brightness < 150) return 'gray';
      return 'silver';
    }

    return 'neutral';
  }

  /**
   * Convert font name to style descriptor
   */
  _fontToStyle(fontName) {
    if (!fontName) return null;

    const lower = fontName.toLowerCase();

    if (lower.includes('mono') || lower.includes('code')) return 'monospace';
    if (lower.includes('serif') && !lower.includes('sans')) return 'elegant serif';
    if (lower.includes('sans') || lower.includes('gothic') || lower.includes('grotesk')) return 'clean sans-serif';
    if (lower.includes('script') || lower.includes('cursive')) return 'flowing script';
    if (lower.includes('display') || lower.includes('black')) return 'bold display';

    return 'modern';
  }

  /**
   * Extract color summary from style guide
   */
  _extractColorSummary(styleGuide) {
    if (!styleGuide?.colors) return 'neutral palette';

    const colors = [];

    if (styleGuide.colors.backgrounds?.[0]) {
      const name = this._colorToName(styleGuide.colors.backgrounds[0].value);
      if (name) colors.push(`${name} background`);
    }

    if (styleGuide.colors.accents?.length > 0) {
      const accents = styleGuide.colors.accents
        .slice(0, 2)
        .map((c) => this._colorToName(c.value))
        .filter((c) => c);
      if (accents.length > 0) {
        colors.push(`${accents.join('/')} accents`);
      }
    }

    return colors.join(', ') || 'neutral palette';
  }

  /**
   * Generate a design prompt with specific image types
   */
  generateDesignPromptWithImages(styleGuide, images, options = {}) {
    const { type = 'component', purpose = '', additionalContext = '' } = options;

    // Categorize images
    const categorized = {
      fullPage: images.filter((i) => i.type === 'full-page'),
      hero: images.filter((i) => i.type === 'hero'),
      component: images.filter((i) => i.type === 'component'),
      responsive: images.filter((i) => i.type === 'responsive'),
      other: images.filter((i) => !['full-page', 'hero', 'component', 'responsive'].includes(i.type)),
    };

    let textPrompt = `# Design ${type}\n\n`;

    if (purpose) {
      textPrompt += `**Purpose:** ${purpose}\n\n`;
    }

    textPrompt += `## Visual References\n\n`;

    if (categorized.fullPage.length > 0) {
      textPrompt += `### Full Page Reference\n`;
      textPrompt += `The full page screenshot shows the overall layout, navigation, and page structure.\n`;
      textPrompt += `Pay attention to: header style, content width, section spacing, footer design.\n\n`;
    }

    if (categorized.hero.length > 0) {
      textPrompt += `### Hero Section\n`;
      textPrompt += `The hero screenshot shows the main above-the-fold content.\n`;
      textPrompt += `Note: headline treatment, CTA placement, background style, imagery use.\n\n`;
    }

    if (categorized.component.length > 0) {
      textPrompt += `### Component Details\n`;
      textPrompt += `These screenshots show specific UI components to replicate.\n`;
      textPrompt += `Match: button styles, card designs, form elements, icons.\n\n`;
    }

    if (categorized.responsive.length > 0) {
      textPrompt += `### Responsive Behavior\n`;
      textPrompt += `These show how the design adapts across viewport sizes.\n`;
      textPrompt += `Ensure the design is responsive following these patterns.\n\n`;
    }

    // Add style data
    if (styleGuide) {
      textPrompt += `## Extracted Specifications\n\n`;
      textPrompt += this._formatStyleData(styleGuide);
    }

    if (additionalContext) {
      textPrompt += `## Additional Context\n${additionalContext}\n\n`;
    }

    textPrompt += `## Output Requirements\n`;
    textPrompt += `- Match the visual style exactly\n`;
    textPrompt += `- Use the same color palette\n`;
    textPrompt += `- Replicate typography choices\n`;
    textPrompt += `- Follow the spacing and layout patterns\n`;

    return {
      text: textPrompt,
      images,
      messages: this._formatForAPI(textPrompt, images),
    };
  }

  /**
   * Helper to format style data concisely
   */
  _formatStyleData(styleGuide) {
    let data = '';

    if (styleGuide.typography) {
      data += `**Typography:**\n`;
      if (styleGuide.typography.fonts?.[0]) {
        data += `- Font: ${styleGuide.typography.fonts[0].primary}\n`;
      }
      if (styleGuide.typography.body) {
        data += `- Body: ${styleGuide.typography.body.fontSize}\n`;
      }
    }

    if (styleGuide.colors) {
      data += `\n**Colors:**\n`;
      if (styleGuide.colors.backgrounds?.[0]) {
        data += `- Background: ${styleGuide.colors.backgrounds[0].value}\n`;
      }
      if (styleGuide.colors.text?.[0]) {
        data += `- Text: ${styleGuide.colors.text[0].value}\n`;
      }
      if (styleGuide.colors.accents?.length > 0) {
        data += `- Accents: ${styleGuide.colors.accents
          .slice(0, 3)
          .map((c) => c.value)
          .join(', ')}\n`;
      }
    }

    if (styleGuide.buttons?.[0]) {
      const btn = styleGuide.buttons[0];
      data += `\n**Buttons:**\n`;
      data += `- Style: ${btn.backgroundColor} / ${btn.color} / ${btn.borderRadius}\n`;
    }

    return data + '\n';
  }

  // ============================================
  // UI MOCKUP GENERATION FOR GSX CREATE
  // ============================================

  /**
   * Generate 4 different design approach prompts for UI mockup generation
   * Each approach has a distinct visual style for user to choose from
   *
   * @param {string} objective - The app/feature objective from user
   * @param {Object} options - Additional context
   * @returns {Array} Array of 4 design approaches with prompts
   */
  generateDesignApproaches(objective, options = {}) {
    const { appType = 'web app', screenSize = '1024x768', includeNav = true, darkModeVariant = false } = options;

    // Base context for all approaches
    const baseContext = `UI mockup for: ${objective}
Application type: ${appType}
Screen size: ${screenSize}
${includeNav ? 'Include navigation header' : 'No navigation header'}`;

    const approaches = [
      {
        id: 'minimal',
        name: 'Minimal & Clean',
        icon: '◯',
        description: 'Lots of whitespace, subtle colors, focus on content',
        bestFor: 'Tools, productivity apps, dashboards',
        prompt: `${baseContext}

DESIGN STYLE: Minimal & Clean
- Abundant whitespace and breathing room
- Monochromatic or very limited color palette (2-3 colors max)
- Light backgrounds (#FAFAFA, #FFFFFF, #F5F5F5)
- Subtle shadows and borders
- Sans-serif typography (Inter, SF Pro, Helvetica Neue)
- Clean geometric shapes
- Thin icons (1.5px stroke)
- Muted accent color for CTAs only
- Card-based layout with generous padding (24-32px)
- No gradients, flat design
- Visual hierarchy through size and weight, not color

Create a professional, sophisticated UI mockup that feels calm and focused.
High-fidelity mockup, photorealistic rendering, UI design, Figma style.`,
      },
      {
        id: 'bold',
        name: 'Bold & Vibrant',
        icon: '◆',
        description: 'Strong colors, high contrast, energetic feel',
        bestFor: 'Consumer apps, marketing, creative tools',
        prompt: `${baseContext}

DESIGN STYLE: Bold & Vibrant
- Vibrant, saturated colors (electric blue, coral, lime green)
- High contrast color combinations
- Gradient backgrounds and accent elements
- Bold typography with strong hierarchy
- Rounded corners (12-16px radius)
- Playful shadows (colored shadows, offset shadows)
- Thick icons (2-2.5px stroke) with color fills
- Dynamic, asymmetric layouts
- Accent colors used generously
- Hover states and interactive feel
- Modern, energetic, youthful aesthetic
- Mix of solid colors and gradients

Create an eye-catching, energetic UI mockup that stands out and excites.
High-fidelity mockup, photorealistic rendering, UI design, Dribbble style.`,
      },
      {
        id: 'professional',
        name: 'Professional & Corporate',
        icon: '▣',
        description: 'Trust-building, structured, business-appropriate',
        bestFor: 'Enterprise, B2B, financial, healthcare',
        prompt: `${baseContext}

DESIGN STYLE: Professional & Corporate
- Conservative color palette (navy, slate gray, white)
- Primary accent: trustworthy blue (#2563EB or similar)
- Structured, grid-based layout
- Clear visual hierarchy
- Professional typography (Source Sans Pro, Roboto, Open Sans)
- Standard border radius (4-8px)
- Subtle shadows for depth
- Data visualization friendly
- Clear section separators
- Status indicators and badges
- Form-heavy layouts done elegantly
- Accessibility-first design choices
- No flashy elements, substance over style

Create a trustworthy, professional UI mockup suitable for enterprise users.
High-fidelity mockup, photorealistic rendering, UI design, corporate style.`,
      },
      {
        id: 'creative',
        name: 'Creative & Playful',
        icon: '✦',
        description: 'Unique typography, artistic, memorable personality',
        bestFor: 'Portfolio, creative tools, entertainment, games',
        prompt: `${baseContext}

DESIGN STYLE: Creative & Playful
- Unexpected color combinations (coral + mint, purple + yellow)
- Custom, distinctive typography (display fonts for headers)
- Organic shapes and irregular borders
- Illustration elements and custom graphics
- Animated feel (show motion through design)
- Micro-interactions implied in static design
- Personality and character throughout
- Breaking the grid intentionally
- Textured backgrounds or patterns
- Hand-drawn or sketch elements
- Emoji or custom iconography
- Surprising delightful details
- Asymmetric balance
- Story-telling through layout

Create a unique, memorable UI mockup with distinct personality and charm.
High-fidelity mockup, photorealistic rendering, UI design, award-winning style.`,
      },
    ];

    // Add dark mode variants if requested
    if (darkModeVariant) {
      approaches.forEach((approach) => {
        approach.prompt = approach.prompt.replace(
          'High-fidelity mockup',
          'DARK MODE VARIANT with dark backgrounds (#0D1117, #1A1A2E, #121212). High-fidelity mockup'
        );
      });
    }

    return approaches;
  }

  /**
   * Generate a single UI mockup prompt with full context
   * Used after user selects an approach
   *
   * @param {string} objective - The app objective
   * @param {Object} approach - Selected approach from generateDesignApproaches
   * @param {Object} options - Additional options
   * @returns {string} Complete prompt for image generation
   */
  generateUIMockupPrompt(objective, approach, options = {}) {
    const { screenSize = '1024x768', additionalInstructions = '', components = [] } = options;

    let prompt = approach.prompt;

    // Add specific components if requested
    if (components.length > 0) {
      prompt += `\n\nMUST INCLUDE THESE UI COMPONENTS:\n`;
      components.forEach((comp) => {
        prompt += `- ${comp}\n`;
      });
    }

    // Add any additional instructions
    if (additionalInstructions) {
      prompt += `\n\nADDITIONAL REQUIREMENTS:\n${additionalInstructions}`;
    }

    // Final quality instructions
    prompt += `\n\nIMPORTANT:
- This is a UI mockup, not a real screenshot
- Show realistic placeholder content (not lorem ipsum)
- Include realistic data/text that matches the app purpose
- Render at ${screenSize} resolution
- Professional quality, ready for development handoff`;

    return prompt;
  }

  /**
   * Extract design tokens from a mockup image for the two-pass approach
   * Returns a prompt that asks Claude to analyze the image
   *
   * @returns {string} Analysis prompt for Claude vision
   */
  getDesignTokenExtractionPrompt() {
    return `Analyze this UI mockup image and extract the design tokens as JSON.

Return ONLY valid JSON with this exact structure:
{
  "colors": {
    "background": "#hex",
    "backgroundSecondary": "#hex",
    "text": "#hex",
    "textSecondary": "#hex",
    "primary": "#hex",
    "primaryHover": "#hex",
    "accent": "#hex",
    "border": "#hex",
    "shadow": "rgba(...)"
  },
  "typography": {
    "fontFamily": "font name",
    "headingWeight": "number",
    "bodyWeight": "number",
    "h1Size": "px",
    "h2Size": "px",
    "bodySize": "px",
    "smallSize": "px"
  },
  "spacing": {
    "xs": "px",
    "sm": "px",
    "md": "px",
    "lg": "px",
    "xl": "px",
    "containerPadding": "px",
    "cardPadding": "px",
    "sectionGap": "px"
  },
  "borders": {
    "radius": "px",
    "radiusLarge": "px",
    "width": "px",
    "style": "solid|dashed|none"
  },
  "effects": {
    "shadowSmall": "CSS shadow value",
    "shadowMedium": "CSS shadow value",
    "shadowLarge": "CSS shadow value",
    "blur": "px or none"
  },
  "layout": {
    "type": "grid|flex|mixed",
    "columns": "number if grid",
    "maxWidth": "px",
    "headerHeight": "px"
  },
  "components": [
    "list of UI components visible: header, card, button, form, table, etc."
  ]
}

Be precise with color hex codes - use a color picker mentally.
Estimate spacing values based on visual proportions.`;
  }

  /**
   * Generate code implementation prompt using extracted design tokens
   * This is the second pass of the two-pass approach
   *
   * @param {string} objective - The app objective
   * @param {Object} designTokens - Extracted tokens from first pass
   * @param {Object} options - Additional options
   * @returns {string} Code generation prompt
   */
  getCodeFromDesignPrompt(objective, designTokens, options = {}) {
    const {
      framework = 'vanilla', // vanilla, tailwind, react
      includeJS = true,
      responsive = true,
    } = options;

    let frameworkInstructions = '';
    if (framework === 'tailwind') {
      frameworkInstructions = `
Use Tailwind CSS classes. Define custom colors in a <style> block:
:root {
  --color-primary: ${designTokens.colors?.primary || '#4f8cff'};
  /* etc */
}`;
    } else if (framework === 'react') {
      frameworkInstructions = 'Generate a React component with styled-components or CSS modules.';
    } else {
      frameworkInstructions = 'Generate vanilla HTML with embedded <style> CSS.';
    }

    return `Generate production-ready code that EXACTLY matches the attached design mockup.

## OBJECTIVE
${objective}

## DESIGN TOKENS (Use these EXACT values)
\`\`\`json
${JSON.stringify(designTokens, null, 2)}
\`\`\`

## REQUIREMENTS
${frameworkInstructions}

1. **Colors**: Use the EXACT hex codes from design tokens
2. **Typography**: Match font sizes and weights precisely
3. **Spacing**: Use the extracted spacing values consistently
4. **Borders**: Match border radius and styles exactly
5. **Shadows**: Replicate shadow effects as specified
6. **Layout**: Follow the layout type (${designTokens.layout?.type || 'flex'})

${responsive ? '7. **Responsive**: Include mobile breakpoints (@media max-width: 768px)' : ''}
${includeJS ? '8. **Interactivity**: Add basic JavaScript for buttons, forms, toggles' : ''}

## OUTPUT FORMAT
Generate a single, complete HTML file with:
- All CSS in a <style> block
- All JS in a <script> block (if needed)
- Realistic placeholder content matching the app purpose
- Clean, well-commented code

The rendered output should be pixel-perfect compared to the design mockup.`;
  }
}

// Singleton
let instance = null;

function getStylePromptGenerator() {
  if (!instance) {
    instance = new StylePromptGenerator();
  }
  return instance;
}

module.exports = {
  StylePromptGenerator,
  getStylePromptGenerator,
};
