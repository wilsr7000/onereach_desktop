/**
 * Tool Agent Generator
 * 
 * Automatically creates an AI agent from a tool's documentation.
 * The agent can then bid on tasks and open the appropriate tool.
 */

const fetch = require('node-fetch');

/**
 * Get OpenAI API key from app settings
 */
function getOpenAIApiKey() {
  if (global.settingsManager) {
    const openaiKey = global.settingsManager.get('openaiApiKey');
    if (openaiKey) return openaiKey;
    
    const provider = global.settingsManager.get('llmProvider');
    const llmKey = global.settingsManager.get('llmApiKey');
    if (provider === 'openai' && llmKey) return llmKey;
  }
  return process.env.OPENAI_API_KEY;
}

/**
 * Fetch and extract text content from a documentation URL
 * @param {string} url - The documentation URL
 * @returns {Promise<string>} - Extracted text content
 */
async function fetchDocsContent(url) {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; GSXPowerUser/1.0)'
      },
      timeout: 15000
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch docs: ${response.status}`);
    }
    
    const html = await response.text();
    
    // Simple HTML to text extraction
    // Remove scripts, styles, and HTML tags
    let text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim();
    
    // Truncate to reasonable length for LLM (about 4000 tokens worth)
    if (text.length > 12000) {
      text = text.substring(0, 12000) + '...';
    }
    
    return text;
  } catch (error) {
    console.error('[ToolAgentGenerator] Error fetching docs:', error.message);
    throw error;
  }
}

/**
 * Use LLM to generate an agent definition from documentation content
 * @param {Object} tool - The tool object (name, url, description, docsUrl)
 * @param {string} docsContent - Extracted documentation text
 * @returns {Promise<Object>} - Agent definition
 */
async function generateAgentDefinition(tool, docsContent) {
  const apiKey = getOpenAIApiKey();
  if (!apiKey) {
    throw new Error('OpenAI API key required for agent generation');
  }
  
  const prompt = `You are creating an AI agent definition for a voice assistant. The agent will help users open and use a specific tool.

TOOL NAME: ${tool.name}
TOOL URL: ${tool.url}
USER DESCRIPTION: ${tool.description || 'None provided'}

DOCUMENTATION CONTENT:
${docsContent}

Based on this documentation, create an agent definition. The agent should:
1. Know what this tool does and when to use it
2. Respond to natural voice requests related to the tool's functionality
3. Open the tool when the user wants to use it

Respond with JSON only:
{
  "description": "<2-3 sentence description of what the tool does and when to use it>",
  "capabilities": ["<capability 1>", "<capability 2>", "<capability 3>"],
  "examplePhrases": ["<phrase 1>", "<phrase 2>", "<phrase 3>", "<phrase 4>", "<phrase 5>"],
  "categories": ["tools", "<category2>", "<category3>"]
}

Guidelines:
- description: Be specific about what the tool DOES, not what it IS
- capabilities: List 3-5 specific things users can do with this tool
- examplePhrases: Natural voice commands that should trigger this agent (varied and realistic)
- categories: Include "tools" plus 1-2 relevant categories like "productivity", "automation", "development", "design", "communication"`;

  try {
    const { getBudgetManager } = require('../budget-manager');
    const budgetManager = getBudgetManager();
    
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 500
      })
    });
    
    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`);
    }
    
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    
    // Track usage
    if (budgetManager && data.usage) {
      budgetManager.trackUsage({
        model: 'gpt-4o-mini',
        inputTokens: data.usage.prompt_tokens || 0,
        outputTokens: data.usage.completion_tokens || 0,
        source: 'tool-agent-generator'
      });
    }
    
    // Parse JSON response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Invalid JSON response from LLM');
    }
    
    const parsed = JSON.parse(jsonMatch[0]);
    
    // Build the full agent definition
    return {
      id: `tool-${tool.id}`,
      name: tool.name,
      description: parsed.description,
      categories: parsed.categories || ['tools'],
      keywords: parsed.examplePhrases.map(p => p.toLowerCase()),
      capabilities: parsed.capabilities || [],
      examplePhrases: parsed.examplePhrases || [],
      toolId: tool.id,
      toolUrl: tool.url,
      docsUrl: tool.docsUrl,
      executionType: 'tool-opener',
      enabled: true,
      autoGenerated: true,
      generatedAt: new Date().toISOString()
    };
    
  } catch (error) {
    console.error('[ToolAgentGenerator] Error generating agent:', error.message);
    throw error;
  }
}

