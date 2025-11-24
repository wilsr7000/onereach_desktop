/**
 * Aider Service - Clean API for AI pair programming
 * 
 * @example
 * ```typescript
 * import { AiderService } from './aider';
 * 
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
} from './types';

// Re-export types
export * from './types';
export { AiderClient } from './AiderClient';

/**
 * High-level Aider service with clean API
 */
export class AiderService {
  private client: AiderClient;
  private config: AiderConfig;
  private streamCallbacks: Set<(chunk: string) => void> = new Set();
  private fileChangeCallbacks: Set<(change: FileChange) => void> = new Set();
  private statusCallbacks: Set<(status: AiderStatus) => void> = new Set();

  constructor(config: Partial<AiderConfig> & { repoPath: string }) {
    this.config = config as AiderConfig;
    this.client = new AiderClient(config);
    
    // Wire up event handlers
    this.client.on('stream', (chunk) => {
      this.streamCallbacks.forEach((cb) => cb(chunk));
    });
    
    this.client.on('fileChanged', (change) => {
      this.fileChangeCallbacks.forEach((cb) => cb(change as FileChange));
    });
    
    this.client.on('status', (status) => {
      this.statusCallbacks.forEach((cb) => cb(status));
    });
  }

  /**
   * Initialize the Aider service
   * Starts the Python sidecar and initializes with the repository
   */
  async initialize(): Promise<void> {
    // Start the Python process
    await this.client.start();
    
    // Initialize with repository
    const result = await this.client.initialize(
      this.config.repoPath,
      this.config.model
    );
    
    if (!result.success) {
      throw new Error(result.error || 'Failed to initialize Aider');
    }
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
   * Add files to the Aider context
   * @param paths Array of file paths (relative to repo root)
   */
  async addFiles(paths: string[]): Promise<void> {
    const result = await this.client.addFiles(paths);
    
    if (!result.success) {
      throw new Error(result.error || 'Failed to add files');
    }
  }

  /**
   * Remove files from the Aider context
   * @param paths Array of file paths to remove
   */
  async removeFiles(paths: string[]): Promise<void> {
    const result = await this.client.removeFiles(paths);
    
    if (!result.success) {
      throw new Error(result.error || 'Failed to remove files');
    }
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
   * Gracefully shutdown the service
   */
  async shutdown(): Promise<void> {
    await this.client.shutdown();
    this.streamCallbacks.clear();
    this.fileChangeCallbacks.clear();
    this.statusCallbacks.clear();
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
    
    // Parse the repo map text to extract symbols
    // This is a simplified parser - Aider's actual format may vary
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
    
    // Find the section for this file in the repo map
    const fileSection = repoMapText.split(filePath)[1]?.split('\n\n')[0] || '';
    const lines = fileSection.split('\n').filter((l) => l.trim());
    
    for (const line of lines) {
      // Parse symbol definitions (simplified)
      const classMatch = line.match(/^\s*class\s+(\w+)/);
      const funcMatch = line.match(/^\s*(?:def|function|async\s+function)\s+(\w+)/);
      const methodMatch = line.match(/^\s+(\w+)\s*\(/);
      
      if (classMatch) {
        symbols.push({
          name: classMatch[1],
          type: 'class',
          line: 0, // Line numbers not available in basic repo map
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
 * Create a new Aider service instance
 * Convenience factory function
 */
export function createAiderService(
  config: Partial<AiderConfig> & { repoPath: string }
): AiderService {
  return new AiderService(config);
}

// Default export
export default AiderService;

