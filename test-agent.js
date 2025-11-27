/**
 * Test Agent - Automated UI Testing with Playwright
 * 
 * A separate testing agent that:
 * 1. Reads the main context (files, recent changes)
 * 2. Generates a test plan based on the UI
 * 3. Executes tests using Playwright (cross-browser)
 * 4. Reports results back to the main chat
 */

const { chromium, firefox, webkit } = require('playwright');
const path = require('path');
const fs = require('fs');

class TestAgent {
    constructor() {
        this.browser = null;
        this.context = null;
        this.page = null;
        this.testResults = [];
        this.testPlan = null;
        this.isRunning = false;
        this.currentBrowserType = 'chromium'; // chromium, firefox, webkit
        this.currentContext = {
            files: [],
            recentChanges: [],
            lastAnalysis: null
        };
        this.traceEnabled = false;
    }

    /**
     * Get browser launcher based on type
     */
    getBrowserType(type = 'chromium') {
        switch (type) {
            case 'firefox': return firefox;
            case 'webkit': return webkit;
            default: return chromium;
        }
    }

    /**
     * Initialize the browser
     */
    async init(browserType = 'chromium') {
        if (this.browser && this.currentBrowserType === browserType) {
            return true;
        }

        // Close existing browser if switching types
        if (this.browser) {
            await this.close();
        }

        this.currentBrowserType = browserType;
        const launcher = this.getBrowserType(browserType);
        
        this.browser = await launcher.launch({
            headless: true
        });
        
        this.context = await this.browser.newContext({
            viewport: { width: 1280, height: 800 },
            deviceScaleFactor: 1
        });

        return true;
    }

