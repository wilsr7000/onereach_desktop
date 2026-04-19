/**
 * Planning & Decision Rubrics
 *
 * Task rubrics for plan evaluation, proposal review, and decision
 * records. Added in the agent-system v2 upgrade so council-mode tasks
 * (variant: 'council') can auto-expand a named rubric into per-
 * criterion scores without every caller defining the criteria inline.
 *
 * Shape matches `lib/task-rubrics/code.js`: each rubric has an object
 * `criteria` keyed by criterion name with `{ weight, check, description }`.
 * The module-level `rubricToCriteria` helper in lib/task-rubrics/index.js
 * converts this into the flat array shape the Task contract expects.
 */

'use strict';

/**
 * Plan review -- evaluate a proposed plan.
 * Used by variant:'council' tasks to consolidate multi-agent scoring.
 */
const PLAN_REVIEW = {
  name: 'plan_review',
  description: 'Criteria for evaluating a proposed plan',
  criteria: {
    clarity: {
      weight: 0.25,
      check: 'llm',
      description: 'Is the plan clearly stated with unambiguous outcomes?',
    },
    feasibility: {
      weight: 0.2,
      check: 'llm',
      description: 'Can the plan realistically be executed with available resources and time?',
    },
    specificity: {
      weight: 0.15,
      check: 'llm',
      description: 'Are the steps, owners, and deadlines concrete enough to act on?',
    },
    risk: {
      weight: 0.2,
      check: 'llm',
      description: 'Are the key risks identified, sized, and mitigated? (higher score = better risk coverage)',
    },
    completeness: {
      weight: 0.15,
      check: 'llm',
      description: 'Does the plan cover the full scope of the goal, including rollback / contingency?',
    },
    coherence: {
      weight: 0.05,
      check: 'llm',
      description: 'Do the steps follow logically and reinforce each other?',
    },
  },
  passThreshold: 0.7,
};

/**
 * Plan proposal -- evaluate a DRAFT plan that is not yet actionable.
 * Lighter than plan_review (no specificity check yet) but surfaces
 * whether the core idea is worth developing further.
 */
const PLAN_PROPOSAL = {
  name: 'plan_proposal',
  description: 'Criteria for an early-stage plan proposal (pre-commitment)',
  criteria: {
    problem_clarity: {
      weight: 0.3,
      check: 'llm',
      description: 'Is the problem being solved well-defined?',
    },
    approach_fit: {
      weight: 0.3,
      check: 'llm',
      description: 'Does the proposed approach address the problem?',
    },
    novelty: {
      weight: 0.1,
      check: 'llm',
      description: 'Does this propose something different from the existing path?',
    },
    effort: {
      weight: 0.15,
      check: 'llm',
      description: 'Is the implied effort proportional to the expected value?',
    },
    risk_awareness: {
      weight: 0.15,
      check: 'llm',
      description: 'Does the proposal anticipate obvious risks / objections?',
    },
  },
  passThreshold: 0.65,
};

/**
 * Decision record -- evaluate a recorded decision and its context.
 * Used by the decision-agent's council mode when reviewing past calls.
 */
const DECISION_RECORD = {
  name: 'decision_record',
  description: 'Criteria for evaluating a recorded decision',
  criteria: {
    rationale: {
      weight: 0.3,
      check: 'llm',
      description: 'Is the reasoning behind the decision clearly documented?',
    },
    alternatives: {
      weight: 0.2,
      check: 'llm',
      description: 'Were plausible alternatives considered and discarded for stated reasons?',
    },
    reversibility: {
      weight: 0.2,
      check: 'llm',
      description: 'Is the cost of reversing the decision clear? (higher = more reversible / transparent)',
    },
    stakeholders: {
      weight: 0.15,
      check: 'llm',
      description: 'Are impacted parties named and communicated with?',
    },
    followup: {
      weight: 0.15,
      check: 'llm',
      description: 'Is there a follow-up check-in scheduled to verify the outcome?',
    },
  },
  passThreshold: 0.7,
};

/**
 * Meeting outcome -- evaluate captured notes + decisions + action items
 * from a meeting.
 */
const MEETING_OUTCOME = {
  name: 'meeting_outcome',
  description: 'Criteria for evaluating the output of a meeting',
  criteria: {
    notes_quality: {
      weight: 0.25,
      check: 'llm',
      description: 'Are the notes accurate, complete, and organized?',
    },
    decisions_captured: {
      weight: 0.25,
      check: 'llm',
      description: 'Are decisions clearly identified with context and rationale?',
    },
    action_items: {
      weight: 0.25,
      check: 'llm',
      description: 'Do action items have owners, deadlines, and definitions of done?',
    },
    unresolved: {
      weight: 0.15,
      check: 'llm',
      description: 'Are unresolved questions / parking-lot items captured?',
    },
    priority: {
      weight: 0.1,
      check: 'llm',
      description: 'Is the relative priority of follow-ups clear?',
    },
  },
  passThreshold: 0.7,
};

module.exports = {
  PLAN_REVIEW,
  PLAN_PROPOSAL,
  DECISION_RECORD,
  MEETING_OUTCOME,
};
