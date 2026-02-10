/**
 * RatingStorage.js - Rating Storage System
 * 
 * Handles storage of project ratings:
 * - Per-project metadata storage
 * - Global trends database
 * - Progress tracking across projects
 */

const { getLogQueue } = require('../../../lib/log-event-queue');
const log = getLogQueue();
/**
 * Storage keys
 */
const STORAGE_KEYS = {
  RATINGS: 'project_ratings',
  TRENDS: 'rating_trends',
  SETTINGS: 'rating_settings'
};

/**
 * RatingStorage - Persistent rating storage
 */
export class RatingStorage {
  constructor() {
    // In-memory cache
    this.ratingsCache = new Map();
    this.trendsCache = null;
    
    // Initialize
    this.loadFromStorage();
  }

  /**
   * Load data from storage
   */
  loadFromStorage() {
    try {
      // Load ratings
      const ratingsData = localStorage.getItem(STORAGE_KEYS.RATINGS);
      if (ratingsData) {
        const ratings = JSON.parse(ratingsData);
        ratings.forEach(r => {
          this.ratingsCache.set(r.projectId, r);
        });
      }
      
      // Load trends
      const trendsData = localStorage.getItem(STORAGE_KEYS.TRENDS);
      if (trendsData) {
        this.trendsCache = JSON.parse(trendsData);
      } else {
        this.trendsCache = this.initializeTrends();
      }
    } catch (e) {
      log.warn('video', '[RatingStorage] Failed to load from storage', { data: e });
      this.trendsCache = this.initializeTrends();
    }
  }

  /**
   * Initialize trends structure
   * @returns {Object} Initial trends
   */
  initializeTrends() {
    return {
      totalRatings: 0,
      byTemplate: {},
      averageByTemplate: {},
      lastUpdated: null
    };
  }

  /**
   * Save rating to storage
   * @param {Object} rating - Rating object
   * @returns {Promise<void>}
   */
  async saveRating(rating) {
    // Add to cache
    this.ratingsCache.set(rating.projectId, rating);
    
    // Update trends
    this.updateTrends(rating);
    
    // Persist to storage
    this.persistRatings();
    this.persistTrends();
    
    return rating;
  }

  /**
   * Get rating by project ID
   * @param {string} projectId - Project ID
   * @returns {Object|null} Rating
   */
  getRating(projectId) {
    return this.ratingsCache.get(projectId) || null;
  }

  /**
   * Get all ratings
   * @param {string} templateId - Optional template filter
   * @returns {Array} Ratings
   */
  getAllRatings(templateId = null) {
    const ratings = Array.from(this.ratingsCache.values());
    
    if (templateId) {
      return ratings.filter(r => r.templateId === templateId)
        .sort((a, b) => new Date(a.ratedAt) - new Date(b.ratedAt));
    }
    
    return ratings.sort((a, b) => new Date(a.ratedAt) - new Date(b.ratedAt));
  }

  /**
   * Get recent ratings
   * @param {number} limit - Number of ratings
   * @returns {Array} Recent ratings
   */
  getRecentRatings(limit = 10) {
    return Array.from(this.ratingsCache.values())
      .sort((a, b) => new Date(b.ratedAt) - new Date(a.ratedAt))
      .slice(0, limit);
  }

  /**
   * Delete rating
   * @param {string} projectId - Project ID
   * @returns {boolean} Success
   */
  deleteRating(projectId) {
    if (this.ratingsCache.has(projectId)) {
      this.ratingsCache.delete(projectId);
      this.recalculateTrends();
      this.persistRatings();
      this.persistTrends();
      return true;
    }
    return false;
  }

  /**
   * Update trends with new rating
   * @param {Object} rating - New rating
   */
  updateTrends(rating) {
    const templateId = rating.templateId;
    
    // Update total count
    this.trendsCache.totalRatings = this.ratingsCache.size;
    
    // Update by template
    if (!this.trendsCache.byTemplate[templateId]) {
      this.trendsCache.byTemplate[templateId] = {
        count: 0,
        scores: [],
        average: 0
      };
    }
    
    const templateTrend = this.trendsCache.byTemplate[templateId];
    templateTrend.count++;
    templateTrend.scores.push(rating.overall.score);
    templateTrend.average = templateTrend.scores.reduce((a, b) => a + b, 0) / templateTrend.scores.length;
    
    // Update averages
    this.trendsCache.averageByTemplate[templateId] = templateTrend.average;
    
    this.trendsCache.lastUpdated = new Date().toISOString();
  }

  /**
   * Recalculate all trends
   */
  recalculateTrends() {
    this.trendsCache = this.initializeTrends();
    
    this.ratingsCache.forEach(rating => {
      this.updateTrends(rating);
    });
  }

  /**
   * Get trends data
   * @returns {Object} Trends
   */
  getTrends() {
    return { ...this.trendsCache };
  }

  /**
   * Get trend for template
   * @param {string} templateId - Template ID
   * @returns {Object|null} Template trend
   */
  getTemplateTrend(templateId) {
    return this.trendsCache.byTemplate[templateId] || null;
  }