    /**
     * Close the browser
     */
    async close() {
        if (this.context) {
            await this.context.close();
            this.context = null;
        }
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
        }
        this.page = null;
    }

    /**
     * Update context from main agent
     */
    updateContext(context) {
        this.currentContext = {
            ...this.currentContext,
            ...context
        };
    }

    /**
     * Generate a test plan based on the HTML file
     */
    async generateTestPlan(htmlFilePath, aiAnalyzer) {
        const htmlContent = fs.readFileSync(htmlFilePath, 'utf-8');
        
        // Extract testable elements
        const testableElements = this.extractTestableElements(htmlContent);
        
        // If we have an AI analyzer, use it to generate smarter tests
        if (aiAnalyzer) {
            const prompt = `Analyze this HTML and generate a comprehensive test plan. Return JSON with this structure:
{
  "testPlan": {
    "name": "Test plan name",
    "tests": [
      {
        "id": "test-1",
        "name": "Test name",
        "description": "What this tests",
        "type": "click|input|navigation|visual|interaction",
        "selector": "CSS selector or text content",
        "selectorType": "css|text|role|testId",
        "action": "click|fill|hover|scroll|screenshot|check|select",
        "value": "value for fill/select actions",
        "expected": "expected result description",
        "expectedSelector": "optional selector to verify after action"
      }
    ]
  }
}

Focus on:
1. User interactions (buttons, forms, links)
2. Navigation flows
3. Form validation
4. Modal/dialog behavior
5. Responsive elements

HTML Content (first 5000 chars):
${htmlContent.substring(0, 5000)}

Testable elements found:
${JSON.stringify(testableElements, null, 2)}`;

            try {
                const response = await aiAnalyzer(prompt);
                const jsonMatch = response.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    this.testPlan = JSON.parse(jsonMatch[0]).testPlan;
                    return this.testPlan;
                }
            } catch (e) {
                console.error('[TestAgent] AI test plan generation failed:', e);
            }
        }

        // Fallback: Generate basic test plan from elements
        this.testPlan = {
            name: `Test Plan for ${path.basename(htmlFilePath)}`,
            tests: testableElements.slice(0, 20).map((el, i) => ({
                id: `test-${i + 1}`,
                name: `Test ${el.type}: ${el.text || el.selector}`.substring(0, 50),
                description: `Verify ${el.type} element is functional`,
                type: el.type === 'button' || el.type === 'a' ? 'click' : 'visual',
                selector: el.selector,
                selectorType: el.text ? 'text' : 'css',
                action: el.type === 'input' ? 'fill' : el.type === 'button' ? 'click' : 'screenshot',
                value: el.type === 'input' ? 'test value' : null,
                expected: `Element should respond to ${el.type === 'button' ? 'click' : 'interaction'}`
            }))
        };

        return this.testPlan;
    }

    /**
     * Extract testable elements from HTML
     */
    extractTestableElements(html) {
        const elements = [];
        
        // Find buttons
        const buttonRegex = /<button[^>]*(?:id=["']([^"']+)["'])?[^>]*(?:class=["']([^"']+)["'])?[^>]*>([^<]*)</gi;
        let match;
        while ((match = buttonRegex.exec(html)) !== null) {
            const text = match[3].trim();
            elements.push({
                type: 'button',
                selector: match[1] ? `#${match[1]}` : text ? `button:has-text("${text}")` : `button`,
                selectorType: text ? 'text' : 'css',
                text: text,
                id: match[1],
                class: match[2]
            });
        }

        // Find inputs
        const inputRegex = /<input[^>]*(?:id=["']([^"']+)["'])?[^>]*(?:type=["']([^"']+)["'])?[^>]*(?:name=["']([^"']+)["'])?[^>]*(?:placeholder=["']([^"']+)["'])?[^>]*/gi;
        while ((match = inputRegex.exec(html)) !== null) {
            elements.push({
                type: 'input',
                inputType: match[2] || 'text',
                selector: match[1] ? `#${match[1]}` : match[4] ? `input[placeholder="${match[4]}"]` : match[3] ? `input[name="${match[3]}"]` : 'input',
                selectorType: 'css',
                id: match[1],
                name: match[3],
                placeholder: match[4]
            });
        }

        // Find links
        const linkRegex = /<a[^>]*href=["']([^"']+)["'][^>]*(?:id=["']([^"']+)["'])?[^>]*>([^<]*)</gi;
        while ((match = linkRegex.exec(html)) !== null) {
            const text = match[3].trim();
            elements.push({
                type: 'a',
                selector: text ? `a:has-text("${text}")` : match[2] ? `#${match[2]}` : `a[href="${match[1]}"]`,
                selectorType: text ? 'text' : 'css',
                href: match[1],
                text: text,
                id: match[2]
            });
        }

        // Find selects
        const selectRegex = /<select[^>]*(?:id=["']([^"']+)["'])?[^>]*(?:name=["']([^"']+)["'])?[^>]*/gi;
        while ((match = selectRegex.exec(html)) !== null) {
            elements.push({
                type: 'select',
                selector: match[1] ? `#${match[1]}` : match[2] ? `select[name="${match[2]}"]` : 'select',
                selectorType: 'css',
                id: match[1],
                name: match[2]
            });
        }

        // Find forms
        const formRegex = /<form[^>]*(?:id=["']([^"']+)["'])?[^>]*(?:action=["']([^"']+)["'])?[^>]*/gi;
        while ((match = formRegex.exec(html)) !== null) {
            elements.push({
                type: 'form',
                selector: match[1] ? `#${match[1]}` : 'form',
                selectorType: 'css',
                action: match[2],
                id: match[1]
            });
        }

        // Find checkboxes
        const checkboxRegex = /<input[^>]*type=["']checkbox["'][^>]*(?:id=["']([^"']+)["'])?[^>]*/gi;
        while ((match = checkboxRegex.exec(html)) !== null) {
            elements.push({
                type: 'checkbox',
                selector: match[1] ? `#${match[1]}` : 'input[type="checkbox"]',
                selectorType: 'css',
                id: match[1]
            });
        }

        return elements;
    }

    /**
     * Run all tests in the test plan
     */
    async runTests(htmlFilePath, options = {}) {
        if (this.isRunning) {
            return { success: false, error: 'Tests already running' };
        }

        this.isRunning = true;
        this.testResults = [];

        try {
            await this.init(options.browser || 'chromium');
            
            // Create a new page
            this.page = await this.context.newPage();
            
            // Start tracing if enabled
            if (this.traceEnabled) {
                await this.context.tracing.start({ screenshots: true, snapshots: true });
            }

            // Load the HTML file
            const fileUrl = `file://${htmlFilePath}`;
            await this.page.goto(fileUrl, { waitUntil: 'networkidle' });

            // Generate test plan if not exists
            if (!this.testPlan) {
                await this.generateTestPlan(htmlFilePath);
            }

            // Run each test
            for (const test of this.testPlan.tests) {
                const result = await this.runSingleTest(test);
                this.testResults.push(result);
                
                // Emit progress if callback provided
                if (options.onProgress) {
                    options.onProgress(result);
                }
            }

            // Take final screenshot
            const finalScreenshot = await this.page.screenshot({
                type: 'png',
                fullPage: true
            });

            // Stop tracing
            if (this.traceEnabled) {
                await this.context.tracing.stop({ path: 'trace.zip' });
            }

            await this.page.close();
            this.page = null;

            return {
                success: true,
                testPlan: this.testPlan,
                results: this.testResults,
                summary: this.generateSummary(),
                finalScreenshot: finalScreenshot.toString('base64'),
                browser: this.currentBrowserType
            };

        } catch (error) {
            console.error('[TestAgent] Test run failed:', error);
            return {
                success: false,
                error: error.message,
                results: this.testResults
            };
        } finally {
            this.isRunning = false;
        }
    }

    /**
     * Get locator based on selector type
     */
    getLocator(test) {
        switch (test.selectorType) {
            case 'text':
                return this.page.getByText(test.selector.replace(/.*:has-text\("(.*)"\)/, '$1'));
            case 'role':
                return this.page.getByRole(test.role, { name: test.name });
            case 'testId':
                return this.page.getByTestId(test.selector);
            case 'label':
                return this.page.getByLabel(test.selector);
            case 'placeholder':
                return this.page.getByPlaceholder(test.selector);
            default:
                return this.page.locator(test.selector);
        }
    }

    /**
     * Run a single test
     */
    async runSingleTest(test) {
        const startTime = Date.now();
        const result = {
            id: test.id,
            name: test.name,
            status: 'pending',
            duration: 0,
            error: null,
            screenshot: null
        };

        try {
            const locator = this.getLocator(test);
            
            // Wait for element with Playwright's auto-waiting
            await locator.waitFor({ state: 'visible', timeout: 5000 });

            // Execute action
            switch (test.action) {
                case 'click':
                    await locator.click();
                    // Playwright auto-waits for navigation/network
                    await this.page.waitForLoadState('networkidle').catch(() => {});
                    break;

                case 'fill':
                    await locator.fill(test.value || 'test');
                    break;

                case 'type':
                    await locator.type(test.value || 'test', { delay: 50 });
                    break;

                case 'hover':
                    await locator.hover();
                    break;

                case 'scroll':
                    await locator.scrollIntoViewIfNeeded();
                    break;

                case 'check':
                    await locator.check();
                    break;

                case 'uncheck':
                    await locator.uncheck();
                    break;

                case 'select':
                    await locator.selectOption(test.value);
                    break;

                case 'screenshot':
                    // Just take a screenshot, no action
                    break;

                case 'press':
                    await locator.press(test.value || 'Enter');
                    break;

                case 'focus':
                    await locator.focus();
                    break;
            }

            // Take screenshot after action
            try {
                const elementScreenshot = await locator.screenshot();
                result.screenshot = elementScreenshot.toString('base64');
            } catch (e) {
                // Element might have changed, take full page
                const pageScreenshot = await this.page.screenshot();
                result.screenshot = pageScreenshot.toString('base64');
            }

            // Verify expected result if specified
            if (test.expectedSelector) {
                const expectedLocator = this.page.locator(test.expectedSelector);
                await expectedLocator.waitFor({ state: 'visible', timeout: 3000 });
            }

            // Check assertions if provided
            if (test.assertions) {
                for (const assertion of test.assertions) {
                    await this.checkAssertion(assertion);
                }
            }

            result.status = 'passed';

        } catch (error) {
            result.status = 'failed';
            result.error = error.message;
            
            // Try to take screenshot even on failure
            try {
                const pageScreenshot = await this.page.screenshot();
                result.screenshot = pageScreenshot.toString('base64');
            } catch (e) {
                // Ignore screenshot error
            }
        }

        result.duration = Date.now() - startTime;
        return result;
    }

    /**
     * Check an assertion
     */
    async checkAssertion(assertion) {
        const locator = this.page.locator(assertion.selector);
        
        switch (assertion.type) {
            case 'visible':
                await expect(locator).toBeVisible();
                break;
            case 'hidden':
                await expect(locator).toBeHidden();
                break;
            case 'text':
                await expect(locator).toHaveText(assertion.value);
                break;
            case 'value':
                await expect(locator).toHaveValue(assertion.value);
                break;
            case 'enabled':
                await expect(locator).toBeEnabled();
                break;
            case 'disabled':
                await expect(locator).toBeDisabled();
                break;
        }
    }

    /**
     * Generate test summary
     */
    generateSummary() {
        const passed = this.testResults.filter(r => r.status === 'passed').length;
        const failed = this.testResults.filter(r => r.status === 'failed').length;
        const total = this.testResults.length;

        return {
            total,
            passed,
            failed,
            passRate: total > 0 ? Math.round((passed / total) * 100) : 0,
            duration: this.testResults.reduce((sum, r) => sum + r.duration, 0),
            browser: this.currentBrowserType
        };
    }

    /**
     * Run visual regression test
     */
    async runVisualTest(htmlFilePath, baselineScreenshot = null, options = {}) {
        try {
            await this.init(options.browser || 'chromium');
            this.page = await this.context.newPage();
            
            await this.page.goto(`file://${htmlFilePath}`, { waitUntil: 'networkidle' });

            const currentScreenshot = await this.page.screenshot({
                type: 'png',
                fullPage: true
            });

            await this.page.close();
            this.page = null;

            const currentBase64 = currentScreenshot.toString('base64');

            if (baselineScreenshot) {
                // Compare screenshots (basic comparison)
                const isDifferent = currentBase64 !== baselineScreenshot;
                return {
                    success: true,
                    hasDifferences: isDifferent,
                    currentScreenshot: currentBase64,
                    baselineScreenshot,
                    browser: this.currentBrowserType
                };
            }

            return {
                success: true,
                currentScreenshot: currentBase64,
                message: 'Baseline screenshot captured',
                browser: this.currentBrowserType
            };

        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Run cross-browser visual test
     */
    async runCrossBrowserTest(htmlFilePath) {
        const results = {};
        const browsers = ['chromium', 'firefox', 'webkit'];
        
        for (const browser of browsers) {
            try {
                await this.init(browser);
                this.page = await this.context.newPage();
                
                await this.page.goto(`file://${htmlFilePath}`, { waitUntil: 'networkidle' });
                
                const screenshot = await this.page.screenshot({
                    type: 'png',
                    fullPage: true
                });
                
                results[browser] = {
                    success: true,
                    screenshot: screenshot.toString('base64')
                };
                
                await this.page.close();
                this.page = null;
                await this.close();
                
            } catch (error) {
                results[browser] = {
                    success: false,
                    error: error.message
                };
            }
        }
        
        return {
            success: true,
            browsers: results
        };
    }

    /**
     * Interactive test - let AI analyze and suggest fixes
     */
    async interactiveTest(htmlFilePath, aiAnalyzer, options = {}) {
        try {
            await this.init(options.browser || 'chromium');
            this.page = await this.context.newPage();
            
            // Collect console messages
            const consoleMessages = [];
            this.page.on('console', msg => {
                consoleMessages.push({
                    type: msg.type(),
                    text: msg.text()
                });
            });

            // Collect page errors
            const pageErrors = [];
            this.page.on('pageerror', error => {
                pageErrors.push(error.message);
            });

            await this.page.goto(`file://${htmlFilePath}`, { waitUntil: 'networkidle' });

            // Get page content and screenshot
            const screenshot = await this.page.screenshot({ type: 'png', fullPage: true });
            const html = await this.page.content();
            
            // Get console errors
            const consoleErrors = consoleMessages.filter(m => m.type === 'error').map(m => m.text);

            await this.page.close();
            this.page = null;

            // Ask AI to analyze
            if (aiAnalyzer) {
                const analysis = await aiAnalyzer({
                    screenshot: screenshot.toString('base64'),
                    html: html.substring(0, 10000),
                    consoleErrors,
                    pageErrors
                });
                
                return {
                    success: true,
                    screenshot: screenshot.toString('base64'),
                    consoleErrors,
                    pageErrors,
                    aiAnalysis: analysis,
                    browser: this.currentBrowserType
                };
            }

            return {
                success: true,
                screenshot: screenshot.toString('base64'),
                consoleErrors,
                pageErrors,
                browser: this.currentBrowserType
            };

        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Accessibility test using Playwright
     */
    async runAccessibilityTest(htmlFilePath, options = {}) {
        try {
            await this.init(options.browser || 'chromium');
            this.page = await this.context.newPage();
            
            await this.page.goto(`file://${htmlFilePath}`, { waitUntil: 'networkidle' });

            // Run accessibility checks
            const issues = await this.page.evaluate(() => {
                const problems = [];
                
                // Check for missing alt text
                document.querySelectorAll('img').forEach(img => {
                    if (!img.alt && !img.getAttribute('aria-label') && !img.getAttribute('aria-labelledby')) {
                        problems.push({
                            type: 'missing-alt',
                            severity: 'error',
                            element: img.outerHTML.substring(0, 100),
                            message: 'Image missing alt text',
                            selector: img.id ? `#${img.id}` : img.className ? `.${img.className.split(' ')[0]}` : 'img'
                        });
                    }
                });

                // Check for missing labels on form inputs
                document.querySelectorAll('input, select, textarea').forEach(input => {
                    if (input.type === 'hidden' || input.type === 'submit' || input.type === 'button') return;
                    
                    const id = input.id;
                    const hasLabel = id && document.querySelector(`label[for="${id}"]`);
                    const hasAriaLabel = input.getAttribute('aria-label');
                    const hasAriaLabelledBy = input.getAttribute('aria-labelledby');
                    const hasPlaceholder = input.placeholder;
                    
                    if (!hasLabel && !hasAriaLabel && !hasAriaLabelledBy) {
                        problems.push({
                            type: 'missing-label',
                            severity: hasPlaceholder ? 'warning' : 'error',
                            element: input.outerHTML.substring(0, 100),
                            message: 'Form input missing accessible label',
                            selector: id ? `#${id}` : input.name ? `[name="${input.name}"]` : input.type
                        });
                    }
                });

                // Check for clickable elements without keyboard access
                document.querySelectorAll('[onclick], [role="button"]').forEach(el => {
                    if (el.tagName === 'BUTTON' || el.tagName === 'A') return;
                    
                    const tabindex = el.getAttribute('tabindex');
                    if (tabindex === null || tabindex === '-1') {
                        problems.push({
                            type: 'keyboard-inaccessible',
                            severity: 'warning',
                            element: el.outerHTML.substring(0, 100),
                            message: 'Clickable element not keyboard accessible (missing tabindex)',
                            selector: el.id ? `#${el.id}` : el.className ? `.${el.className.split(' ')[0]}` : el.tagName.toLowerCase()
                        });
                    }
                });

                // Check heading hierarchy
                const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'));
                let lastLevel = 0;
                headings.forEach(h => {
                    const level = parseInt(h.tagName[1]);
                    if (level > lastLevel + 1 && lastLevel > 0) {
                        problems.push({
                            type: 'heading-skip',
                            severity: 'warning',
                            element: h.outerHTML.substring(0, 100),
                            message: `Heading level skipped from h${lastLevel} to h${level}`,
                            selector: `h${level}`
                        });
                    }
                    lastLevel = level;
                });

                // Check for missing language attribute
                if (!document.documentElement.lang) {
                    problems.push({
                        type: 'missing-lang',
                        severity: 'error',
                        element: '<html>',
                        message: 'Document missing lang attribute',
                        selector: 'html'
                    });
                }

                // Check for empty links
                document.querySelectorAll('a').forEach(link => {
                    const text = link.textContent.trim();
                    const ariaLabel = link.getAttribute('aria-label');
                    const hasImage = link.querySelector('img[alt]');
                    
                    if (!text && !ariaLabel && !hasImage) {
                        problems.push({
                            type: 'empty-link',
                            severity: 'error',
                            element: link.outerHTML.substring(0, 100),
                            message: 'Link has no accessible text',
                            selector: link.href ? `a[href="${link.href}"]` : 'a'
                        });
                    }
                });

                // Check for missing button text
                document.querySelectorAll('button').forEach(btn => {
                    const text = btn.textContent.trim();
                    const ariaLabel = btn.getAttribute('aria-label');
                    const hasImage = btn.querySelector('img[alt]');
                    
                    if (!text && !ariaLabel && !hasImage) {
                        problems.push({
                            type: 'empty-button',
                            severity: 'error',
                            element: btn.outerHTML.substring(0, 100),
                            message: 'Button has no accessible text',
                            selector: btn.id ? `#${btn.id}` : 'button'
                        });
                    }
                });

                // Check color contrast (basic - checks for very low contrast combinations)
                document.querySelectorAll('*').forEach(el => {
                    const style = window.getComputedStyle(el);
                    const color = style.color;
                    const bg = style.backgroundColor;
                    
                    // Very basic check for white on white or black on black
                    if (color === bg && color !== 'rgba(0, 0, 0, 0)') {
                        problems.push({
                            type: 'color-contrast',
                            severity: 'warning',
                            element: el.outerHTML.substring(0, 100),
                            message: 'Possible color contrast issue',
                            selector: el.id ? `#${el.id}` : el.tagName.toLowerCase()
                        });
                    }
                });

                return problems;
            });

            await this.page.close();
            this.page = null;

            return {
                success: true,
                issues,
                summary: {
                    errors: issues.filter(i => i.severity === 'error').length,
                    warnings: issues.filter(i => i.severity === 'warning').length,
                    total: issues.length
                },
                browser: this.currentBrowserType
            };

        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Performance test using Playwright
     */
    async runPerformanceTest(htmlFilePath, options = {}) {
        try {
            await this.init(options.browser || 'chromium');
            this.page = await this.context.newPage();

            // Clear cache
            await this.context.clearCookies();
            
            const startTime = Date.now();
            
            // Navigate and measure
            const response = await this.page.goto(`file://${htmlFilePath}`, { 
                waitUntil: 'networkidle' 
            });
            
            const loadTime = Date.now() - startTime;

            // Get performance timing
            const performanceTiming = await this.page.evaluate(() => {
                const timing = performance.timing;
                return {
                    domContentLoaded: timing.domContentLoadedEventEnd - timing.navigationStart,
                    domComplete: timing.domComplete - timing.navigationStart,
                    loadEvent: timing.loadEventEnd - timing.navigationStart
                };
            });

            // Get resource timing
            const resources = await this.page.evaluate(() => {
                return performance.getEntriesByType('resource').map(r => ({
                    name: r.name.split('/').pop(),
                    type: r.initiatorType,
                    duration: Math.round(r.duration),
                    size: r.transferSize || 0
                })).slice(0, 20); // Limit to 20 resources
            });

            // Get DOM stats
            const domStats = await this.page.evaluate(() => ({
                nodeCount: document.querySelectorAll('*').length,
                scriptCount: document.querySelectorAll('script').length,
                styleCount: document.querySelectorAll('style, link[rel="stylesheet"]').length,
                imageCount: document.querySelectorAll('img').length,
                formCount: document.querySelectorAll('form').length,
                inputCount: document.querySelectorAll('input, select, textarea').length
            }));

            // Get memory usage if available
            const memoryUsage = await this.page.evaluate(() => {
                if (performance.memory) {
                    return {
                        usedJSHeapSize: Math.round(performance.memory.usedJSHeapSize / 1024 / 1024),
                        totalJSHeapSize: Math.round(performance.memory.totalJSHeapSize / 1024 / 1024)
                    };
                }
                return null;
            });

            await this.page.close();
            this.page = null;

            const score = this.calculatePerformanceScore(loadTime, domStats, performanceTiming);

            return {
                success: true,
                loadTime,
                performanceTiming,
                resources,
                domStats,
                memoryUsage,
                score,
                browser: this.currentBrowserType
            };

        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Calculate performance score
     */
    calculatePerformanceScore(loadTime, domStats, timing) {
        let score = 100;
        
        // Penalize slow load times
        if (loadTime > 3000) score -= 30;
        else if (loadTime > 1500) score -= 15;
        else if (loadTime > 500) score -= 5;

        // Penalize large DOM
        if (domStats.nodeCount > 1500) score -= 20;
        else if (domStats.nodeCount > 800) score -= 10;
        else if (domStats.nodeCount > 400) score -= 5;

        // Penalize many scripts
        if (domStats.scriptCount > 15) score -= 15;
        else if (domStats.scriptCount > 8) score -= 10;
        else if (domStats.scriptCount > 4) score -= 5;

        // Penalize many stylesheets
        if (domStats.styleCount > 10) score -= 10;
        else if (domStats.styleCount > 5) score -= 5;

        // Penalize slow DOM content loaded
        if (timing.domContentLoaded > 2000) score -= 10;
        else if (timing.domContentLoaded > 1000) score -= 5;

        return Math.max(0, Math.min(100, score));
    }

    /**
     * Enable/disable tracing
     */
    setTracing(enabled) {
        this.traceEnabled = enabled;
    }

    /**
     * Record a video of test execution
     */
    async recordTest(htmlFilePath, testPlan, outputPath) {
        try {
            await this.init();
            
            // Create context with video recording
            const videoContext = await this.browser.newContext({
                viewport: { width: 1280, height: 800 },
                recordVideo: {
                    dir: path.dirname(outputPath),
                    size: { width: 1280, height: 800 }
                }
            });
            
            this.page = await videoContext.newPage();
            await this.page.goto(`file://${htmlFilePath}`, { waitUntil: 'networkidle' });
            
            // Run tests
            for (const test of testPlan.tests) {
                await this.runSingleTest(test);
            }
            
            await this.page.close();
            await videoContext.close();
            
            return {
                success: true,
                videoPath: outputPath
            };
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
}

// Export singleton instance
const testAgent = new TestAgent();

module.exports = {
    testAgent,
    TestAgent
};
