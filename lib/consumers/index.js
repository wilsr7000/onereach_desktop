/**
 * Consumers Module
 * Part of the Governed Self-Improving Agent Runtime
 *
 * Agents that pull and execute tasks from the queue
 */

const {
  BaseConsumer,
  AiderConsumer,
  EvaluationConsumer,
  ImprovementConsumer,
  RecoveryConsumer,
  UndoConsumer,
} = require('./base-consumer');

module.exports = {
  BaseConsumer,
  AiderConsumer,
  EvaluationConsumer,
  ImprovementConsumer,
  RecoveryConsumer,
  UndoConsumer,
};
