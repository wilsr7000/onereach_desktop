# AI-Powered Log Analysis Guide

## Overview

OneReach.ai now includes AI-powered log analysis using Claude to automatically:
- Identify issues and errors in your logs
- Detect patterns and anomalies
- Generate fix recommendations
- Create ready-to-use prompts for Cursor to implement fixes

## Prerequisites

Before using AI log analysis, ensure you have:
1. **Claude API Key**: Configure in Settings > API Keys > Anthropic
2. **Active logs**: The system needs logs to analyze
3. **Internet connection**: Required for Claude API calls

## How to Use

### 1. Access the Log Viewer
- Open the Event Log Viewer from the main menu
- Or use the integrated log viewer in the Test Runner

### 2. Filter Logs (Optional)
Before analysis, you can filter logs to focus on specific areas:
- **Level**: Focus on errors, warnings, or specific severity
- **Test Area**: Analyze logs from specific functional areas
- **Window**: Examine logs from particular windows
- **Time Range**: Recent logs are more relevant

### 3. Start AI Analysis
1. Click the **"🤖 Analyze with AI"** button
2. The system will:
   - Collect current filtered logs (or all logs if no filter)
   - Send them to Claude for analysis
   - Display results in a modal

### 4. Review Analysis Results

The AI analysis provides:

#### Summary
- Overview of what's happening in the logs
- General health assessment

#### Issues Identified
Each issue includes:
- **Title**: Clear description of the problem
- **Severity**: Critical, High, Medium, or Low
- **Component**: Affected part of the application
- **Impact**: How this affects functionality
- **Description**: Detailed explanation
- **Suggested Fix**: Specific steps to resolve

#### Patterns
- Recurring issues or behaviors
- Trends that might indicate systemic problems

#### Recommendations
- Prioritized list of actions to improve the system
- Best practices to prevent future issues

### 5. Generate Cursor Prompt
If issues are found:
1. Click **"📋 Generate Cursor Prompt"**
2. The system creates a comprehensive prompt including:
   - All identified issues
   - Specific code changes needed
   - Implementation steps
   - Testing instructions
3. The prompt is automatically copied to your clipboard

### 6. Use in Cursor
1. Open Cursor
2. Paste the generated prompt
3. Cursor will understand the context and provide:
   - Specific file changes
   - Code implementations
   - Test updates

## Example Scenarios

### Scenario 1: Test Failures
1. Run tests and see failures
2. Filter logs by "Level: Error" and "Test Area: [failing area]"
3. Analyze with AI to understand root causes
4. Generate Cursor prompt for fixes

### Scenario 2: Performance Issues
1. Filter logs by "Test Area: Performance Monitoring"
2. Include logs showing slow operations
3. AI identifies bottlenecks and optimization opportunities
4. Get specific code optimizations via Cursor

### Scenario 3: API Integration Problems
1. Filter by "Test Area: AI Integration" or "Authentication"
2. Analyze connection failures and API errors
3. Receive configuration fixes and error handling improvements

## Understanding AI Suggestions

### Severity Levels
- **Critical**: Application breaking issues, data loss risks
- **High**: Major functionality problems, security concerns
- **Medium**: Performance issues, user experience problems
- **Low**: Minor issues, code quality improvements

### Fix Categories
1. **Immediate Fixes**: Quick wins that solve pressing issues
2. **Configuration Changes**: Settings adjustments
3. **Code Refactoring**: Structural improvements
4. **Error Handling**: Better exception management
5. **Performance Optimization**: Speed and efficiency improvements

## Best Practices

### 1. Focus Your Analysis
- Use filters to analyze specific problem areas
- Don't analyze too many logs at once (500 log limit)
- Recent logs are usually more relevant

### 2. Iterative Improvement
1. Fix critical issues first
2. Re-run tests
3. Analyze new logs
4. Address remaining issues

### 3. Context Matters
The AI considers:
- Current filters applied
- Test execution context
- Error patterns
- System configuration

### 4. Verify Fixes
After implementing AI suggestions:
1. Run affected tests
2. Check that errors no longer appear
3. Verify performance improvements
4. Test edge cases

## Troubleshooting

### "Analysis Failed" Error
- Check your Claude API key in Settings
- Ensure you have internet connectivity
- Verify the API key has sufficient credits

### No Issues Found
- This is good! Your logs are clean
- Consider analyzing different time periods
- Check if filters are too restrictive

### Unclear Suggestions
- Provide more context by including related logs
- Use test area filters for focused analysis
- Include both errors and warnings for context

## Advanced Features

### Custom Analysis Prompts
The system uses specialized prompts for:
- Test failure analysis
- Performance profiling
- Security issue detection
- Integration problem solving

### Batch Analysis
Analyze multiple test runs:
1. Run full test suite
2. Filter by failed tests
3. Analyze all failures together
4. Get comprehensive fix package

### Historical Comparison
- Export logs from different dates
- Compare analysis results
- Track improvement over time

## Integration with Development Workflow

### CI/CD Pipeline
```bash
# Export test logs
npm run test > test-results.log

# Analyze with AI (via API)
curl -X POST http://localhost:3000/analyze-logs \
  -H "Content-Type: application/json" \
  -d @test-results.log

# Generate fixes
npm run generate-fixes
```

### Automated Analysis
Set up automated analysis:
1. Schedule regular test runs
2. Auto-analyze failures
3. Create fix tickets
4. Track resolution

## Privacy and Security

- Logs are sent to Claude API for analysis
- Sensitive data should be filtered before analysis
- API keys are encrypted locally
- No logs are stored by Claude

## Future Enhancements

Planned features include:
- Custom AI training on your codebase
- Automatic fix implementation
- Predictive issue detection
- Team collaboration on fixes 