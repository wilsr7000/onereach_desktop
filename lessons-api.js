// Lessons API Service Module
const { net } = require('electron');
const https = require('https');
const { URL } = require('url');
const getLogger = require('./event-logger');

class LessonsAPI {
  constructor() {
    // Default OneReach API endpoint for quick starts
    this.defaultUrl = 'https://em.staging.api.onereach.ai/http/48cc49ef-ab05-4d51-acc6-559c7ff22150/idw_quick_starts';
    this.baseUrl = null; // Will be set from settings
    this.method = 'POST'; // Default method
    this.cache = new Map();
    this.cacheExpiry = 5 * 60 * 1000; // 5 minutes cache
    this.cacheEnabled = true; // Default cache enabled
    
    // Load settings on initialization
    this.loadSettings();
  }
  
  /**
   * Load settings from the global settings manager
   */
  loadSettings() {
    try {
      // Try to get settings from global settings manager if available
      if (global && global.settingsManager) {
        const settings = global.settingsManager.get();
        this.baseUrl = settings.learningApiUrl || this.defaultUrl;
        this.method = settings.learningApiMethod || 'POST';
        this.cacheEnabled = settings.learningApiCache !== false;
        
        // Parse URL to separate base and path
        if (this.baseUrl.includes('/idw_quick_starts')) {
          this.baseUrl = this.baseUrl.replace('/idw_quick_starts', '');
        }
      } else {
        // Fallback to defaults
        this.baseUrl = this.defaultUrl.replace('/idw_quick_starts', '');
      }
    } catch (error) {
      const logger = getLogger();
      logger.warn('LessonsAPI settings load failed, using defaults', {
        error: error.message
      });
      this.baseUrl = this.defaultUrl.replace('/idw_quick_starts', '');
    }
  }
  
  /**
   * Set custom API base URL
   */
  setBaseUrl(url) {
    this.baseUrl = url;
  }
  
