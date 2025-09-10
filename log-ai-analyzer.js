/**
 * AI-Powered Log Analyzer
 * 
 * This module analyzes filtered logs using Claude AI to identify issues
 * and generate fix prompts for Cursor.
 */

const { ipcMain } = require('electron');
const getLogger = require('./event-logger');

class LogAIAnalyzer {
    constructor() {
        this.logger = getLogger();
        this.setupIpcHandlers();
    }

    setupIpcHandlers() {
        // Analyze logs with AI
        ipcMain.handle('ai:analyze-logs', async (event, options) => {
            try {
                return await this.analyzeLogs(options);
            } catch (error) {
                this.logger.error('Error analyzing logs with AI', {
                    error: error.message,
                    stack: error.stack
                });
                throw error;
            }
        });

        // Generate Cursor prompt from analysis
        ipcMain.handle('ai:generate-cursor-prompt', async (event, analysis) => {
            try {
                return await this.generateCursorPrompt(analysis);
            } catch (error) {
                this.logger.error('Error generating Cursor prompt', {
                    error: error.message,
                    stack: error.stack
                });
                throw error;
            }
        });
    }

    /**
     * Analyze logs using Claude AI
     */
    async analyzeLogs(options) {
        const {
            logs,
            context,
            focusArea,
            includeContext = true
        } = options;

        // Prepare logs for analysis
        const preparedLogs = this.prepareLogs(logs, includeContext);
        
        // Build the analysis prompt
        const prompt = this.buildAnalysisPrompt(preparedLogs, context, focusArea);
        
        // Call Claude API
        const ClaudeAPI = require('./claude-api');
        const claudeApi = new ClaudeAPI();
        const analysis = await claudeApi.analyze(prompt);
        
        return {
            summary: analysis.summary,
            issues: analysis.issues,
            patterns: analysis.patterns,
            recommendations: analysis.recommendations,
            fixes: analysis.fixes,
            timestamp: new Date().toISOString()
        };
    }

    /**
     * Prepare logs for AI analysis
     */
    prepareLogs(logs, includeContext) {
        return logs.map(log => {
            const prepared = {
                timestamp: log.timestamp,
                level: log.level,
                message: log.message
            };

            if (includeContext) {
                // Include relevant context
                if (log.testContext) {
                    prepared.testContext = {
                        testId: log.testContext.testId,
                        testName: log.testContext.testName,
                        testArea: log.testContext.testArea
                    };
                }

                if (log.error) {
                    prepared.error = log.error;
                }

                if (log.stack) {
                    prepared.stack = log.stack;
                }

                if (log.window) {
                    prepared.window = log.window;
                }

                // Include performance metrics
                if (log.duration) {
                    prepared.duration = log.duration;
                }
            }

            return prepared;
        });
    }

    /**
     * Build analysis prompt for Claude
     */
    buildAnalysisPrompt(logs, context, focusArea) {
        let prompt = `Analyze the following application logs and identify issues, patterns, and potential fixes.

Context: ${context || 'General application logs'}
Focus Area: ${focusArea || 'All areas'}
Number of logs: ${logs.length}

LOGS:
\`\`\`json
${JSON.stringify(logs, null, 2)}
\`\`\`

Please analyze these logs and provide:

1. **Summary**: A brief overview of what's happening in these logs
2. **Issues Identified**: List any errors, warnings, or potential problems
3. **Patterns**: Any recurring patterns or trends you notice
4. **Root Causes**: Potential root causes for the issues
5. **Recommendations**: Specific recommendations to fix the issues
6. **Code Fixes**: If applicable, suggest specific code changes

For each issue, please provide:
- Severity (critical, high, medium, low)
- Affected component/area
- Impact description
- Suggested fix

Format your response as a structured JSON object.`;

        return prompt;
    }

    /**
     * Generate a Cursor prompt from AI analysis
     */
    async generateCursorPrompt(analysis) {
        const prompt = `# Fix Request for Cursor

## Summary
${analysis.summary}

## Issues to Fix

${analysis.issues.map((issue, index) => `
### ${index + 1}. ${issue.title} (${issue.severity})

**Component**: ${issue.component}
**Impact**: ${issue.impact}

**Description**: ${issue.description}

**Suggested Fix**:
${issue.fix}

**Code Changes**:
\`\`\`${issue.language || 'javascript'}
${issue.codeChanges || '// Implement fix here'}
\`\`\`
`).join('\n')}

