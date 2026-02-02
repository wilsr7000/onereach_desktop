/**
 * Category Index - Fast keyword-to-agent lookup
 */
import type { Task, CategoryConfig } from '../types/index.js';

export class CategoryIndex {
  // Keyword -> category IDs
  private keywordToCategories: Map<string, Set<string>> = new Map();
  
  // Category ID -> agent IDs (built dynamically as agents connect)
  private categoryAgents: Map<string, Set<string>> = new Map();
  
  // Agent ID -> category IDs (reverse lookup)
  private agentCategories: Map<string, Set<string>> = new Map();
  
  // All registered categories
  private categories: Map<string, CategoryConfig> = new Map();
  
  // Market maker agent ID
  private marketMakerId: string | null = null;

  constructor(categories: CategoryConfig[]) {
    for (const category of categories) {
      this.registerCategory(category);
    }
  }

  /**
   * Register a category
   */
  registerCategory(category: CategoryConfig): void {
    this.categories.set(category.name, category);
    this.categoryAgents.set(category.name, new Set());

    // Build keyword index
    for (const keyword of category.keywords) {
      const lower = keyword.toLowerCase();
      if (!this.keywordToCategories.has(lower)) {
        this.keywordToCategories.set(lower, new Set());
      }
      this.keywordToCategories.get(lower)!.add(category.name);
    }

    console.log(`[CategoryIndex] Registered category: ${category.name} with ${category.keywords.length} keywords`);
  }

  /**
   * Register an agent with its categories
   */
  addAgent(agentId: string, categories: string[]): void {
    this.agentCategories.set(agentId, new Set(categories));

    for (const categoryName of categories) {
      if (this.categoryAgents.has(categoryName)) {
        this.categoryAgents.get(categoryName)!.add(agentId);
      } else {
        console.warn(`[CategoryIndex] Agent ${agentId} registered for unknown category: ${categoryName}`);
      }
    }

    console.log(`[CategoryIndex] Added agent ${agentId} to categories: ${categories.join(', ')}`);
  }

  /**
   * Remove an agent from all categories
   */
  removeAgent(agentId: string): void {
    const categories = this.agentCategories.get(agentId);
    if (categories) {
      for (const categoryName of categories) {
        this.categoryAgents.get(categoryName)?.delete(agentId);
      }
    }
    this.agentCategories.delete(agentId);
    console.log(`[CategoryIndex] Removed agent ${agentId}`);
  }

  /**
   * Set the market maker agent ID
   */
  setMarketMaker(agentId: string): void {
    this.marketMakerId = agentId;
    console.log(`[CategoryIndex] Market maker set: ${agentId}`);
  }

  /**
   * Find all categories matching a task's content
   */
  findCategories(task: Task): string[] {
    const words = task.content.toLowerCase().split(/\s+/);
    const matchedCategories = new Set<string>();

    for (const word of words) {
      // Check exact match
      const categories = this.keywordToCategories.get(word);
      if (categories) {
        for (const cat of categories) {
          matchedCategories.add(cat);
        }
      }

      // Also check if word contains a keyword (for compound words)
      for (const [keyword, cats] of this.keywordToCategories) {
        if (word.includes(keyword) && keyword.length >= 3) {
          for (const cat of cats) {
            matchedCategories.add(cat);
          }
        }
      }
    }

    return Array.from(matchedCategories);
  }

  /**
   * Get all connected agents for bidding
   * ALL agents bid on ALL tasks - LLM bidding determines winner
   * Categories are used for context/logging only, not filtering
   */
  getAgentsForTask(task: Task): Set<string> {
    // Return ALL connected agents - let LLM bidding determine who handles it
    const agents = new Set<string>();
    
    // Add all agents that have registered with any category
    for (const agentId of this.agentCategories.keys()) {
      agents.add(agentId);
    }

    // Always include market maker if set
    if (this.marketMakerId) {
      agents.add(this.marketMakerId);
    }

    return agents;
  }

  /**
   * Get categories for an agent
   */
  getAgentCategories(agentId: string): string[] {
    return Array.from(this.agentCategories.get(agentId) ?? []);
  }

  /**
   * Get agents in a category
   */
  getCategoryAgents(categoryName: string): string[] {
    return Array.from(this.categoryAgents.get(categoryName) ?? []);
  }

  /**
   * Get all registered category names
   */
  getCategoryNames(): string[] {
    return Array.from(this.categories.keys());
  }

  /**
   * Get total agent count
   */
  getAgentCount(): number {
    return this.agentCategories.size;
  }

  /**
   * Check if any agents are available
   */
  hasAgents(): boolean {
    return this.agentCategories.size > 0 || this.marketMakerId !== null;
  }

  /**
   * Get summary for debugging
   */
  getSummary(): { categories: Record<string, number>; totalAgents: number } {
    const categories: Record<string, number> = {};
    for (const [name, agents] of this.categoryAgents) {
      categories[name] = agents.size;
    }
    return {
      categories,
      totalAgents: this.agentCategories.size,
    };
  }
}
