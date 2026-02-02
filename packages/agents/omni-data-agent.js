/**
 * Omni Data Agent
 * 
 * Central context provider for all agents. Reads from two main files in "gsx-agent" space:
 * 
 * 1. main.md - User & system context (auto-populated on first run)
 *    - User info, system info, timezone, locale, installed apps
 *    - User can add location, preferences, custom data
 * 
 * 2. agent-profile.md - Agent personality settings
 *    - Name, tone, greeting style, verbosity
 *    - User can customize how the agent behaves
 * 
 * Usage by other agents:
 *   const omniData = require('./omni-data-agent');
 *   
 *   // Simple query for specific data
 *   const location = await omniData.query('location');
 *   
 *   // Get agent personality
 *   const profile = await omniData.getAgentProfile();
 *   
 *   // Smart query based on task context
 *   const context = await omniData.getRelevantContext(task, agentInfo);
 *   
 *   // Get all available context
 *   const all = await omniData.getAll();
 */

const path = require('path');
const fs = require('fs');

const CONTEXT_SPACE_ID = 'gsx-agent';
const MAIN_FILE = 'main.md';
const PROFILE_FILE = 'agent-profile.md';

// Cache to avoid repeated file reads
let contextCache = null;
let profileCache = null;
let cacheTimestamp = 0;
let profileCacheTimestamp = 0;
const CACHE_TTL = 30000; // 30 seconds

// Keywords that indicate what context might be relevant
const CONTEXT_KEYWORDS = {
  location: ['weather', 'temperature', 'forecast', 'near me', 'local', 'here', 'my city', 'my location', 'around me'],
  timezone: ['time', 'clock', 'schedule', 'when', 'hour', 'minute'],
  preferences: ['prefer', 'settings', 'format', 'units', 'language'],
  user: ['my name', 'who am i', 'about me', 'my profile'],
  system: ['my computer', 'my mac', 'my machine', 'what apps', 'installed'],
  apps: ['open', 'launch', 'start', 'run app', 'application']
};

/**
 * Query for specific context data
 * @param {string} key - What to query: 'location', 'preferences', 'timezone', etc.
 * @returns {Promise<any>} - The requested data or null
 */
async function query(key) {
  const context = await loadContext();
  return context[key] || null;
}

/**
 * Get all available context
 * @returns {Promise<Object>} - All context data
 */
async function getAll() {
  return loadContext();
}

/**
 * Get relevant context based on task and agent info
 * This is the smart query that analyzes what's needed
 * 
 * @param {Object} task - The task being executed { content, type, data, ... }
 * @param {Object} agentInfo - Info about the requesting agent { id, name, description, ... }
 * @returns {Promise<Object>} - Relevant context for this task
 */
async function getRelevantContext(task, agentInfo = {}) {
  const allContext = await loadContext();
  const relevantContext = {};
  
  const taskContent = (task?.content || '').toLowerCase();
  const taskType = task?.type || '';
  const agentId = agentInfo?.id || '';
  const agentName = agentInfo?.name || '';
  
  console.log(`[OmniData] Analyzing context for task: "${taskContent.substring(0, 50)}..." agent: ${agentId || agentName}`);
  
  // Check each context type for relevance
  for (const [contextKey, keywords] of Object.entries(CONTEXT_KEYWORDS)) {
    const isRelevant = keywords.some(keyword => taskContent.includes(keyword));
    
    if (isRelevant && allContext[contextKey]) {
      relevantContext[contextKey] = allContext[contextKey];
      console.log(`[OmniData] Including ${contextKey} context (keyword match)`);
    }
  }
  
  // Agent-specific context rules
  if (agentId === 'search-agent' || agentName?.toLowerCase().includes('search')) {
    // Search agent often needs location for weather, local info
    if (allContext.location && !relevantContext.location) {
      // Check if task might benefit from location
      if (/weather|forecast|temperature|rain|snow|local|near/i.test(taskContent)) {
        relevantContext.location = allContext.location;
        console.log('[OmniData] Including location for search agent');
      }
    }
  }
  
  if (agentId === 'time-agent' || taskType === 'time') {
    // Time agent needs timezone
    if (allContext.timezone && !relevantContext.timezone) {
      relevantContext.timezone = allContext.timezone;
      console.log('[OmniData] Including timezone for time task');
    }
  }
  
  // Include preferences if they exist and might be relevant
  if (allContext.preferences && Object.keys(allContext.preferences).length > 0) {
    // Check for preference-sensitive queries
    if (/celsius|fahrenheit|metric|imperial|format/i.test(taskContent)) {
      relevantContext.preferences = allContext.preferences;
      console.log('[OmniData] Including preferences');
    }
  }
  
  // Include system info if relevant
  if (allContext.system && /computer|mac|system|machine|os|version/i.test(taskContent)) {
    relevantContext.system = allContext.system;
    console.log('[OmniData] Including system info');
  }
  
  // Include apps if relevant
  if (allContext.apps && allContext.apps.length > 0) {
    if (/app|application|install|open|launch|run|start/i.test(taskContent)) {
      relevantContext.apps = allContext.apps;
      console.log('[OmniData] Including installed apps');
    }
  }
  
  // Always include custom data if it exists and task mentions it
  if (allContext.customData) {
    for (const [key, value] of Object.entries(allContext.customData)) {
      if (taskContent.includes(key.toLowerCase())) {
        relevantContext[key] = value;
        console.log(`[OmniData] Including custom data: ${key}`);
      }
    }
  }
  
  console.log(`[OmniData] Returning ${Object.keys(relevantContext).length} context items`);
  return relevantContext;
}

