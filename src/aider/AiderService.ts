/**
 * Aider Service - High-level API for AI pair programming
 * 
 * Provides a clean, callback-based interface on top of AiderClient.
 * Handles streaming, file change notifications, and status updates.
 */

import { AiderClient } from './AiderClient';
import {
  AiderConfig,
  AiderStatus,
  RunResult,
  FileChange,
  RepoMapEntry,
  RepoSymbol,
  PromptResult,
  FilesResult,
  RepoMapResult,
  PingResult,
  InstallationCheckResult,
} from './types';

/**
 * High-level Aider service with clean API
 * 
 * @example
 * ```typescript
 * const aider = new AiderService({
 *   repoPath: '/path/to/project',
 *   model: 'gpt-4',
 *   testCmd: 'npm test',
 * });
 * 
 * await aider.initialize();
 * 
 * aider.onStream((chunk) => console.log(chunk));
 * 
 * const result = await aider.prompt('Add a login form to App.tsx');
 * console.log(result.response);
 * console.log('Modified files:', result.fileChanges);
 * 
 * await aider.shutdown();
 * ```
 */
export class AiderService {
  private client: AiderClient;
  private config: AiderConfig;
  private streamCallbacks: Set<(chunk: string) => void> = new Set();
  private fileChangeCallbacks: Set<(change: FileChange) => void> = new Set();
  private statusCallbacks: Set<(status: AiderStatus) => void> = new Set();
  private errorCallbacks: Set<(error: Error) => void> = new Set();

  constructor(config: Partial<AiderConfig> & { repoPath: string }) {
    this.config = config as AiderConfig;
    this.client = new AiderClient(config);
    this.setupEventHandlers();
  }

  /**
   * Wire up event handlers from the client
   */
  private setupEventHandlers(): void {
    this.client.on('stream', (chunk) => {
      this.streamCallbacks.forEach((cb) => {
        try {
          cb(chunk);
        } catch (e) {
          console.error('[AiderService] Stream callback error:', e);
        }
      });
    });
    
    this.client.on('fileChanged', (change) => {
      this.fileChangeCallbacks.forEach((cb) => {
        try {
          cb(change as FileChange);
        } catch (e) {
          console.error('[AiderService] FileChange callback error:', e);
        }
      });
    });
    
    this.client.on('status', (status) => {
      this.statusCallbacks.forEach((cb) => {
        try {
          cb(status);
        } catch (e) {
          console.error('[AiderService] Status callback error:', e);
        }
      });
    });

    this.client.on('error', (error) => {
      this.errorCallbacks.forEach((cb) => {
        try {
          cb(error);
        } catch (e) {
          console.error('[AiderService] Error callback error:', e);
        }
      });
    });
  }

  /**
   * Initialize the Aider service
   * Starts the Python sidecar and initializes with the repository
   * 
   * @throws Error if aider-chat is not installed (with installation instructions)
   */
  async initialize(): Promise<void> {
    // Start the Python process
    await this.client.start();
    
    // Check if aider is properly installed
    const installCheck = await this.client.checkInstallation();
    if (!installCheck.aider_installed) {
      const instructions = installCheck.install_instructions;
      throw new AiderNotInstalledError(
        `Aider is not installed. ${installCheck.error || ''}`,
        instructions?.pip || 'pip install aider-chat',
        installCheck
      );
    }
    
    // Check for API keys
    if (installCheck.warning) {
      console.warn('[AiderService]', installCheck.warning);
    }
    
    // Initialize with repository
    const result = await this.client.initialize(
      this.config.repoPath,
      this.config.model
    );
    
    if (!result.success) {
      throw new Error(result.error || 'Failed to initialize Aider');
    }
    
    // Start health checks
    this.client.startHealthCheck();
  }

  /**
   * Send a prompt to Aider and get the result
   * @param message The prompt message
   * @returns Result including response and file changes
   */
  async prompt(message: string): Promise<RunResult> {
    const result = await this.client.runPrompt(message);
    return this.transformPromptResult(result);
  }

  /**
   * Send a prompt with token-by-token streaming
   * Use onStream() to receive tokens in real-time
   * 
   * @param message The prompt message
   * @returns Result including response and file changes
   */
  async promptStreaming(message: string): Promise<RunResult> {
    const result = await this.client.runPromptStreaming(message);
    return this.transformPromptResult(result);
  }