  /**
   * Get cached data if available and not expired
   */
  getCached(key) {
    // Check if caching is enabled
    if (!this.cacheEnabled) {
      return null;
    }
    
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.timestamp < this.cacheExpiry) {
      const logger = getLogger();
      logger.debug('LessonsAPI cache hit', { key });
      return cached.data;
    }
    return null;
  }
  
  /**
   * Store data in cache
   */
  setCache(key, data) {
    this.cache.set(key, {
      data,
      timestamp: Date.now()
    });
  }
  
  /**
   * Fetch lessons for a specific user
   * @param {string} userId - The user ID to fetch lessons for
   * @returns {Promise<Object>} Lesson data
   */
  async fetchUserLessons(userId) {
    // Reload settings in case they changed
    this.loadSettings();
    
    const cacheKey = `lessons_${userId}`;
    const cached = this.getCached(cacheKey);
    
    if (cached) {
      return cached;
    }
    
    const logger = getLogger();
    try {
      // Fetching lessons from OneReach API
      logger.info('LessonsAPI request', {
        event: 'api:request',
        provider: 'onereach',
        endpoint: '/idw_quick_starts',
        method: this.method
      });
      
      // Prepare request options based on method
      const requestOptions = {
        method: this.method,
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        }
      };
      
      // Add body for POST requests
      if (this.method === 'POST') {
        requestOptions.body = {};  // API may require POST with body (can be empty)
      }
      
      // Call the actual OneReach API endpoint
      const response = await this.makeApiCall('/idw_quick_starts', requestOptions);
      
      // Successfully received response from OneReach API
      
      // The API returns data in our exact format!
      const data = response;
      
      // Cache the response if caching is enabled
      if (this.cacheEnabled) {
        this.setCache(cacheKey, data);
      }
      
      return data;
    } catch (error) {
      logger.logAPIError('/idw_quick_starts', error, {
        provider: 'onereach',
        operation: 'fetchUserLessons',
        userId
      });
      logger.info('LessonsAPI falling back to mock data', {
        reason: error.message
      });
      
      // Fallback to mock data if API fails
      const mockData = await this.getMockLessonsData(userId);
      if (this.cacheEnabled) {
        this.setCache(cacheKey, mockData);
      }
      return mockData;
    }
  }
  
  /**
   * Make an API call to OneReach endpoint
   */
  async makeApiCall(endpoint, options = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(`${this.baseUrl}${endpoint}`);
      const requestStartTime = Date.now();
      
      const requestOptions = {
        method: options.method || 'GET',
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': 'OneReach-Desktop/1.0',
          'Origin': 'file://',
          ...options.headers
        }
      };
      
      const req = https.request(requestOptions, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          const logger = getLogger();
          try {
            // Response received
            
            if (res.statusCode >= 200 && res.statusCode < 300) {
              const jsonData = JSON.parse(data);
              logger.logNetworkRequest(options.method || 'GET', endpoint, res.statusCode, Date.now() - requestStartTime);
              resolve(jsonData);
            } else {
              logger.logAPIError(endpoint, new Error(`API error: ${res.statusCode}`), {
                provider: 'onereach',
                statusCode: res.statusCode
              });
              reject(new Error(`API error: ${res.statusCode}`));
            }
          } catch (error) {
            logger.logAPIError(endpoint, error, {
              provider: 'onereach',
              parseError: true
            });
            reject(new Error(`Failed to parse API response: ${error.message}`));
          }
        });
      });
      
      req.on('error', (error) => {
        const logger = getLogger();
        logger.logAPIError(endpoint, error, {
          provider: 'onereach',
          networkError: true
        });
        reject(error);
      });
      
      // Set timeout
      req.setTimeout(30000, () => {
        req.abort();
        reject(new Error('Request timeout'));
      });
      
      if (options.body) {
        req.write(JSON.stringify(options.body));
      }
      
      req.end();
    });
  }
  
  /**
   * Get mock lessons data (temporary until real API is available)
   */
  async getMockLessonsData(userId) {
    // Simulate API delay
    await new Promise(resolve => setTimeout(resolve, 500));
    
    return {
      user: {
        id: userId,
        name: "User",
        progress: {
          completed: 12,
          inProgress: 3,
          total: 45
        }
      },
      featured: [
        {
          id: "feat-1",
          title: "Welcome to OneReach",
          description: "Get started with the basics of OneReach platform and discover its powerful features",
          duration: "15 min",
          category: "getting-started",
          url: "https://learning.staging.onereach.ai/courses/welcome",
          thumbnail: { type: "gradient", colors: ["#667eea", "#764ba2"] },
          featured: true,
          progress: 0
        },
        {
          id: "feat-2",
          title: "Building Your First Agent",
          description: "Step-by-step guide to creating and deploying your first intelligent agent",
          duration: "25 min",
          category: "getting-started",
          url: "https://learning.staging.onereach.ai/courses/first-agent",
          thumbnail: { type: "gradient", colors: ["#f093fb", "#f5576c"] },
          featured: true,
          progress: 30,
          recommended: true
        },
        {
          id: "feat-3",
          title: "Advanced Workflows",
          description: "Master complex automation workflows and orchestration patterns",
          duration: "45 min",
          category: "advanced",
          url: "https://learning.staging.onereach.ai/courses/advanced-workflows",
          thumbnail: { type: "gradient", colors: ["#4facfe", "#00f2fe"] },
          featured: true,
          progress: 0
        }
      ],
      categories: {
        "getting-started": {
          name: "Getting Started",
          lessons: [
            {
              id: "gs-1",
              title: "Platform Overview",
              description: "Introduction to the OneReach platform interface and navigation",
              duration: "12 min",
              url: "https://learning.staging.onereach.ai/courses/intro-to-onereach",
              thumbnail: { type: "gradient", colors: ["#667eea", "#764ba2"] },
              progress: 100,
              completed: true
            },
            {
              id: "gs-2",
              title: "Your First Project",
              description: "Create your first project and understand the basics",
              duration: "8 min",
              url: "https://learning.staging.onereach.ai/courses/first-project",
              thumbnail: { type: "gradient", colors: ["#fa709a", "#fee140"] },
              progress: 100,
              completed: true
            },
            {
              id: "gs-3",
              title: "Environment Setup",
              description: "Configure your development environment for optimal productivity",
              duration: "15 min",
              url: "https://learning.staging.onereach.ai/courses/environment-setup",
              thumbnail: { type: "gradient", colors: ["#a8edea", "#fed6e3"] },
              progress: 60,
              inProgress: true
            },
            {
              id: "gs-4",
              title: "Understanding Workspaces",
              description: "Learn how to organize your projects with workspaces",
              duration: "10 min",
              url: "https://learning.staging.onereach.ai/courses/workspaces",
              thumbnail: { type: "gradient", colors: ["#ffecd2", "#fcb69f"] },
              progress: 0,
              new: true
            }
          ]
        },
        "workflows": {
          name: "Workflows",
          lessons: [
            {
              id: "wf-1",
              title: "Workflow Fundamentals",
              description: "Understanding nodes, connections, and data flow",
              duration: "20 min",
              url: "https://learning.staging.onereach.ai/courses/workflow-basics",
              thumbnail: { type: "gradient", colors: ["#ffecd2", "#fcb69f"] },
              progress: 75,
              inProgress: true
            },
            {
              id: "wf-2",
              title: "Conditional Logic",
              description: "Implementing decision trees and branching logic",
              duration: "18 min",
              url: "https://learning.staging.onereach.ai/courses/conditional-logic",
              thumbnail: { type: "gradient", colors: ["#a1c4fd", "#c2e9fb"] },
              progress: 0,
              recommended: true
            },
            {
              id: "wf-3",
              title: "Data Transformation",
              description: "Transform and manipulate data within your workflows",
              duration: "25 min",
              url: "https://learning.staging.onereach.ai/courses/data-transformation",
              thumbnail: { type: "gradient", colors: ["#d299c2", "#fef9d7"] },
              progress: 0
            },
            {
              id: "wf-4",
              title: "Error Handling",
              description: "Best practices for handling errors in workflows",
              duration: "15 min",
              url: "https://learning.staging.onereach.ai/courses/error-handling",
              thumbnail: { type: "gradient", colors: ["#89f7fe", "#66a6ff"] },
              progress: 0,
              new: true
            },
            {
              id: "wf-5",
              title: "Parallel Processing",
              description: "Execute multiple workflow branches simultaneously",
              duration: "22 min",
              url: "https://learning.staging.onereach.ai/courses/parallel-processing",
              thumbnail: { type: "gradient", colors: ["#fddb92", "#d1fdff"] },
              progress: 0
            }
          ]
        },
        "integrations": {
          name: "Integrations",
          lessons: [
            {
              id: "int-1",
              title: "API Integration",
              description: "Connect external APIs and services to your workflows",
              duration: "30 min",
              url: "https://learning.staging.onereach.ai/courses/api-integration",
              thumbnail: { type: "gradient", colors: ["#89f7fe", "#66a6ff"] },
              progress: 25,
              inProgress: true
            },
            {
              id: "int-2",
              title: "Database Connections",
              description: "Connect and query databases in your applications",
              duration: "22 min",
              url: "https://learning.staging.onereach.ai/courses/database-connections",
              thumbnail: { type: "gradient", colors: ["#fddb92", "#d1fdff"] },
              progress: 0
            },
            {
              id: "int-3",
              title: "Webhooks",
              description: "Set up and manage webhook integrations",
              duration: "15 min",
              url: "https://learning.staging.onereach.ai/courses/webhooks",
              thumbnail: { type: "gradient", colors: ["#9890e3", "#b1f4cf"] },
              progress: 0
            },
            {
              id: "int-4",
              title: "OAuth Authentication",
              description: "Implement secure OAuth flows for third-party services",
              duration: "28 min",
              url: "https://learning.staging.onereach.ai/courses/oauth",
              thumbnail: { type: "gradient", colors: ["#f093fb", "#f5576c"] },
              progress: 0,
              recommended: true
            }
          ]
        },
        "advanced": {
          name: "Advanced Topics",
          lessons: [
            {
              id: "adv-1",
              title: "Performance Optimization",
              description: "Optimize your workflows for maximum performance",
              duration: "35 min",
              url: "https://learning.staging.onereach.ai/courses/performance",
              thumbnail: { type: "gradient", colors: ["#4facfe", "#00f2fe"] },
              progress: 0
            },
            {
              id: "adv-2",
              title: "Custom Components",
              description: "Build reusable custom components for your workflows",
              duration: "40 min",
              url: "https://learning.staging.onereach.ai/courses/custom-components",
              thumbnail: { type: "gradient", colors: ["#fa709a", "#fee140"] },
              progress: 0
            },
            {
              id: "adv-3",
              title: "Security Best Practices",
              description: "Implement security best practices in your applications",
              duration: "30 min",
              url: "https://learning.staging.onereach.ai/courses/security",
              thumbnail: { type: "gradient", colors: ["#667eea", "#764ba2"] },
              progress: 0,
              new: true
            }
          ]
        }
      },
      recommendations: [
        "wf-2", // Conditional Logic
        "int-4", // OAuth Authentication
        "feat-2" // Building Your First Agent
      ],
      recentlyViewed: ["gs-1", "gs-2", "wf-1", "int-1", "gs-3"],
      continueWatching: ["gs-3", "wf-1", "int-1"]
    };
  }
}

// Export singleton instance
module.exports = new LessonsAPI();
