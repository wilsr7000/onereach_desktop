/**
 * ProjectRating.js - Project Rating & Retrospective System
 * 
 * Features:
 * - Generic rating criteria per content template
 * - Custom user-defined criteria
 * - Improvement suggestions (immediate + content)
 * - "Next time" lessons learned
 * - Progress tracking across projects
 */

import { getRatingCriteria, getTemplate } from './ContentTemplates.js';

/**
 * Default rating scale
 */
const RATING_SCALE = {
  MIN: 1,
  MAX: 10,
  PASS_THRESHOLD: 6
};

/**
 * ProjectRating - Rate projects and track progress
 */
export class ProjectRating {
  constructor(appContext, ratingStorage) {
    this.app = appContext;
    this.storage = ratingStorage;
    
    // Current rating state
    this.currentRating = null;
    this.customCriteria = [];
    this.projectGoals = '';
    
    // Event listeners
    this.eventListeners = {};
  }

  /**
   * Rate a project using template criteria
   * @param {Object} projectData - Project data to rate
   * @param {string} templateId - Template ID for criteria
   * @param {Object} analysisResults - Optional analysis results (hooks, ZZZ, energy)
   * @returns {Promise<Object>} Rating result
   */
  async rateProject(projectData, templateId, analysisResults = {}) {
    const template = getTemplate(templateId);
    const criteria = getRatingCriteria(templateId);
    
    if (!criteria || criteria.length === 0) {
      throw new Error(`No rating criteria for template: ${templateId}`);
    }
    
    this.emit('ratingStarted', { projectData, templateId });
    
    try {
      // Rate each criterion
      const criteriaScores = await this.rateCriteria(criteria, projectData, analysisResults);
      
      // Calculate overall score
      const overallScore = this.calculateOverallScore(criteriaScores);
      
      // Get previous scores for trend
      const history = await this.getProjectHistory(templateId);
      const trend = this.calculateTrend(overallScore, history);
      
      // Generate improvements
      const improvements = this.generateImprovements(criteriaScores, analysisResults);
      
      // Generate "next time" lessons
      const nextTime = this.generateNextTimeLessons(criteriaScores, analysisResults);
      
      // Build rating result
      this.currentRating = {
        projectId: projectData.id || `project-${Date.now()}`,
        projectName: projectData.name || 'Untitled',
        videoPath: projectData.videoPath,
        templateId,
        ratedAt: new Date().toISOString(),
        
        overall: {
          score: overallScore,
          trend: trend.change,
          trendDirection: trend.direction,
          percentile: await this.calculatePercentile(overallScore, templateId)
        },
        
        criteria: criteriaScores,
        
        improvements,
        nextTime,
        
        history: {
          previousScores: history.map(h => h.overall.score),
          averageImprovement: trend.averageImprovement,
          strongestAreas: this.findStrongestAreas(criteriaScores),
          needsWork: this.findWeakestAreas(criteriaScores)
        },
        
        customCriteria: this.customCriteria.length > 0 ? 
          await this.rateCustomCriteria(projectData, analysisResults) : null
      };
      
      // Save rating
      if (this.storage) {
        await this.storage.saveRating(this.currentRating);
      }
      
      this.emit('ratingComplete', { rating: this.currentRating });
      
      return this.currentRating;
      
    } catch (error) {
      this.emit('ratingError', { error });
      throw error;
    }
  }

  /**
   * Rate each criterion
   * @param {Array} criteria - Criteria definitions
   * @param {Object} projectData - Project data
   * @param {Object} analysisResults - Analysis results
   * @returns {Promise<Array>} Criterion scores
   */
  async rateCriteria(criteria, projectData, analysisResults) {
    const scores = [];
    
    for (const criterion of criteria) {
      const score = await this.rateSingleCriterion(criterion, projectData, analysisResults);
      scores.push({
        id: criterion.id,
        name: criterion.name,
        weight: criterion.weight,
        score: score.value,
        positives: score.positives,
        issues: score.issues,
        suggestions: score.suggestions
      });
    }
    
    return scores;
  }