/**
 * Load and parse context from main.md (primary) and fallback to individual files
 * @returns {Promise<Object>} - All parsed context
 */
async function loadContext() {
  // Return cached if fresh
  if (contextCache && Date.now() - cacheTimestamp < CACHE_TTL) {
    return contextCache;
  }
  
  const context = {
    location: null,
    preferences: {},
    timezone: null,
    locale: null,
    user: null,
    system: null,
    apps: [],
    customData: {}
  };
  
  try {
    const homeDir = process.env.HOME || process.env.USERPROFILE;
    const storageRoot = path.join(homeDir, 'Documents', 'OR-Spaces');
    
    // Primary: Try to read from indexed item (gsx-agent-main-context)
    // Check for different possible extensions since UI might change it
    const itemDir = path.join(storageRoot, 'items', 'gsx-agent-main-context');
    let mainContent = null;
    
    if (fs.existsSync(itemDir)) {
      const possibleFiles = ['content.md', 'content.yaml', 'content.txt'];
      for (const file of possibleFiles) {
        const filePath = path.join(itemDir, file);
        if (fs.existsSync(filePath)) {
          mainContent = fs.readFileSync(filePath, 'utf-8');
          console.log(`[OmniData] Loaded context from ${file}`);
          break;
        }
      }
    }
    
    if (mainContent) {
      parseMainFile(mainContent, context);
      // Also store raw content for freeform queries
      context.rawContent = mainContent;
    } else {
      // Fallback: Try old space-based file location
      const spacePath = path.join(storageRoot, 'spaces', CONTEXT_SPACE_ID);
      const mainPath = path.join(spacePath, MAIN_FILE);
      if (fs.existsSync(mainPath)) {
        const content = fs.readFileSync(mainPath, 'utf-8');
        parseMainFile(content, context);
        context.rawContent = content;
        console.log('[OmniData] Loaded context from main.md (legacy location)');
      } else {
        console.log('[OmniData] No main.md found');
      }
    }
  } catch (error) {
    console.error('[OmniData] Error loading context:', error.message);
  }
  
  contextCache = context;
  cacheTimestamp = Date.now();
  
  const contextSummary = Object.keys(context).filter(k => {
    const v = context[k];
    if (Array.isArray(v)) return v.length > 0;
    return v !== null && (typeof v !== 'object' || Object.keys(v).length > 0);
  });
  console.log('[OmniData] Context loaded:', contextSummary.join(', ') || 'empty');
  
  return context;
}

/**
 * Parse main.md with section headers
 * Sections: ## User, ## System, ## Location, ## Timezone, ## Locale, ## Preferences, ## Installed Apps
 */
