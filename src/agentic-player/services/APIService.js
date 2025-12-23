/**
 * APIService - API communication with retry logic
 * @module src/agentic-player/services/APIService
 */

/**
 * API service class
 */
export class APIService {
  constructor(config) {
    this.config = config;
    this.retryCount = 0;
    this.maxRetries = 3;
    this.retryDelay = 1000; // Start with 1 second
    this.isFetching = false;
  }

  /**
   * Fetch clips from API
   * @param {Object} payload - Request payload
   * @returns {Promise<Object>} API response
   */
  async fetchClips(payload) {
    if (this.isFetching) {
      console.log('[APIService] Already fetching, skipping');
      return null;
    }

    if (!this.config.apiEndpoint) {
      throw new Error('No API endpoint configured');
    }

    this.isFetching = true;
    console.log('[APIService] Fetching clips...');

    try {
      const response = await fetch(this.config.apiEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.apiKey && { 'Authorization': `Bearer ${this.config.apiKey}` }),
          ...this.config.apiHeaders
        },
        body: JSON.stringify({
          ...payload,
          context: this.config.context
        })
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      const data = await response.json();
      console.log('[APIService] Response:', data);

      // Reset retry count on success
      this.retryCount = 0;
      this.isFetching = false;

      return data;

    } catch (error) {
      console.error('[APIService] Error:', error);

      // Retry logic
      if (this.retryCount < this.maxRetries) {
        this.retryCount++;
        const delay = this.retryDelay * Math.pow(2, this.retryCount - 1);
        
        console.log(`[APIService] Retrying in ${delay}ms (${this.retryCount}/${this.maxRetries})`);
        
        await this.sleep(delay);
        this.isFetching = false;
        return this.fetchClips(payload);
      }

      // Max retries exceeded
      this.retryCount = 0;
      this.isFetching = false;
      throw error;
    }
  }

  /**
   * Sleep for specified duration
   * @param {number} ms - Milliseconds
   * @returns {Promise} Resolves after delay
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Reset retry count
   */
  resetRetries() {
    this.retryCount = 0;
  }

  /**
   * Check if currently fetching
   */
  get fetching() {
    return this.isFetching;
  }
}
