## Implementation Steps

${analysis.recommendations.map((rec, index) => 
    `${index + 1}. ${rec}`
).join('\n')}

## Testing Instructions

After implementing the fixes, please:
1. Run the test suite to ensure no regressions
2. Specifically test the affected areas: ${analysis.issues.map(i => i.component).join(', ')}
3. Verify the error logs no longer appear
4. Check performance metrics if applicable

## Additional Context

${analysis.patterns.length > 0 ? `
### Patterns Observed
${analysis.patterns.map(p => `- ${p}`).join('\n')}
` : ''}

Please implement these fixes following the project's coding standards and best practices.`;

        return {
            prompt,
            metadata: {
                generatedAt: new Date().toISOString(),
                issueCount: analysis.issues.length,
                severity: this.getOverallSeverity(analysis.issues),
                affectedAreas: [...new Set(analysis.issues.map(i => i.component))]
            }
        };
    }

    /**
     * Calculate overall severity
     */
    getOverallSeverity(issues) {
        const severityScores = {
            critical: 4,
            high: 3,
            medium: 2,
            low: 1
        };

        if (issues.length === 0) return 'none';

        const maxSeverity = Math.max(...issues.map(i => 
            severityScores[i.severity] || 0
        ));

        return Object.entries(severityScores).find(
            ([severity, score]) => score === maxSeverity
        )?.[0] || 'unknown';
    }

    /**
     * Analyze test failures specifically
     */
    async analyzeTestFailures(logs) {
        const failureLogs = logs.filter(log => 
            log.level === 'ERROR' || 
            (log.message && log.message.includes('fail')) ||
            (log.action === 'test-fail')
        );

        const prompt = `Analyze these test failure logs and provide specific fixes:

\`\`\`json
${JSON.stringify(failureLogs, null, 2)}
\`\`\`

Focus on:
1. Why each test failed
2. Common failure patterns
3. Specific code fixes needed
4. Test improvements to prevent future failures

Provide actionable fixes that can be implemented immediately.`;

        const ClaudeAPI = require('./claude-api');
        const claudeApi = new ClaudeAPI();
        return await claudeApi.analyze(prompt);
    }

    /**
     * Analyze performance issues
     */
    async analyzePerformance(logs) {
        const perfLogs = logs.filter(log => 
            log.duration || 
            log.testArea?.includes('performance') ||
            (log.message && log.message.toLowerCase().includes('slow'))
        );

        const prompt = `Analyze these performance-related logs:

\`\`\`json
${JSON.stringify(perfLogs, null, 2)}
\`\`\`

Identify:
1. Performance bottlenecks
2. Slow operations (duration > expected)
3. Resource usage issues
4. Optimization opportunities

Provide specific code optimizations and performance improvements.`;

        const ClaudeAPI = require('./claude-api');
        const claudeApi = new ClaudeAPI();
        return await claudeApi.analyze(prompt);
    }

    /**
     * Generate a comprehensive test report with AI insights
     */
    async generateTestReport(testRun, logs) {
        const prompt = `Generate a comprehensive test report based on this test run data and logs:

Test Run Summary:
\`\`\`json
${JSON.stringify(testRun, null, 2)}
\`\`\`

Related Logs:
\`\`\`json
${JSON.stringify(logs.slice(0, 100), null, 2)}
\`\`\`

Please provide:
1. Executive summary of test results
2. Areas of concern
3. Trends compared to previous runs (if data available)
4. Specific recommendations for improving test coverage
5. Priority fixes needed

Format as a professional test report.`;

        const ClaudeAPI = require('./claude-api');
        const claudeApi = new ClaudeAPI();
        return await claudeApi.analyze(prompt);
    }
}

// Create singleton instance
let analyzer = null;

function getLogAIAnalyzer() {
    if (!analyzer) {
        analyzer = new LogAIAnalyzer();
    }
    return analyzer;
}

module.exports = getLogAIAnalyzer; 