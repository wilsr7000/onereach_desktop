/**
 * Playbook Agent
 *
 * Executes playbooks in Spaces via the Playbook Execution REST API.
 * Handles voice/HUD commands to start, monitor, respond to, and cancel
 * playbook executions.
 */

const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();

const SPACES_API = 'http://127.0.0.1:47291';

const playbookAgent = {
  id: 'playbook-agent',
  name: 'Playbook Agent',
  description: 'Executes playbooks in spaces -- runs plans, checks status, relays questions, reports results',
  voice: 'alloy',
  categories: ['automation', 'execution', 'spaces'],
  keywords: ['playbook', 'execute', 'run playbook', 'plan', 'execution', 'status', 'job'],
  executionType: 'action',

  prompt: `Playbook Agent executes playbooks in Spaces. A playbook is a plan stored in a space that can be run by Claude Code.

HIGH CONFIDENCE (0.85+):
- "Run the playbook in my marketing space"
- "Execute the onboarding plan"
- "Start the playbook"
- "What's the status of my execution?"
- "Check on the playbook job"
- "Answer yes to the pending question"
- "Cancel the running playbook"
- "What playbooks are in my project space?"
- "List available playbooks"

LOW CONFIDENCE (0.00) -- do NOT bid on:
- General search queries (search agent)
- Creating agents (agent composer)
- Playing media (DJ agent)
- Saving content to spaces (spaces agent)
- General questions about the app (help agent)

HALLUCINATION GUARD:
NEVER state facts that are not in your context window.
You do NOT know what spaces or playbooks exist unless you query the API.`,

  /**
   * Execute a playbook-related task.
   */
  async execute(task) {
    const content = (task.content || '').toLowerCase();
    const data = task.data || {};

    try {
      // Determine intent
      if (data.action === 'run' || _isRunRequest(content)) {
        return await _handleRun(task);
      }

      if (data.action === 'status' || _isStatusRequest(content)) {
        return await _handleStatus(task);
      }

      if (data.action === 'respond' || _isRespondRequest(content)) {
        return await _handleRespond(task);
      }

      if (data.action === 'cancel' || _isCancelRequest(content)) {
        return await _handleCancel(task);
      }

      if (data.action === 'list' || _isListRequest(content)) {
        return await _handleList(task);
      }

      // Default: try to figure out what they want
      return await _handleRun(task);
    } catch (error) {
      log.error('agent', 'Playbook agent error', { error: error.message });
      return {
        success: false,
        message: `Playbook execution failed: ${error.message}`,
      };
    }
  },
};

// ---------------------------------------------------------------------------
// Intent detection
// ---------------------------------------------------------------------------

function _isRunRequest(content) {
  return (
    /\b(run|execute|start|launch|kick off)\b.*\b(playbook|plan|execution)\b/i.test(content) ||
    /\b(playbook|plan)\b.*\b(run|execute|start|launch)\b/i.test(content)
  );
}

function _isStatusRequest(content) {
  return /\b(status|progress|how.*(going|doing)|check on|what.*happening)\b/i.test(content);
}

function _isRespondRequest(content) {
  return /\b(answer|respond|reply|yes|no)\b.*\b(question|pending|paused)\b/i.test(content);
}

function _isCancelRequest(content) {
  return /\b(cancel|stop|abort|kill)\b.*\b(playbook|job|execution)\b/i.test(content);
}

