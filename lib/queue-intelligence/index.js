/**
 * Queue Intelligence Module
 * Part of the Governed Self-Improving Agent Runtime
 * 
 * LLM-based task classification and priority optimization
 */

const TaskClassifier = require('./classifier');
const QueueOptimizer = require('./optimizer');

module.exports = {
  TaskClassifier,
  QueueOptimizer
};
