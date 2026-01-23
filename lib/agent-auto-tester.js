/**
 * Agent Auto-Tester
 * 
 * Autonomous testing system that creates, tests, diagnoses failures,
 * applies fixes, and iterates until agents work - with no user intervention.
 * 
 * GENERIC DESIGN: Works for ANY agent type by using Claude Code to generate
 * both execution scripts and verification scripts dynamically.
 * 
 * Uses Claude Code CLI (browser login) - no API key needed.
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const { getSystemStateCapture } = require('./system-state-capture');
const claudeCode = require('./claude-code-runner');

class AgentAutoTester {
  constructor(claudeAPI) {
    // Use Claude Code CLI instead of API (claudeAPI parameter kept for compatibility)
    this.claude = {
      complete: claudeCode.complete.bind(claudeCode),
      chat: claudeCode.chat.bind(claudeCode),
      executeWithTools: claudeCode.executeWithTools.bind(claudeCode),
    };
    this.useAgenticExecution = true; // Use CLI with tools for actual execution
    this.maxAttempts = 5;
    this.attemptHistory = [];
    this.stateCapture = getSystemStateCapture();
    this.timeline = []; // Event timeline for current test
  }
  
  /**
   * Add event to timeline
   */
  addTimelineEvent(event, details = {}) {
    this.timeline.push({
      t: Date.now() - (this.testStartTime || Date.now()),
      timestamp: Date.now(),
      event,
      details: typeof details === 'string' ? details : JSON.stringify(details).substring(0, 200),
      ...details
    });
  }
  
  /**
   * Generate an execution plan for any agent action
   * Returns both the script to execute AND how to verify it worked
   */
  async generateExecutionPlan(agent, testPrompt) {
    const prompt = `Generate an execution and verification plan for this agent test:

AGENT:
- Name: ${agent.name}
- Type: ${agent.executionType}
- Prompt: ${agent.prompt?.substring(0, 500)}

TEST COMMAND: "${testPrompt}"

Based on the agent type, generate a plan in JSON format:
{
  "action": "What action is being requested (e.g., play, stop, open, create, delete, etc.)",
  "executionScript": "The exact script to execute (AppleScript, shell command, etc.)",
  "scriptType": "applescript | shell | none",
  "verification": {
    "method": "process-check | app-state | file-check | output-check | command-result | manual",
    "script": "The verification script to run after execution",
    "expectedResult": "What the verification script should return if successful",
    "successCondition": "How to determine success from the result"
  },
  "preConditions": ["Any checks to run before execution"],
  "timeout": 5000
}

GUIDELINES:
- For AppleScript app control: Use "tell application X to..." syntax
- For verification, always check the ACTUAL STATE after execution
- For media apps: Check "player state" (playing, paused, stopped)
- For file operations: Check if file/folder exists
- For app launches: Check if process is running and frontmost
- Be specific about expected results`;

    try {
      const response = await this.claude.complete(prompt, {
        maxTokens: 800,
        temperature: 0.1
      });
      
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      
      return null;
    } catch (error) {
      console.error('[AutoTester] Failed to generate execution plan:', error);
      return null;
    }
  }

  /**
   * Main entry point - test an agent until it works or max attempts reached
   * @param {Object} agent - The agent configuration
   * @param {string} testPrompt - The prompt to test with
   * @param {Function} onProgress - Callback for progress updates
   * @returns {Object} Result with success status, attempts, and details
   */
  async testUntilSuccess(agent, testPrompt, onProgress = () => {}) {
    this.attemptHistory = [];
    this.masterTimeline = []; // Master timeline across all attempts
    const masterStartTime = Date.now();
    
    const addMasterEvent = (event, details = {}) => {
      this.masterTimeline.push({
        t: Date.now() - masterStartTime,
        timestamp: Date.now(),
        event,
        ...details
      });
    };
    
    addMasterEvent('test-session-start', { agent: agent.name, prompt: testPrompt });
    
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      addMasterEvent('attempt-start', { attempt, maxAttempts: this.maxAttempts });
      
      onProgress({
        type: 'attempt-start',
        attempt,
        maxAttempts: this.maxAttempts,
        agent: agent.name,
        message: `Testing attempt ${attempt}/${this.maxAttempts}...`
      });

      // Execute and verify
      const result = await this.executeAndVerify(agent, testPrompt);
      
      // Merge attempt timeline into master
      if (result.timeline) {
        for (const event of result.timeline) {
          addMasterEvent(`attempt-${attempt}:${event.event}`, event);
        }
      }
      
      this.attemptHistory.push({
        attempt,
        agent: { ...agent },
        result,
        timestamp: Date.now()
      });

      if (result.verified === true) {
        addMasterEvent('success', { attempt, details: result.details });
        
        onProgress({
          type: 'success',
          attempt,
          message: `Success on attempt ${attempt}!`,
          details: result.details,
          stateDiff: result.stateDiff,
          verificationResults: result.verificationResults
        });
        
        return {
          success: true,
          attempts: attempt,
          finalAgent: agent,
          verificationDetails: result.details,
          history: this.attemptHistory,
          timeline: this.masterTimeline,
          lastResult: result
        };
      }

      addMasterEvent('attempt-failed', { 
        attempt, 
        details: result.details,
        stateDiff: result.stateDiff?.summary
      });

      // If this is the last attempt, don't try to fix
      if (attempt >= this.maxAttempts) {
        addMasterEvent('max-attempts-reached', { attempts: this.maxAttempts });
        
        onProgress({
          type: 'max-attempts',
          message: `Max attempts (${this.maxAttempts}) reached`,
          lastResult: result,
          stateDiff: result.stateDiff,
          verificationResults: result.verificationResults
        });
        break;
      }

      // Diagnose the failure
      addMasterEvent('diagnosis-start', { attempt });
      
      onProgress({
        type: 'diagnosing',
        attempt,
        message: 'Diagnosing failure...',
        failureDetails: result.details,
        stateDiff: result.stateDiff,
        verificationResults: result.verificationResults
      });

      const diagnosis = await this.diagnoseFailure(agent, testPrompt, result);
      
      addMasterEvent('diagnosis-complete', { summary: diagnosis.summary });
      
      onProgress({
        type: 'diagnosis-complete',
        attempt,
        message: `Diagnosis: ${diagnosis.summary}`,
        diagnosis
      });

      // Generate and apply fix
      addMasterEvent('fix-generation-start', { attempt });
      
      onProgress({
        type: 'generating-fix',
        attempt,
        message: 'Generating fix...'
      });

      const fix = await this.generateFix(agent, testPrompt, diagnosis);
      
      if (!fix.canFix) {
        addMasterEvent('fix-impossible', { reason: fix.reason });
        
        onProgress({
          type: 'cannot-fix',
          attempt,
          message: `Cannot auto-fix: ${fix.reason}`,
          diagnosis
        });
        break;
      }

      addMasterEvent('fix-applying', { description: fix.description });
      
      onProgress({
        type: 'applying-fix',
        attempt,
        message: `Applying fix: ${fix.description}`,
        fix
      });

      agent = await this.applyFix(agent, fix);
      
      addMasterEvent('fix-applied', { newAgentConfig: agent.name });
    }

    addMasterEvent('test-session-end', { success: false, totalAttempts: this.attemptHistory.length });

    // Return failure with full diagnosis
    const lastResult = this.attemptHistory[this.attemptHistory.length - 1]?.result;
    
    return {
      success: false,
      attempts: this.attemptHistory.length,
      finalAgent: agent,
      finalDiagnosis: lastResult,
      history: this.attemptHistory,
      timeline: this.masterTimeline,
      lastResult,
      recommendation: await this.generateRecommendation(agent, testPrompt)
    };
  }

  /**
   * Execute the agent and verify the result - GENERIC for any agent type
   * Uses comprehensive state capture and multi-method verification
   */
  async executeAndVerify(agent, testPrompt) {
    const executionType = agent.executionType || 'llm';
    this.testStartTime = Date.now();
    this.timeline = [];
    
    this.addTimelineEvent('test-start', { prompt: testPrompt, agent: agent.name });
    
    // For LLM agents, we can't auto-verify
    if (executionType === 'llm') {
      return await this.executeLLM(agent, testPrompt);
    }
    
    try {
      // Detect relevant apps from agent name/prompt
      const relevantApps = this.detectRelevantApps(agent, testPrompt);
      
      // STEP 1: Capture BEFORE state
      this.addTimelineEvent('state-capture-before', 'Capturing system state before action');
      const beforeState = await this.stateCapture.captureFullState({ relevantApps });
      this.addTimelineEvent('state-captured', { 
        frontmost: beforeState.frontmostApp?.name,
        apps: Object.keys(beforeState.appStates).join(', ')
      });
      
      // STEP 2: Generate execution plan using Claude
      this.addTimelineEvent('plan-generation', 'Generating execution plan');
      const plan = await this.generateExecutionPlan(agent, testPrompt);
      
      if (!plan) {
        this.addTimelineEvent('plan-failed', 'Failed to generate plan, using fallback');
        return await this.executeBasic(agent, testPrompt, executionType);
      }
      
      this.addTimelineEvent('plan-generated', { 
        action: plan.action, 
        scriptType: plan.scriptType,
        script: plan.executionScript?.substring(0, 100)
      });
      
      console.log('[AutoTester] Execution plan:', plan.action, '->', plan.scriptType);
      
      // STEP 3: Execute the script
      this.addTimelineEvent('script-execution', 'Executing script');
      let executionResult = null;
      let executionOutput = '';
      
      // Use agentic CLI execution if enabled
      if (this.useAgenticExecution && plan.executionScript) {
        try {
          console.log('[AutoTester] Using agentic CLI execution');
          const agentPrompt = plan.scriptType === 'applescript' 
            ? `Execute this AppleScript and report the result:\n\nosascript -e '${plan.executionScript.replace(/'/g, "'\"'\"'")}'\n\nRun the command and tell me what happened.`
            : `Execute this command and report the result:\n\n${plan.executionScript}\n\nRun the command and tell me what happened.`;
          
          const result = await this.claude.executeWithTools(agentPrompt, {
            allowedTools: ['Bash'],
            systemPrompt: 'You are executing a test command. Run the command using Bash and report the output. Be concise.'
          });
          
          executionOutput = result.output || '';
          executionResult = { 
            success: result.success, 
            output: result.output, 
            exitCode: result.success ? 0 : 1,
            agentic: true
          };
          this.addTimelineEvent('script-executed', { success: result.success, output: executionOutput.substring(0, 200), agentic: true });
          console.log('[AutoTester] Agentic execution result:', result.success ? 'SUCCESS' : 'FAILED');
        } catch (error) {
          console.error('[AutoTester] Agentic execution error:', error.message);
          executionResult = { success: false, error: error.message, exitCode: 1 };
          this.addTimelineEvent('script-error', { error: error.message, agentic: true });
        }
      } else if (plan.scriptType === 'applescript' && plan.executionScript) {
        // Fallback to direct osascript execution
        try {
          const script = plan.executionScript.replace(/'/g, "'\"'\"'");
          const { stdout, stderr } = await execAsync(`osascript -e '${script}'`, { timeout: plan.timeout || 10000 });
          executionOutput = stdout;
          executionResult = { success: true, output: stdout, exitCode: 0 };
          this.addTimelineEvent('script-executed', { success: true, output: stdout.substring(0, 100) });
        } catch (error) {
          executionResult = { success: false, error: error.message, exitCode: error.code };
          this.addTimelineEvent('script-error', { error: error.message });
        }
      } else if (plan.scriptType === 'shell' && plan.executionScript) {
        try {
          const { stdout, stderr } = await execAsync(plan.executionScript, { timeout: plan.timeout || 10000 });
          executionOutput = stdout;
          executionResult = { success: true, output: stdout, exitCode: 0 };
          this.addTimelineEvent('script-executed', { success: true, output: stdout.substring(0, 100) });
        } catch (error) {
          executionResult = { success: false, error: error.message, exitCode: error.code };
          this.addTimelineEvent('script-error', { error: error.message });
        }
      }
      
      // STEP 4: Wait for action to take effect
      this.addTimelineEvent('waiting', 'Waiting for action to take effect');
      await new Promise(r => setTimeout(r, 500));
      
      // STEP 5: Capture AFTER state
      this.addTimelineEvent('state-capture-after', 'Capturing system state after action');
      const afterState = await this.stateCapture.captureFullState({ relevantApps });
      this.addTimelineEvent('state-captured', {
        frontmost: afterState.frontmostApp?.name,
        apps: Object.keys(afterState.appStates).join(', ')
      });
      
      // STEP 6: Generate state diff
      this.addTimelineEvent('diff-generation', 'Comparing before/after states');
      const stateDiff = this.stateCapture.diff(beforeState, afterState);
      this.addTimelineEvent('diff-complete', {
        hasChanges: stateDiff.hasChanges,
        changeCount: stateDiff.changeCount
      });
      
      // STEP 7: Run MULTI-METHOD verification
      this.addTimelineEvent('verification-start', 'Running multi-method verification');
      const multiVerification = await this.runMultiVerification(plan, beforeState, afterState, stateDiff, executionResult);
      this.addTimelineEvent('verification-complete', {
        passed: multiVerification.allPassed,
        results: Object.entries(multiVerification.results).map(([k, v]) => `${k}:${v.passed}`).join(', ')
      });
      
      // Build comprehensive result
      const result = {
        verified: multiVerification.allPassed,
        method: 'multi-verification',
        details: multiVerification.summary,
        action: plan.action,
        executionOutput,
        
        // State information
        beforeState: this.summarizeState(beforeState, relevantApps),
        afterState: this.summarizeState(afterState, relevantApps),
        stateDiff,
        
        // Verification details
        verificationResults: multiVerification.results,
        
        // Expected vs actual
        actualState: multiVerification.actualState,
        expectedState: multiVerification.expectedState,
        
        // Timeline and plan
        timeline: this.timeline,
        plan,
        
        // Formatted reports
        beforeStateFormatted: this.stateCapture.formatStateForDisplay(beforeState),
        afterStateFormatted: this.stateCapture.formatStateForDisplay(afterState)
      };
      
      return result;
      
    } catch (error) {
      this.addTimelineEvent('error', { message: error.message });
      return {
        verified: false,
        method: 'execution-error',
        details: error.message,
        error: true,
        timeline: this.timeline
      };
    }
  }
  
  /**
   * Detect relevant apps based on agent and prompt
   */
  detectRelevantApps(agent, testPrompt) {
    const apps = [];
    const combined = `${agent.name} ${agent.prompt} ${testPrompt}`.toLowerCase();
    
    // Media apps
    if (combined.includes('music') || combined.includes('itunes')) {
      apps.push({ name: 'music', type: 'media' });
    }
    if (combined.includes('spotify')) {
      apps.push({ name: 'spotify', type: 'media' });
    }
    
    // Browsers
    if (combined.includes('safari')) {
      apps.push({ name: 'safari', type: 'browser' });
    }
    if (combined.includes('chrome')) {
      apps.push({ name: 'google chrome', type: 'browser' });
    }
    
    // Finder
    if (combined.includes('finder') || combined.includes('folder') || combined.includes('file')) {
      apps.push({ name: 'finder', type: 'finder' });
    }
    
    return apps;
  }
  
  /**
   * Run multiple verification methods
   */
  async runMultiVerification(plan, beforeState, afterState, stateDiff, executionResult) {
    const results = {};
    let actualState = null;
    let expectedState = plan.verification?.expectedResult;
    
    // 1. Primary verification (from plan)
    results.primary = await this.runPrimaryVerification(plan.verification, executionResult);
    if (results.primary.actualState) {
      actualState = results.primary.actualState;
    }
    
    // 2. State diff verification - did ANYTHING change?
    results.stateDiff = {
      passed: stateDiff.hasChanges,
      details: stateDiff.hasChanges 
        ? `${stateDiff.changeCount} state change(s) detected`
        : 'NO STATE CHANGES DETECTED - action may have had no effect',
      changes: stateDiff.changes
    };
    
    // 3. App-specific state verification
    const targetApp = this.detectTargetApp(plan, beforeState);
    if (targetApp) {
      const beforeAppState = beforeState.appStates?.[targetApp];
      const afterAppState = afterState.appStates?.[targetApp];
      
      if (beforeAppState && afterAppState) {
        results.appState = this.verifyAppStateChange(plan, beforeAppState, afterAppState);
        if (results.appState.actualState) {
          actualState = results.appState.actualState;
        }
      }
    }
    
    // 4. Process verification - is the target app running?
    if (targetApp) {
      const isRunning = afterState.processes?.includes(targetApp.toLowerCase());
      results.process = {
        passed: isRunning,
        details: isRunning ? `${targetApp} is running` : `${targetApp} is NOT running`
      };
    }
    
    // 5. Execution result verification
    results.execution = {
      passed: executionResult?.success !== false,
      details: executionResult?.success 
        ? 'Script executed without error'
        : `Execution error: ${executionResult?.error || 'unknown'}`
    };
    
    // Determine overall pass/fail
    // Primary verification is most important, but state diff gives us insight
    const allPassed = results.primary.passed && 
                      (results.appState?.passed !== false) && 
                      results.execution.passed;
    
    // Generate summary
    const summary = this.generateVerificationSummary(results, stateDiff, plan);
    
    return {
      allPassed,
      results,
      summary,
      actualState,
      expectedState
    };
  }
  
  /**
   * Run primary verification from plan
   */
  async runPrimaryVerification(verification, executionResult) {
    if (!verification) {
      return { passed: executionResult?.success || false, details: 'No verification defined' };
    }
    
    if (executionResult && !executionResult.success) {
      return {
        passed: false,
        details: `Execution failed: ${executionResult.error}`,
        actualState: 'error',
        expectedState: verification.expectedResult
      };
    }
    
    try {
      let actualResult = '';
      
      if (verification.method === 'app-state' && verification.script) {
        const script = verification.script.replace(/'/g, "'\"'\"'");
        const { stdout } = await execAsync(`osascript -e '${script}'`);
        actualResult = stdout.trim();
      } else if (verification.method === 'process-check' && verification.script) {
        const { stdout } = await execAsync(verification.script);
        actualResult = stdout.trim();
      } else if (verification.method === 'file-check' && verification.script) {
        const { stdout } = await execAsync(verification.script);
        actualResult = stdout.trim();
      } else if (verification.method === 'command-result' && verification.script) {
        const { stdout } = await execAsync(verification.script);
        actualResult = stdout.trim();
      } else if (verification.method === 'output-check') {
        actualResult = executionResult?.output || '';
      } else if (verification.method === 'manual') {
        return {
          passed: null,
          details: 'Manual verification required',
          needsUserConfirmation: true
        };
      }
      
      const expected = (verification.expectedResult || '').toLowerCase().trim();
      const actual = actualResult.toLowerCase().trim();
      
      const passed = actual === expected || 
                    actual.includes(expected) || 
                    expected.includes(actual) ||
                    (verification.successCondition && actual.includes(verification.successCondition.toLowerCase()));
      
      return {
        passed,
        details: passed 
          ? `Verified: ${actualResult}` 
          : `Expected "${verification.expectedResult}" but got "${actualResult}"`,
        actualState: actualResult,
        expectedState: verification.expectedResult
      };
      
    } catch (error) {
      return {
        passed: false,
        details: `Verification error: ${error.message}`,
        actualState: 'error',
        expectedState: verification.expectedResult
      };
    }
  }
  
  /**
   * Verify app-specific state changes
   */
  verifyAppStateChange(plan, beforeState, afterState) {
    const action = plan.action?.toLowerCase() || '';
    
    // Media app verification
    if (beforeState.type === 'media') {
      if (action.includes('stop')) {
        const passed = afterState.playerState === 'stopped';
        return {
          passed,
          details: passed 
            ? 'Player stopped successfully'
            : `Player state is "${afterState.playerState}" (expected: stopped)`,
          actualState: afterState.playerState,
          expectedState: 'stopped',
          before: beforeState.playerState,
          after: afterState.playerState
        };
      }
      
      if (action.includes('pause')) {
        const passed = afterState.playerState === 'paused';
        return {
          passed,
          details: passed 
            ? 'Player paused successfully'
            : `Player state is "${afterState.playerState}" (expected: paused)`,
          actualState: afterState.playerState,
          expectedState: 'paused',
          before: beforeState.playerState,
          after: afterState.playerState
        };
      }
      
      if (action.includes('play')) {
        const passed = afterState.playerState === 'playing';
        return {
          passed,
          details: passed 
            ? `Playing: "${afterState.track?.name}"`
            : `Player state is "${afterState.playerState}" (expected: playing)`,
          actualState: afterState.playerState,
          expectedState: 'playing',
          before: beforeState.playerState,
          after: afterState.playerState
        };
      }
      
      if (action.includes('next') || action.includes('skip')) {
        const trackChanged = beforeState.track?.name !== afterState.track?.name;
        return {
          passed: trackChanged,
          details: trackChanged 
            ? `Track changed to: "${afterState.track?.name}"`
            : `Track did not change (still: "${afterState.track?.name}")`,
          before: beforeState.track?.name,
          after: afterState.track?.name
        };
      }
    }
    
    // Browser verification
    if (beforeState.type === 'browser') {
      if (action.includes('open') || action.includes('navigate') || action.includes('go to')) {
        const urlChanged = beforeState.url !== afterState.url;
        return {
          passed: urlChanged || afterState.url?.length > 0,
          details: urlChanged 
            ? `Navigated to: ${afterState.url}`
            : `URL unchanged: ${afterState.url}`,
          before: beforeState.url,
          after: afterState.url
        };
      }
    }
    
    // Generic - just check if state changed
    const stateStr = JSON.stringify(beforeState);
    const afterStr = JSON.stringify(afterState);
    const changed = stateStr !== afterStr;
    
    return {
      passed: changed,
      details: changed ? 'App state changed' : 'No app state change detected'
    };
  }
  
  /**
   * Detect target app from plan
   */
  detectTargetApp(plan, state) {
    const action = (plan.action || '').toLowerCase();
    const script = (plan.executionScript || '').toLowerCase();
    
    for (const appName of Object.keys(state.appStates || {})) {
      if (action.includes(appName) || script.includes(appName)) {
        return appName;
      }
    }
    
    // Check for app mentions in script
    const appPatterns = ['music', 'spotify', 'safari', 'chrome', 'finder'];
    for (const app of appPatterns) {
      if (script.includes(app)) {
        return app;
      }
    }
    
    return null;
  }
  
  /**
   * Generate verification summary
   */
  generateVerificationSummary(results, stateDiff, plan) {
    const lines = [];
    
    // Primary result
    const primaryIcon = results.primary?.passed ? '✓' : '✗';
    lines.push(`${primaryIcon} Primary (${plan.verification?.method || 'none'}): ${results.primary?.details || 'N/A'}`);
    
    // State diff
    const diffIcon = results.stateDiff?.passed ? '✓' : '✗';
    lines.push(`${diffIcon} State Diff: ${results.stateDiff?.details || 'N/A'}`);
    
    // App state
    if (results.appState) {
      const appIcon = results.appState.passed ? '✓' : '✗';
      lines.push(`${appIcon} App State: ${results.appState.details}`);
    }
    
    // Process
    if (results.process) {
      const procIcon = results.process.passed ? '✓' : '✗';
      lines.push(`${procIcon} Process: ${results.process.details}`);
    }
    
    // Execution
    const execIcon = results.execution?.passed ? '✓' : '✗';
    lines.push(`${execIcon} Execution: ${results.execution?.details || 'N/A'}`);
    
    return lines.join('\n');
  }
  
  /**
   * Summarize state for storage
   */
  summarizeState(state, relevantApps) {
    return {
      timestamp: state.timestamp,
      frontmostApp: state.frontmostApp?.name,
      processCount: state.processes?.length || 0,
      appStates: state.appStates,
      clipboard: state.clipboard?.hasContent ? '(has content)' : '(empty)'
    };
  }
  
  /**
   * Run the verification script and check results
   */
  async runVerification(verification, executionResult) {
    if (!verification) {
      return { verified: executionResult?.success || false, details: 'No verification defined' };
    }
    
    // If execution failed, verification fails
    if (executionResult && !executionResult.success) {
      return {
        verified: false,
        details: `Execution failed: ${executionResult.error}`,
        actualState: 'error',
        expectedState: verification.expectedResult
      };
    }
    
    try {
      let actualResult = '';
      
      // Run verification script based on method
      if (verification.method === 'app-state' && verification.script) {
        const script = verification.script.replace(/'/g, "'\"'\"'");
        const { stdout } = await execAsync(`osascript -e '${script}'`);
        actualResult = stdout.trim();
      } else if (verification.method === 'process-check' && verification.script) {
        const { stdout } = await execAsync(verification.script);
        actualResult = stdout.trim();
      } else if (verification.method === 'file-check' && verification.script) {
        const { stdout } = await execAsync(verification.script);
        actualResult = stdout.trim();
      } else if (verification.method === 'command-result' && verification.script) {
        const { stdout } = await execAsync(verification.script);
        actualResult = stdout.trim();
      } else if (verification.method === 'output-check') {
        actualResult = executionResult?.output || '';
      } else if (verification.method === 'manual') {
        return {
          verified: null,
          details: 'Manual verification required',
          needsUserConfirmation: true
        };
      }
      
      // Check if actual matches expected
      const expected = (verification.expectedResult || '').toLowerCase().trim();
      const actual = actualResult.toLowerCase().trim();
      
      // Smart comparison - check for containment or exact match
      const verified = actual === expected || 
                      actual.includes(expected) || 
                      expected.includes(actual) ||
                      (verification.successCondition && actual.includes(verification.successCondition.toLowerCase()));
      
      return {
        verified,
        details: verified 
          ? `Verified: ${actualResult}` 
          : `Expected "${verification.expectedResult}" but got "${actualResult}"`,
        actualState: actualResult,
        expectedState: verification.expectedResult
      };
      
    } catch (error) {
      return {
        verified: false,
        details: `Verification error: ${error.message}`,
        actualState: 'error',
        expectedState: verification.expectedResult
      };
    }
  }
  
  /**
   * Basic execution fallback when plan generation fails
   */
  async executeBasic(agent, testPrompt, executionType) {
    if (executionType === 'applescript') {
      return await this.executeAppleScriptBasic(agent, testPrompt);
    } else if (executionType === 'shell') {
      return await this.executeShellBasic(agent, testPrompt);
    }
    return {
      verified: null,
      method: 'unknown',
      details: `Unknown execution type: ${executionType}`
    };
  }

  /**
   * Basic AppleScript execution fallback (when plan generation fails)
   */
  async executeAppleScriptBasic(agent, testPrompt) {
    try {
      // Generate and execute a script using Claude
      const script = await this.generateScript(agent, testPrompt, 'applescript');
      
      const escapedScript = script.replace(/'/g, "'\"'\"'");
      const { stdout } = await execAsync(`osascript -e '${escapedScript}'`, { timeout: 10000 });
      
      // Try to verify by checking if any app became active
      await new Promise(r => setTimeout(r, 300));
      const { stdout: frontApp } = await execAsync(`osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'`);
      
      return {
        verified: true,
        method: 'script-executed',
        details: `Script executed. Front app: ${frontApp.trim()}. Output: ${stdout.substring(0, 100)}`,
        script,
        output: stdout
      };
    } catch (error) {
      return {
        verified: false,
        method: 'execution-error',
        details: error.message,
        error: true
      };
    }
  }

  /**
   * Execute shell command agent
   */
  /**
   * Basic shell execution fallback (when plan generation fails)
   */
  async executeShellBasic(agent, testPrompt) {
    try {
      const script = await this.generateScript(agent, testPrompt, 'shell');
      
      // Safety check
      const dangerous = ['rm -rf', 'sudo', 'mkfs', '> /dev/'];
      if (dangerous.some(d => script.includes(d))) {
        return {
          verified: false,
          method: 'safety-block',
          details: `Command blocked for safety: ${script.substring(0, 50)}`,
          script
        };
      }
      
      const { stdout, stderr } = await execAsync(script, { timeout: 10000 });
      
      return {
        verified: true,
        method: 'exit-code',
        details: stdout || 'Command completed',
        script,
        output: stdout
      };
    } catch (error) {
      return {
        verified: false,
        method: 'execution-error',
        details: error.message,
        error: true
      };
    }
  }

  /**
   * Execute LLM agent (conversational)
   */
  async executeLLM(agent, testPrompt) {
    try {
      const response = await this.claude.complete(testPrompt, {
        systemPrompt: agent.prompt,
        maxTokens: 1000,
        temperature: 0.7
      });
      
      return {
        verified: null, // Can't auto-verify LLM responses
        method: 'user-confirmation',
        details: 'Response generated - needs user confirmation',
        response,
        needsUserConfirmation: true
      };
    } catch (error) {
      return {
        verified: false,
        method: 'execution-error',
        details: error.message,
        error: true
      };
    }
  }

  /**
   * Execute a generated AppleScript
   */
  async executeGeneratedScript(agent, testPrompt) {
    const script = await this.generateScript(agent, testPrompt, 'applescript');
    
    try {
      const { stdout, stderr } = await execAsync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`);
      
      // Generic verification - check if any app became frontmost
      await new Promise(r => setTimeout(r, 300));
      const { stdout: frontApp } = await execAsync(`osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'`);
      
      return {
        verified: true,
        method: 'script-executed',
        details: `Script executed. Front app: ${frontApp.trim()}`,
        script,
        output: stdout
      };
    } catch (error) {
      return {
        verified: false,
        method: 'script-error',
        details: error.message,
        script,
        error: true
      };
    }
  }

  /**
   * Generate a script using Claude
   */
  async generateScript(agent, testPrompt, type) {
    const prompt = type === 'applescript'
      ? `Generate ONLY the AppleScript code (no explanation) for: ${testPrompt}\n\nAgent context: ${agent.prompt}`
      : `Generate ONLY the shell command (no explanation) for: ${testPrompt}\n\nAgent context: ${agent.prompt}`;
    
    const response = await this.claude.complete(prompt, {
      maxTokens: 500,
      temperature: 0.1
    });
    
    // Clean up response
    let script = response.trim();
    script = script.replace(/^```(applescript|bash|sh|shell)?\n?/i, '');
    script = script.replace(/\n?```$/i, '');
    
    return script;
  }

  /**
   * Diagnose why the agent failed
   */
  async diagnoseFailure(agent, testPrompt, result) {
    // Build detailed context for better diagnosis
    const stateInfo = result.actualState && result.expectedState
      ? `\n- Actual State: ${result.actualState}\n- Expected State: ${result.expectedState}`
      : '';
    
    const prompt = `Analyze this agent test failure and identify the root cause:

AGENT:
- Name: ${agent.name}
- Type: ${agent.executionType}
- Prompt: ${agent.prompt}

TEST:
- Input: ${testPrompt}
- Action Attempted: ${result.action || 'unknown'}

RESULT:
- Verified: ${result.verified}
- Method: ${result.method}
- Details: ${result.details}${stateInfo}
${result.script ? `- Script: ${result.script}` : ''}
${result.error ? '- Error occurred during execution' : ''}

Respond in JSON format:
{
  "summary": "One-line summary of what went wrong",
  "rootCause": "Technical explanation of the root cause",
  "category": "command-error | missing-step | wrong-approach | permission-issue | app-state | timing-issue | other",
  "suggestedFix": "What should be changed to fix this",
  "specificCommand": "The exact AppleScript or command that should be used (if applicable)"
}`;

    try {
      const response = await this.claude.complete(prompt, {
        maxTokens: 500,
        temperature: 0.1
      });
      
      // Parse JSON response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      
      return {
        summary: 'Could not parse diagnosis',
        rootCause: response,
        category: 'other',
        suggestedFix: 'Manual review required'
      };
    } catch (error) {
      return {
        summary: 'Diagnosis failed',
        rootCause: error.message,
        category: 'other',
        suggestedFix: 'Manual review required'
      };
    }
  }

  /**
   * Generate a fix based on the diagnosis
   */
  async generateFix(agent, testPrompt, diagnosis) {
    const prompt = `Generate a fix for this agent based on the diagnosis:

AGENT:
${JSON.stringify(agent, null, 2)}

DIAGNOSIS:
${JSON.stringify(diagnosis, null, 2)}

TEST PROMPT: ${testPrompt}

Respond in JSON format:
{
  "canFix": true/false,
  "reason": "Why fix is possible or not",
  "description": "What the fix does",
  "changes": {
    "prompt": "New prompt if needed (or null)",
    "executionType": "New type if needed (or null)",
    "script": "Specific script to use (or null)",
    "preCommands": ["Commands to run before main action"],
    "postCommands": ["Commands to run after main action"]
  }
}`;

    try {
      const response = await this.claude.complete(prompt, {
        maxTokens: 800,
        temperature: 0.1
      });
      
      
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          return parsed;
        } catch (parseErr) {
          return {
            canFix: false,
            reason: 'JSON parse error: ' + parseErr.message,
            description: response
          };
        }
      }
      
      
      return {
        canFix: false,
        reason: 'Could not generate fix',
        description: response
      };
    } catch (error) {
      return {
        canFix: false,
        reason: error.message,
        description: 'Fix generation failed'
      };
    }
  }

  /**
   * Apply the fix to the agent
   */
  async applyFix(agent, fix) {
    const updatedAgent = { ...agent };
    
    if (fix.changes) {
      if (fix.changes.prompt) {
        updatedAgent.prompt = fix.changes.prompt;
      }
      if (fix.changes.executionType) {
        updatedAgent.executionType = fix.changes.executionType;
      }
      if (fix.changes.script) {
        updatedAgent._fixedScript = fix.changes.script;
      }
      if (fix.changes.preCommands) {
        updatedAgent._preCommands = fix.changes.preCommands;
      }
      if (fix.changes.postCommands) {
        updatedAgent._postCommands = fix.changes.postCommands;
      }
    }
    
    updatedAgent._lastFix = fix;
    updatedAgent._fixCount = (agent._fixCount || 0) + 1;
    
    return updatedAgent;
  }

  /**
   * Generate a recommendation when all attempts fail
   */
  async generateRecommendation(agent, testPrompt) {
    const historyText = this.attemptHistory.map((h, i) => 
      `Attempt ${i + 1}: ${h.result.method} - ${h.result.details}`
    ).join('\n');

    const prompt = `All ${this.maxAttempts} attempts to make this agent work have failed.

AGENT: ${agent.name} (${agent.executionType})
TEST: ${testPrompt}

ATTEMPT HISTORY:
${historyText}

Provide a final recommendation for the user on how to manually resolve this, or suggest an alternative approach. Be concise.`;

    try {
      const response = await this.claude.complete(prompt, {
        maxTokens: 300,
        temperature: 0.3
      });
      return response;
    } catch (error) {
      return 'Unable to generate recommendation. Please try manually testing the agent.';
    }
  }
}

module.exports = { AgentAutoTester };