function parseMainFile(content, context) {
  const lines = content.split('\n');
  let currentSection = null;
  
  for (const line of lines) {
    const trimmed = line.trim();
    
    // Check for section header
    if (trimmed.startsWith('## ')) {
      currentSection = trimmed.substring(3).toLowerCase().replace(/\s+/g, '_');
      continue;
    }
    
    // Skip title and empty lines
    if (trimmed.startsWith('# ') || trimmed === '') continue;
    
    // Handle list items for apps
    if (currentSection === 'installed_apps' && trimmed.startsWith('- ')) {
      const app = trimmed.substring(2).trim();
      if (app) context.apps.push(app);
      continue;
    }
    
    // Parse key: value pairs
    const match = trimmed.match(/^(\w+):\s*(.+)$/);
    if (match && currentSection) {
      const key = match[1].toLowerCase();
      const value = match[2].trim();
      
      switch (currentSection) {
        case 'user':
          if (!context.user) context.user = {};
          context.user[key] = value;
          break;
        case 'system':
          if (!context.system) context.system = {};
          context.system[key] = value;
          break;
        case 'location':
          if (!context.location) context.location = {};
          context.location[key] = value;
          break;
        case 'timezone':
          if (key === 'timezone' || key === 'tz') {
            context.timezone = value;
          } else {
            if (!context.timezoneInfo) context.timezoneInfo = {};
            context.timezoneInfo[key] = value;
          }
          break;
        case 'locale':
          if (!context.locale) context.locale = {};
          context.locale[key] = value;
          break;
        case 'preferences':
        case 'settings':
          context.preferences[key] = value;
          break;
        default:
          // Store in customData under section name
          if (!context.customData[currentSection]) {
            context.customData[currentSection] = {};
          }
          context.customData[currentSection][key] = value;
          break;
      }
    }
  }
}

/**
 * Fallback: Load from individual files (backward compatibility)
 */
async function loadFromIndividualFiles(spacePath, context) {
  try {
    if (!fs.existsSync(spacePath)) return;
    
    const files = fs.readdirSync(spacePath);
    
    for (const file of files) {
      if (file === MAIN_FILE || file === PROFILE_FILE) continue;
      if (!file.endsWith('.md') && !file.endsWith('.txt')) continue;
      
      const filePath = path.join(spacePath, file);
      const content = fs.readFileSync(filePath, 'utf-8');
      parseContextFile(file, content, context);
    }
  } catch (e) {
    console.error('[OmniData] Error loading individual files:', e.message);
  }
}

/**
 * Load and parse agent profile from agent-profile.md
 * @returns {Promise<Object>} - Agent profile settings
 */
async function loadAgentProfile() {
  // Return cached if fresh
  if (profileCache && Date.now() - profileCacheTimestamp < CACHE_TTL) {
    return profileCache;
  }
  
  const profile = {
    identity: {
      name: 'Atlas',
      role: 'Personal Assistant'
    },
    personality: {
      tone: 'friendly',
      humor: 'light',
      formality: 'casual'
    },
    communication: {
      greeting: null,
      signoff: null,
      verbosity: 'brief',
      use_emoji: false
    },
    preferences: {
      confirm_actions: true,
      proactive_suggestions: true
    }
  };
  
  try {
    const homeDir = process.env.HOME || process.env.USERPROFILE;
    const storageRoot = path.join(homeDir, 'Documents', 'OR-Spaces');
    
    // Primary: Try to read from indexed item (gsx-agent-profile)
    const profileItemDir = path.join(storageRoot, 'items', 'gsx-agent-profile');
    let profileContent = null;
    
    if (fs.existsSync(profileItemDir)) {
      const possibleFiles = ['content.md', 'content.yaml', 'content.txt'];
      for (const file of possibleFiles) {
        const filePath = path.join(profileItemDir, file);
        if (fs.existsSync(filePath)) {
          profileContent = fs.readFileSync(filePath, 'utf-8');
          console.log(`[OmniData] Loaded agent profile from ${file}`);
          break;
        }
      }
    }
    
    if (profileContent) {
      parseProfileFile(profileContent, profile);
    } else {
      // Fallback: Try old space-based file location
      const profilePath = path.join(storageRoot, 'spaces', CONTEXT_SPACE_ID, PROFILE_FILE);
      if (fs.existsSync(profilePath)) {
        const content = fs.readFileSync(profilePath, 'utf-8');
        parseProfileFile(content, profile);
        console.log('[OmniData] Loaded agent profile (legacy location)');
      }
    }
  } catch (error) {
    console.error('[OmniData] Error loading agent profile:', error.message);
  }
  
  profileCache = profile;
  profileCacheTimestamp = Date.now();
  
  return profile;
}

/**
 * Parse agent-profile.md with section headers
 */
