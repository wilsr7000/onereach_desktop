/**
 * Copy Style Extractor
 * Extracts copywriting style guide elements from a website:
 * - Brand/Product names
 * - Taglines and slogans
 * - Core messaging and value propositions
 * - Tone of voice indicators
 * - Call-to-action patterns
 * - Key phrases and terminology
 * - Headlines and subheadlines
 */

const puppeteer = require('puppeteer');

class CopyStyleExtractor {
    constructor(options = {}) {
        this.browser = null;
        this.defaultOptions = {
            timeout: 30000,
            waitUntil: 'networkidle2',
            ...options
        };
    }

    async init() {
        if (!this.browser) {
            this.browser = await puppeteer.launch({
                headless: 'new',
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
            });
            console.log('[CopyStyle] Browser initialized');
        }
        return this;
    }

    /**
     * Extract copy style guide from a URL
     */
    async extract(url, options = {}) {
        const opts = { ...this.defaultOptions, ...options };

        if (!this.browser) {
            await this.init();
        }

        const page = await this.browser.newPage();

        try {
            console.log(`[CopyStyle] Analyzing: ${url}`);
            await page.goto(url, {
                waitUntil: opts.waitUntil,
                timeout: opts.timeout
            });

            await new Promise(resolve => setTimeout(resolve, 1000));

            const copyGuide = await page.evaluate(() => {
                const guide = {
                    url: window.location.href,
                    extractedAt: new Date().toISOString(),
                    
                    // Brand Identity
                    brand: {
                        name: null,
                        tagline: null,
                        logoAlt: null,
                        metaDescription: null
                    },
                    
                    // Headlines
                    headlines: {
                        primary: [],    // h1
                        secondary: [],  // h2
                        tertiary: []    // h3
                    },
                    
                    // Core Messaging
                    messaging: {
                        valuePropositions: [],
                        benefits: [],
                        features: []
                    },
                    
                    // CTAs
                    callsToAction: [],
                    
                    // Navigation/Menu items (product names often here)
                    navigation: [],
                    
                    // Key phrases
                    keyPhrases: {
                        action: [],      // Verbs and action-oriented phrases
                        emotional: [],   // Emotional/benefit language
                        technical: [],   // Technical/feature terms
                        social: []       // Social proof phrases
                    },
                    
                    // Tone indicators
                    toneIndicators: {
                        formal: 0,
                        casual: 0,
                        technical: 0,
                        emotional: 0,
                        urgent: 0,
                        friendly: 0
                    },
                    
                    // Writing patterns
                    patterns: {
                        sentenceStarters: [],
                        punctuation: {
                            exclamations: 0,
                            questions: 0,
                            ellipsis: 0
                        },
                        capitalization: 'mixed',
                        averageSentenceLength: 0
                    },
                    
                    // Product/Service names
                    productNames: [],
                    
                    // Testimonials/Social proof
                    socialProof: [],
                    
                    // Footer content (often has key messaging)
                    footerContent: null
                };

                // Helper functions
                const cleanText = (text) => {
                    return text?.trim().replace(/\s+/g, ' ') || '';
                };

                const addUnique = (array, item, maxLength = 50) => {
                    const cleaned = cleanText(item);
                    if (cleaned && cleaned.length > 2 && cleaned.length < 500 && !array.includes(cleaned)) {
                        if (array.length < maxLength) {
                            array.push(cleaned);
                        }
                    }
                };

                // ===== BRAND IDENTITY =====
                
                // Get brand name from various sources
                const titleTag = document.title;
                const ogSiteName = document.querySelector('meta[property="og:site_name"]')?.content;
                const logoAlt = document.querySelector('header img, .logo img, [class*="logo"] img, a[href="/"] img')?.alt;
                const schemaOrg = document.querySelector('script[type="application/ld+json"]');
                
                guide.brand.name = ogSiteName || logoAlt || titleTag?.split(/[|\-–—]/)[0]?.trim();
                guide.brand.logoAlt = logoAlt;
                guide.brand.metaDescription = document.querySelector('meta[name="description"]')?.content;
                
                // Try to get tagline
                const ogDescription = document.querySelector('meta[property="og:description"]')?.content;
                const heroSubtext = document.querySelector('.hero p, [class*="hero"] p, header p, .tagline, [class*="tagline"]')?.textContent;
                guide.brand.tagline = heroSubtext || ogDescription || guide.brand.metaDescription;

                // ===== HEADLINES =====
                
                document.querySelectorAll('h1').forEach(h => {
                    addUnique(guide.headlines.primary, h.textContent);
                });
                
                document.querySelectorAll('h2').forEach(h => {
                    addUnique(guide.headlines.secondary, h.textContent);
                });
                
                document.querySelectorAll('h3').forEach(h => {
                    addUnique(guide.headlines.tertiary, h.textContent);
                });

                // ===== CALLS TO ACTION =====
                
                const ctaSelectors = [
                    'button',
                    '[type="submit"]',
                    '.btn',
                    '.button',
                    'a.btn',
                    'a.button',
                    '[class*="cta"]',
                    '[class*="action"]',
                    'a[href*="signup"]',
                    'a[href*="register"]',
                    'a[href*="start"]',
                    'a[href*="try"]',
                    'a[href*="demo"]',
                    'a[href*="contact"]',
                    'a[href*="get-started"]'
                ];
                
                const seenCTAs = new Set();
                ctaSelectors.forEach(selector => {
                    document.querySelectorAll(selector).forEach(el => {
                        const text = cleanText(el.textContent);
                        if (text && text.length > 1 && text.length < 50 && !seenCTAs.has(text.toLowerCase())) {
                            seenCTAs.add(text.toLowerCase());
                            guide.callsToAction.push({
                                text: text,
                                type: el.tagName.toLowerCase(),
                                href: el.href || null
                            });
                        }
                    });
                });

                // ===== NAVIGATION (Product names) =====
                
                document.querySelectorAll('nav a, header a, .nav a, .menu a, [class*="nav"] a').forEach(a => {
                    const text = cleanText(a.textContent);
                    if (text && text.length > 1 && text.length < 30) {
                        addUnique(guide.navigation, text);
                    }
                });

                // ===== VALUE PROPOSITIONS & BENEFITS =====
                
                // Look for value prop sections
                const valuePropSelectors = [
                    '[class*="benefit"]',
                    '[class*="feature"]',
                    '[class*="value"]',
                    '[class*="why"]',
                    '[class*="advantage"]',
                    '.card h3',
                    '.card h4',
                    'section h2 + p',
                    'section h3 + p'
                ];
                
                valuePropSelectors.forEach(selector => {
                    document.querySelectorAll(selector).forEach(el => {
                        const text = cleanText(el.textContent);
                        if (text && text.length > 10 && text.length < 200) {
                            if (el.tagName === 'P') {
                                addUnique(guide.messaging.benefits, text);
                            } else {
                                addUnique(guide.messaging.valuePropositions, text);
                            }
                        }
                    });
                });

                // ===== PRODUCT NAMES =====
                
                // Look for capitalized proper nouns, trademarked terms
                const allText = document.body.innerText;
                const properNouns = allText.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g) || [];
                const trademarks = allText.match(/\b\w+[™®©]\b/g) || [];
                
                // Filter and dedupe
                const productCandidates = new Map();
                [...properNouns, ...trademarks].forEach(term => {
                    const cleaned = term.replace(/[™®©]/g, '').trim();
                    if (cleaned.length > 2 && cleaned.length < 30) {
                        productCandidates.set(cleaned, (productCandidates.get(cleaned) || 0) + 1);
                    }
                });
                
                // Sort by frequency and take top ones
                const sortedProducts = Array.from(productCandidates.entries())
                    .filter(([term, count]) => count >= 2)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 20)
                    .map(([term]) => term);
                
                guide.productNames = sortedProducts;

                // ===== KEY PHRASES =====
                
                // Action words
                const actionPatterns = /\b(get|start|try|discover|explore|learn|build|create|grow|boost|improve|transform|unlock|achieve|accelerate|simplify|automate|streamline|optimize|scale|launch|join|sign up|subscribe|download|install|upgrade|activate)\b/gi;
                const actionMatches = allText.match(actionPatterns) || [];
                actionMatches.forEach(m => addUnique(guide.keyPhrases.action, m.toLowerCase()));

                // Emotional/benefit words
                const emotionalPatterns = /\b(free|easy|simple|fast|secure|powerful|beautiful|amazing|incredible|revolutionary|innovative|trusted|reliable|seamless|effortless|intuitive|smart|intelligent|premium|exclusive|unlimited|guaranteed)\b/gi;
                const emotionalMatches = allText.match(emotionalPatterns) || [];
                emotionalMatches.forEach(m => addUnique(guide.keyPhrases.emotional, m.toLowerCase()));

                // Social proof phrases
                const socialProofPatterns = /\b(trusted by|used by|loved by|preferred by|recommended by|as seen in|featured in|award-winning|#1|leading|top-rated|best-in-class|industry-leading|world-class|enterprise-grade|million|billion|customers|users|companies|teams)\b/gi;
                const socialMatches = allText.match(socialProofPatterns) || [];
                socialMatches.forEach(m => addUnique(guide.keyPhrases.social, m.toLowerCase()));

                // ===== TONE ANALYSIS =====
                
                // Count indicators
                const formalIndicators = (allText.match(/\b(therefore|furthermore|consequently|regarding|pursuant|hereby|aforementioned)\b/gi) || []).length;
                const casualIndicators = (allText.match(/\b(hey|awesome|cool|super|totally|gonna|wanna|yeah|yep|nope|btw)\b/gi) || []).length;
                const technicalIndicators = (allText.match(/\b(API|SDK|integration|platform|infrastructure|architecture|scalable|deploy|configure|implement)\b/gi) || []).length;
                const emotionalIndicators = (allText.match(/\b(love|amazing|incredible|exciting|passionate|inspiring|delightful|wonderful)\b/gi) || []).length;
                const urgentIndicators = (allText.match(/\b(now|today|limited|hurry|don't miss|act fast|last chance|expires|deadline)\b/gi) || []).length;
                const friendlyIndicators = (allText.match(/\b(we|our|you|your|together|help|support|team|community|welcome)\b/gi) || []).length;

                guide.toneIndicators = {
                    formal: formalIndicators,
                    casual: casualIndicators,
                    technical: technicalIndicators,
                    emotional: emotionalIndicators,
                    urgent: urgentIndicators,
                    friendly: friendlyIndicators
                };

                // ===== WRITING PATTERNS =====
                
                // Sentence starters
                const sentences = allText.split(/[.!?]+/).filter(s => s.trim().length > 10);
                const starters = new Map();
                sentences.forEach(s => {
                    const words = s.trim().split(/\s+/).slice(0, 2).join(' ');
                    if (words) {
                        starters.set(words, (starters.get(words) || 0) + 1);
                    }
                });
                
                guide.patterns.sentenceStarters = Array.from(starters.entries())
                    .filter(([_, count]) => count >= 2)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 10)
                    .map(([starter, count]) => ({ starter, count }));

                // Punctuation analysis
                guide.patterns.punctuation = {
                    exclamations: (allText.match(/!/g) || []).length,
                    questions: (allText.match(/\?/g) || []).length,
                    ellipsis: (allText.match(/\.\.\./g) || []).length
                };

                // Average sentence length
                if (sentences.length > 0) {
                    const totalWords = sentences.reduce((sum, s) => sum + s.split(/\s+/).length, 0);
                    guide.patterns.averageSentenceLength = Math.round(totalWords / sentences.length);
                }

                // ===== SOCIAL PROOF / TESTIMONIALS =====
                
                const testimonialSelectors = [
                    '[class*="testimonial"]',
                    '[class*="review"]',
                    '[class*="quote"]',
                    'blockquote',
                    '[class*="customer"]'
                ];
                
                testimonialSelectors.forEach(selector => {
                    document.querySelectorAll(selector).forEach(el => {
                        const text = cleanText(el.textContent);
                        if (text && text.length > 20 && text.length < 500) {
                            guide.socialProof.push({
                                text: text.substring(0, 300),
                                source: el.querySelector('[class*="author"], [class*="name"], cite')?.textContent?.trim() || null
                            });
                        }
                    });
                });

                // ===== FOOTER CONTENT =====
                
                const footer = document.querySelector('footer');
                if (footer) {
                    const footerText = cleanText(footer.textContent);
                    guide.footerContent = footerText.substring(0, 500);
                }

                return guide;
            });

            console.log(`[CopyStyle] Extracted: ${copyGuide.headlines.primary.length} headlines, ${copyGuide.callsToAction.length} CTAs, ${copyGuide.productNames.length} product names`);
            return copyGuide;

        } finally {
            await page.close();
        }
    }

    /**
     * Generate a formatted copy style guide report
     */
    generateReport(guide) {
        let report = `# Copy Style Guide\n\n`;
        report += `**Source:** ${guide.url}\n`;
        report += `**Extracted:** ${guide.extractedAt}\n\n`;

        // Brand Identity
        report += `## Brand Identity\n\n`;
        report += `**Brand Name:** ${guide.brand.name || 'Not detected'}\n`;
        report += `**Tagline:** ${guide.brand.tagline || 'Not detected'}\n`;
        report += `**Meta Description:** ${guide.brand.metaDescription || 'Not set'}\n\n`;

        // Voice & Tone
        report += `## Voice & Tone\n\n`;
        const tones = Object.entries(guide.toneIndicators)
            .sort((a, b) => b[1] - a[1])
            .filter(([_, v]) => v > 0);
        
        if (tones.length > 0) {
            report += `Based on language analysis, the primary tone characteristics are:\n\n`;
            tones.forEach(([tone, score]) => {
                const bar = '█'.repeat(Math.min(score, 20));
                report += `- **${tone.charAt(0).toUpperCase() + tone.slice(1)}:** ${bar} (${score})\n`;
            });
            report += `\n`;
        }

        // Determine overall tone
        const dominantTone = tones[0]?.[0] || 'neutral';
        report += `**Dominant Tone:** ${dominantTone.charAt(0).toUpperCase() + dominantTone.slice(1)}\n\n`;

        // Writing Patterns
        report += `## Writing Patterns\n\n`;
        report += `**Average Sentence Length:** ${guide.patterns.averageSentenceLength} words\n`;
        report += `**Exclamation Points:** ${guide.patterns.punctuation.exclamations}\n`;
        report += `**Questions:** ${guide.patterns.punctuation.questions}\n\n`;

        if (guide.patterns.sentenceStarters.length > 0) {
            report += `### Common Sentence Starters\n`;
            guide.patterns.sentenceStarters.forEach(s => {
                report += `- "${s.starter}..." (${s.count}x)\n`;
            });
            report += `\n`;
        }

        // Headlines
        report += `## Headlines\n\n`;
        
        if (guide.headlines.primary.length > 0) {
            report += `### Primary Headlines (H1)\n`;
            guide.headlines.primary.forEach(h => {
                report += `- ${h}\n`;
            });
            report += `\n`;
        }

        if (guide.headlines.secondary.length > 0) {
            report += `### Secondary Headlines (H2)\n`;
            guide.headlines.secondary.slice(0, 10).forEach(h => {
                report += `- ${h}\n`;
            });
            report += `\n`;
        }

        // Product Names
        if (guide.productNames.length > 0) {
            report += `## Product & Feature Names\n\n`;
            guide.productNames.forEach(p => {
                report += `- ${p}\n`;
            });
            report += `\n`;
        }

        // Calls to Action
        if (guide.callsToAction.length > 0) {
            report += `## Calls to Action\n\n`;
            guide.callsToAction.slice(0, 15).forEach(cta => {
                report += `- **"${cta.text}"**\n`;
            });
            report += `\n`;
        }

        // Key Phrases
        report += `## Key Phrases & Vocabulary\n\n`;

        if (guide.keyPhrases.action.length > 0) {
            report += `### Action Words\n`;
            report += guide.keyPhrases.action.join(', ') + `\n\n`;
        }

        if (guide.keyPhrases.emotional.length > 0) {
            report += `### Emotional/Benefit Words\n`;
            report += guide.keyPhrases.emotional.join(', ') + `\n\n`;
        }

        if (guide.keyPhrases.social.length > 0) {
            report += `### Social Proof Language\n`;
            report += guide.keyPhrases.social.join(', ') + `\n\n`;
        }

        // Value Propositions
        if (guide.messaging.valuePropositions.length > 0) {
            report += `## Value Propositions\n\n`;
            guide.messaging.valuePropositions.slice(0, 10).forEach(vp => {
                report += `- ${vp}\n`;
            });
            report += `\n`;
        }

        // Benefits
        if (guide.messaging.benefits.length > 0) {
            report += `## Key Benefits\n\n`;
            guide.messaging.benefits.slice(0, 10).forEach(b => {
                report += `- ${b}\n`;
            });
            report += `\n`;
        }

        // Social Proof
        if (guide.socialProof.length > 0) {
            report += `## Social Proof & Testimonials\n\n`;
            guide.socialProof.slice(0, 5).forEach(sp => {
                report += `> "${sp.text}"\n`;
                if (sp.source) report += `> — ${sp.source}\n`;
                report += `\n`;
            });
        }

        // Navigation (often contains product names)
        if (guide.navigation.length > 0) {
            report += `## Navigation Items\n\n`;
            report += guide.navigation.join(' | ') + `\n\n`;
        }

        return report;
    }

    /**
     * Generate a condensed brand voice summary
     */
    generateVoiceSummary(guide) {
        const tones = Object.entries(guide.toneIndicators)
            .sort((a, b) => b[1] - a[1])
            .filter(([_, v]) => v > 0);

        let summary = `## Brand Voice Summary\n\n`;

        // Determine voice characteristics
        const characteristics = [];
        
        if (guide.toneIndicators.friendly > 5) characteristics.push('approachable');
        if (guide.toneIndicators.technical > 5) characteristics.push('expert');
        if (guide.toneIndicators.casual > 3) characteristics.push('conversational');
        if (guide.toneIndicators.formal > 3) characteristics.push('professional');
        if (guide.toneIndicators.emotional > 3) characteristics.push('enthusiastic');
        if (guide.toneIndicators.urgent > 3) characteristics.push('action-oriented');

        if (characteristics.length > 0) {
            summary += `**Voice Characteristics:** ${characteristics.join(', ')}\n\n`;
        }

        // Writing style
        const avgLength = guide.patterns.averageSentenceLength;
        let lengthDesc = 'medium';
        if (avgLength < 12) lengthDesc = 'short and punchy';
        else if (avgLength > 20) lengthDesc = 'detailed and explanatory';

        summary += `**Writing Style:** ${lengthDesc} sentences\n\n`;

        // Punctuation style
        if (guide.patterns.punctuation.exclamations > 5) {
            summary += `**Energy Level:** High (uses exclamation points frequently)\n\n`;
        }

        // Key vocabulary
        if (guide.keyPhrases.action.length > 0) {
            summary += `**Action Vocabulary:** ${guide.keyPhrases.action.slice(0, 8).join(', ')}\n\n`;
        }

        if (guide.keyPhrases.emotional.length > 0) {
            summary += `**Emotional Vocabulary:** ${guide.keyPhrases.emotional.slice(0, 8).join(', ')}\n\n`;
        }

        // CTA patterns
        if (guide.callsToAction.length > 0) {
            summary += `**CTA Patterns:**\n`;
            guide.callsToAction.slice(0, 5).forEach(cta => {
                summary += `- "${cta.text}"\n`;
            });
        }

        return summary;
    }

    async close() {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
            console.log('[CopyStyle] Browser closed');
        }
    }
}

// Singleton
let instance = null;

function getCopyStyleExtractor(options = {}) {
    if (!instance) {
        instance = new CopyStyleExtractor(options);
    }
    return instance;
}

async function extractCopyStyle(url, options = {}) {
    const extractor = getCopyStyleExtractor();
    await extractor.init();
    return extractor.extract(url, options);
}

module.exports = {
    CopyStyleExtractor,
    getCopyStyleExtractor,
    extractCopyStyle
};

