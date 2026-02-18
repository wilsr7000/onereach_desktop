'use strict';
/**
 * Aider Bridge Client - TypeScript/Electron side
 * Communicates with Python sidecar via JSON-RPC over stdio
 */
Object.defineProperty(exports, '__esModule', { value: true });
exports.AiderBridgeClient = void 0;
const child_process_1 = require('child_process');
const events_1 = require('events');
const path = require('path');
class AiderBridgeClient extends events_1.EventEmitter {
  constructor(pythonPath = 'python3', apiKey = null, apiProvider = 'openai') {
    super();
    this.pythonPath = pythonPath;
    this.apiKey = apiKey;
    this.apiProvider = apiProvider;
    this.process = null;
    this.requestId = 0;
    this.pendingRequests = new Map();
    this.buffer = '';
  }
  /**
   * Start the Python sidecar process
   */
  async start() {
    return new Promise((resolve, reject) => {
      // Try multiple possible paths for the server script
      // In packaged app, aider_bridge is unpacked to app.asar.unpacked
      const possiblePaths = [
        // Packaged app: unpacked location (must be first for packaged builds)
        path.join(process.resourcesPath || '', 'app.asar.unpacked', 'aider_bridge', 'server.py'),
        // Development: same directory
        path.join(__dirname, 'aider_bridge', 'server.py'),
        // Development: parent directory
        path.join(__dirname, '../aider_bridge/server.py'),
        // Development: cwd
        path.join(process.cwd(), 'aider_bridge', 'server.py'),
      ];

      let scriptPath = null;
      const fs = require('fs');

      for (const p of possiblePaths) {
        // Skip paths with empty resourcesPath in dev
        if (p.includes('undefined') || p.startsWith('/app.asar.unpacked')) {
          continue;
        }
        console.log(`[Aider Bridge] Checking path: ${p}`);
        if (fs.existsSync(p)) {
          scriptPath = p;
          console.log(`[Aider Bridge] Found server.py at: ${p}`);
          break;
        }
      }

      if (!scriptPath) {
        const error = new Error(`Cannot find aider_bridge/server.py. Searched: ${possiblePaths.join(', ')}`);
        console.error('[Aider Bridge]', error.message);
        reject(error);
        return;
      }

      console.log(`[Aider Bridge] Starting Python process: ${this.pythonPath} ${scriptPath}`);

      // Build environment with API key
      const env = { ...process.env };
      if (this.apiKey) {
        // Set the appropriate API key based on provider
        if (this.apiProvider === 'anthropic' || this.apiProvider === 'claude') {
          env.ANTHROPIC_API_KEY = this.apiKey;
          console.log('[Aider Bridge] Using Anthropic API key from settings');
        } else {
          env.OPENAI_API_KEY = this.apiKey;
          console.log('[Aider Bridge] Using OpenAI API key from settings');
        }
      } else {
        console.log('[Aider Bridge] No API key provided, using environment variables');
      }

      // Spawn Python process
      this.process = (0, child_process_1.spawn)(this.pythonPath, [scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: path.dirname(scriptPath),
        env: env,
      });

      if (!this.process.stdout || !this.process.stdin || !this.process.stderr) {
        reject(new Error('Failed to create process stdio'));
        return;
      }

      // Handle stdout (responses)
      this.process.stdout.on('data', (data) => {
        console.log('[Aider Bridge stdout]:', data.toString().trim());
        this.handleData(data.toString());
      });

      // Handle stderr (logs/ready signal)
      this.process.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        console.log('[Aider Bridge stderr]:', msg);

        // Check for ready signal in stderr
        if (msg.includes('AIDER_BRIDGE_READY')) {
          console.log('[Aider Bridge] Received ready signal from stderr');
          this.emit('notification', { method: 'ready' });
        }
      });

      // Handle process exit
      this.process.on('exit', (code, signal) => {
        console.log(`[Aider Bridge] Process exited with code ${code}, signal ${signal}`);
        this.emit('exit', code);
      });

      // Handle errors
      this.process.on('error', (error) => {
        console.error('[Aider Bridge] Process error:', error);
        this.emit('error', error);
        reject(error);
      });

      // Wait for ready signal
      let startupResolved = false;

      const readyHandler = (notification) => {
        if (notification.method === 'ready') {
          console.log('[Aider Bridge] Ready signal received, resolving start()');
          startupResolved = true;
          this.removeListener('notification', readyHandler);
          resolve();
        }
      };
      this.on('notification', readyHandler);

      // Timeout after 10 seconds - only reject if startup hasn't resolved
      setTimeout(() => {
        if (!startupResolved && this.process && !this.process.killed) {
          this.removeListener('notification', readyHandler);
          const error = new Error(
            'Timeout waiting for Aider Bridge to start. Check if Python and aider-chat are installed.'
          );
          console.error('[Aider Bridge]', error.message);
          reject(error);
        }
      }, 10000);
    });
  }
  /**
   * Handle incoming data from Python process
   */
  handleData(data) {
    this.buffer += data;
    // Process complete lines
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || ''; // Keep incomplete line in buffer
    for (const line of lines) {
      if (!line.trim()) continue;

      // Only try to parse lines that look like JSON (start with { or [)
      const trimmed = line.trim();
      if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
        // Non-JSON output from Aider - log it but don't try to parse
        if (trimmed.length > 0 && !trimmed.startsWith('Tokens:') && !trimmed.includes('│') && !trimmed.includes('█')) {
          console.log('[Aider Output]', trimmed.substring(0, 100));
        }
        continue;
      }

      try {
        const message = JSON.parse(line);
        console.log('[AiderBridge] Received JSON-RPC message, id:', message.id);

        // Handle notification
        if ('method' in message && !('id' in message)) {
          this.emit('notification', message);
          continue;
        }
        // Handle response
        const response = message;
        const pending = this.pendingRequests.get(response.id);
        if (pending) {
          this.pendingRequests.delete(response.id);
          if (response.error) {
            pending.reject(new Error(response.error.message));
          } else {
            pending.resolve(response.result);
          }
        } else {
          console.warn('[AiderBridge] Received response for unknown request id:', response.id);
        }
      } catch (error) {
        // Only log if it looked like JSON but failed to parse
        console.error('[AiderBridge] JSON parse error:', error.message);
        console.error('[AiderBridge]     Line preview:', line.substring(0, 80));
      }
    }
  }
  async sendRequest(method, params) {
    if (!this.process || !this.process.stdin) {
      console.error('[AiderBridge] ERROR: Process not started or stdin unavailable');
      throw new Error('Aider Bridge not started');
    }
    const id = ++this.requestId;
    const request = {
      jsonrpc: '2.0',
      method,
      params,
      id,
    };

    const startTime = Date.now();
    console.log(`[AiderBridge] >>> Request #${id}: ${method}`);
    if (params) {
      const paramPreview = JSON.stringify(params).substring(0, 200);
      console.log(`[AiderBridge]     Params: ${paramPreview}${paramPreview.length >= 200 ? '...' : ''}`);
    }

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: (result) => {
          const elapsed = Date.now() - startTime;
          console.log(`[AiderBridge] <<< Response #${id}: ${method} (${elapsed}ms)`);
          if (result && result.success !== undefined) {
            console.log(`[AiderBridge]     Success: ${result.success}`);
          }
          if (result && result.error) {
            console.log(`[AiderBridge]     Error: ${result.error}`);
          }
          if (result && result.modified_files) {
            console.log(`[AiderBridge]     Modified files: ${result.modified_files.length}`);
          }
          if (result && result.file_details) {
            console.log(`[AiderBridge]     File details: ${JSON.stringify(result.file_details)}`);
          }
          resolve(result);
        },
        reject: (error) => {
          const elapsed = Date.now() - startTime;
          console.error(`[AiderBridge] !!! Error #${id}: ${method} (${elapsed}ms) - ${error.message}`);
          reject(error);
        },
      });

      // Send request
      const requestStr = JSON.stringify(request) + '\n';
      console.log(`[AiderBridge]     Sending ${requestStr.length} bytes to stdin`);
      try {
        this.process.stdin.write(requestStr);
        console.log(`[AiderBridge]     Request sent, waiting for response...`);
      } catch (writeError) {
        console.error(`[AiderBridge]     WRITE ERROR: ${writeError.message}`);
        this.pendingRequests.delete(id);
        reject(writeError);
        return;
      }

      // Timeout after 120 seconds (increased from 60)
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          const elapsed = Date.now() - startTime;
          console.error(`[AiderBridge] !!! TIMEOUT #${id}: ${method} after ${elapsed}ms`);
          console.error(`[AiderBridge]     Process alive: ${this.process && !this.process.killed}`);
          console.error(`[AiderBridge]     Pending requests: ${this.pendingRequests.size}`);
          this.pendingRequests.delete(id);
          reject(new Error(`Request timeout: ${method} (after ${elapsed}ms)`));
        }
      }, 300000); // 5 minute timeout
    });
  }
  async initialize(repoPath, modelName = 'claude-opus-4-5-20251101') {
    return this.sendRequest('initialize', { repo_path: repoPath, model_name: modelName });
  }
  /**
   * Run a prompt through Aider
   */
  async runPrompt(message) {
    return this.sendRequest('run_prompt', { message });
  }
  /**
   * Run a prompt with streaming output
   * @param {string} message - The prompt to send
   * @param {function} onToken - Callback for each token received
   * @returns {Promise} Final result
   */
  async runPromptStreaming(message, onToken) {
    // Set up stream listener before sending request
    const streamHandler = (notification) => {
      if (notification.method === 'stream' && notification.params) {
        const { type, content } = notification.params;
        if (type === 'token' && content && onToken) {
          onToken(content);
        } else if (type === 'start') {
          console.log('[AiderBridge] Stream started');
        } else if (type === 'complete') {
          console.log('[AiderBridge] Stream completed');
        } else if (type === 'error') {
          console.error('[AiderBridge] Stream error:', content);
        }
      }
    };

    this.on('notification', streamHandler);

    try {
      const result = await this.sendRequest('run_prompt_streaming', { message });
      return result;
    } finally {
      this.removeListener('notification', streamHandler);
    }
  }

  /**
   * Add files to Aider's context
   */
  async addFiles(filePaths) {
    return this.sendRequest('add_files', { file_paths: filePaths });
  }
  /**
   * Remove files from Aider's context
   */
  async removeFiles(filePaths) {
    return this.sendRequest('remove_files', { file_paths: filePaths });
  }
  /**
   * Get the repository map
   */
  async getRepoMap() {
    return this.sendRequest('get_repo_map');
  }
  /**
   * Set auto-test command
   */
  async setTestCmd(command) {
    return this.sendRequest('set_test_cmd', { command });
  }
  /**
   * Set auto-lint command
   */
  async setLintCmd(command) {
    return this.sendRequest('set_lint_cmd', { command });
  }
  /**
   * Shutdown the Aider bridge
   */
  async shutdown() {
    if (!this.process) return;
    try {
      await this.sendRequest('shutdown');
    } catch (error) {
      console.error('[Aider Bridge] Error during shutdown:', error);
    }
    // Send exit signal
    if (this.process.stdin) {
      this.process.stdin.write('__EXIT__\n');
    }
    // Kill process if still running after 2 seconds
    setTimeout(() => {
      if (this.process && !this.process.killed) {
        this.process.kill();
      }
    }, 2000);
  }
  /**
   * Check if the process is running
   */
  isRunning() {
    return this.process !== null && !this.process.killed;
  }
}
exports.AiderBridgeClient = AiderBridgeClient;
