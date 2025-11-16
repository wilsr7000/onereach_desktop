/**
 * Agent Explorer API
 * Provides functionality to discover and explore available IDWs and Agents
 */

class AgentExplorerAPI {
    constructor(environment = 'production') {
        this.environment = environment;
        this.baseUrls = {
            production: 'https://api.onereach.ai',
            staging: 'https://api.staging.onereach.ai',
            edison: 'https://api.edison.onereach.ai'
        };
    }

    /**
     * Get the base API URL for the current environment
     */
    getBaseUrl() {
        return this.baseUrls[this.environment] || this.baseUrls.production;
    }

    /**
     * Fetch available IDWs for a given environment
     * @param {string} environment - The environment (production, staging, edison)
     * @returns {Promise<Array>} List of available IDWs
     */
    async fetchAvailableIDWs(environment = null) {
        const env = environment || this.environment;
        
        try {
            // For now, return sample data - in production, this would call the actual API
            // const response = await fetch(`${this.getBaseUrl()}/v1/idws/available`);
            // const data = await response.json();
            
            // Sample IDW data structure
            const sampleIDWs = {
                production: [
                    {
                        id: 'idw-prod-001',
                        name: 'Customer Service Assistant',
                        description: 'AI-powered customer service agent for handling inquiries',
                        environment: 'production',
                        homeUrl: 'https://idw.onereach.ai/customer-service',
                        chatUrl: 'https://chat.onereach.ai/cs-assistant',
                        capabilities: ['chat', 'voice', 'email'],
                        icon: '🤝',
                        category: 'Customer Service'
                    },
                    {
                        id: 'idw-prod-002',
                        name: 'Sales Assistant',
                        description: 'Intelligent sales support agent',
                        environment: 'production',
                        homeUrl: 'https://idw.onereach.ai/sales',
                        chatUrl: 'https://chat.onereach.ai/sales-bot',
                        capabilities: ['chat', 'crm-integration'],
                        icon: '💼',
                        category: 'Sales'
                    },
                    {
                        id: 'idw-prod-003',
                        name: 'HR Assistant',
                        description: 'Human resources support agent',
                        environment: 'production',
                        homeUrl: 'https://idw.onereach.ai/hr',
                        chatUrl: 'https://chat.onereach.ai/hr-assistant',
                        capabilities: ['chat', 'document-processing'],
                        icon: '👥',
                        category: 'Human Resources'
                    }
                ],
                staging: [
                    {
                        id: 'idw-staging-001',
                        name: 'Test Assistant Beta',
                        description: 'Beta version of the test automation assistant',
                        environment: 'staging',
                        homeUrl: 'https://idw.staging.onereach.ai/test-beta',
                        chatUrl: 'https://chat.staging.onereach.ai/test-bot',
                        capabilities: ['chat', 'testing'],
                        icon: '🧪',
                        category: 'Development'
                    },
                    {
                        id: 'idw-staging-002',
                        name: 'Analytics Bot',
                        description: 'Data analysis and reporting agent',
                        environment: 'staging',
                        homeUrl: 'https://idw.staging.onereach.ai/analytics',
                        chatUrl: 'https://chat.staging.onereach.ai/analytics',
                        capabilities: ['chat', 'data-analysis'],
                        icon: '📊',
                        category: 'Analytics'
                    }
                ],
                edison: [
                    {
                        id: 'idw-edison-001',
                        name: 'Edison Dev Assistant',
                        description: 'Development environment assistant',
                        environment: 'edison',
                        homeUrl: 'https://idw.edison.onereach.ai/dev-assistant',
                        chatUrl: 'https://chat.edison.onereach.ai/dev',
                        capabilities: ['chat', 'code-generation'],
                        icon: '💻',
                        category: 'Development'
                    },
                    {
                        id: 'idw-edison-002',
                        name: 'Marvin',
                        description: 'The helpful development bot',
                        environment: 'edison',
                        homeUrl: 'https://idw.edison.onereach.ai/idw-marvin-dev',
                        chatUrl: 'https://flow-desc.chat.edison.onereach.ai/05bd3c92-5d3c-4dc5-a95d-0c584695cea4',
                        capabilities: ['chat', 'workflow'],
                        icon: '🤖',
                        category: 'Development'
                    }
                ]
            };

            return sampleIDWs[env] || [];
        } catch (error) {
            console.error('[AgentExplorer] Error fetching IDWs:', error);
            return [];
        }
    }

    /**
     * Fetch available external AI agents
     * @returns {Promise<Array>} List of available external agents
     */
    async fetchExternalAgents() {
        // Predefined list of popular external AI agents
        return [
            {
                id: 'ext-chatgpt',
                name: 'ChatGPT',
                description: 'OpenAI\'s conversational AI',
                url: 'https://chat.openai.com',
                icon: '🤖',
                category: 'General AI',
                type: 'external'
            },
            {
                id: 'ext-claude',
                name: 'Claude',
                description: 'Anthropic\'s AI assistant',
                url: 'https://claude.ai',
                icon: '🎭',
                category: 'General AI',
                type: 'external'
            },
            {
                id: 'ext-perplexity',
                name: 'Perplexity',
                description: 'AI-powered search engine',
                url: 'https://perplexity.ai',
                icon: '🔍',
                category: 'Search',
                type: 'external'
            },
            {
                id: 'ext-gemini',
                name: 'Google Gemini',
                description: 'Google\'s multimodal AI',
                url: 'https://gemini.google.com',
                icon: '✨',
                category: 'General AI',
                type: 'external'
            },
            {
                id: 'ext-copilot',
                name: 'GitHub Copilot',
                description: 'AI pair programmer',
                url: 'https://github.com/features/copilot',
                icon: '👨‍💻',
                category: 'Development',
                type: 'external'
            }
        ];
    }

    /**
     * Search for agents based on query
     * @param {string} query - Search query
     * @param {Object} filters - Filter options
     * @returns {Promise<Array>} Filtered list of agents
     */
    async searchAgents(query, filters = {}) {
        const allIDWs = [];
        
        // Fetch from all environments if not specified
        if (!filters.environment) {
            for (const env of Object.keys(this.baseUrls)) {
                const idws = await this.fetchAvailableIDWs(env);
                allIDWs.push(...idws);
            }
        } else {
            const idws = await this.fetchAvailableIDWs(filters.environment);
            allIDWs.push(...idws);
        }

        // Add external agents if requested
        if (!filters.type || filters.type === 'external') {
            const externalAgents = await this.fetchExternalAgents();
            allIDWs.push(...externalAgents);
        }

        // Filter by query
        if (query) {
            const lowerQuery = query.toLowerCase();
            return allIDWs.filter(agent => 
                agent.name.toLowerCase().includes(lowerQuery) ||
                agent.description.toLowerCase().includes(lowerQuery) ||
                (agent.category && agent.category.toLowerCase().includes(lowerQuery))
            );
        }

        // Filter by category
        if (filters.category) {
            return allIDWs.filter(agent => agent.category === filters.category);
        }

        return allIDWs;
    }

    /**
     * Get categories of available agents
     * @returns {Promise<Array>} List of categories
     */
    async getCategories() {
        const allAgents = await this.searchAgents('');
        const categories = new Set();
        
        allAgents.forEach(agent => {
            if (agent.category) {
                categories.add(agent.category);
            }
        });
        
        return Array.from(categories).sort();
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { AgentExplorerAPI };
}
