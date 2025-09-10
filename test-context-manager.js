/**
 * Global Test Context Manager
 * 
 * This module provides a global context for test execution that can be used
 * to automatically tag all logs with the current test information.
 */

class TestContextManager {
    constructor() {
        this.currentContext = null;
        this.contextStack = [];
    }

    /**
     * Set the current test context
     * @param {Object} context - Test context information
     * @param {string} context.testId - Unique test identifier
     * @param {string} context.testName - Human-readable test name
     * @param {string} context.testCategory - Test category (core, auth, spaces, etc.)
     * @param {string} context.testArea - Specific area being tested
     * @param {number} context.testIndex - Current test index
     * @param {number} context.totalTests - Total number of tests
     */
    setContext(context) {
        this.currentContext = {
            ...context,
            startTime: Date.now()
        };
        
        // Also set as global for other modules to access
        if (global) {
            global.currentTestContext = this.currentContext;
        }
    }

    /**
     * Push a new context onto the stack (for nested operations)
     */
    pushContext(context) {
        if (this.currentContext) {
            this.contextStack.push(this.currentContext);
        }
        this.setContext(context);
    }

    /**
     * Pop the previous context from the stack
     */
    popContext() {
        if (this.contextStack.length > 0) {
            this.currentContext = this.contextStack.pop();
            if (global) {
                global.currentTestContext = this.currentContext;
            }
        } else {
            this.clearContext();
        }
    }

    /**
     * Clear the current test context
     */
    clearContext() {
        this.currentContext = null;
        if (global) {
            global.currentTestContext = null;
        }
    }

    /**
     * Get the current test context
     */
    getContext() {
        return this.currentContext;
    }

    /**
     * Add test context to log data
     */
    enrichLogData(data = {}) {
        if (!this.currentContext) {
            return data;
        }

        return {
            ...data,
            testContext: {
                testId: this.currentContext.testId,
                testName: this.currentContext.testName,
                testCategory: this.currentContext.testCategory,
                testArea: this.currentContext.testArea,
                testIndex: this.currentContext.testIndex,
                totalTests: this.currentContext.totalTests,
                duration: Date.now() - this.currentContext.startTime
            }
        };
    }

    /**
     * Check if we're currently in a test context
     */
    isInTestContext() {
        return this.currentContext !== null;
    }

    /**
     * Get a formatted test identifier for logging
     */
    getTestIdentifier() {
        if (!this.currentContext) {
            return null;
        }

        return `[Test ${this.currentContext.testIndex}/${this.currentContext.totalTests}] ${this.currentContext.testName} (${this.currentContext.testId})`;
    }
}

// Create singleton instance
const testContextManager = new TestContextManager();

// Export for use in other modules
module.exports = testContextManager; 