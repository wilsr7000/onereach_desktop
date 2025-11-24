/**
 * Aider Bridge TypeScript Client
 * Handles communication with the Python Aider sidecar process
 */

import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import {
  AiderConfig,
  AiderStatus,
  AiderEvents,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  InitializeResult,
  FilesResult,
  PromptResult,
  RepoMapResult,
} from './types';

// Default configuration
const DEFAULT_CONFIG: Partial<AiderConfig> = {
  model: 'gpt-4',
  timeout: 120000, // 2 minutes
  autoRestart: true,
  maxRestarts: 3,
};

// JSON-RPC error codes
const RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  NOT_INITIALIZED: -32000,
  ALREADY_INITIALIZED: -32001,
};

/**
 * TypeScript client for the Aider Python bridge
 * Handles process lifecycle, JSON-RPC communication, and event streaming
 */
export class AiderClient extends EventEmitter {
  private config: AiderConfig;
  private process: ChildProcess | null = null;
  private status: AiderStatus = 'disconnected';
  private requestId = 0;
  private pendingRequests = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }>();
  private buffer = '';
  private restartCount = 0;
  private isShuttingDown = false;
  private initialized = false;

  constructor(config: Partial<AiderConfig> & { repoPath: string }) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config } as AiderConfig;
    
    // Resolve server path
    if (!this.config.serverPath) {
      this.config.serverPath = this.findServerPath();
    }
    
    // Resolve Python path
    if (!this.config.pythonPath) {
      this.config.pythonPath = this.findPythonPath();
    }
  }

  /**
   * Find the server.py script path
   */
  private findServerPath(): string {
    const possiblePaths = [
      // Development path
      path.join(__dirname, '..', '..', 'aider_bridge', 'server.py'),
      // Packaged app path (asar)
      path.join(process.resourcesPath || '', 'aider_bridge', 'server.py'),
      // Relative to app root
      path.join(process.cwd(), 'aider_bridge', 'server.py'),
      // Electron app path
      path.join(__dirname, '..', '..', '..', 'aider_bridge', 'server.py'),
    ];

    for (const p of possiblePaths) {
      try {
        if (fs.existsSync(p)) {
          return p;
        }
      } catch {
        // Continue searching
      }
    }

    throw new Error('Could not find aider_bridge/server.py');
  }

  /**
   * Find Python executable
   */
  private findPythonPath(): string {
    const possiblePaths = [
      // Bundled Python (future)
      path.join(process.resourcesPath || '', 'python', 'bin', 'python3'),
      // System Python
      'python3',
      'python',
      '/usr/bin/python3',
      '/usr/local/bin/python3',
      // Homebrew Python
      '/opt/homebrew/bin/python3',
    ];

    // For now, default to system python3
    return 'python3';
  }

  /**
   * Get current status
   */
  getStatus(): AiderStatus {
    return this.status;
  }

  /**
   * Check if client is ready
   */
  isReady(): boolean {
    return this.status === 'ready' && this.initialized;
  }

  /**
   * Start the Python sidecar process
   */
  async start(): Promise<void> {
    if (this.process) {
      throw new Error('Process already running');
    }

    this.setStatus('starting');
    this.isShuttingDown = false;

    return new Promise((resolve, reject) => {
      try {
        // Spawn Python process
        const env = {
          ...process.env,
          ...this.config.env,
          PYTHONUNBUFFERED: '1',
        };

        this.process = spawn(this.config.pythonPath!, [this.config.serverPath!], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env,
          cwd: this.config.repoPath,
        });

        // Handle stdout (JSON-RPC responses)
        this.process.stdout?.on('data', (data: Buffer) => {
          this.handleStdout(data.toString());
        });

        // Handle stderr (logs/errors)
        this.process.stderr?.on('data', (data: Buffer) => {
          const message = data.toString().trim();
          if (message) {
            // Check for ready signal
            if (message.includes('AIDER_BRIDGE_READY')) {
              this.setStatus('ready');
              resolve();
            } else {
              console.error('[AiderClient stderr]', message);
            }
          }
        });

        // Handle process exit
        this.process.on('exit', (code, signal) => {
          this.handleExit(code, signal);
        });

        // Handle spawn errors
        this.process.on('error', (error) => {
          this.setStatus('error');
          this.emit('error', error);
          reject(error);
        });

        // Timeout for startup
        setTimeout(() => {
          if (this.status === 'starting') {
            reject(new Error('Timeout waiting for server to start'));
          }
        }, 10000);

      } catch (error) {
        this.setStatus('error');
        reject(error);
      }
    });
  }

  /**
   * Handle stdout data (JSON-RPC messages)
   */
  private handleStdout(data: string): void {
    this.buffer += data;
    
    // Process complete lines
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || ''; // Keep incomplete line in buffer
    
    for (const line of lines) {
      if (!line.trim()) continue;
      
      try {
        const message = JSON.parse(line);
        
        if ('id' in message && message.id !== null) {
          // Response to a request
          this.handleResponse(message as JsonRpcResponse);
        } else if ('method' in message) {
          // Notification (streaming, etc.)
          this.handleNotification(message as JsonRpcNotification);
        }
      } catch (error) {
        console.error('[AiderClient] Failed to parse message:', line, error);
      }
    }
  }

  /**
   * Handle JSON-RPC response
   */
  private handleResponse(response: JsonRpcResponse): void {
    const pending = this.pendingRequests.get(response.id as number);
    if (!pending) {
      console.warn('[AiderClient] Received response for unknown request:', response.id);
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(response.id as number);

    if (response.error) {
      pending.reject(new Error(response.error.message));
    } else {
      pending.resolve(response.result);
    }
  }

  /**
   * Handle JSON-RPC notification
   */
  private handleNotification(notification: JsonRpcNotification): void {
    switch (notification.method) {
      case 'stream':
        // Streaming content
        const content = (notification.params as { content?: string })?.content;
        if (content) {
          this.emit('stream', content);
        }
        break;
        
      case 'file_changed':
        // File modification notification
        this.emit('fileChanged', notification.params);
        break;
        
      case 'status':
        // Status update
        const status = (notification.params as { status?: string })?.status;
        if (status) {
          console.log('[AiderClient] Status:', status);
        }
        break;
        
      default:
        console.log('[AiderClient] Unknown notification:', notification.method);
    }
  }

  /**
   * Handle process exit
   */
  private handleExit(code: number | null, signal: string | null): void {
    this.process = null;
    
    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Process exited'));
    }
    this.pendingRequests.clear();

    this.emit('exit', { code, signal });

    // Auto-restart if enabled and not shutting down
    if (
      this.config.autoRestart &&
      !this.isShuttingDown &&
      this.restartCount < (this.config.maxRestarts || 3)
    ) {
      this.restartCount++;
      this.setStatus('restarting');
      this.emit('restart', {
        attempt: this.restartCount,
        maxAttempts: this.config.maxRestarts || 3,
      });

      // Delay before restart
      setTimeout(() => {
        this.start().catch((error) => {
          console.error('[AiderClient] Restart failed:', error);
          this.setStatus('error');
        });
      }, 1000 * this.restartCount); // Exponential backoff
    } else {
      this.setStatus('disconnected');
    }
  }

  /**
   * Set status and emit event
   */
  private setStatus(status: AiderStatus): void {
    this.status = status;
    this.emit('status', status);
    
    if (status === 'ready') {
      this.emit('ready');
    }
  }

  /**
   * Send JSON-RPC request
   */
  private async sendRequest<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (!this.process || !this.process.stdin) {
      throw new Error('Process not running');
    }

    const id = ++this.requestId;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, this.config.timeout);

      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      });

      const message = JSON.stringify(request) + '\n';
      this.process!.stdin!.write(message);
    });
  }

  /**
   * Initialize Aider with repository
   */
  async initialize(repoPath?: string, modelName?: string): Promise<InitializeResult> {
    if (this.status !== 'ready') {
      throw new Error('Client not ready. Call start() first.');
    }

    this.setStatus('busy');
    
    try {
      const result = await this.sendRequest<InitializeResult>('initialize', {
        repo_path: repoPath || this.config.repoPath,
        model_name: modelName || this.config.model,
      });

      if (result.success) {
        this.initialized = true;
        
        // Set test/lint commands if configured
        if (this.config.testCmd) {
          await this.setTestCmd(this.config.testCmd);
        }
        if (this.config.lintCmd) {
          await this.setLintCmd(this.config.lintCmd);
        }
      }

      this.setStatus('ready');
      return result;
    } catch (error) {
      this.setStatus('error');
      throw error;
    }
  }

  /**
   * Run a prompt through Aider
   */
  async runPrompt(message: string): Promise<PromptResult> {
    if (!this.initialized) {
      throw new Error('Not initialized. Call initialize() first.');
    }

    this.setStatus('busy');
    
    try {
      const result = await this.sendRequest<PromptResult>('run_prompt', { message });
      this.setStatus('ready');
      return result;
    } catch (error) {
      this.setStatus('ready');
      throw error;
    }
  }

  /**
   * Add files to context
   */
  async addFiles(filePaths: string[]): Promise<FilesResult> {
    if (!this.initialized) {
      throw new Error('Not initialized. Call initialize() first.');
    }

    return this.sendRequest<FilesResult>('add_files', { file_paths: filePaths });
  }

  /**
   * Remove files from context
   */
  async removeFiles(filePaths: string[]): Promise<FilesResult> {
    if (!this.initialized) {
      throw new Error('Not initialized. Call initialize() first.');
    }

    return this.sendRequest<FilesResult>('remove_files', { file_paths: filePaths });
  }

  /**
   * Get repository map
   */
  async getRepoMap(): Promise<RepoMapResult> {
    if (!this.initialized) {
      throw new Error('Not initialized. Call initialize() first.');
    }

    return this.sendRequest<RepoMapResult>('get_repo_map');
  }

  /**
   * Set test command
   */
  async setTestCmd(command: string): Promise<{ success: boolean }> {
    return this.sendRequest('set_test_cmd', { command });
  }

  /**
   * Set lint command
   */
  async setLintCmd(command: string): Promise<{ success: boolean }> {
    return this.sendRequest('set_lint_cmd', { command });
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    this.setStatus('shutdown');

    if (this.process) {
      try {
        // Send shutdown command
        await this.sendRequest('shutdown');
      } catch {
        // Ignore errors during shutdown
      }

      // Give process time to exit gracefully
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          // Force kill if still running
          if (this.process) {
            this.process.kill('SIGKILL');
          }
          resolve();
        }, 5000);

        if (this.process) {
          this.process.once('exit', () => {
            clearTimeout(timeout);
            resolve();
          });
        } else {
          clearTimeout(timeout);
          resolve();
        }
      });
    }

    this.process = null;
    this.initialized = false;
    this.setStatus('disconnected');
  }

  /**
   * Force kill the process
   */
  kill(): void {
    this.isShuttingDown = true;
    if (this.process) {
      this.process.kill('SIGKILL');
    }
    this.process = null;
    this.initialized = false;
    this.setStatus('disconnected');
  }
}

// Type augmentation for EventEmitter
declare interface AiderClient {
  on<K extends keyof AiderEvents>(event: K, listener: (arg: AiderEvents[K]) => void): this;
  emit<K extends keyof AiderEvents>(event: K, arg?: AiderEvents[K]): boolean;
  off<K extends keyof AiderEvents>(event: K, listener: (arg: AiderEvents[K]) => void): this;
  once<K extends keyof AiderEvents>(event: K, listener: (arg: AiderEvents[K]) => void): this;
}

export default AiderClient;