function _isListRequest(content) {
  return /\b(list|what|which|show|available)\b.*\b(playbook|plan)\b/i.test(content);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function _handleRun(task) {
  const data = task.data || {};

  // Resolve space and playbook
  let spaceId = data.spaceId;
  let playbookId = data.playbookId;

  if (!spaceId) {
    // Try to find a space from context
    const spaces = await _fetchJSON(`${SPACES_API}/api/spaces`);
    if (!spaces || spaces.length === 0) {
      return { success: false, message: 'No spaces found. Create a space with a playbook first.' };
    }

    // Look for a space mentioned in the content
    const content = (task.content || '').toLowerCase();
    const matched = spaces.find((s) => content.includes((s.name || '').toLowerCase()));

    if (matched) {
      spaceId = matched.id || matched.spaceId;
    } else {
      // List spaces and ask user to pick
      const names = spaces
        .slice(0, 5)
        .map((s) => s.name || s.id)
        .join(', ');
      return {
        success: true,
        message: `Which space should I run the playbook in? Available: ${names}`,
        needsInput: true,
      };
    }
  }

  // Check for playbooks in the space
  if (!playbookId) {
    const playbooks = await _fetchJSON(`${SPACES_API}/api/playbook/spaces/${spaceId}/playbooks`);
    if (!playbooks || playbooks.length === 0) {
      return {
        success: false,
        message: 'No playbooks found in this space. Add a text item tagged "playbook" with steps.',
      };
    }
    if (playbooks.length === 1) {
      playbookId = playbooks[0].id;
    } else {
      const names = playbooks.map((p) => p.title).join(', ');
      return {
        success: true,
        message: `Found ${playbooks.length} playbooks: ${names}. Which one should I run?`,
        needsInput: true,
      };
    }
  }

  // Execute
  const result = await _fetchJSON(`${SPACES_API}/api/playbook/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      spaceId,
      playbookId,
      context: task.content,
      maxTurns: data.maxTurns || 20,
      maxBudget: data.maxBudget || 2.0,
    }),
  });

  if (result && result.jobId) {
    return {
      success: true,
      message: `Playbook started. Job ID: ${result.jobId}. I will monitor progress. Ask me for status updates.`,
      data: { jobId: result.jobId, spaceId },
    };
  }

  return { success: false, message: `Failed to start playbook: ${result?.error || 'Unknown error'}` };
}

async function _handleStatus(task) {
  const data = task.data || {};
  let jobId = data.jobId;

  if (!jobId) {
    // Get most recent job
    const jobs = await _fetchJSON(`${SPACES_API}/api/playbook/jobs?limit=1`);
    if (!jobs?.jobs?.length) {
      return { success: true, message: 'No playbook executions found.' };
    }
    jobId = jobs.jobs[0].jobId;
  }

  const job = await _fetchJSON(`${SPACES_API}/api/playbook/jobs/${jobId}`);
  if (!job) {
    return { success: false, message: 'Job not found.' };
  }

  if (job.status === 'paused' && job.pendingQuestions?.length > 0) {
    const q = job.pendingQuestions[0];
    const optionsText = q.options ? ` Options: ${q.options.join(', ')}` : '';
    return {
      success: true,
      message: `The playbook is paused. It is asking: "${q.question}"${optionsText}`,
      needsInput: true,
      data: { jobId, questionId: q.id },
    };
  }

  const progressMsg = job.progress?.lastEvent ? ` Last: ${job.progress.lastEvent}` : '';
  const outputCount = job.outputs?.length || 0;
  const ticketCount = job.tickets?.length || 0;

  let statusMsg = `Job ${jobId.substring(0, 8)}: ${job.status}.${progressMsg}`;
  if (job.status === 'completed') {
    statusMsg += ` Produced ${outputCount} output(s).`;
    if (ticketCount > 0) statusMsg += ` Processed ${ticketCount} ticket(s).`;
  }
  if (job.status === 'failed') {
    statusMsg += ` Error: ${job.error || 'Unknown'}`;
  }

  return { success: true, message: statusMsg, data: { jobId, status: job.status } };
}

async function _handleRespond(task) {
  const data = task.data || {};
  let jobId = data.jobId;
  let questionId = data.questionId;
  const answer = data.answer || task.content;

  if (!jobId) {
    // Find the paused job
    const jobs = await _fetchJSON(`${SPACES_API}/api/playbook/jobs?status=paused&limit=1`);
    if (!jobs?.jobs?.length) {
      return { success: false, message: 'No paused playbook jobs found.' };
    }
    jobId = jobs.jobs[0].jobId;

    // Get the job to find the question
    const job = await _fetchJSON(`${SPACES_API}/api/playbook/jobs/${jobId}`);
    if (job?.pendingQuestions?.length > 0) {
      questionId = job.pendingQuestions[0].id;
    }
  }

  if (!questionId) {
    return { success: false, message: 'No pending question to answer.' };
  }

  const result = await _fetchJSON(`${SPACES_API}/api/playbook/jobs/${jobId}/respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ questionId, answer }),
  });

  if (result && result.status === 'running') {
    return { success: true, message: 'Got it. Playbook execution resumed.' };
  }

  return { success: false, message: `Failed to respond: ${result?.error || 'Unknown error'}` };
}

async function _handleCancel(task) {
  const data = task.data || {};
  let jobId = data.jobId;

  if (!jobId) {
    // Find the most recent running job
    const jobs = await _fetchJSON(`${SPACES_API}/api/playbook/jobs?limit=5`);
    const active = jobs?.jobs?.find((j) => j.status === 'running' || j.status === 'paused');
    if (!active) {
      return { success: true, message: 'No active playbook jobs to cancel.' };
    }
    jobId = active.jobId;
  }

  const result = await _fetchJSON(`${SPACES_API}/api/playbook/jobs/${jobId}/cancel`, {
    method: 'POST',
  });

  if (result && result.status === 'cancelled') {
    return { success: true, message: 'Playbook execution cancelled.' };
  }

  return { success: false, message: `Failed to cancel: ${result?.error || 'Unknown error'}` };
}

async function _handleList(task) {
  const data = task.data || {};
  let spaceId = data.spaceId;

  if (!spaceId) {
    // List playbooks across all spaces
    const spaces = await _fetchJSON(`${SPACES_API}/api/spaces`);
    if (!spaces || spaces.length === 0) {
      return { success: true, message: 'No spaces found.' };
    }

    const allPlaybooks = [];
    for (const space of spaces.slice(0, 10)) {
      const sid = space.id || space.spaceId;
      const playbooks = await _fetchJSON(`${SPACES_API}/api/playbook/spaces/${sid}/playbooks`);
      if (playbooks && playbooks.length > 0) {
        for (const p of playbooks) {
          allPlaybooks.push({ ...p, spaceName: space.name, spaceId: sid });
        }
      }
    }

    if (allPlaybooks.length === 0) {
      return { success: true, message: 'No playbooks found in any space.' };
    }

    const list = allPlaybooks.map((p) => `- "${p.title}" in ${p.spaceName}`).join('\n');
    return { success: true, message: `Found ${allPlaybooks.length} playbook(s):\n${list}` };
  }

  const playbooks = await _fetchJSON(`${SPACES_API}/api/playbook/spaces/${spaceId}/playbooks`);
  if (!playbooks || playbooks.length === 0) {
    return { success: true, message: 'No playbooks found in this space.' };
  }

  const list = playbooks.map((p) => `- "${p.title}"`).join('\n');
  return { success: true, message: `Found ${playbooks.length} playbook(s):\n${list}` };
}

// ---------------------------------------------------------------------------
// Fetch helper -- delegates to centralized HTTP client
// ---------------------------------------------------------------------------

const httpClient = require('../../lib/http-client');

async function _fetchJSON(url, opts = {}) {
  return httpClient.fetchJSON(url, opts);
}

module.exports = playbookAgent;
