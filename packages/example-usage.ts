/**
 * Example: Using @onereach/task-exchange and @onereach/task-agent together
 * 
 * This file demonstrates how to:
 * 1. Create an exchange server
 * 2. Create agents that connect to the exchange
 * 3. Submit tasks and watch them get processed
 */

// === EXCHANGE SETUP (Server/Main App) ===

import { createExchange, TaskPriority } from './task-exchange/src/index.js';

async function startExchange() {
  const { exchange, shutdown } = await createExchange({
    port: 3000,
    storage: 'memory',
    
    // Define categories
    categories: [
      { name: 'file', keywords: ['open', 'save', 'create', 'delete', 'copy', 'move', 'file', 'folder'] },
      { name: 'search', keywords: ['search', 'find', 'look', 'query', 'lookup', 'where'] },
      { name: 'media', keywords: ['play', 'pause', 'stop', 'volume', 'video', 'audio', 'music'] },
    ],
    
    // Enable market maker (fallback agent)
    marketMaker: {
      enabled: true,
      agentId: 'market-maker',
      confidence: 0.2,
    },
  });

  // Listen for events
  exchange.on('task:queued', ({ task }) => {
    console.log(`[Exchange] Task queued: ${task.id} - "${task.content}"`);
  });

  exchange.on('task:assigned', ({ task, winner }) => {
    console.log(`[Exchange] Task assigned to ${winner.agentId} (score: ${winner.score.toFixed(2)})`);
  });

  exchange.on('task:settled', ({ task, result, agentId }) => {
    console.log(`[Exchange] Task completed by ${agentId}: ${JSON.stringify(result.data)}`);
  });

  exchange.on('task:dead_letter', ({ task, reason }) => {
    console.error(`[Exchange] Task failed: ${task.id} - ${reason}`);
  });

  exchange.on('agent:flagged', ({ agentId, reputation }) => {
    console.warn(`[Exchange] Agent ${agentId} flagged for review (score: ${reputation.score})`);
  });

  return { exchange, shutdown };
}

// === AGENT SETUP (Agent Process) ===

import { createAgent, createKeywordMatcher } from './task-agent/src/index.js';
import type { Task, TaskResult, ExecutionContext } from './task-exchange/src/types/index.js';

async function startFileAgent() {
  const agent = createAgent({
    name: 'file-agent',
    version: '1.0.0',
    categories: ['file'],
    
    exchange: {
      url: 'ws://localhost:3000',
      reconnect: true,
    },
    
    // Fast keyword matching
    quickMatch: createKeywordMatcher(['open', 'save', 'create', 'delete', 'copy', 'move']),
    
    // Execute file operations
    execute: async (task: Task, context: ExecutionContext): Promise<TaskResult> => {
      console.log(`[FileAgent] Executing: "${task.content}"`);
      
      // Check for cancellation
      if (context.signal.aborted) {
        return { success: false, error: 'Cancelled' };
      }
      
      // Simulate file operation
      await new Promise(resolve => setTimeout(resolve, 100));
      
      if (task.content.includes('save')) {
        return { success: true, data: { action: 'saved', path: '/example/file.txt' } };
      }
      
      if (task.content.includes('open')) {
        return { success: true, data: { action: 'opened', content: 'File contents...' } };
      }
      
      return { success: true, data: { action: 'generic-file-op' } };
    },
  });

  agent.on('connected', () => console.log('[FileAgent] Connected to exchange'));
  agent.on('task:assigned', ({ task }) => console.log(`[FileAgent] Assigned: ${task.id}`));
  agent.on('task:completed', ({ taskId }) => console.log(`[FileAgent] Completed: ${taskId}`));

  await agent.start();
  return agent;
}

async function startMediaAgent() {
  const agent = createAgent({
    name: 'media-agent',
    version: '1.0.0',
    categories: ['media'],
    
    exchange: {
      url: 'ws://localhost:3000',
      reconnect: true,
    },
    
    quickMatch: createKeywordMatcher(['play', 'pause', 'stop', 'volume', 'video', 'audio']),
    
    execute: async (task: Task, _context: ExecutionContext): Promise<TaskResult> => {
      console.log(`[MediaAgent] Executing: "${task.content}"`);
      await new Promise(resolve => setTimeout(resolve, 50));
      
      if (task.content.includes('play')) {
        return { success: true, data: { action: 'playing', mediaId: '123' } };
      }
      
      return { success: true, data: { action: 'media-op' } };
    },
  });

  agent.on('connected', () => console.log('[MediaAgent] Connected to exchange'));
  
  await agent.start();
  return agent;
}

// === MAIN ===

async function main() {
  console.log('Starting Task Auction Example\n');

  // Start exchange
  const { exchange, shutdown } = await startExchange();
  console.log('Exchange started on port 3000\n');

  // Wait a bit for server to be ready
  await new Promise(resolve => setTimeout(resolve, 500));

  // Start agents
  const fileAgent = await startFileAgent();
  const mediaAgent = await startMediaAgent();

  // Wait for agents to register
  await new Promise(resolve => setTimeout(resolve, 500));
  console.log('\nAgents connected\n');

  // Submit some tasks
  console.log('Submitting tasks...\n');

  await exchange.submit({
    content: 'Save the document to my desktop',
    priority: TaskPriority.NORMAL,
    metadata: { userId: 'user-1' },
  });

  await exchange.submit({
    content: 'Play the video file',
    priority: TaskPriority.NORMAL,
    metadata: { userId: 'user-1' },
  });

  await exchange.submit({
    content: 'Open the settings file',
    priority: TaskPriority.URGENT, // This one goes first!
    metadata: { userId: 'user-2' },
  });

  // Wait for tasks to complete
  await new Promise(resolve => setTimeout(resolve, 3000));

  // Check queue stats
  const stats = exchange.getQueueStats();
  console.log('\nQueue stats:', stats);

  // Cleanup
  console.log('\nShutting down...');
  await fileAgent.stop();
  await mediaAgent.stop();
  await shutdown();
  console.log('Done!');
}

// Run if this is the main module
main().catch(console.error);
