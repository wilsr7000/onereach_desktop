/**
 * Evaluation Profiles
 * Part of the Governed Self-Improving Agent Runtime
 * 
 * Cost/latency control with Quick, Standard, and Deep profiles
 */

/**
 * Evaluation profile configurations
 */
const EVALUATION_PROFILES = {
  quick: {
    name: 'Quick',
    description: 'Fast evaluation with minimal agents',
    maxAgents: 2,
    useLLMJudge: false,
    multiPass: false,
    timeout: 10000, // 10 seconds
    estimatedDuration: '5-10 seconds',
    costFactor: 0.3,
    
    // Which agents to prioritize
    agentSelection: 'top_performers',
    
    // Skip detailed criteria evaluation
    skipDetailedCriteria: true,
    
    // Use simpler prompts
    promptComplexity: 'simple',
    
    useCase: 'Quick sanity checks, minor edits'
  },
  
  standard: {
    name: 'Standard',
    description: 'Balanced evaluation with moderate depth',
    maxAgents: 4,
    useLLMJudge: true,
    multiPass: false,
    timeout: 30000, // 30 seconds
    estimatedDuration: '15-30 seconds',
    costFactor: 1.0,
    
    agentSelection: 'balanced',
    skipDetailedCriteria: false,
    promptComplexity: 'standard',
    
    useCase: 'Regular code reviews, documentation'
  },
  
  deep: {
    name: 'Deep',
    description: 'Thorough evaluation with all available agents',
    maxAgents: 8,
    useLLMJudge: true,
    multiPass: true,
    timeout: 120000, // 2 minutes
    estimatedDuration: '45-90 seconds',
    costFactor: 2.5,
    
    agentSelection: 'comprehensive',
    skipDetailedCriteria: false,
    promptComplexity: 'detailed',
    
    // Additional deep analysis features
    includeSecurityScan: true,
    includePerformanceAnalysis: true,
    crossAgentValidation: true,
    
    useCase: 'Critical code, security-sensitive changes, major features'
  }
};

/**
 * Profile Manager
 * Manages evaluation profile selection and configuration
 */
class ProfileManager {
  constructor(options = {}) {
    this.defaultProfile = options.defaultProfile || 'standard';
    this.customProfiles = new Map();
    this.profiles = { ...EVALUATION_PROFILES };
  }

  /**
   * Get a profile by name
   * @param {string} name - Profile name
   * @returns {Object} Profile configuration
   */
  getProfile(name) {
    return this.customProfiles.get(name) || this.profiles[name] || this.profiles.standard;
  }

  /**
   * Get the default profile
   * @returns {Object}
   */
  getDefaultProfile() {
    return this.getProfile(this.defaultProfile);
  }

  /**
   * Set the default profile
   * @param {string} name - Profile name
   */
  setDefaultProfile(name) {
    if (!this.profiles[name] && !this.customProfiles.has(name)) {
      throw new Error(`Unknown profile: ${name}`);
    }
    this.defaultProfile = name;
  }

  /**
   * Get all available profiles
   * @returns {Object}
   */
  getAllProfiles() {
    return {
      ...this.profiles,
      ...Object.fromEntries(this.customProfiles)
    };
  }

  /**
   * Create a custom profile
   * @param {string} name - Profile name
   * @param {Object} config - Profile configuration
   */
  createCustomProfile(name, config) {
    // Merge with standard profile as base
    const baseProfile = this.profiles.standard;
    this.customProfiles.set(name, {
      ...baseProfile,
      ...config,
      name,
      isCustom: true
    });
  }

  /**
   * Delete a custom profile
   * @param {string} name - Profile name
   */
  deleteCustomProfile(name) {
    this.customProfiles.delete(name);
    if (this.defaultProfile === name) {
      this.defaultProfile = 'standard';
    }
  }

  /**
   * Select best profile based on context
   * @param {Object} context - Evaluation context
   * @returns {Object} Recommended profile
   */
  selectProfile(context = {}) {
    const { 
      urgency = 'normal',
      complexity = 'moderate',
      securitySensitive = false,
      isProduction = false 
    } = context;

    // Auto-select based on context
    if (urgency === 'high' && !securitySensitive) {
      return this.getProfile('quick');
    }

    if (securitySensitive || isProduction || complexity === 'complex') {
      return this.getProfile('deep');
    }

    if (complexity === 'trivial' || complexity === 'simple') {
      return this.getProfile('quick');
    }

    return this.getProfile('standard');
  }

  /**
   * Estimate evaluation cost for a profile
   * @param {string} profileName - Profile name
   * @param {number} baseCost - Base cost per evaluation
   * @returns {Object} Cost estimate
   */
  estimateCost(profileName, baseCost = 0.01) {
    const profile = this.getProfile(profileName);
    const cost = baseCost * profile.costFactor * profile.maxAgents;
    
    return {
      profile: profileName,
      estimatedCost: cost,
      costFactor: profile.costFactor,
      agentCount: profile.maxAgents,
      breakdown: {
        agents: baseCost * profile.maxAgents,
        llmJudge: profile.useLLMJudge ? baseCost : 0,
        multiPass: profile.multiPass ? cost * 0.5 : 0
      }
    };
  }

  /**
   * Get profile recommendations
   * @returns {Object[]} Recommendations for each profile
   */
  getRecommendations() {
    return Object.values(this.profiles).map(profile => ({
      name: profile.name,
      useCase: profile.useCase,
      estimatedDuration: profile.estimatedDuration,
      costFactor: profile.costFactor
    }));
  }

  /**
   * Validate profile configuration
   * @param {Object} config - Profile configuration
   * @returns {Object} Validation result
   */
  validateProfile(config) {
    const errors = [];

    if (typeof config.maxAgents !== 'number' || config.maxAgents < 1 || config.maxAgents > 10) {
      errors.push('maxAgents must be between 1 and 10');
    }

    if (typeof config.timeout !== 'number' || config.timeout < 5000) {
      errors.push('timeout must be at least 5000ms');
    }

    if (typeof config.costFactor !== 'number' || config.costFactor < 0) {
      errors.push('costFactor must be a positive number');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }
}

module.exports = ProfileManager;
module.exports.ProfileManager = ProfileManager;
module.exports.EVALUATION_PROFILES = EVALUATION_PROFILES;

