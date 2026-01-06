/**
 * Aider Bridge Client - TypeScript/Electron side
 * Communicates with Python sidecar via JSON-RPC over stdio
 */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as path from 'path';

interface JSONRPCRequest {
  jsonrpc: '2.0';
  method: string;
  params?: any;
  id?: number | string;
}

interface JSONRPCResponse {
  jsonrpc: '2.0';
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
  id: number | string;
}

interface JSONRPCNotification {
  jsonrpc: '2.0';
  method: string;
  params?: any;
}

interface AiderInitResult {
  success: boolean;
  repo_path?: string;
  model?: string;
  files_in_context?: string[];
  error?: string;
}

interface AiderPromptResult {
  success: boolean;
  response?: string;
  modified_files?: string[];
  files_in_context?: string[];
  error?: string;
}

export class AiderBridgeClient extends EventEmitter {
  private process: ChildProcess | null = null;
  private requestId = 0;
  private pendingRequests: Map<number, {
    resolve: (value: any) => void;
    reject: (reason: any) => void;
  }> = new Map();
  private buffer = '';

  constructor(private pythonPath: string = 'python3') {
    super();
  }

  /**
   * Start the Python sidecar process
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const scriptPath = path.join(__dirname, '../aider_bridge/server.py');

      // Spawn Python process
      this.process = spawn(this.pythonPath, [scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      if (!this.process.stdout || !this.process.stdin || !this.process.stderr) {
        reject(new Error('Failed to create process stdio'));
        return;
      }

      // Handle stdout (responses)
      this.process.stdout.on('data', (data) => {
        this.handleData(data.toString());
      });

      // Handle stderr (logs)
      this.process.stderr.on('data', (data) => {
        console.error('[Aider Bridge stderr]:', data.toString());
        this.emit('error', new Error(data.toString()));
      });

      // Handle process exit
      this.process.on('exit', (code) => {
        console.log(`[Aider Bridge] Process exited with code ${code}`);
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
      
      const readyHandler = (notification: JSONRPCNotification) => {
        if (notification.method === 'ready') {
          startupResolved = true;
          this.removeListener('notification', readyHandler);
          resolve();
        }
      };
      this.on('notification', readyHandler);

      // Timeout after 10 seconds - only reject if startup hasn't resolved
      setTimeout(() => {
        if (!startupResolved) {
          this.removeListener('notification', readyHandler);
          reject(new Error('Timeout waiting for Aider Bridge to start'));
        }
      }, 10000);
    });
  }

  /**
   * Handle incoming data from Python process
   */
  private handleData(data: string): void {
    this.buffer += data;

    // Process complete lines
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || ''; // Keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const message = JSON.parse(line);

        // Handle notification
        if ('method' in message && !('id' in message)) {
          this.emit('notification', message as JSONRPCNotification);
          continue;
        }

        // Handle response
        const response = message as JSONRPCResponse;
        const pending = this.pendingRequests.get(response.id as number);

        if (pending) {
          this.pendingRequests.delete(response.id as number);

          if (response.error) {
            pending.reject(new Error(response.error.message));
          } else {
            pending.resolve(response.result);
          }
        }
      } catch (error) {
        console.error('[Aider Bridge] Failed to parse message:', line, error);
      }
    }
  }

  /**
   * Send a JSON-RPC request to Python process
   */
  private async sendRequest(method: string, params?: any): Promise<any> {
    if (!this.process || !this.process.stdin) {
      throw new Error('Aider Bridge not started');
    }

    const id = ++this.requestId;
    const request: JSONRPCRequest = {
      jsonrpc: '2.0',
      method,
      params,
      id
    };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });

      // Send request
      this.process!.stdin!.write(JSON.stringify(request) + '\n');

      // Timeout after 60 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request timeout: ${method}`));
        }
      }, 60000);
    });
  }

  /**
   * Initialize Aider with a repository
   */
  async initialize(repoPath: string, modelName: string = 'claude-opus-4-5-20251101'): Promise<AiderInitResult> {
    return this.sendRequest('initialize', { repo_path: repoPath, model_name: modelName });
  }

  /**
   * Run a prompt through Aider
   */
  async runPrompt(message: string): Promise<AiderPromptResult> {
    return this.sendRequest('run_prompt', { message });
  }

  /**
   * Add files to Aider's context
   */
  async addFiles(filePaths: string[]): Promise<any> {
    return this.sendRequest('add_files', { file_paths: filePaths });
  }

  /**
   * Remove files from Aider's context
   */
  async removeFiles(filePaths: string[]): Promise<any> {
    return this.sendRequest('remove_files', { file_paths: filePaths });
  }

  /**
   * Get the repository map
   */
  async getRepoMap(): Promise<any> {
    return this.sendRequest('get_repo_map');
  }

  /**
   * Set auto-test command
   */
  async setTestCmd(command: string): Promise<any> {
    return this.sendRequest('set_test_cmd', { command });
  }

  /**
   * Set auto-lint command
   */
  async setLintCmd(command: string): Promise<any> {
    return this.sendRequest('set_lint_cmd', { command });
  }

  /**
   * Shutdown the Aider bridge
   */
  async shutdown(): Promise<void> {
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
  isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }
}

