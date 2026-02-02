/**
 * Project Templates Type Definitions
 * 
 * Templates customize the AI coding experience with:
 * - System prompts and coding conventions
 * - Auto-included files and ignore patterns
 * - Quality gates (test/lint commands)
 * - Custom slash commands
 * - Project scaffolding
 */

/**
 * Main project template definition
 */
export interface ProjectTemplate {
  /** Unique identifier for the template */
  id: string;
  
  /** Human-readable name */
  name: string;
  
  /** Description of what this template is for */
  description: string;
  
  /** Icon identifier (emoji or icon name) */
  icon?: string;
  
  /** Template category for organization */
  category?: TemplateCategory;
  
  /** Tags for searchability */
  tags?: string[];
  
  /** Template version */
  version?: string;
  
  /** Author information */
  author?: string;
  
  // ─────────────────────────────────────────────────────────────
  // AI Behavior Configuration
  // ─────────────────────────────────────────────────────────────
  
  /** System prompt defining coding conventions and AI behavior */
  systemPrompt: string;
  
  /** Preferred AI model for this template */
  model: string;
  
  /** Temperature setting (0-1, lower = more deterministic) */
  temperature?: number;
  
  // ─────────────────────────────────────────────────────────────
  // Context Management
  // ─────────────────────────────────────────────────────────────
  
  /** Glob patterns for files to auto-include in context */
  autoIncludePatterns: string[];
  
  /** Glob patterns for files to always ignore */
  ignorePatterns: string[];
  
  /** Maximum number of files to auto-include */
  maxAutoIncludeFiles?: number;
  
  /** File extensions this template primarily works with */
  primaryExtensions?: string[];
  
  // ─────────────────────────────────────────────────────────────
  // Quality Gates
  // ─────────────────────────────────────────────────────────────
  
  /** Command to run tests */
  testCommand?: string;
  
  /** Command to run linter */
  lintCommand?: string;
  
  /** Command to run type checker */
  typeCheckCommand?: string;
  
  /** Command to format code */
  formatCommand?: string;
  
  /** Run tests automatically after changes */
  autoTest?: boolean;
  
  /** Run linter automatically after changes */
  autoLint?: boolean;
  
  // ─────────────────────────────────────────────────────────────
  // Custom Commands
  // ─────────────────────────────────────────────────────────────
  
  /** Custom slash commands specific to this template */
  commands: TemplateCommand[];
  
  // ─────────────────────────────────────────────────────────────
  // Project Scaffolding
  // ─────────────────────────────────────────────────────────────
  
  /** Configuration for creating new projects */
  scaffold?: ScaffoldConfig;
  
  // ─────────────────────────────────────────────────────────────
  // Metadata
  // ─────────────────────────────────────────────────────────────
  
  /** Whether this is a built-in template */
  builtIn?: boolean;
  
  /** Whether user has customized this template */
  customized?: boolean;
  
  /** Timestamp when template was created */
  createdAt?: string;
  
  /** Timestamp when template was last modified */
  updatedAt?: string;
}

/**
 * Template categories for organization
 */
export type TemplateCategory = 
  | 'frontend'
  | 'backend'
  | 'fullstack'
  | 'mobile'
  | 'cli'
  | 'library'
  | 'data'
  | 'devops'
  | 'other';

/**
 * Custom command that users can invoke
 */
export interface TemplateCommand {
  /** Command name (e.g., "component") - used as /component */
  name: string;
  
  /** Human-readable description */
  description: string;
  
  /** The prompt template sent to Aider */
  prompt: string;
  
  /** Required inputs from the user */
  requiredInputs: CommandInput[];
  
  /** Optional inputs */
  optionalInputs?: CommandInput[];
  
  /** Files to auto-add to context when running this command */
  contextFiles?: string[];
  
  /** Example usage */
  example?: string;
  
  /** Keyboard shortcut */
  shortcut?: string;
}

/**
 * Input definition for a command
 */
export interface CommandInput {
  /** Input name (used in prompt template as {{name}}) */
  name: string;
  
  /** Human-readable description */
  description: string;
  
  /** Input type */
  type: 'string' | 'file' | 'selection' | 'boolean' | 'number';
  
  /** For selection type: available options */
  options?: SelectionOption[];
  
  /** Default value */
  defaultValue?: string | boolean | number;
  
  /** Placeholder text */
  placeholder?: string;
  
  /** Validation pattern (regex) */
  validation?: string;
  
  /** Whether this input is required */
  required?: boolean;
}

/**
 * Option for selection-type inputs
 */
export interface SelectionOption {
  /** Display label */
  label: string;
  
  /** Actual value */
  value: string;
  
  /** Description of this option */
  description?: string;
}

/**
 * Configuration for project scaffolding
 */
export interface ScaffoldConfig {
  /** Files to create */
  files: ScaffoldFile[];
  
  /** Directories to create */
  directories?: string[];
  
  /** Commands to run after creating files */
  postCreateCommands?: string[];
  
  /** Variables available in templates */
  variables?: ScaffoldVariable[];
  
  /** Dependencies to install */
  dependencies?: {
    npm?: string[];
    pip?: string[];
    other?: { command: string; packages: string[] }[];
  };
}

/**
 * File to create during scaffolding
 */
export interface ScaffoldFile {
  /** Path relative to project root (can include {{variables}}) */
  path: string;
  
  /** File content (can include {{variables}}) */
  content: string;
  
  /** Whether to overwrite if file exists */
  overwrite?: boolean;
  
  /** Condition for creating this file */
  condition?: string;
}

/**
 * Variable for scaffold templates
 */
export interface ScaffoldVariable {
  /** Variable name (used as {{name}}) */
  name: string;
  
  /** Description */
  description: string;
  
  /** Default value */
  defaultValue?: string;
  
  /** How to get the value */
  source: 'prompt' | 'env' | 'computed' | 'config';
  
  /** For computed: the computation expression */
  compute?: string;
}

/**
 * Result of applying a template
 */
export interface TemplateApplyResult {
  success: boolean;
  template: ProjectTemplate;
  filesCreated?: string[];
  commandsRun?: string[];
  errors?: string[];
}

/**
 * Result of running a template command
 */
export interface CommandRunResult {
  success: boolean;
  command: TemplateCommand;
  inputs: Record<string, unknown>;
  expandedPrompt: string;
  aiderResponse?: string;
  filesModified?: string[];
  error?: string;
}

/**
 * Template storage format
 */
export interface TemplateStore {
  version: string;
  templates: ProjectTemplate[];
  activeTemplateId?: string;
  lastUpdated: string;
}

/**
 * Template search/filter options
 */
export interface TemplateFilter {
  category?: TemplateCategory;
  tags?: string[];
  search?: string;
  builtInOnly?: boolean;
  customOnly?: boolean;
}

