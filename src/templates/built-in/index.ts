/**
 * Built-in Project Templates
 * 
 * Export all built-in templates for registration with the TemplateManager
 */

import { ProjectTemplate } from '../types';
import { reactTypescriptTemplate } from './react-typescript';
import { nodeApiTemplate } from './node-api';
import { pythonFastApiTemplate } from './python-fastapi';

/**
 * All built-in templates
 */
export const builtInTemplates: ProjectTemplate[] = [
  reactTypescriptTemplate,
  nodeApiTemplate,
  pythonFastApiTemplate,
];

/**
 * Get a built-in template by ID
 */
export function getBuiltInTemplate(id: string): ProjectTemplate | undefined {
  return builtInTemplates.find(t => t.id === id);
}

/**
 * Get all built-in template IDs
 */
export function getBuiltInTemplateIds(): string[] {
  return builtInTemplates.map(t => t.id);
}

// Individual exports
export { reactTypescriptTemplate } from './react-typescript';
export { nodeApiTemplate } from './node-api';
export { pythonFastApiTemplate } from './python-fastapi';

