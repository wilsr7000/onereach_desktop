/**
 * Project Templates Module
 * 
 * Provides a template system for customizing the AI coding experience.
 * 
 * @example
 * ```typescript
 * import { TemplateManager, ProjectTemplate } from './templates';
 * 
 * // Create manager
 * const manager = new TemplateManager('/path/to/templates.json');
 * 
 * // List templates
 * const templates = manager.getTemplates({ category: 'frontend' });
 * 
 * // Apply a template
 * await manager.applyTemplate('react-typescript');
 * 
 * // Get Aider config from active template
 * const config = manager.getAiderConfig();
 * 
 * // Run a template command
 * const result = manager.runCommand('component', {
 *   name: 'UserProfile',
 *   description: 'Displays user info',
 * });
 * 
 * // Use the expanded prompt with Aider
 * await aider.prompt(result.expandedPrompt);
 * ```
 * 
 * @module templates
 */

// Types
export * from './types';

// Manager
export { TemplateManager, type TemplateManagerEvents } from './TemplateManager';

// Built-in templates
export {
  builtInTemplates,
  getBuiltInTemplate,
  getBuiltInTemplateIds,
  reactTypescriptTemplate,
  nodeApiTemplate,
  pythonFastApiTemplate,
} from './built-in';

// Re-export commonly used types
export type {
  ProjectTemplate,
  TemplateCommand,
  CommandInput,
  SelectionOption,
  ScaffoldConfig,
  ScaffoldFile,
  TemplateApplyResult,
  CommandRunResult,
  TemplateFilter,
  TemplateCategory,
} from './types';

// Import for factory
import { TemplateManager } from './TemplateManager';
import * as path from 'path';

/**
 * Create a TemplateManager with default store path
 * 
 * @param userDataPath - Path to user data directory (e.g., app.getPath('userData'))
 */
export function createTemplateManager(userDataPath: string): TemplateManager {
  const storePath = path.join(userDataPath, 'templates.json');
  return new TemplateManager(storePath);
}

// Default export
export default TemplateManager;