  /**
   * Health check - verify the Python process is responsive
   * @param timeout Optional timeout in ms
   */
  async ping(timeout?: number): Promise<PingResult> {
    return this.client.ping(timeout);
  }

  /**
   * Check if aider-chat is properly installed
   * Returns detailed installation status and instructions
   */
  async checkInstallation(): Promise<InstallationCheckResult> {
    return this.client.checkInstallation();
  }

  /**
   * Add files to the Aider context
   * @param paths Array of file paths (relative to repo root)
   */
  async addFiles(paths: string[]): Promise<string[]> {
    const result = await this.client.addFiles(paths);
    
    if (!result.success) {
      throw new Error(result.error || 'Failed to add files');
    }
    
    return result.files_in_context || [];
  }

  /**
   * Remove files from the Aider context
   * @param paths Array of file paths to remove
   */
  async removeFiles(paths: string[]): Promise<string[]> {
    const result = await this.client.removeFiles(paths);
    
    if (!result.success) {
      throw new Error(result.error || 'Failed to remove files');
    }
    
    return result.files_in_context || [];
  }

  /**
   * Get the repository map showing file structure and symbols
   * @returns Array of repo map entries
   */
  async getRepoMap(): Promise<RepoMapEntry[]> {
    const result = await this.client.getRepoMap();
    
    if (!result.success) {
      throw new Error(result.error || 'Failed to get repo map');
    }
    
    return this.parseRepoMap(result);
  }

  /**
   * Get files currently in context
   */
  async getFilesInContext(): Promise<string[]> {
    const result = await this.client.getRepoMap();
    return result.files || [];
  }

  /**
   * Set the test command
   * @param command Test command (e.g., 'npm test', 'pytest')
   */
  async setTestCommand(command: string): Promise<void> {
    await this.client.setTestCmd(command);
  }

  /**
   * Set the lint command
   * @param command Lint command (e.g., 'npm run lint', 'flake8')
   */
  async setLintCommand(command: string): Promise<void> {
    await this.client.setLintCmd(command);
  }

  /**
   * Register a callback for streaming responses
   * @param callback Function called with each chunk of streamed content
   * @returns Unsubscribe function
   */
  onStream(callback: (chunk: string) => void): () => void {
    this.streamCallbacks.add(callback);
    return () => this.streamCallbacks.delete(callback);
  }

  /**
   * Register a callback for file changes
   * @param callback Function called when a file is modified
   * @returns Unsubscribe function
   */
  onFileChange(callback: (change: FileChange) => void): () => void {
    this.fileChangeCallbacks.add(callback);
    return () => this.fileChangeCallbacks.delete(callback);
  }

  /**
   * Register a callback for status changes
   * @param callback Function called when status changes
   * @returns Unsubscribe function
   */
  onStatusChange(callback: (status: AiderStatus) => void): () => void {
    this.statusCallbacks.add(callback);
    return () => this.statusCallbacks.delete(callback);
  }

  /**
   * Register a callback for errors
   * @param callback Function called on error
   * @returns Unsubscribe function
   */
  onError(callback: (error: Error) => void): () => void {
    this.errorCallbacks.add(callback);
    return () => this.errorCallbacks.delete(callback);
  }

  /**
   * Get current status
   */
  getStatus(): AiderStatus {
    return this.client.getStatus();
  }

  /**
   * Check if service is ready
   */
  isReady(): boolean {
    return this.client.isReady();
  }

  /**
   * Get the underlying client (for advanced usage)
   */
  getClient(): AiderClient {
    return this.client;
  }

  /**
   * Gracefully shutdown the service
   */
  async shutdown(): Promise<void> {
    this.client.stopHealthCheck();
    await this.client.shutdown();
    this.streamCallbacks.clear();
    this.fileChangeCallbacks.clear();
    this.statusCallbacks.clear();
    this.errorCallbacks.clear();
  }

  /**
   * Get time since last successful health check ping
   * @returns Milliseconds since last ping, or -1 if never pinged
   */
  getTimeSinceLastPing(): number {
    return this.client.getTimeSinceLastPing();
  }

