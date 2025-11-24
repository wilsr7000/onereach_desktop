/**
 * Aider Bridge - TypeScript client for AI pair programming
 * 
 * This module provides a clean API for integrating Aider into Electron apps.
 * 
 * @example
 * ```typescript
 * import { AiderService, createAiderService } from './aider';
 * 
 * // Using the class directly
 * const aider = new AiderService({
 *   repoPath: '/path/to/project',
 *   model: 'gpt-4',
 * });
 * 
 * // Or using the factory function
 * const aider = createAiderService({
 *   repoPath: '/path/to/project',
 *   model: 'claude-3-opus-20240229',
 *   testCmd: 'npm test',
 *   lintCmd: 'npm run lint',
 * });
 * 
 * await aider.initialize();
 * 
 * // Stream responses
 * aider.onStream((chunk) => process.stdout.write(chunk));
 * 
 * // Send prompts
 * const result = await aider.prompt('Add authentication to the app');
 * 
 * // Cleanup
 * await aider.shutdown();
 * ```
 * 
 * @module aider
 */

// Type exports
export * from './types';

// Class exports
export { AiderClient } from './AiderClient';
export { AiderService } from './AiderService';

// Re-export commonly used types for convenience
export type {
  AiderConfig,
  AiderStatus,
  AiderEvents,
  RunResult,
  FileChange,
  RepoMapEntry,
  RepoSymbol,
  TestResult,
  LintResult,
  TokenUsage,
} from './types';

// Import for factory function
import { AiderService } from './AiderService';
import { AiderConfig } from './types';

/**
 * Create a new Aider service instance
 * 
 * @param config Configuration options
 * @returns Configured AiderService instance
 * 
 * @example
 * ```typescript
 * const aider = createAiderService({
 *   repoPath: process.cwd(),
 *   model: 'gpt-4',
 *   timeout: 60000,
 * });
 * ```
 */
export function createAiderService(
  config: Partial<AiderConfig> & { repoPath: string }
): AiderService {
  return new AiderService(config);
}

// Default export
export default AiderService;
