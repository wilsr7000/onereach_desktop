/**
 * Template Manager
 * 
 * Manages project templates including:
 * - Loading and saving templates
 * - Applying templates to projects
 * - Running template commands
 * - Scaffolding new projects
 */

import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { glob } from 'glob';
import {
  ProjectTemplate,
  TemplateCommand,
  CommandInput,
  ScaffoldConfig,
  TemplateApplyResult,
  CommandRunResult,
  TemplateStore,
  TemplateFilter,
  TemplateCategory,
} from './types';
import { builtInTemplates } from './built-in';

// Default store version
const STORE_VERSION = '1.0.0';

/**
 * Events emitted by TemplateManager
 */
export interface TemplateManagerEvents {
  templateApplied: TemplateApplyResult;
  commandRun: CommandRunResult;
  scaffoldComplete: { template: ProjectTemplate; projectPath: string };
  error: Error;
}

/**
 * Manages project templates
 */
export class TemplateManager extends EventEmitter {
  private templates: Map<string, ProjectTemplate> = new Map();
  private activeTemplateId: string | null = null;
  private storePath: string;
  private projectPath: string | null = null;

  constructor(storePath: string) {
    super();
    this.storePath = storePath;
    this.loadBuiltInTemplates();
    this.loadUserTemplates();
  }

  /**
   * Load built-in templates
   */
  private loadBuiltInTemplates(): void {
    for (const template of builtInTemplates) {
      this.templates.set(template.id, { ...template, builtIn: true });
    }
    console.log(`[TemplateManager] Loaded ${builtInTemplates.length} built-in templates`);
  }

  /**
   * Load user-defined templates from store
   */
  private loadUserTemplates(): void {
    try {
      if (fs.existsSync(this.storePath)) {
        const data = fs.readFileSync(this.storePath, 'utf-8');
        const store: TemplateStore = JSON.parse(data);
        
        for (const template of store.templates) {
          if (!template.builtIn) {
            this.templates.set(template.id, template);
          }
        }
        
        this.activeTemplateId = store.activeTemplateId || null;
        console.log(`[TemplateManager] Loaded ${store.templates.length} user templates`);
      }
    } catch (error) {
      console.error('[TemplateManager] Failed to load user templates:', error);
    }
  }