  /**
   * Transform raw prompt result to RunResult
   */
  private transformPromptResult(result: PromptResult): RunResult {
    const fileChanges: FileChange[] = (result.modified_files || []).map((path) => ({
      path,
      status: 'modified' as const,
    }));

    return {
      success: result.success,
      response: result.response || '',
      fileChanges,
      filesInContext: result.files_in_context || [],
      error: result.error,
    };
  }

  /**
   * Parse repo map result into structured entries
   */
  private parseRepoMap(result: RepoMapResult): RepoMapEntry[] {
    const files = result.files || [];
    const repoMapText = result.repo_map || '';
    
    const entries: RepoMapEntry[] = files.map((filePath) => {
      const symbols = this.extractSymbolsForFile(filePath, repoMapText);
      const extension = filePath.split('.').pop() || '';
      const language = this.getLanguageFromExtension(extension);
      
      return {
        path: filePath,
        language,
        symbols,
        inContext: true,
      };
    });
    
    return entries;
  }

  /**
   * Extract symbols for a file from repo map text
   */
  private extractSymbolsForFile(filePath: string, repoMapText: string): RepoSymbol[] {
    const symbols: RepoSymbol[] = [];
    
    const fileSection = repoMapText.split(filePath)[1]?.split('\n\n')[0] || '';
    const lines = fileSection.split('\n').filter((l) => l.trim());
    
    for (const line of lines) {
      const classMatch = line.match(/^\s*class\s+(\w+)/);
      const funcMatch = line.match(/^\s*(?:def|function|async\s+function)\s+(\w+)/);
      const methodMatch = line.match(/^\s+(\w+)\s*\(/);
      
      if (classMatch) {
        symbols.push({
          name: classMatch[1],
          type: 'class',
          line: 0,
        });
      } else if (funcMatch) {
        symbols.push({
          name: funcMatch[1],
          type: 'function',
          line: 0,
        });
      } else if (methodMatch && symbols.length > 0) {
        const lastClass = [...symbols].reverse().find((s) => s.type === 'class');
        symbols.push({
          name: methodMatch[1],
          type: 'method',
          line: 0,
          parent: lastClass?.name,
        });
      }
    }
    
    return symbols;
  }

  /**
   * Get language from file extension
   */
  private getLanguageFromExtension(ext: string): string {
    const languageMap: Record<string, string> = {
      ts: 'typescript',
      tsx: 'typescript',
      js: 'javascript',
      jsx: 'javascript',
      py: 'python',
      rb: 'ruby',
      go: 'go',
      rs: 'rust',
      java: 'java',
      kt: 'kotlin',
      swift: 'swift',
      c: 'c',
      cpp: 'cpp',
      h: 'c',
      hpp: 'cpp',
      cs: 'csharp',
      php: 'php',
      html: 'html',
      css: 'css',
      scss: 'scss',
      json: 'json',
      yaml: 'yaml',
      yml: 'yaml',
      md: 'markdown',
      sql: 'sql',
      sh: 'shell',
      bash: 'shell',
    };
    
    return languageMap[ext.toLowerCase()] || ext;
  }
}

/**
 * Error thrown when aider-chat is not installed
 * Includes installation instructions
 */
export class AiderNotInstalledError extends Error {
  public readonly installCommand: string;
  public readonly installationCheck: InstallationCheckResult;

  constructor(
    message: string,
    installCommand: string,
    installationCheck: InstallationCheckResult
  ) {
    super(message);
    this.name = 'AiderNotInstalledError';
    this.installCommand = installCommand;
    this.installationCheck = installationCheck;
  }

  /**
   * Get a user-friendly error message with instructions
   */
  getHelpfulMessage(): string {
    const lines = [
      'Aider AI pair programming is not installed.',
      '',
      'To install, run one of the following commands:',
      `  pip install aider-chat`,
      `  pip3 install aider-chat`,
      `  pipx install aider-chat`,
      '',
    ];

    if (!this.installationCheck.api_keys.openai && 
        !this.installationCheck.api_keys.anthropic) {
      lines.push(
        'You will also need to set an API key:',
        '  export OPENAI_API_KEY=your-key-here',
        '  # or',
        '  export ANTHROPIC_API_KEY=your-key-here',
        ''
      );
    }

    return lines.join('\n');
  }
}

export default AiderService;