  /**
   * Get progress over time
   * @param {string} templateId - Optional template filter
   * @param {number} limit - Number of data points
   * @returns {Array} Progress data
   */
  getProgressOverTime(templateId = null, limit = 10) {
    const ratings = this.getAllRatings(templateId);
    
    return ratings.slice(-limit).map(r => ({
      date: r.ratedAt,
      score: r.overall.score,
      projectName: r.projectName,
      templateId: r.templateId
    }));
  }

  /**
   * Get improvement areas
   * @param {string} templateId - Template ID
   * @returns {Object} Improvement analysis
   */
  getImprovementAreas(templateId) {
    const ratings = this.getAllRatings(templateId);
    if (ratings.length < 2) return null;
    
    // Analyze criteria trends
    const criteriaHistory = {};
    
    ratings.forEach(r => {
      r.criteria.forEach(c => {
        if (!criteriaHistory[c.id]) {
          criteriaHistory[c.id] = {
            name: c.name,
            scores: [],
            trend: 0
          };
        }
        criteriaHistory[c.id].scores.push(c.score);
      });
    });
    
    // Calculate trends for each criterion
    Object.values(criteriaHistory).forEach(ch => {
      if (ch.scores.length >= 2) {
        const recent = ch.scores.slice(-3);
        const older = ch.scores.slice(-6, -3);
        
        if (recent.length > 0 && older.length > 0) {
          const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
          const olderAvg = older.reduce((a, b) => a + b, 0) / older.length;
          ch.trend = recentAvg - olderAvg;
        }
      }
    });
    
    // Sort by trend to find improving and declining
    const sorted = Object.values(criteriaHistory).sort((a, b) => b.trend - a.trend);
    
    return {
      improving: sorted.filter(c => c.trend > 0.3).slice(0, 3),
      declining: sorted.filter(c => c.trend < -0.3).slice(0, 3),
      stable: sorted.filter(c => Math.abs(c.trend) <= 0.3)
    };
  }

  /**
   * Get statistics summary
   * @returns {Object} Statistics
   */
  getStatistics() {
    const ratings = Array.from(this.ratingsCache.values());
    
    if (ratings.length === 0) {
      return {
        totalProjects: 0,
        averageScore: 0,
        highestScore: 0,
        lowestScore: 0,
        improvement: 0
      };
    }
    
    const scores = ratings.map(r => r.overall.score);
    
    return {
      totalProjects: ratings.length,
      averageScore: Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10,
      highestScore: Math.max(...scores),
      lowestScore: Math.min(...scores),
      improvement: this.calculateOverallImprovement(ratings)
    };
  }

  /**
   * Calculate overall improvement
   * @param {Array} ratings - All ratings
   * @returns {number} Improvement score
   */
  calculateOverallImprovement(ratings) {
    if (ratings.length < 2) return 0;
    
    const sorted = ratings.sort((a, b) => new Date(a.ratedAt) - new Date(b.ratedAt));
    const firstHalf = sorted.slice(0, Math.floor(sorted.length / 2));
    const secondHalf = sorted.slice(Math.floor(sorted.length / 2));
    
    const firstAvg = firstHalf.reduce((sum, r) => sum + r.overall.score, 0) / firstHalf.length;
    const secondAvg = secondHalf.reduce((sum, r) => sum + r.overall.score, 0) / secondHalf.length;
    
    return Math.round((secondAvg - firstAvg) * 10) / 10;
  }

  /**
   * Export all data
   * @returns {Object} All data
   */
  exportAll() {
    return {
      ratings: Array.from(this.ratingsCache.values()),
      trends: this.trendsCache,
      exportedAt: new Date().toISOString()
    };
  }

  /**
   * Import data
   * @param {Object} data - Data to import
   */
  importData(data) {
    if (data.ratings) {
      data.ratings.forEach(r => {
        this.ratingsCache.set(r.projectId, r);
      });
    }
    
    this.recalculateTrends();
    this.persistRatings();
    this.persistTrends();
  }

  /**
   * Clear all data
   */
  clearAll() {
    this.ratingsCache.clear();
    this.trendsCache = this.initializeTrends();
    
    localStorage.removeItem(STORAGE_KEYS.RATINGS);
    localStorage.removeItem(STORAGE_KEYS.TRENDS);
  }

  /**
   * Persist ratings to storage
   */
  persistRatings() {
    try {
      const ratings = Array.from(this.ratingsCache.values());
      localStorage.setItem(STORAGE_KEYS.RATINGS, JSON.stringify(ratings));
    } catch (e) {
      log.error('video', '[RatingStorage] Failed to persist ratings', { error: e });
    }
  }

  /**
   * Persist trends to storage
   */
  persistTrends() {
    try {
      localStorage.setItem(STORAGE_KEYS.TRENDS, JSON.stringify(this.trendsCache));
    } catch (e) {
      log.error('video', '[RatingStorage] Failed to persist trends', { error: e });
    }
  }
}

export default RatingStorage;











