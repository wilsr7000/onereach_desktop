const { BrowserWindow } = require('electron');
const ai = require('./lib/ai-service');

class WebStyleAnalyzer {
  constructor() {
    this.window = null;
  }

  async analyzeStyles(urls, options = {}) {
    console.log('[WebStyleAnalyzer] Starting analysis for URLs:', urls);

    const results = {
      colors: new Map(),
      fonts: new Map(),
      spacing: new Map(),
      components: {},
    };

    try {
      // Create a hidden window for analyzing
      this.window = new BrowserWindow({
        width: 1280,
        height: 800,
        show: false,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          webSecurity: false, // Allow cross-origin requests
        },
      });

      for (const url of urls) {
        try {
          await this.analyzeURL(url, results, options);
        } catch (error) {
          console.error(`Error analyzing ${url}:`, error);
        }
      }

      // Process the results
      const processedStyles = this.processResults(results);

      // Always enhance with LLM by default, unless explicitly disabled
      if (options.useLLMEnhancement !== false) {
        console.log('[WebStyleAnalyzer] Running LLM enhancement...');
        const enhancedStyles = await this.enhanceWithLLM(processedStyles, urls);
        return {
          success: true,
          styles: enhancedStyles,
          llmEnhanced: true,
        };
      }

      return {
        success: true,
        styles: processedStyles,
        llmEnhanced: false,
      };
    } catch (error) {
      console.error('[WebStyleAnalyzer] Error:', error);
      return {
        success: false,
        error: error.message,
      };
    } finally {
      if (this.window) {
        this.window.close();
      }
    }
  }

  async enhanceWithLLM(styles, urls) {
    try {
      const prompt = `You are a professional UI/UX designer and design system expert. I've extracted styles from ${urls.join(', ')} but the extraction may be incomplete or ugly. Please review and enhance this style guide to make it complete and professional.

Current extracted styles:
${JSON.stringify(styles, null, 2)}

Please enhance this style guide by:
1. Review all colors and ensure they form a cohesive palette
2. If primary/secondary colors seem wrong or ugly, suggest better ones that match the website's brand
3. Add any missing essential colors (success, warning, error, info) if not present
4. Ensure proper color contrast between text and background
5. Complete the font system with appropriate sizes and weights
6. Add missing spacing values to create a consistent spacing scale
7. Enhance component styles with modern design patterns
8. Add shadow system for depth
9. Add border radius system for consistency
10. Add any other design tokens that would make this a complete design system

IMPORTANT: Your response must be a valid JSON object with this exact structure:
{
  "colors": [
    {"hex": "#hexcode", "category": "primary|secondary|text|background|accent|success|warning|error|info", "name": "Optional friendly name", "usage": "What this color is used for"},
    ...
  ],
  "fonts": [
    {
      "family": "Font Name",
      "fallback": "Appropriate fallback fonts", 
      "sizes": {
        "xs": "12px",
        "sm": "14px", 
        "base": "16px",
        "lg": "18px",
        "xl": "20px",
        "2xl": "24px",
        "3xl": "30px",
        "4xl": "36px"
      },
      "weights": {
        "light": "300",
        "normal": "400",
        "medium": "500", 
        "semibold": "600",
        "bold": "700"
      },
      "lineHeights": {
        "tight": "1.25",
        "normal": "1.5",
        "relaxed": "1.75"
      }
    }
  ],
  "spacing": {
    "xs": "4px",
    "sm": "8px",
    "md": "16px", 
    "lg": "24px",
    "xl": "32px",
    "2xl": "48px",
    "3xl": "64px"
  },
  "borderRadius": {
    "none": "0",
    "sm": "2px",
    "base": "4px",
    "md": "6px",
    "lg": "8px", 
    "xl": "12px",
    "2xl": "16px",
    "full": "9999px"
  },
  "shadows": {
    "sm": "0 1px 2px 0 rgba(0, 0, 0, 0.05)",
    "base": "0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.06)",
    "md": "0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)",
    "lg": "0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)",
    "xl": "0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)"
  },
  "components": {
    "button": {
      "padding": "12px 24px",
      "borderRadius": "6px",
      "fontSize": "16px",
      "fontWeight": "500",
      "transition": "all 0.2s ease",
      "variants": {
        "primary": {
          "backgroundColor": "primary color",
          "color": "white or contrasting color",
          "hover": "darker shade"
        },
        "secondary": {
          "backgroundColor": "secondary color",
          "color": "contrasting color",
          "hover": "darker shade"
        }
      }
    },
    "card": {
      "padding": "24px",
      "borderRadius": "8px",
      "backgroundColor": "white or surface color",
      "boxShadow": "base shadow",
      "border": "1px solid border color"
    },
    "input": {
      "padding": "12px 16px",
      "borderRadius": "6px",
      "fontSize": "16px",
      "border": "1px solid border color",
      "focus": "primary color border"
    }
  },
  "enhancements": {
    "description": "Brief description of what was improved",
    "suggestions": ["Any additional suggestions for the design system"]
  }
}`;

      const enhancedStyles = await ai.json(prompt, {
        profile: 'standard',
        maxTokens: 4000,
        feature: 'web-style-analyzer',
      });

      try {
        // Ensure the enhanced styles have the required structure
        if (!enhancedStyles.colors || !Array.isArray(enhancedStyles.colors)) {
          console.error('[WebStyleAnalyzer] Invalid enhanced styles structure');
          return styles;
        }

        // Add metadata about enhancement
        enhancedStyles.metadata = {
          enhanced: true,
          enhancedAt: new Date().toISOString(),
          originalUrls: urls,
          enhancementModel: 'claude-3',
        };

        console.log('[WebStyleAnalyzer] Successfully enhanced styles with LLM');
        return enhancedStyles;
      } catch (error) {
        console.error('[WebStyleAnalyzer] Failed to enhance styles:', error);
        return styles; // Return original if enhancement fails
      }
    } catch (error) {
      console.error('[WebStyleAnalyzer] LLM enhancement error:', error);
      // Return original styles if enhancement fails
      return styles;
    }
  }

  async analyzeURL(url, results, options) {
    console.log(`[WebStyleAnalyzer] Analyzing ${url}`);

    await this.window.loadURL(url);

    // Wait for page to load
    await new Promise((resolve) => {
      setTimeout(resolve, 3000);
    });

    // Extract styles using JavaScript injection
    const extractedStyles = await this.window.webContents.executeJavaScript(`
      (() => {
        const styles = {
          colors: new Set(),
          fonts: new Set(),
          spacing: new Set(),
          components: {},
          // Track specific color uses
          backgroundColors: new Map(),
          textColors: new Map(),
          accentColors: new Map()
        };

        // Helper function to extract colors
        function extractColor(value) {
          if (!value) return null;
          
          // Handle rgb/rgba
          const rgbMatch = value.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?\\)/);
          if (rgbMatch) {
            const r = parseInt(rgbMatch[1]);
            const g = parseInt(rgbMatch[2]);
            const b = parseInt(rgbMatch[3]);
            const a = rgbMatch[4] ? parseFloat(rgbMatch[4]) : 1;
            
            // Skip transparent or very transparent colors
            if (a < 0.1) return null;
            
            return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
          }
          
          // Handle hex colors
          const hexMatch = value.match(/#([0-9a-fA-F]{3,8})/);
          if (hexMatch) {
            const hex = hexMatch[1];
            if (hex.length === 3) {
              return '#' + hex.split('').map(c => c + c).join('');
            }
            return '#' + hex.slice(0, 6); // Remove alpha channel if present
          }
          
          return null;
        }

        // Analyze all elements
        const elements = document.querySelectorAll('*');
        const seenFonts = new Map();
        const seenSizes = new Set();
        const seenWeights = new Set();
        
        // Analyze main body and document styles first - these are important!
        const bodyStyles = window.getComputedStyle(document.body);
        const htmlStyles = window.getComputedStyle(document.documentElement);
        
        // Get the actual page background (check html, then body)
        let pageBackground = extractColor(htmlStyles.backgroundColor);
        if (!pageBackground || pageBackground === 'rgba(0, 0, 0, 0)') {
          pageBackground = extractColor(bodyStyles.backgroundColor);
        }
        if (pageBackground) {
          styles.backgroundColors.set(pageBackground, 1000); // High weight for page background
        }
        
        // Get main text color
        const bodyColor = extractColor(bodyStyles.color);
        if (bodyColor) {
          styles.textColors.set(bodyColor, 100); // High weight for body text
        }
        
        // Get body font
        const bodyFont = bodyStyles.fontFamily;
        if (bodyFont) seenFonts.set(bodyFont, (seenFonts.get(bodyFont) || 0) + 10);
        
        elements.forEach(el => {
          const computed = window.getComputedStyle(el);
          
          // Skip invisible elements
          if (computed.display === 'none' || computed.visibility === 'hidden' || computed.opacity === '0') {
            return;
          }
          
          // Extract colors
          if (${options.extractColors !== false ? 'true' : 'false'}) {
            const bgColor = extractColor(computed.backgroundColor);
            const textColor = extractColor(computed.color);
            const borderColor = extractColor(computed.borderColor);
            
            // Track background colors (including white)
            if (bgColor && bgColor !== 'rgba(0, 0, 0, 0)') {
              styles.backgroundColors.set(bgColor, (styles.backgroundColors.get(bgColor) || 0) + 1);
            }
            
            // Track text colors (including black)
            if (textColor) {
              styles.textColors.set(textColor, (styles.textColors.get(textColor) || 0) + 1);
            }
            
            // Track accent colors (links, buttons, etc.)
            if (el.tagName === 'A' || el.tagName === 'BUTTON' || el.classList.contains('btn')) {
              if (textColor && textColor !== bodyColor) {
                styles.accentColors.set(textColor, (styles.accentColors.get(textColor) || 0) + 5);
              }
              if (bgColor && bgColor !== pageBackground && bgColor !== 'rgba(0, 0, 0, 0)') {
                styles.accentColors.set(bgColor, (styles.accentColors.get(bgColor) || 0) + 5);
              }
            }
            
            // Track border colors
            if (borderColor && computed.borderWidth !== '0px') {
              styles.accentColors.set(borderColor, (styles.accentColors.get(borderColor) || 0) + 1);
            }
          }
          
          // Extract fonts - prioritize headings and important text
          if (${options.extractFonts !== false ? 'true' : 'false'}) {
            const fontFamily = computed.fontFamily;
            const fontSize = computed.fontSize;
            const fontWeight = computed.fontWeight;
            
            if (fontFamily) {
              const tagName = el.tagName.toLowerCase();
              const weight = tagName.match(/^h[1-6]$/) ? 5 : 1; // Weight headings higher
              seenFonts.set(fontFamily, (seenFonts.get(fontFamily) || 0) + weight);
            }
            if (fontSize) seenSizes.add(fontSize);
            if (fontWeight) seenWeights.add(fontWeight);
          }
          
          // Extract spacing
          if (${options.extractSpacing !== false ? 'true' : 'false'}) {
            const padding = computed.padding;
            const margin = computed.margin;
            const paddingTop = computed.paddingTop;
            const paddingBottom = computed.paddingBottom;
            const marginTop = computed.marginTop;
            const marginBottom = computed.marginBottom;
            
            [paddingTop, paddingBottom, marginTop, marginBottom].forEach(space => {
              if (space && space !== '0px' && !space.includes('-')) {
                styles.spacing.add(space);
              }
            });
          }
        });
        
        // Analyze specific components
        if (${options.extractComponents !== false ? 'true' : 'false'}) {
          // Buttons
          const buttons = document.querySelectorAll('button, .btn, [role="button"], a.button, input[type="button"], input[type="submit"]');
          if (buttons.length > 0) {
            const button = Array.from(buttons).find(btn => {
              const style = window.getComputedStyle(btn);
              return style.display !== 'none' && style.visibility !== 'hidden';
            });
            
            if (button) {
              const btnStyle = window.getComputedStyle(button);
              styles.components.button = {
                padding: btnStyle.padding,
                borderRadius: btnStyle.borderRadius,
                fontSize: btnStyle.fontSize,
                fontWeight: btnStyle.fontWeight,
                backgroundColor: extractColor(btnStyle.backgroundColor),
                color: extractColor(btnStyle.color),
                border: btnStyle.border,
                textTransform: btnStyle.textTransform,
                letterSpacing: btnStyle.letterSpacing
              };
            }
          }
          
          // Cards
          const cards = document.querySelectorAll('.card, [class*="card"], article, .panel, .box');
          if (cards.length > 0) {
            const card = Array.from(cards).find(c => {
              const style = window.getComputedStyle(c);
              return style.display !== 'none' && style.visibility !== 'hidden';
            });
            
            if (card) {
              const cardStyle = window.getComputedStyle(card);
              styles.components.card = {
                padding: cardStyle.padding,
                borderRadius: cardStyle.borderRadius,
                boxShadow: cardStyle.boxShadow,
                backgroundColor: extractColor(cardStyle.backgroundColor),
                border: cardStyle.border
              };
            }
          }
          
          // Headers
          const headers = document.querySelectorAll('h1, h2, h3');
          if (headers.length > 0) {
            const header = headers[0];
            const headerStyle = window.getComputedStyle(header);
            styles.components.heading = {
              fontFamily: headerStyle.fontFamily,
              fontSize: headerStyle.fontSize,
              fontWeight: headerStyle.fontWeight,
              lineHeight: headerStyle.lineHeight,
              color: extractColor(headerStyle.color),
              marginBottom: headerStyle.marginBottom
            };
          }
        }
        
        // Convert Maps to sorted arrays
        const sortedBackgrounds = Array.from(styles.backgroundColors.entries())
          .sort((a, b) => b[1] - a[1])
          .map(([color]) => color);
          
        const sortedTextColors = Array.from(styles.textColors.entries())
          .sort((a, b) => b[1] - a[1])
          .map(([color]) => color);
          
        const sortedAccentColors = Array.from(styles.accentColors.entries())
          .sort((a, b) => b[1] - a[1])
          .map(([color]) => color);
        
        return {
          colors: {
            backgrounds: sortedBackgrounds,
            textColors: sortedTextColors,
            accentColors: sortedAccentColors
          },
          fonts: {
            families: Array.from(seenFonts.entries())
              .sort((a, b) => b[1] - a[1])
              .map(([font]) => font)
              .slice(0, 5),
            sizes: Array.from(seenSizes).slice(0, 10),
            weights: Array.from(seenWeights).slice(0, 5)
          },
          spacing: Array.from(styles.spacing).slice(0, 10),
          components: styles.components
        };
      })();
    `);

    // Merge results with better color categorization
    if (extractedStyles.colors) {
      // Store categorized colors
      if (!results.categorizedColors) {
        results.categorizedColors = {
          backgrounds: new Map(),
          textColors: new Map(),
          accentColors: new Map(),
        };
      }

      extractedStyles.colors.backgrounds.forEach((color) => {
        results.categorizedColors.backgrounds.set(color, (results.categorizedColors.backgrounds.get(color) || 0) + 1);
      });

      extractedStyles.colors.textColors.forEach((color) => {
        results.categorizedColors.textColors.set(color, (results.categorizedColors.textColors.get(color) || 0) + 1);
      });

      extractedStyles.colors.accentColors.forEach((color) => {
        results.categorizedColors.accentColors.set(color, (results.categorizedColors.accentColors.get(color) || 0) + 1);
      });
    }

    if (extractedStyles.fonts) {
      extractedStyles.fonts.families.forEach((font) => results.fonts.set(font, (results.fonts.get(font) || 0) + 1));
    }

    if (extractedStyles.spacing) {
      extractedStyles.spacing.forEach((space) => results.spacing.set(space, (results.spacing.get(space) || 0) + 1));
    }

    // Merge components (prefer non-null values)
    Object.entries(extractedStyles.components).forEach(([key, value]) => {
      if (!results.components[key] || Object.keys(value).length > Object.keys(results.components[key]).length) {
        results.components[key] = value;
      }
    });
  }

  processResults(results) {
    // Process categorized colors intelligently
    let topColors = [];

    if (results.categorizedColors) {
      // Get the most common background color (usually white or a light color)
      const topBackground = Array.from(results.categorizedColors.backgrounds.entries()).sort((a, b) => b[1] - a[1])[0];

      // Get the most common text color (usually black or dark gray)
      const topTextColor = Array.from(results.categorizedColors.textColors.entries()).sort((a, b) => b[1] - a[1])[0];

      // Get top accent colors (exclude background and text colors)
      const topAccents = Array.from(results.categorizedColors.accentColors.entries())
        .filter(
          ([color]) => (!topBackground || color !== topBackground[0]) && (!topTextColor || color !== topTextColor[0])
        )
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3);

      // Build color array with proper categorization
      topColors = [
        { hex: topAccents[0] ? topAccents[0][0] : '#3B82F6', category: 'primary' },
        { hex: topAccents[1] ? topAccents[1][0] : '#10B981', category: 'secondary' },
        { hex: topTextColor ? topTextColor[0] : '#2C2C2C', category: 'text' },
        { hex: topBackground ? topBackground[0] : '#FFFFFF', category: 'background' },
        { hex: topAccents[2] ? topAccents[2][0] : '#F59E0B', category: 'accent' },
      ];
    } else if (results.colors) {
      // Fallback to old logic if categorized colors not available
      topColors = Array.from(results.colors.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([color]) => ({ hex: color }));
    } else {
      // Ultimate fallback - default colors
      topColors = [
        { hex: '#3B82F6', category: 'primary' },
        { hex: '#10B981', category: 'secondary' },
        { hex: '#2C2C2C', category: 'text' },
        { hex: '#FFFFFF', category: 'background' },
        { hex: '#F59E0B', category: 'accent' },
      ];
    }

    // Process fonts - clean up font families
    const topFonts = Array.from(results.fonts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([family]) => {
        // Clean up font family string
        const cleanFamily = family
          .replace(/['"]/g, '') // Remove quotes
          .split(',')[0] // Take first font
          .trim();

        return {
          family: cleanFamily,
          sizes: ['14px', '16px', '18px', '24px', '32px'], // Default sizes
          weights: ['400', '500', '600', '700'], // Default weights
        };
      });

    // Process spacing - sort numerically
    const spacingValues = Array.from(results.spacing.keys())
      .filter((v) => v && v !== '0px')
      .sort((a, b) => {
        const aNum = parseFloat(a);
        const bNum = parseFloat(b);
        return aNum - bNum;
      })
      .slice(0, 6);

    const spacing = {};
    const sizes = ['xs', 'sm', 'md', 'lg', 'xl', 'xxl'];
    spacingValues.forEach((value, index) => {
      if (sizes[index]) {
        spacing[sizes[index]] = value;
      }
    });

    return {
      colors: topColors,
      fonts: topFonts,
      spacing: spacing,
      components: results.components,
    };
  }
}

module.exports = WebStyleAnalyzer;