function parseProfileFile(content, profile) {
  const lines = content.split('\n');
  let currentSection = null;
  
  for (const line of lines) {
    const trimmed = line.trim();
    
    // Check for section header
    if (trimmed.startsWith('## ')) {
      currentSection = trimmed.substring(3).toLowerCase().replace(/\s+/g, '_');
      continue;
    }
    
    // Skip title and empty lines
    if (trimmed.startsWith('# ') || trimmed === '') continue;
    
    // Parse key: value pairs
    const match = trimmed.match(/^(\w+):\s*(.+)$/);
    if (match && currentSection) {
      const key = match[1].toLowerCase();
      let value = match[2].trim();
      
      // Convert boolean strings
      if (value === 'true') value = true;
      else if (value === 'false') value = false;
      
      // Map to profile sections
      if (profile[currentSection]) {
        profile[currentSection][key] = value;
      }
    }
  }
}

/**
 * Get agent profile (public API)
 * @returns {Promise<Object>} - Agent profile
 */
async function getAgentProfile() {
  return loadAgentProfile();
}

/**
 * Parse a context file and populate context object
 * Supports YAML-like frontmatter or simple key: value pairs
 */
function parseContextFile(filename, content, context) {
  const name = filename.toLowerCase().replace(/\.(md|txt)$/, '');
  
  // Parse key: value pairs from content
  const lines = content.split('\n');
  const data = {};
  
  for (const line of lines) {
    // Skip markdown headers and empty lines
    if (line.startsWith('#') || line.trim() === '') continue;
    
    // Match key: value pairs
    const match = line.match(/^(\w+):\s*(.+)$/);
    if (match) {
      const key = match[1].toLowerCase();
      const value = match[2].trim();
      data[key] = value;
    }
  }
  
  // Map to context based on filename
  switch (name) {
    case 'location':
      if (Object.keys(data).length > 0) {
        context.location = {
          city: data.city || null,
          state: data.state || null,
          country: data.country || null,
          zip: data.zip || null,
          coordinates: data.coordinates || data.coords || null
        };
      }
      break;
      
    case 'preferences':
    case 'settings':
      context.preferences = { ...context.preferences, ...data };
      break;
      
    case 'timezone':
    case 'time':
      context.timezone = data.timezone || data.tz || data.zone || null;
      break;
      
    case 'user':
    case 'profile':
      context.user = {
        name: data.name || null,
        email: data.email || null,
        ...data
      };
      break;
      
    default:
      // Store other files in customData
      if (Object.keys(data).length > 0) {
        context.customData[name] = data;
      }
      break;
  }
}

/**
 * Clear cache (call when space is updated)
 */
function clearCache() {
  contextCache = null;
  profileCache = null;
  cacheTimestamp = 0;
  profileCacheTimestamp = 0;
  console.log('[OmniData] Cache cleared');
}

/**
 * Check if the GSX Agent space has any context data
 * @returns {Promise<boolean>}
 */
async function hasContext() {
  const context = await loadContext();
  return Object.keys(context).some(k => {
    const v = context[k];
    return v !== null && (typeof v !== 'object' || Object.keys(v).length > 0);
  });
}

/**
 * Get a summary of available context (for debugging/logging)
 * @returns {Promise<string>}
 */
async function getSummary() {
  const context = await loadContext();
  const profile = await loadAgentProfile();
  const parts = [];
  
  if (context.user?.name) {
    parts.push(`User: ${context.user.name}`);
  }
  if (context.location?.city) {
    parts.push(`Location: ${context.location.city}`);
  }
  if (context.timezone) {
    parts.push(`Timezone: ${context.timezone}`);
  }
  if (context.system?.os) {
    parts.push(`System: ${context.system.os}`);
  }
  if (context.apps && context.apps.length > 0) {
    parts.push(`Apps: ${context.apps.length} installed`);
  }
  if (Object.keys(context.preferences).length > 0) {
    parts.push(`Preferences: ${Object.keys(context.preferences).length} items`);
  }
  if (profile.identity?.name) {
    parts.push(`Agent: ${profile.identity.name}`);
  }
  
  return parts.length > 0 ? parts.join(' | ') : 'No context data';
}

module.exports = { 
  query, 
  getAll, 
  getRelevantContext,
  getAgentProfile,
  clearCache,
  hasContext,
  getSummary,
  CONTEXT_SPACE_ID,
  MAIN_FILE,
  PROFILE_FILE
};