  /**
   * Rate a single criterion
   * @param {Object} criterion - Criterion definition
   * @param {Object} projectData - Project data
   * @param {Object} analysisResults - Analysis results
   * @returns {Promise<Object>} Score with details
   */
  async rateSingleCriterion(criterion, projectData, analysisResults) {
    const result = {
      value: 5, // Default mid-score
      positives: [],
      issues: [],
      suggestions: []
    };
    
    // Use analysis results if available
    switch (criterion.id) {
      case 'hook_strength':
      case 'attention_grab':
        if (analysisResults.hooks?.currentOpeningScore) {
          result.value = analysisResults.hooks.currentOpeningScore.score;
          if (result.value >= 7) {
            result.positives.push('Strong opening hook');
          } else {
            result.issues.push(...(analysisResults.hooks.currentOpeningScore.issues || []));
            if (analysisResults.hooks.openingSuggestion?.hook) {
              result.suggestions.push(analysisResults.hooks.openingSuggestion.recommendation);
            }
          }
        }
        break;
        
      case 'pacing':
      case 'pacing_energy':
        if (analysisResults.energy?.pacing) {
          const pacing = analysisResults.energy.pacing;
          result.value = Math.round(pacing.overallVariation / 10);
          
          if (pacing.energyArc === 'building' || pacing.energyArc === 'wave') {
            result.positives.push(`Good ${pacing.energyArc} energy arc`);
          }
          if (pacing.valleyPercentage > 15) {
            result.issues.push(`${pacing.valleyPercentage}% low-energy sections`);
          }
        }
        break;
        
      case 'audio_quality':
        if (analysisResults.zzz?.sections) {
          const zzzTime = analysisResults.zzz.totalZZZTime || 0;
          const percentage = analysisResults.zzz.percentageOfVideo || 0;
          
          result.value = Math.max(1, 10 - Math.floor(percentage / 5));
          
          if (percentage < 10) {
            result.positives.push('Good audio consistency');
          } else {
            result.issues.push(`${percentage.toFixed(0)}% has audio issues`);
          }
        }
        break;
        
      case 'value_delivery':
      case 'clarity':
        // Use transcript analysis if available
        if (projectData.transcript) {
          // Simple heuristic: longer, structured content = better value
          const wordCount = projectData.transcript.split(/\s+/).length;
          if (wordCount > 500) {
            result.value = 7;
            result.positives.push('Substantial content');
          }
        }
        break;
        
      default:
        // Default scoring based on analysis presence
        if (analysisResults.hooks || analysisResults.energy) {
          result.value = 6; // Has been analyzed
        }
    }
    
    return result;
  }

  /**
   * Calculate overall score from criteria
   * @param {Array} criteriaScores - Individual criterion scores
   * @returns {number} Overall score
   */
  calculateOverallScore(criteriaScores) {
    let weightedSum = 0;
    let totalWeight = 0;
    
    criteriaScores.forEach(cs => {
      weightedSum += cs.score * cs.weight;
      totalWeight += cs.weight;
    });
    
    return totalWeight > 0 ? Math.round((weightedSum / totalWeight) * 10) / 10 : 0;
  }

  /**
   * Calculate trend from history
   * @param {number} currentScore - Current score
   * @param {Array} history - Previous ratings
   * @returns {Object} Trend data
   */
  calculateTrend(currentScore, history) {
    if (history.length === 0) {
      return { change: 0, direction: 'new', averageImprovement: 0 };
    }
    
    const lastScore = history[history.length - 1]?.overall?.score || 0;
    const change = currentScore - lastScore;
    
    // Calculate average improvement
    let totalImprovement = 0;
    for (let i = 1; i < history.length; i++) {
      totalImprovement += (history[i].overall?.score || 0) - (history[i - 1].overall?.score || 0);
    }
    totalImprovement += change;
    const averageImprovement = history.length > 0 ? totalImprovement / history.length : change;
    
    return {
      change: Math.round(change * 10) / 10,
      direction: change > 0 ? 'improving' : change < 0 ? 'declining' : 'stable',
      averageImprovement: Math.round(averageImprovement * 10) / 10
    };
  }

  /**
   * Calculate percentile among all ratings
   * @param {number} score - Current score
   * @param {string} templateId - Template ID
   * @returns {Promise<number>} Percentile
   */
  async calculatePercentile(score, templateId) {
    if (!this.storage) return 50;
    
    const allRatings = await this.storage.getAllRatings(templateId);
    if (allRatings.length === 0) return 50;
    
    const scores = allRatings.map(r => r.overall?.score || 0);
    const belowCount = scores.filter(s => s < score).length;
    
    return Math.round((belowCount / scores.length) * 100);
  }

