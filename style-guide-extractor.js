/**
 * Style Guide Extractor
 * Extracts key design elements from a website to create a style guide:
 * - Typography (fonts, sizes, weights)
 * - Colors (text, backgrounds, accents)
 * - Buttons (colors, borders, hover states)
 * - Links (colors, hover states)
 * - Spacing & Layout
 * - Borders & Shadows
 */

const puppeteer = require('puppeteer');

class StyleGuideExtractor {
  constructor(options = {}) {
    this.browser = null;
    this.defaultOptions = {
      timeout: 30000,
      waitUntil: 'networkidle2',
      ...options,
    };
  }

  async init() {
    if (!this.browser) {
      this.browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      });
      console.log('[StyleGuide] Browser initialized');
    }
    return this;
  }

  /**
   * Extract complete style guide from a URL
   */
  async extract(url, options = {}) {
    const opts = { ...this.defaultOptions, ...options };

    if (!this.browser) {
      await this.init();
    }

    const page = await this.browser.newPage();

    try {
      console.log(`[StyleGuide] Analyzing: ${url}`);
      await page.goto(url, {
        waitUntil: opts.waitUntil,
        timeout: opts.timeout,
      });

      // Wait for page to fully render
      await new Promise((resolve) => {
        setTimeout(resolve, 1000);
      });

      const styleGuide = await page.evaluate(() => {
        const guide = {
          url: window.location.href,
          title: document.title,
          extractedAt: new Date().toISOString(),

          // Typography
          typography: {
            fonts: [],
            headings: {},
            body: {},
            fontSizes: [],
          },

          // Colors
          colors: {
            text: [],
            backgrounds: [],
            borders: [],
            accents: [],
            all: [],
          },

          // Buttons
          buttons: [],

          // Links
          links: {
            default: null,
            hover: null,
            visited: null,
          },

          // CSS Variables
          cssVariables: {},

          // Spacing
          spacing: {
            margins: [],
            paddings: [],
          },

          // Borders & Shadows
          borders: {
            radii: [],
            styles: [],
          },
          shadows: [],
        };

        // Helper to normalize colors
        const normalizeColor = (color) => {
          if (
            !color ||
            color === 'transparent' ||
            color === 'rgba(0, 0, 0, 0)' ||
            color === 'inherit' ||
            color === 'currentcolor'
          ) {
            return null;
          }
          return color;
        };

        // Helper to add unique color
        const addColor = (colorArray, color, context = '') => {
          const normalized = normalizeColor(color);
          if (normalized && !colorArray.find((c) => c.value === normalized)) {
            colorArray.push({ value: normalized, context });
          }
        };

        // Helper to add unique value
        const addUnique = (array, value) => {
          if (value && !array.includes(value)) {
            array.push(value);
          }
        };

        const fontSet = new Set();
        const fontSizeSet = new Set();

        // ===== EXTRACT CSS VARIABLES =====
        try {
          const _rootStyles = getComputedStyle(document.documentElement);
          for (const sheet of document.styleSheets) {
            try {
              for (const rule of sheet.cssRules) {
                if (rule.selectorText === ':root' && rule.style) {
                  for (let i = 0; i < rule.style.length; i++) {
                    const prop = rule.style[i];
                    if (prop.startsWith('--')) {
                      guide.cssVariables[prop] = rule.style.getPropertyValue(prop).trim();
                    }
                  }
                }
              }
            } catch (_ignored) {
              /* cross-origin stylesheet rules inaccessible */
            }
          }
        } catch (_ignored) {
          /* style extraction may fail for cross-origin or missing styles */
        }

        // ===== ANALYZE KEY ELEMENTS =====

        // Body styles
        const bodyStyle = getComputedStyle(document.body);
        guide.typography.body = {
          fontFamily: bodyStyle.fontFamily,
          fontSize: bodyStyle.fontSize,
          fontWeight: bodyStyle.fontWeight,
          lineHeight: bodyStyle.lineHeight,
          color: bodyStyle.color,
        };
        fontSet.add(bodyStyle.fontFamily);
        fontSizeSet.add(bodyStyle.fontSize);
        addColor(guide.colors.text, bodyStyle.color, 'body');
        addColor(guide.colors.backgrounds, bodyStyle.backgroundColor, 'body');

        // Headings (h1-h6)
        ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].forEach((tag) => {
          const el = document.querySelector(tag);
          if (el) {
            const style = getComputedStyle(el);
            guide.typography.headings[tag] = {
              fontFamily: style.fontFamily,
              fontSize: style.fontSize,
              fontWeight: style.fontWeight,
              lineHeight: style.lineHeight,
              color: style.color,
              letterSpacing: style.letterSpacing,
              textTransform: style.textTransform,
            };
            fontSet.add(style.fontFamily);
            fontSizeSet.add(style.fontSize);
            addColor(guide.colors.text, style.color, tag);
          }
        });

        // Paragraphs
        const paragraphs = document.querySelectorAll('p');
        paragraphs.forEach((p) => {
          const style = getComputedStyle(p);
          fontSet.add(style.fontFamily);
          fontSizeSet.add(style.fontSize);
          addColor(guide.colors.text, style.color, 'paragraph');
        });

        // ===== BUTTONS =====
        const buttonSelectors = [
          'button',
          '[type="button"]',
          '[type="submit"]',
          '.btn',
          '.button',
          '[class*="btn-"]',
          '[class*="button-"]',
          'a.btn',
          'a.button',
        ];

        const seenButtons = new Set();
        buttonSelectors.forEach((selector) => {
          document.querySelectorAll(selector).forEach((btn) => {
            const style = getComputedStyle(btn);
            const key = `${style.backgroundColor}-${style.color}-${style.borderColor}`;

            if (!seenButtons.has(key)) {
              seenButtons.add(key);

              const buttonStyle = {
                text: btn.textContent?.trim().substring(0, 30) || 'Button',
                backgroundColor: style.backgroundColor,
                color: style.color,
                borderColor: style.borderColor,
                borderWidth: style.borderWidth,
                borderRadius: style.borderRadius,
                padding: style.padding,
                fontSize: style.fontSize,
                fontWeight: style.fontWeight,
                fontFamily: style.fontFamily,
                boxShadow: style.boxShadow !== 'none' ? style.boxShadow : null,
              };

              guide.buttons.push(buttonStyle);
              addColor(guide.colors.accents, style.backgroundColor, 'button-bg');
              addColor(guide.colors.text, style.color, 'button-text');
              addColor(guide.colors.borders, style.borderColor, 'button-border');
              addUnique(guide.borders.radii, style.borderRadius);
            }
          });
        });

        // ===== LINKS =====
        const links = document.querySelectorAll('a');
        links.forEach((link) => {
          const style = getComputedStyle(link);
          if (!guide.links.default) {
            guide.links.default = {
              color: style.color,
              textDecoration: style.textDecoration,
              fontWeight: style.fontWeight,
            };
          }
          addColor(guide.colors.accents, style.color, 'link');
        });

        // ===== BACKGROUNDS =====
        const bgElements = document.querySelectorAll(
          'header, footer, nav, main, section, article, aside, div[class*="hero"], div[class*="banner"], div[class*="card"], div[class*="container"]'
        );
        bgElements.forEach((el) => {
          const style = getComputedStyle(el);
          addColor(guide.colors.backgrounds, style.backgroundColor, el.tagName.toLowerCase());

          // Check for gradient backgrounds
          if (style.backgroundImage && style.backgroundImage !== 'none' && style.backgroundImage.includes('gradient')) {
            addColor(guide.colors.backgrounds, style.backgroundImage, 'gradient');
          }
        });

        // ===== CARDS & CONTAINERS =====
        const cards = document.querySelectorAll(
          '[class*="card"], [class*="panel"], [class*="box"], [class*="container"]'
        );
        cards.forEach((card) => {
          const style = getComputedStyle(card);
          addColor(guide.colors.backgrounds, style.backgroundColor, 'card');
          addColor(guide.colors.borders, style.borderColor, 'card');
          addUnique(guide.borders.radii, style.borderRadius);
          if (style.boxShadow !== 'none') {
            addUnique(guide.shadows, style.boxShadow);
          }
        });

        // ===== INPUTS =====
        const inputs = document.querySelectorAll('input, textarea, select');
        inputs.forEach((input) => {
          const style = getComputedStyle(input);
          addColor(guide.colors.backgrounds, style.backgroundColor, 'input');
          addColor(guide.colors.borders, style.borderColor, 'input');
          addColor(guide.colors.text, style.color, 'input');
          addUnique(guide.borders.radii, style.borderRadius);
        });

        // ===== NAVIGATION =====
        const navItems = document.querySelectorAll('nav a, nav button, .nav-item, .menu-item');
        navItems.forEach((item) => {
          const style = getComputedStyle(item);
          addColor(guide.colors.text, style.color, 'nav');
          addColor(guide.colors.backgrounds, style.backgroundColor, 'nav');
        });

        // ===== SPACING (sample from common elements) =====
        const spacingElements = document.querySelectorAll('section, article, .container, main > *');
        const marginSet = new Set();
        const paddingSet = new Set();

        spacingElements.forEach((el) => {
          const style = getComputedStyle(el);
          if (style.marginTop !== '0px') marginSet.add(style.marginTop);
          if (style.marginBottom !== '0px') marginSet.add(style.marginBottom);
          if (style.paddingTop !== '0px') paddingSet.add(style.paddingTop);
          if (style.paddingBottom !== '0px') paddingSet.add(style.paddingBottom);
        });

        guide.spacing.margins = Array.from(marginSet).sort((a, b) => parseInt(a) - parseInt(b));
        guide.spacing.paddings = Array.from(paddingSet).sort((a, b) => parseInt(a) - parseInt(b));

        // ===== COMPILE FONTS =====
        guide.typography.fonts = Array.from(fontSet).map((f) => {
          // Clean up font family string
          const families = f.split(',').map((fam) => fam.trim().replace(/['"]/g, ''));
          return {
            full: f,
            primary: families[0],
            fallbacks: families.slice(1),
          };
        });

        guide.typography.fontSizes = Array.from(fontSizeSet)
          .map((s) => ({ value: s, px: parseInt(s) }))
          .filter((s) => !isNaN(s.px))
          .sort((a, b) => a.px - b.px);

        // ===== COMPILE ALL COLORS =====
        const allColors = new Map();
        [...guide.colors.text, ...guide.colors.backgrounds, ...guide.colors.borders, ...guide.colors.accents].forEach(
          (c) => {
            if (c && c.value) {
              if (!allColors.has(c.value)) {
                allColors.set(c.value, { value: c.value, contexts: [] });
              }
              allColors.get(c.value).contexts.push(c.context);
            }
          }
        );
        guide.colors.all = Array.from(allColors.values());

        // Sort colors by frequency of use
        guide.colors.all.sort((a, b) => b.contexts.length - a.contexts.length);

        return guide;
      });

      console.log(
        `[StyleGuide] Extracted: ${styleGuide.colors.all.length} colors, ${styleGuide.typography.fonts.length} fonts, ${styleGuide.buttons.length} button styles`
      );
      return styleGuide;
    } finally {
      await page.close();
    }
  }

  /**
   * Generate a formatted style guide report
   */
  generateReport(styleGuide) {
    let report = `# Style Guide: ${styleGuide.title}\n`;
    report += `URL: ${styleGuide.url}\n`;
    report += `Extracted: ${styleGuide.extractedAt}\n\n`;

    // Typography
    report += `## Typography\n\n`;
    report += `### Fonts\n`;
    styleGuide.typography.fonts.forEach((f) => {
      report += `- **${f.primary}** (fallbacks: ${f.fallbacks.join(', ') || 'none'})\n`;
    });

    report += `\n### Body Text\n`;
    const body = styleGuide.typography.body;
    report += `- Font: ${body.fontFamily}\n`;
    report += `- Size: ${body.fontSize}\n`;
    report += `- Weight: ${body.fontWeight}\n`;
    report += `- Line Height: ${body.lineHeight}\n`;
    report += `- Color: ${body.color}\n`;

    report += `\n### Headings\n`;
    Object.entries(styleGuide.typography.headings).forEach(([tag, styles]) => {
      report += `\n**${tag.toUpperCase()}**\n`;
      report += `- Size: ${styles.fontSize}\n`;
      report += `- Weight: ${styles.fontWeight}\n`;
      report += `- Color: ${styles.color}\n`;
    });

    report += `\n### Font Sizes Scale\n`;
    styleGuide.typography.fontSizes.forEach((s) => {
      report += `- ${s.value}\n`;
    });

    // Colors
    report += `\n## Colors\n\n`;

    report += `### Text Colors\n`;
    styleGuide.colors.text.forEach((c) => {
      report += `- \`${c.value}\` (${c.context})\n`;
    });

    report += `\n### Background Colors\n`;
    styleGuide.colors.backgrounds.forEach((c) => {
      report += `- \`${c.value}\` (${c.context})\n`;
    });

    report += `\n### Accent Colors\n`;
    styleGuide.colors.accents.forEach((c) => {
      report += `- \`${c.value}\` (${c.context})\n`;
    });

    report += `\n### Border Colors\n`;
    styleGuide.colors.borders.forEach((c) => {
      report += `- \`${c.value}\` (${c.context})\n`;
    });

    // Buttons
    report += `\n## Buttons\n\n`;
    styleGuide.buttons.forEach((btn, i) => {
      report += `### Button ${i + 1}: "${btn.text}"\n`;
      report += `- Background: \`${btn.backgroundColor}\`\n`;
      report += `- Text Color: \`${btn.color}\`\n`;
      report += `- Border: \`${btn.borderWidth} ${btn.borderColor}\`\n`;
      report += `- Border Radius: ${btn.borderRadius}\n`;
      report += `- Padding: ${btn.padding}\n`;
      report += `- Font: ${btn.fontSize} ${btn.fontWeight}\n`;
      if (btn.boxShadow) report += `- Shadow: ${btn.boxShadow}\n`;
      report += `\n`;
    });

    // Links
    report += `## Links\n\n`;
    if (styleGuide.links.default) {
      report += `- Color: \`${styleGuide.links.default.color}\`\n`;
      report += `- Text Decoration: ${styleGuide.links.default.textDecoration}\n`;
    }

    // CSS Variables
    if (Object.keys(styleGuide.cssVariables).length > 0) {
      report += `\n## CSS Variables\n\n`;
      report += `\`\`\`css\n:root {\n`;
      Object.entries(styleGuide.cssVariables).forEach(([name, value]) => {
        report += `  ${name}: ${value};\n`;
      });
      report += `}\n\`\`\`\n`;
    }

    // Borders & Shadows
    report += `\n## Borders & Shadows\n\n`;
    report += `### Border Radii\n`;
    styleGuide.borders.radii.forEach((r) => {
      report += `- ${r}\n`;
    });

    if (styleGuide.shadows.length > 0) {
      report += `\n### Box Shadows\n`;
      styleGuide.shadows.forEach((s) => {
        report += `- \`${s}\`\n`;
      });
    }

    // Spacing
    report += `\n## Spacing\n\n`;
    report += `### Margins\n`;
    styleGuide.spacing.margins.forEach((m) => {
      report += `- ${m}\n`;
    });
    report += `\n### Paddings\n`;
    styleGuide.spacing.paddings.forEach((p) => {
      report += `- ${p}\n`;
    });

    return report;
  }

  /**
   * Generate CSS variables from extracted styles
   */
  generateCSSVariables(styleGuide) {
    let css = `:root {\n`;
    css += `  /* Typography */\n`;

    if (styleGuide.typography.fonts[0]) {
      css += `  --font-primary: ${styleGuide.typography.fonts[0].full};\n`;
    }
    if (styleGuide.typography.fonts[1]) {
      css += `  --font-secondary: ${styleGuide.typography.fonts[1].full};\n`;
    }

    css += `  --font-size-base: ${styleGuide.typography.body.fontSize};\n`;
    css += `  --line-height-base: ${styleGuide.typography.body.lineHeight};\n`;

    styleGuide.typography.fontSizes.forEach((s, i) => {
      css += `  --font-size-${i + 1}: ${s.value};\n`;
    });

    css += `\n  /* Colors */\n`;
    css += `  --color-text: ${styleGuide.typography.body.color};\n`;

    styleGuide.colors.backgrounds.slice(0, 5).forEach((c, i) => {
      css += `  --color-bg-${i + 1}: ${c.value};\n`;
    });

    styleGuide.colors.accents.slice(0, 5).forEach((c, i) => {
      css += `  --color-accent-${i + 1}: ${c.value};\n`;
    });

    if (styleGuide.buttons[0]) {
      css += `\n  /* Buttons */\n`;
      css += `  --btn-bg: ${styleGuide.buttons[0].backgroundColor};\n`;
      css += `  --btn-color: ${styleGuide.buttons[0].color};\n`;
      css += `  --btn-border-radius: ${styleGuide.buttons[0].borderRadius};\n`;
      css += `  --btn-padding: ${styleGuide.buttons[0].padding};\n`;
    }

    if (styleGuide.links.default) {
      css += `\n  /* Links */\n`;
      css += `  --link-color: ${styleGuide.links.default.color};\n`;
    }

    css += `\n  /* Spacing */\n`;
    styleGuide.spacing.margins.slice(0, 6).forEach((m, i) => {
      css += `  --spacing-${i + 1}: ${m};\n`;
    });

    css += `\n  /* Borders */\n`;
    styleGuide.borders.radii.slice(0, 4).forEach((r, i) => {
      css += `  --border-radius-${i + 1}: ${r};\n`;
    });

    if (styleGuide.shadows[0]) {
      css += `\n  /* Shadows */\n`;
      styleGuide.shadows.slice(0, 3).forEach((s, i) => {
        css += `  --shadow-${i + 1}: ${s};\n`;
      });
    }

    css += `}\n`;
    return css;
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      console.log('[StyleGuide] Browser closed');
    }
  }
}

// Singleton
let instance = null;

function getStyleGuideExtractor(options = {}) {
  if (!instance) {
    instance = new StyleGuideExtractor(options);
  }
  return instance;
}

async function extractStyleGuide(url, options = {}) {
  const extractor = getStyleGuideExtractor();
  await extractor.init();
  return extractor.extract(url, options);
}

module.exports = {
  StyleGuideExtractor,
  getStyleGuideExtractor,
  extractStyleGuide,
};