/**
 * Format agent definition as markdown for Spaces
 * @param {Object} agentDef - The agent definition
 * @returns {string} - Markdown content
 */
function formatAgentMarkdown(agentDef) {
  return `# ${agentDef.name} Agent

## Description
${agentDef.description}

## What This Tool Does
${agentDef.capabilities.map(c => `- ${c}`).join('\n')}

## When To Use
Say things like:
${agentDef.examplePhrases.map(p => `- "${p}"`).join('\n')}

## Categories
${agentDef.categories.join(', ')}

## Tool Link
- **Tool URL:** ${agentDef.toolUrl}
${agentDef.docsUrl ? `- **Documentation:** ${agentDef.docsUrl}` : ''}

---
*Auto-generated from documentation on ${new Date().toLocaleDateString()}.*
*Edit this file to improve agent matching and responses.*
`;
}

/**
 * Save agent markdown to Spaces
 * @param {Object} agentDef - The agent definition
 * @returns {Promise<void>}
 */
async function saveAgentToSpaces(agentDef) {
  try {
    // Use the clipboard manager's spaces API if available
    if (global.clipboardManager && global.clipboardManager.spacesAPI) {
      const mdContent = formatAgentMarkdown(agentDef);
      
      // Find or create "Tool Agents" space
      const spaces = global.clipboardManager.spacesAPI.getSpaces();
      let toolAgentsSpace = spaces.find(s => s.name === 'Tool Agents');
      
      if (!toolAgentsSpace) {
        toolAgentsSpace = global.clipboardManager.spacesAPI.createSpace('Tool Agents');
        console.log('[ToolAgentGenerator] Created "Tool Agents" space');
      }
      
      // Add the markdown content as an item
      global.clipboardManager.spacesAPI.addItem(toolAgentsSpace.id, {
        type: 'text',
        content: mdContent,
        title: `${agentDef.name} Agent`,
        metadata: {
          agentId: agentDef.id,
          toolId: agentDef.toolId,
          autoGenerated: true
        }
      });
      
      console.log(`[ToolAgentGenerator] Saved agent markdown to Spaces: ${agentDef.name}`);
    } else {
      console.warn('[ToolAgentGenerator] Spaces API not available, skipping markdown save');
    }
  } catch (error) {
    console.error('[ToolAgentGenerator] Error saving to Spaces:', error.message);
    // Don't throw - this is optional
  }
}

/**
 * Register the agent in the local agent store
 * @param {Object} agentDef - The agent definition
 * @returns {Promise<void>}
 */
async function registerAgent(agentDef) {
  try {
    const { getAgentStore } = require('../src/voice-task-sdk/agent-store');
    const store = getAgentStore();
    await store.init();
    
    // Build the prompt for the agent
    const prompt = `You are the ${agentDef.name} assistant. ${agentDef.description}

When the user wants to use ${agentDef.name}, open the tool for them.

Capabilities:
${agentDef.capabilities.map(c => `- ${c}`).join('\n')}

Example requests you should handle:
${agentDef.examplePhrases.map(p => `- "${p}"`).join('\n')}

When you match a request, respond with a brief confirmation and open the tool.`;

    // Create the agent with required fields
    const agentData = {
      name: agentDef.name,
      description: agentDef.description,
      categories: agentDef.categories,
      keywords: agentDef.examplePhrases.map(p => p.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim()),
      capabilities: agentDef.capabilities,
      prompt: prompt,
      executionType: 'tool-opener',
      enabled: true,
      // Custom fields for tool-agents
      toolId: agentDef.toolId,
      toolUrl: agentDef.toolUrl,
      docsUrl: agentDef.docsUrl,
      autoGenerated: true,
      generatedAt: agentDef.generatedAt
    };
    
    // Create the agent using the store's createAgent method
    const createdAgent = await store.createAgent(agentData);
    
    console.log(`[ToolAgentGenerator] Registered agent: ${createdAgent.id}`);
    return createdAgent;
  } catch (error) {
    console.error('[ToolAgentGenerator] Error registering agent:', error.message);
    throw error;
  }
}