  /**
   * Save templates to store
   */
  private saveTemplates(): void {
    try {
      const userTemplates = Array.from(this.templates.values())
        .filter(t => !t.builtIn || t.customized);
      
      const store: TemplateStore = {
        version: STORE_VERSION,
        templates: userTemplates,
        activeTemplateId: this.activeTemplateId || undefined,
        lastUpdated: new Date().toISOString(),
      };
      
      const dir = path.dirname(this.storePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      fs.writeFileSync(this.storePath, JSON.stringify(store, null, 2));
    } catch (error) {
      console.error('[TemplateManager] Failed to save templates:', error);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Template CRUD
  // ─────────────────────────────────────────────────────────────

  /**
   * Get all templates
   */
  getAllTemplates(): ProjectTemplate[] {
    return Array.from(this.templates.values());
  }

  /**
   * Get templates matching filter
   */
  getTemplates(filter?: TemplateFilter): ProjectTemplate[] {
    let templates = this.getAllTemplates();
    
    if (filter) {
      if (filter.category) {
        templates = templates.filter(t => t.category === filter.category);
      }
      if (filter.tags && filter.tags.length > 0) {
        templates = templates.filter(t => 
          filter.tags!.some(tag => t.tags?.includes(tag))
        );
      }
      if (filter.search) {
        const search = filter.search.toLowerCase();
        templates = templates.filter(t =>
          t.name.toLowerCase().includes(search) ||
          t.description.toLowerCase().includes(search) ||
          t.tags?.some(tag => tag.toLowerCase().includes(search))
        );
      }
      if (filter.builtInOnly) {
        templates = templates.filter(t => t.builtIn);
      }
      if (filter.customOnly) {
        templates = templates.filter(t => !t.builtIn || t.customized);
      }
    }
    
    return templates;
  }

  /**
   * Get template by ID
   */
  getTemplate(id: string): ProjectTemplate | undefined {
    return this.templates.get(id);
  }

  /**
   * Add a new template
   */
  addTemplate(template: ProjectTemplate): void {
    if (this.templates.has(template.id)) {
      throw new Error(`Template with ID "${template.id}" already exists`);
    }
    
    template.createdAt = new Date().toISOString();
    template.updatedAt = template.createdAt;
    this.templates.set(template.id, template);
    this.saveTemplates();
  }

  /**
   * Update an existing template
   */
  updateTemplate(id: string, updates: Partial<ProjectTemplate>): void {
    const template = this.templates.get(id);
    if (!template) {
      throw new Error(`Template "${id}" not found`);
    }
    
    const updated = {
      ...template,
      ...updates,
      id: template.id, // Don't allow ID change
      builtIn: template.builtIn,
      customized: template.builtIn ? true : template.customized,
      updatedAt: new Date().toISOString(),
    };
    
    this.templates.set(id, updated);
    this.saveTemplates();
  }

  /**
   * Delete a template
   */
  deleteTemplate(id: string): void {
    const template = this.templates.get(id);
    if (!template) {
      throw new Error(`Template "${id}" not found`);
    }
    
    if (template.builtIn && !template.customized) {
      throw new Error('Cannot delete built-in templates');
    }
    
    this.templates.delete(id);
    
    if (this.activeTemplateId === id) {
      this.activeTemplateId = null;
    }
    
    this.saveTemplates();
  }

  /**
   * Reset a customized built-in template to defaults
   */
  resetTemplate(id: string): void {
    const builtIn = builtInTemplates.find(t => t.id === id);
    if (!builtIn) {
      throw new Error(`No built-in template with ID "${id}"`);
    }
    
    this.templates.set(id, { ...builtIn, builtIn: true });
    this.saveTemplates();
  }

  /**
   * Duplicate a template
   */
  duplicateTemplate(id: string, newId: string, newName: string): ProjectTemplate {
    const template = this.templates.get(id);
    if (!template) {
      throw new Error(`Template "${id}" not found`);
    }
    
    const duplicate: ProjectTemplate = {
      ...template,
      id: newId,
      name: newName,
      builtIn: false,
      customized: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    
    this.templates.set(newId, duplicate);
    this.saveTemplates();
    
    return duplicate;
  }

  // ─────────────────────────────────────────────────────────────
  // Active Template
  // ─────────────────────────────────────────────────────────────

  /**
   * Get the active template
   */
  getActiveTemplate(): ProjectTemplate | null {
    if (!this.activeTemplateId) return null;
    return this.templates.get(this.activeTemplateId) || null;
  }

  /**
   * Set the active template
   */
  setActiveTemplate(id: string | null): void {
    if (id && !this.templates.has(id)) {
      throw new Error(`Template "${id}" not found`);
    }
    this.activeTemplateId = id;
    this.saveTemplates();
  }

  /**
   * Set the current project path
   */
  setProjectPath(projectPath: string): void {
    this.projectPath = projectPath;
  }

  // ─────────────────────────────────────────────────────────────
  // Template Application
  // ─────────────────────────────────────────────────────────────

  /**
   * Apply a template to the current project
   * Returns configuration for Aider
   */
  async applyTemplate(templateId: string): Promise<TemplateApplyResult> {
    const template = this.templates.get(templateId);
    if (!template) {
      return {
        success: false,
        template: {} as ProjectTemplate,
        errors: [`Template "${templateId}" not found`],
      };
    }

    try {
      this.setActiveTemplate(templateId);
      
      const result: TemplateApplyResult = {
        success: true,
        template,
        filesCreated: [],
        commandsRun: [],
        errors: [],
      };

      this.emit('templateApplied', result);
      return result;
    } catch (error) {
      const result: TemplateApplyResult = {
        success: false,
        template,
        errors: [(error as Error).message],
      };
      this.emit('error', error as Error);
      return result;
    }
  }

  /**
   * Get Aider configuration from active template
   */
  getAiderConfig(): {
    systemPrompt: string;
    model: string;
    testCommand?: string;
    lintCommand?: string;
    autoIncludeFiles: string[];
    ignorePatterns: string[];
  } | null {
    const template = this.getActiveTemplate();
    if (!template) return null;

    return {
      systemPrompt: template.systemPrompt,
      model: template.model,
      testCommand: template.testCommand,
      lintCommand: template.lintCommand,
      autoIncludeFiles: template.autoIncludePatterns,
      ignorePatterns: template.ignorePatterns,
    };
  }

  /**
   * Get files to auto-include based on template patterns
   */
  async getAutoIncludeFiles(): Promise<string[]> {
    const template = this.getActiveTemplate();
    if (!template || !this.projectPath) return [];

    const files: string[] = [];
    const maxFiles = template.maxAutoIncludeFiles || 10;

    for (const pattern of template.autoIncludePatterns) {
      try {
        const matches = await glob(pattern, {
          cwd: this.projectPath,
          ignore: template.ignorePatterns,
          nodir: true,
        });
        
        for (const match of matches) {
          if (files.length >= maxFiles) break;
          if (!files.includes(match)) {
            files.push(match);
          }
        }
      } catch (error) {
        console.error(`[TemplateManager] Glob error for pattern "${pattern}":`, error);
      }
    }

    return files.slice(0, maxFiles);
  }

  // ─────────────────────────────────────────────────────────────
  // Template Commands
  // ─────────────────────────────────────────────────────────────

  /**
   * Get available commands from active template
   */
  getCommands(): TemplateCommand[] {
    const template = this.getActiveTemplate();
    return template?.commands || [];
  }

  /**
   * Get a specific command by name
   */
  getCommand(name: string): TemplateCommand | undefined {
    return this.getCommands().find(c => c.name === name);
  }

  /**
   * Expand a command prompt with inputs
   */
  expandCommandPrompt(
    command: TemplateCommand,
    inputs: Record<string, unknown>
  ): string {
    let prompt = command.prompt;

    // Replace simple {{variable}} placeholders
    for (const [key, value] of Object.entries(inputs)) {
      const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
      prompt = prompt.replace(regex, String(value));
    }

    // Handle conditionals {{#if variable}}...{{/if}}
    prompt = prompt.replace(
      /\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
      (match, variable, content) => {
        return inputs[variable] ? content : '';
      }
    );

    // Clean up extra whitespace
    prompt = prompt.replace(/\n{3,}/g, '\n\n').trim();

    return prompt;
  }

  /**
   * Validate command inputs
   */
  validateCommandInputs(
    command: TemplateCommand,
    inputs: Record<string, unknown>
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    for (const input of command.requiredInputs) {
      const value = inputs[input.name];
      
      if (value === undefined || value === null || value === '') {
        errors.push(`Missing required input: ${input.name}`);
        continue;
      }

      if (input.validation && typeof value === 'string') {
        const regex = new RegExp(input.validation);
        if (!regex.test(value)) {
          errors.push(`Invalid format for ${input.name}: must match ${input.validation}`);
        }
      }

      if (input.type === 'selection' && input.options) {
        const validValues = input.options.map(o => o.value);
        if (!validValues.includes(String(value))) {
          errors.push(`Invalid selection for ${input.name}`);
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Run a template command
   * Returns the expanded prompt ready for Aider
   */
  runCommand(
    commandName: string,
    inputs: Record<string, unknown>
  ): CommandRunResult {
    const command = this.getCommand(commandName);
    if (!command) {
      return {
        success: false,
        command: {} as TemplateCommand,
        inputs,
        expandedPrompt: '',
        error: `Command "${commandName}" not found`,
      };
    }

    const validation = this.validateCommandInputs(command, inputs);
    if (!validation.valid) {
      return {
        success: false,
        command,
        inputs,
        expandedPrompt: '',
        error: validation.errors.join('; '),
      };
    }

    const expandedPrompt = this.expandCommandPrompt(command, inputs);

    const result: CommandRunResult = {
      success: true,
      command,
      inputs,
      expandedPrompt,
    };

    this.emit('commandRun', result);
    return result;
  }

  // ─────────────────────────────────────────────────────────────
  // Scaffolding
  // ─────────────────────────────────────────────────────────────

  /**
   * Scaffold a new project from template
   */
  async scaffoldProject(
    templateId: string,
    projectPath: string,
    variables: Record<string, string> = {}
  ): Promise<{ success: boolean; filesCreated: string[]; errors: string[] }> {
    const template = this.templates.get(templateId);
    if (!template) {
      return { success: false, filesCreated: [], errors: [`Template "${templateId}" not found`] };
    }

    if (!template.scaffold) {
      return { success: false, filesCreated: [], errors: ['Template has no scaffold configuration'] };
    }

    const filesCreated: string[] = [];
    const errors: string[] = [];
    const scaffold = template.scaffold;

    try {
      // Create directories
      if (scaffold.directories) {
        for (const dir of scaffold.directories) {
          const dirPath = path.join(projectPath, dir);
          if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
          }
        }
      }

      // Create files
      for (const file of scaffold.files) {
        try {
          const filePath = this.expandVariables(file.path, variables);
          const fullPath = path.join(projectPath, filePath);
          
          // Check if file exists and overwrite setting
          if (fs.existsSync(fullPath) && !file.overwrite) {
            continue;
          }

          // Create directory if needed
          const fileDir = path.dirname(fullPath);
          if (!fs.existsSync(fileDir)) {
            fs.mkdirSync(fileDir, { recursive: true });
          }

          // Write file with expanded variables
          const content = this.expandVariables(file.content, variables);
          fs.writeFileSync(fullPath, content);
          filesCreated.push(filePath);
        } catch (error) {
          errors.push(`Failed to create ${file.path}: ${(error as Error).message}`);
        }
      }

      this.emit('scaffoldComplete', { template, projectPath });
      
      return {
        success: errors.length === 0,
        filesCreated,
        errors,
      };
    } catch (error) {
      return {
        success: false,
        filesCreated,
        errors: [...errors, (error as Error).message],
      };
    }
  }

  /**
   * Expand variables in a string
   */
  private expandVariables(text: string, variables: Record<string, string>): string {
    let result = text;
    for (const [key, value] of Object.entries(variables)) {
      const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
      result = result.replace(regex, value);
    }
    return result;
  }
}

// Type augmentation for EventEmitter
declare interface TemplateManager {
  on<K extends keyof TemplateManagerEvents>(
    event: K,
    listener: (arg: TemplateManagerEvents[K]) => void
  ): this;
  emit<K extends keyof TemplateManagerEvents>(
    event: K,
    arg: TemplateManagerEvents[K]
  ): boolean;
}

export default TemplateManager;

