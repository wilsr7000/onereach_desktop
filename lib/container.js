/**
 * Service Container
 * Part of the Governed Self-Improving Agent Runtime
 * 
 * Centralized dependency injection for testability
 */

class ServiceContainer {
  constructor() {
    this.services = new Map();
    this.mocks = new Map();
    this.singletons = new Map();
  }

  /**
   * Register a service factory
   * @param {string} name - Service name
   * @param {Function} factory - Factory function that creates the service
   * @param {Object} options - Options like { singleton: true }
   */
  register(name, factory, options = {}) {
    this.services.set(name, { factory, options });
  }

  /**
   * Register a mock implementation (for testing)
   * @param {string} name - Service name
   * @param {*} mockImpl - Mock implementation
   */
  mock(name, mockImpl) {
    this.mocks.set(name, mockImpl);
  }

  /**
   * Get a service instance
   * @param {string} name - Service name
   * @returns {*} Service instance or mock
   */
  get(name) {
    // Mocks take priority (for testing)
    if (this.mocks.has(name)) {
      return this.mocks.get(name);
    }

    const registration = this.services.get(name);
    if (!registration) {
      return undefined;
    }

    const { factory, options } = registration;

    // Return singleton if already created
    if (options.singleton && this.singletons.has(name)) {
      return this.singletons.get(name);
    }

    // Create new instance
    const instance = factory(this);

    // Store as singleton if configured
    if (options.singleton) {
      this.singletons.set(name, instance);
    }

    return instance;
  }

  /**
   * Check if a service is registered
   * @param {string} name - Service name
   * @returns {boolean}
   */
  has(name) {
    return this.services.has(name) || this.mocks.has(name);
  }

  /**
   * Reset all mocks (call between tests)
   */
  resetMocks() {
    this.mocks.clear();
  }

  /**
   * Reset singletons (for testing)
   */
  resetSingletons() {
    this.singletons.clear();
  }

  /**
   * Reset everything
   */
  reset() {
    this.resetMocks();
    this.resetSingletons();
  }

  /**
   * Get all registered service names
   * @returns {string[]}
   */
  getRegisteredServices() {
    return [...this.services.keys()];
  }
}

// Create singleton container instance
const container = new ServiceContainer();

// Register default services
container.register('fs', () => require('fs'), { singleton: true });
container.register('path', () => require('path'), { singleton: true });
container.register('crypto', () => require('crypto'), { singleton: true });

module.exports = container;
module.exports.ServiceContainer = ServiceContainer;


