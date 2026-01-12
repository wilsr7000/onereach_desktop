/**
 * Meta-Learning Governance
 * Part of the Governed Self-Improving Agent Runtime
 * 
 * Safety bounds and audit trail for learning updates
 */

/**
 * Meta-Learning Governance
 * Ensures learning stays within safe bounds
 */
class MetaLearningGovernance {
  constructor(options = {}) {
    // Safety bounds
    this.maxWeightChange = options.maxWeightChange || 0.1; // Max 10% change per update
    this.minSamplesForLearning = options.minSamples || 20;
    this.humanOverrideRequired = options.requireHuman || false;
    this.maxWeightBound = options.maxWeight || 1.5;
    this.minWeightBound = options.minWeight || 0.5;
    
    // Audit storage
    this.auditLog = [];
    this.pendingApprovals = new Map();
    this.maxAuditEntries = options.maxAuditEntries || 1000;
  }

  /**
   * Validate proposed weight change
   * @param {string} agentType - Agent type
   * @param {number} currentWeight - Current weight
   * @param {number} proposedWeight - Proposed new weight
   * @returns {Object} Validation result
   */
  validateWeightChange(agentType, currentWeight, proposedWeight) {
    const change = Math.abs(proposedWeight - currentWeight);
    
    // Check maximum change
    if (change > this.maxWeightChange) {
      const direction = proposedWeight > currentWeight ? 1 : -1;
      const boundedWeight = currentWeight + (direction * this.maxWeightChange);
      
      return {
        approved: false,
        reason: `Change of ${change.toFixed(3)} exceeds max allowed ${this.maxWeightChange}`,
        boundedWeight: Math.max(this.minWeightBound, Math.min(this.maxWeightBound, boundedWeight)),
        originalProposed: proposedWeight
      };
    }

    // Check absolute bounds
    if (proposedWeight > this.maxWeightBound) {
      return {
        approved: false,
        reason: `Weight ${proposedWeight.toFixed(3)} exceeds maximum ${this.maxWeightBound}`,
        boundedWeight: this.maxWeightBound,
        originalProposed: proposedWeight
      };
    }

    if (proposedWeight < this.minWeightBound) {
      return {
        approved: false,
        reason: `Weight ${proposedWeight.toFixed(3)} below minimum ${this.minWeightBound}`,
        boundedWeight: this.minWeightBound,
        originalProposed: proposedWeight
      };
    }

    return {
      approved: true,
      weight: proposedWeight
    };
  }

  /**
   * Check if learning update should be applied
   * @param {Object} update - Learning update proposal
   * @returns {Object} Decision
   */
  shouldApplyLearning(update) {
    const checks = [];

    // Require minimum samples
    if (update.sampleCount < this.minSamplesForLearning) {
      checks.push({
        passed: false,
        check: 'min_samples',
        reason: `Only ${update.sampleCount} samples (need ${this.minSamplesForLearning})`
      });
    } else {
      checks.push({ passed: true, check: 'min_samples' });
    }

    // Check magnitude
    const magnitude = Math.abs(update.proposedChange || 0);
    if (magnitude > this.maxWeightChange) {
      checks.push({
        passed: false,
        check: 'magnitude',
        reason: `Change magnitude ${magnitude.toFixed(3)} exceeds limit`
      });
    } else {
      checks.push({ passed: true, check: 'magnitude' });
    }

    // Require human approval for large changes
    if (this.humanOverrideRequired && magnitude > 0.05) {
      checks.push({
        passed: false,
        check: 'human_approval',
        reason: 'Human approval required for changes > 5%',
        pendingApproval: true
      });
    }

    const allPassed = checks.every(c => c.passed);
    const hasPendingApproval = checks.some(c => c.pendingApproval);

    return {
      apply: allPassed,
      checks,
      pendingApproval: hasPendingApproval,
      reason: allPassed ? 'All checks passed' : checks.filter(c => !c.passed).map(c => c.reason).join('; ')
    };
  }