/**
 * Delete an auto-generated agent by tool ID
 * @param {string} toolId - The tool ID
 * @returns {Promise<void>}
 */
async function deleteToolAgent(toolId) {
  try {
    const { getAgentStore } = require('../src/voice-task-sdk/agent-store');
    const store = getAgentStore();
    await store.init();
    
    // Find agent by toolId
    const agents = store.getLocalAgents();
    const toolAgent = agents.find(a => a.toolId === toolId);
    
    if (toolAgent) {
      await store.deleteAgent(toolAgent.id);
      console.log(`[ToolAgentGenerator] Deleted agent: ${toolAgent.id}`);
    } else {
      console.log(`[ToolAgentGenerator] No agent found for tool: ${toolId}`);
    }
    
    // Also try to remove from Spaces (best effort)
    if (global.clipboardManager && global.clipboardManager.spacesAPI) {
      const spaces = global.clipboardManager.spacesAPI.getSpaces();
      const toolAgentsSpace = spaces.find(s => s.name === 'Tool Agents');
      
      if (toolAgentsSpace) {
        const items = global.clipboardManager.spacesAPI.getItems(toolAgentsSpace.id);
        const agentItem = items.find(i => i.metadata?.toolId === toolId);
        
        if (agentItem) {
          global.clipboardManager.spacesAPI.deleteItem(toolAgentsSpace.id, agentItem.id);
          console.log(`[ToolAgentGenerator] Removed agent markdown from Spaces`);
        }
      }
    }
  } catch (error) {
    console.error('[ToolAgentGenerator] Error deleting agent:', error.message);
    // Don't throw - best effort cleanup
  }
}

/**
 * Generate an agent from a tool's documentation
 * Main entry point for auto-agent creation
 * @param {Object} tool - The tool object with docsUrl
 * @returns {Promise<Object>} - The created agent definition
 */
async function generateAgentFromDocs(tool) {
  if (!tool.docsUrl) {
    throw new Error('Tool must have a docsUrl to generate an agent');
  }
  
  console.log(`[ToolAgentGenerator] Generating agent for: ${tool.name}`);
  console.log(`[ToolAgentGenerator] Fetching docs from: ${tool.docsUrl}`);
  
  // 1. Fetch documentation content
  const docsContent = await fetchDocsContent(tool.docsUrl);
  console.log(`[ToolAgentGenerator] Fetched ${docsContent.length} chars of documentation`);
  
  // 2. Generate agent definition using LLM
  const agentDef = await generateAgentDefinition(tool, docsContent);
  console.log(`[ToolAgentGenerator] Generated agent definition:`, agentDef.id);
  
  // 3. Save markdown to Spaces (optional, for user editing)
  await saveAgentToSpaces(agentDef);
  
  // 4. Register as local agent
  await registerAgent(agentDef);
  
  console.log(`[ToolAgentGenerator] Successfully created agent: ${agentDef.name}`);
  return agentDef;
}

module.exports = {
  generateAgentFromDocs,
  deleteToolAgent,
  fetchDocsContent,
  generateAgentDefinition,
  formatAgentMarkdown,
  saveAgentToSpaces,
  registerAgent
};
