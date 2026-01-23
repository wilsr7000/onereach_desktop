/**
 * Dynamic Agent
 * 
 * A single agent that handles all user-defined agents.
 * Loads definitions from the agent store and executes tasks via LLM.
 */

const path = require('path');

/**
 * Create a dynamic agent that handles user-defined agent definitions
 */
function createDynamicAgent(exchangeUrl, agentDefinitions, llmClient) {
  // Load the agent SDK from the compiled dist folder
  let createAgent;
  
  try {
    const agentPkg = require('../task-agent/dist/index.js');
    createAgent = agentPkg.createAgent;
  } catch (error) {
    console.error('[DynamicAgent] Failed to load task-agent package:', error.message);
    console.log('[DynamicAgent] Make sure to run: cd packages/task-agent && npm run build');
    throw error;
  }
  
  // Collect all unique categories from all agent definitions
  const allCategories = new Set();
  for (const def of agentDefinitions) {
    (def.categories || []).forEach(cat => allCategories.add(cat));
    // Also use keywords as categories for better matching
    (def.keywords || []).forEach(kw => allCategories.add(kw.toLowerCase()));
  }
  
  // Add a generic category for user-defined agents
  allCategories.add('user-defined');
  allCategories.add('custom');
  
  console.log('[DynamicAgent] Creating with', agentDefinitions.length, 'definitions');
  console.log('[DynamicAgent] Categories:', Array.from(allCategories).join(', '));
  
  return createAgent({
    name: 'dynamic-user-agent',
    version: '1.0.0',
    categories: Array.from(allCategories),
    
    exchange: {
      url: exchangeUrl,
      reconnect: true,
      reconnectIntervalMs: 3000,
    },
    
    // Fast keyword matching
    quickMatch: (task) => {
      const content = task.content.toLowerCase();
      
      let bestMatch = null;
      let bestScore = 0;
      
      
      for (const def of agentDefinitions) {
        if (!def.enabled) continue;
        
        // Count matching keywords
        const matchedKeywords = (def.keywords || []).filter(kw => 
          content.includes(kw.toLowerCase())
        );
        
        if (matchedKeywords.length > 0) {
          // Score based on keyword match ratio
          const score = Math.min(1, matchedKeywords.length / def.keywords.length + 0.5);
          const finalScore = Math.max(score, def.settings?.confidenceThreshold || 0.7);
          
          if (finalScore > bestScore) {
            bestScore = finalScore;
            bestMatch = def;
          }
        }
      }
      
      if (bestMatch) {
        console.log('[DynamicAgent] Quick match:', bestMatch.name, 'score:', bestScore);
        return bestScore;
      }
      
      return 0;
    },
    
    // Execute using the matching agent's prompt
    execute: async (task, context) => {
      const content = task.content.toLowerCase();
      
      
      // Check for cancellation
      if (context.signal.aborted) {
        return { success: false, error: 'Task cancelled' };
      }
      
      // Find the best matching agent definition
      let bestMatch = null;
      let bestMatchCount = 0;
      
      for (const def of agentDefinitions) {
        if (!def.enabled) continue;
        
        const matchedKeywords = (def.keywords || []).filter(kw => 
          content.includes(kw.toLowerCase())
        );
        
        if (matchedKeywords.length > bestMatchCount) {
          bestMatchCount = matchedKeywords.length;
          bestMatch = def;
        }
      }
      
      if (!bestMatch) {
        return {
          success: false,
          error: 'No matching agent found for this request',
        };
      }
      
      console.log('[DynamicAgent] Executing with agent:', bestMatch.name, 'type:', bestMatch.executionType);
    
    if (definitions.length === 0) {
      console.log('[DynamicAgent] No user-defined agents to start');
      return null;
    }
    
    console.log('[DynamicAgent] Starting with', definitions.length, 'agent definitions');
    
    const agent = createDynamicAgent(exchangeUrl, definitions);
    
    agent.on('connected', () => {
      console.log('[DynamicAgent] Connected to exchange');
    });
    
    agent.on('disconnected', ({ reason }) => {
      console.log('[DynamicAgent] Disconnected:', reason);
    });
    
    agent.on('bid:requested', ({ task }) => {
      console.log('[DynamicAgent] Bid requested for:', task.content.substring(0, 50));
    });
    
    agent.on('task:assigned', ({ task }) => {
      console.log('[DynamicAgent] Task assigned:', task.id);
    });
    
    agent.on('task:completed', ({ taskId, success }) => {
      console.log('[DynamicAgent] Task completed:', taskId, success ? 'SUCCESS' : 'FAILED');
    });
    
    await agent.start();
    console.log('[DynamicAgent] Started successfully');
    
    return agent;
  } catch (error) {
    console.error('[DynamicAgent] Failed to start:', error);
    return null;
  }
}

module.exports = {
  createDynamicAgent,
  startDynamicAgent,
  executeWithAppLLM,
};