  /**
   * Request human approval for an update
   * @param {Object} update - Update requiring approval
   * @returns {string} Approval ID
   */
  requestApproval(update) {
    const approvalId = `approval-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    
    this.pendingApprovals.set(approvalId, {
      id: approvalId,
      update,
      requestedAt: new Date().toISOString(),
      status: 'pending'
    });

    return approvalId;
  }

  /**
   * Process human approval decision
   * @param {string} approvalId - Approval ID
   * @param {boolean} approved - Whether approved
   * @param {string} approver - Who approved
   * @returns {Object} Updated approval
   */
  processApproval(approvalId, approved, approver) {
    const approval = this.pendingApprovals.get(approvalId);
    if (!approval) return null;

    approval.status = approved ? 'approved' : 'rejected';
    approval.approvedBy = approver;
    approval.approvedAt = new Date().toISOString();

    this.pendingApprovals.set(approvalId, approval);

    // Log the decision
    this.logAudit({
      type: 'approval_decision',
      approvalId,
      approved,
      approver,
      update: approval.update
    });

    return approval;
  }

  /**
   * Log a learning update to audit trail
   * @param {Object} update - Update to log
   */
  logAudit(update) {
    const entry = {
      id: `audit-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      timestamp: new Date().toISOString(),
      ...update
    };

    this.auditLog.unshift(entry);

    // Trim old entries
    if (this.auditLog.length > this.maxAuditEntries) {
      this.auditLog = this.auditLog.slice(0, this.maxAuditEntries);
    }
  }

  /**
   * Log a learning update
   * @param {Object} update - Update details
   * @returns {Object} Logged entry
   */
  async logLearningUpdate(update) {
    const entry = {
      type: 'learning_update',
      updateType: update.type,
      agent: update.agentType,
      previousValue: update.previous,
      newValue: update.new,
      sampleCount: update.samples,
      confidence: update.confidence,
      humanApproved: update.humanApproved || false,
      bounded: update.bounded || false,
      originalProposed: update.originalProposed
    };

    this.logAudit(entry);
    return entry;
  }

  /**
   * Get audit log
   * @param {Object} options - Query options
   * @returns {Object[]} Audit entries
   */
  getAuditLog(options = {}) {
    let entries = this.auditLog;

    if (options.type) {
      entries = entries.filter(e => e.type === options.type);
    }

    if (options.agent) {
      entries = entries.filter(e => e.agent === options.agent);
    }

    if (options.since) {
      const sinceDate = new Date(options.since);
      entries = entries.filter(e => new Date(e.timestamp) >= sinceDate);
    }

    if (options.limit) {
      entries = entries.slice(0, options.limit);
    }

    return entries;
  }

  /**
   * Get pending approvals
   * @returns {Object[]}
   */
  getPendingApprovals() {
    return [...this.pendingApprovals.values()].filter(a => a.status === 'pending');
  }

  /**
   * Get governance statistics
   * @returns {Object}
   */
  getStats() {
    const learningUpdates = this.auditLog.filter(e => e.type === 'learning_update');
    const boundedUpdates = learningUpdates.filter(e => e.bounded);
    const approvalDecisions = this.auditLog.filter(e => e.type === 'approval_decision');

    return {
      totalAuditEntries: this.auditLog.length,
      learningUpdates: learningUpdates.length,
      boundedUpdates: boundedUpdates.length,
      pendingApprovals: this.getPendingApprovals().length,
      approvalDecisions: approvalDecisions.length,
      approvedCount: approvalDecisions.filter(e => e.approved).length,
      rejectedCount: approvalDecisions.filter(e => !e.approved).length,
      
      config: {
        maxWeightChange: this.maxWeightChange,
        minSamplesForLearning: this.minSamplesForLearning,
        humanOverrideRequired: this.humanOverrideRequired,
        weightBounds: [this.minWeightBound, this.maxWeightBound]
      }
    };
  }

  /**
   * Export audit log
   * @returns {Object}
   */
  exportAuditLog() {
    return {
      exportedAt: new Date().toISOString(),
      config: this.getStats().config,
      entries: this.auditLog
    };
  }

  /**
   * Clear audit log
   */
  clearAuditLog() {
    this.auditLog = [];
  }

  /**
   * Clear pending approvals
   */
  clearPendingApprovals() {
    this.pendingApprovals.clear();
  }
}

module.exports = MetaLearningGovernance;
module.exports.MetaLearningGovernance = MetaLearningGovernance;