  /**
   * Get project history
   * @param {string} templateId - Template ID
   * @returns {Promise<Array>} Previous ratings
   */
  async getProjectHistory(templateId) {
    if (!this.storage) return [];
    
    const allRatings = await this.storage.getAllRatings(templateId);
    return allRatings.slice(-5); // Last 5 ratings
  }

  /**
   * Find strongest areas
   * @param {Array} criteriaScores - Criterion scores
   * @returns {Array} Strongest areas
   */
  findStrongestAreas(criteriaScores) {
    return criteriaScores
      .filter(cs => cs.score >= 8)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map(cs => cs.name);
  }

  /**
   * Find weakest areas
   * @param {Array} criteriaScores - Criterion scores
   * @returns {Array} Weakest areas
   */
  findWeakestAreas(criteriaScores) {
    return criteriaScores
      .filter(cs => cs.score < 6)
      .sort((a, b) => a.score - b.score)
      .slice(0, 3)
      .map(cs => cs.name);
  }

  /**
   * Generate improvement suggestions
   * @param {Array} criteriaScores - Criterion scores
   * @param {Object} analysisResults - Analysis results
   * @returns {Object} Improvements
   */
  generateImprovements(criteriaScores, analysisResults) {
    const immediate = [];
    const content = [];
    
    // From ZZZ detector
    if (analysisResults.zzz?.autoEditList) {
      const editList = analysisResults.zzz.autoEditList;
      if (editList.summary.cuts > 0) {
        immediate.push(`Cut ${editList.summary.cuts} low-energy sections`);
      }
      if (editList.summary.speedUps > 0) {
        immediate.push(`Speed up ${editList.summary.speedUps} slow sections`);
      }
      if (editList.summary.brollNeeded > 0) {
        immediate.push(`Add B-roll to ${editList.summary.brollNeeded} static sections`);
      }
    }
    
    // From hook detector
    if (analysisResults.hooks?.openingSuggestion?.hook) {
      content.push('Consider using a stronger hook from detected moments');
    }
    
    // From energy analysis
    if (analysisResults.energy?.pacing?.openingEnergy < 50) {
      content.push('Re-record intro with higher energy');
    }
    
    // From low criteria scores
    criteriaScores.forEach(cs => {
      if (cs.score < 6 && cs.suggestions.length > 0) {
        content.push(...cs.suggestions);
      }
    });
    
    return { immediate, content };
  }

  /**
   * Generate "next time" lessons
   * @param {Array} criteriaScores - Criterion scores
   * @param {Object} analysisResults - Analysis results
   * @returns {Object} Next time lessons
   */
  generateNextTimeLessons(criteriaScores, analysisResults) {
    const whatWorked = [];
    const tryNext = {
      preProduction: [],
      during: [],
      postProduction: []
    };
    
    // What worked well
    criteriaScores.forEach(cs => {
      if (cs.score >= 8) {
        cs.positives.forEach(p => whatWorked.push(p));
      }
    });
    
    // Pre-production suggestions
    if (criteriaScores.find(cs => cs.id === 'audio_quality' && cs.score < 7)) {
      tryNext.preProduction.push('Check audio levels before recording');
    }
    
    if (criteriaScores.find(cs => cs.id === 'host_questions' && cs.score < 7)) {
      tryNext.preProduction.push('Prepare deeper follow-up questions');
    }
    
    // During recording
    if (analysisResults.zzz?.sections?.length > 3) {
      tryNext.during.push('Watch for energy dips - take breaks if needed');
    }
    
    if (analysisResults.energy?.pacing?.energyArc === 'flat') {
      tryNext.during.push('Vary your delivery for more engagement');
    }
    
    // Post-production
    if (analysisResults.hooks?.currentOpeningScore?.score < 6) {
      tryNext.postProduction.push('Review first 30s carefully for hook strength');
    }
    
    return { whatWorked, tryNext };
  }

  /**
   * Set custom criteria for rating
   * @param {Array} criteria - Custom criteria
   */
  setCustomCriteria(criteria) {
    this.customCriteria = criteria.map((c, idx) => ({
      id: c.id || `custom-${idx}`,
      name: c.name,
      prompt: c.prompt,
      weight: c.weight || 10
    }));
  }

  /**
   * Set project goals
   * @param {string} goals - Project goals text
   */
  setProjectGoals(goals) {
    this.projectGoals = goals;
  }

