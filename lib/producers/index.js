/**
 * Producers Module
 * Part of the Governed Self-Improving Agent Runtime
 *
 * Agents that add tasks to the unified queue
 */

const { BaseProducer, AiderProducer, EvaluationProducer, UserProducer, SystemProducer } = require('./base-producer');

module.exports = {
  BaseProducer,
  AiderProducer,
  EvaluationProducer,
  UserProducer,
  SystemProducer,
};