  /**
   * Rate custom criteria
   * @param {Object} projectData - Project data
   * @param {Object} analysisResults - Analysis results
   * @returns {Promise<Array>} Custom criteria scores
   */
  async rateCustomCriteria(projectData, analysisResults) {
    const scores = [];
    
    for (const criterion of this.customCriteria) {
      // For custom criteria, use AI or default to mid-score
      // In full implementation, this would call AI with the prompt
      scores.push({
        id: criterion.id,
        name: criterion.name,
        weight: criterion.weight,
        score: 6, // Default - would be AI-generated
        positives: [],
        issues: [],
        suggestions: [`Evaluate: ${criterion.prompt}`]
      });
    }
    
    return scores;
  }

  /**
   * Get current rating
   * @returns {Object|null} Current rating
   */
  getCurrentRating() {
    return this.currentRating;
  }

  /**
   * Export rating as report
   * @param {string} format - Export format ('markdown', 'json', 'text')
   * @returns {string} Formatted report
   */
  exportReport(format = 'markdown') {
    if (!this.currentRating) return '';
    
    const r = this.currentRating;
    
    switch (format) {
      case 'markdown':
        return this.generateMarkdownReport(r);
      case 'json':
        return JSON.stringify(r, null, 2);
      case 'text':
        return this.generateTextReport(r);
      default:
        return JSON.stringify(r);
    }
  }

  /**
   * Generate markdown report
   * @param {Object} rating - Rating object
   * @returns {string} Markdown report
   */
  generateMarkdownReport(rating) {
    let md = `# Project Rating Report\n\n`;
    md += `**Project:** ${rating.projectName}\n`;
    md += `**Date:** ${new Date(rating.ratedAt).toLocaleDateString()}\n`;
    md += `**Template:** ${rating.templateId}\n\n`;
    
    md += `## Overall Score: ${rating.overall.score}/10\n`;
    md += `Trend: ${rating.overall.trendDirection} (${rating.overall.trend > 0 ? '+' : ''}${rating.overall.trend})\n\n`;
    
    md += `## Criteria Breakdown\n\n`;
    rating.criteria.forEach(c => {
      md += `### ${c.name}: ${c.score}/10\n`;
      if (c.positives.length > 0) {
        md += `✓ ${c.positives.join(', ')}\n`;
      }
      if (c.issues.length > 0) {
        md += `⚠ ${c.issues.join(', ')}\n`;
      }
      md += '\n';
    });
    
    md += `## Improvements\n\n`;
    md += `### Immediate\n`;
    rating.improvements.immediate.forEach(i => md += `- ${i}\n`);
    md += `\n### Content\n`;
    rating.improvements.content.forEach(i => md += `- ${i}\n`);
    
    md += `\n## Next Time\n\n`;
    md += `### What Worked\n`;
    rating.nextTime.whatWorked.forEach(w => md += `- ${w}\n`);
    
    return md;
  }

  /**
   * Generate text report
   * @param {Object} rating - Rating object
   * @returns {string} Text report
   */
  generateTextReport(rating) {
    return `
PROJECT RATING REPORT
=====================

Project: ${rating.projectName}
Date: ${new Date(rating.ratedAt).toLocaleDateString()}
Overall Score: ${rating.overall.score}/10 (${rating.overall.trendDirection})

CRITERIA:
${rating.criteria.map(c => `  ${c.name}: ${c.score}/10`).join('\n')}

IMPROVEMENTS:
${rating.improvements.immediate.map(i => `  - ${i}`).join('\n')}

NEXT TIME:
${rating.nextTime.whatWorked.map(w => `  + ${w}`).join('\n')}
    `.trim();
  }

  // Event emitter methods
  
  on(event, callback) {
    if (!this.eventListeners[event]) {
      this.eventListeners[event] = [];
    }
    this.eventListeners[event].push(callback);
  }

  emit(event, data = {}) {
    if (this.eventListeners[event]) {
      this.eventListeners[event].forEach(callback => callback(data));
    }
  }

  off(event, callback) {
    if (this.eventListeners[event]) {
      this.eventListeners[event] = this.eventListeners[event].filter(cb => cb !== callback);
    }
  }

  /**
   * Reset rating state
   */
  reset() {
    this.currentRating = null;
    this.customCriteria = [];
    this.projectGoals = '';
  }
}

export default ProjectRating;







