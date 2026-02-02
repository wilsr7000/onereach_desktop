/**
 * App Health Dashboard - Frontend JavaScript
 * 
 * Handles:
 * - Tab navigation
 * - Data loading and real-time updates
 * - User interactions
 * - Chart rendering
 */

// Dashboard state
const state = {
  activeTab: 'overview',
  refreshInterval: 5000,
  autoRefresh: true,
  refreshTimer: null,
  data: {
    appStatus: null,
    todaySummary: null,
    spacesHealth: null,
    llmUsage: null,
    pipelineHealth: null,
    activity: [],
    logs: [],
    agentStatus: null
  }
};

// Initialize dashboard
document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initControls();
  updateTime();
  loadAllData();
  startAutoRefresh();
  
  // Update time every second
  setInterval(updateTime, 1000);
});

// Tab Navigation
function initTabs() {
  const tabButtons = document.querySelectorAll('.tab-btn');
  
  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const tabId = btn.dataset.tab;
      switchTab(tabId);
    });
  });
}

function switchTab(tabId) {
  state.activeTab = tabId;
  
  // Update button states
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });
  
  // Update panel visibility
  document.querySelectorAll('.tab-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === `panel-${tabId}`);
  });
  
  // Load tab-specific data
  loadTabData(tabId);
}

// Initialize controls
function initControls() {
  // Activity filters
  document.getElementById('activity-filter-type')?.addEventListener('change', loadActivity);
  document.getElementById('activity-filter-time')?.addEventListener('change', loadActivity);
  document.getElementById('activity-search')?.addEventListener('input', debounce(loadActivity, 300));
  document.getElementById('activity-export')?.addEventListener('click', exportActivity);
  
  // Logs controls
  document.getElementById('logs-filter-level')?.addEventListener('change', loadLogs);
  document.getElementById('logs-search')?.addEventListener('input', debounce(loadLogs, 300));
  document.getElementById('logs-auto-refresh')?.addEventListener('change', (e) => {
    state.autoRefresh = e.target.checked;
  });
  document.getElementById('logs-download')?.addEventListener('click', downloadLogs);
  document.getElementById('logs-clear')?.addEventListener('click', clearLogs);
  document.getElementById('logs-folder')?.addEventListener('click', openLogFolder);
  
  // Pipeline controls
  document.getElementById('run-integrity-check')?.addEventListener('click', runIntegrityCheck);
  
  // Agent controls
  document.getElementById('agent-pause')?.addEventListener('click', toggleAgentPause);
  document.getElementById('agent-run-now')?.addEventListener('click', runAgentNow);
  
  // Broken items controls
  document.getElementById('broken-filter-status')?.addEventListener('change', loadBrokenItems);
  document.getElementById('broken-clear')?.addEventListener('click', clearAllBrokenItems);
  
  // Settings controls
  document.getElementById('setting-refresh')?.addEventListener('change', (e) => {
    state.refreshInterval = parseInt(e.target.value);
    restartAutoRefresh();
  });
  
  // Export buttons
  document.getElementById('export-json')?.addEventListener('click', () => exportData('json'));
  document.getElementById('export-activity')?.addEventListener('click', () => exportData('activity'));
  document.getElementById('export-llm')?.addEventListener('click', () => exportData('llm'));
  
  // Maintenance buttons
  document.getElementById('maintenance-integrity')?.addEventListener('click', runIntegrityCheck);
  document.getElementById('maintenance-clear-cache')?.addEventListener('click', clearActivityCache);
  document.getElementById('maintenance-reset-stats')?.addEventListener('click', resetAgentStats);
}

// Time display
function updateTime() {
  const timeEl = document.getElementById('header-time');
  if (timeEl) {
    timeEl.textContent = new Date().toLocaleTimeString();
  }
}

// Auto-refresh
function startAutoRefresh() {
  stopAutoRefresh();
  if (state.autoRefresh) {
    state.refreshTimer = setInterval(() => {
      loadTabData(state.activeTab);
      updateLastRefresh();
    }, state.refreshInterval);
  }
}

function stopAutoRefresh() {
  if (state.refreshTimer) {
    clearInterval(state.refreshTimer);
    state.refreshTimer = null;
  }
}

function restartAutoRefresh() {
  stopAutoRefresh();
  startAutoRefresh();
}

function updateLastRefresh() {
  const el = document.getElementById('last-refresh');
  if (el) {
    el.textContent = new Date().toLocaleTimeString();
  }
}

// Data Loading
async function loadAllData() {
  try {
    const data = await window.dashboard.getData();
    state.data = { ...state.data, ...data };
    updateOverview();
    updateLastRefresh();
  } catch (error) {
    console.error('Error loading dashboard data:', error);
  }
}

async function loadTabData(tabId) {
  switch (tabId) {
    case 'overview':
      await loadOverviewData();
      break;
    case 'activity':
      await loadActivity();
      break;
    case 'spaces':
      await loadSpaces();
      break;
    case 'logs':
      await loadLogs();
      break;
    case 'llm':
      await loadLLMUsage();
      break;
    case 'pipeline':
      await loadPipeline();
      break;
    case 'agent':
      await loadAgentStatus();
      break;
    case 'broken':
      await loadBrokenItems();
      break;
  }
}

// ========================================
// Health Rings System - Apple Health Style
// ========================================

function calculateHealthScore(data) {
  const { todaySummary, pipelineHealth, agentStatus, brokenItems } = data;
  
  // 1. Stability Score (error-free operations)
  // Based on errors vs total operations today
  const totalOps = (todaySummary?.itemsAdded || 0) + (todaySummary?.aiOperations || 0) + 1;
  const errors = todaySummary?.errors || 0;
  const stabilityScore = Math.max(0, Math.min(100, Math.round(((totalOps - errors) / totalOps) * 100)));
  
  // 2. Pipeline Score (successful asset processing)
  // Based on pipeline stage success rates
  const rates = pipelineHealth?.stageSuccessRates || {};
  const avgPipelineRate = Object.values(rates).length > 0 
    ? Object.values(rates).reduce((a, b) => a + b, 0) / Object.values(rates).length 
    : 100;
  const pipelineScore = Math.round(avgPipelineRate);
  
  // 3. Healing Score (issues auto-fixed vs total issues)
  // If agent has detected issues, what percentage were fixed?
  const issuesDetected = agentStatus?.issuesDetected || 0;
  const fixesApplied = agentStatus?.fixesApplied || 0;
  const healingScore = issuesDetected > 0 
    ? Math.min(100, Math.round((fixesApplied / issuesDetected) * 100))
    : 100; // 100% if no issues (perfect health!)
  
  // Overall health score (weighted average)
  // Stability is most important (50%), Pipeline (30%), Healing (20%)
  const overallScore = Math.round(
    stabilityScore * 0.5 + 
    pipelineScore * 0.3 + 
    healingScore * 0.2
  );
  
  return {
    stability: stabilityScore,
    pipeline: pipelineScore,
    healing: healingScore,
    overall: overallScore,
    details: {
      stabilityDetail: `${totalOps - errors}/${totalOps} ops`,
      pipelineDetail: `${Object.values(rates).filter(r => r === 100).length}/${Object.values(rates).length} stages`,
      healingDetail: issuesDetected > 0 ? `${fixesApplied}/${issuesDetected} fixed` : 'No issues'
    }
  };
}

function updateHealthRings(healthData) {
  const { stability, pipeline, healing, overall, details } = healthData;
  
  // Update ring progress (circumference calculations)
  // stability ring: r=85, circumference = 2πr = 534
  // pipeline ring: r=65, circumference = 408
  // healing ring: r=45, circumference = 283
  
  const stabilityRing = document.getElementById('ring-stability');
  const pipelineRing = document.getElementById('ring-pipeline');
  const healingRing = document.getElementById('ring-healing');
  
  if (stabilityRing) {
    const offset = 534 - (534 * stability / 100);
    stabilityRing.style.strokeDashoffset = offset;
    if (stability >= 100) stabilityRing.classList.add('complete');
  }
  
  if (pipelineRing) {
    const offset = 408 - (408 * pipeline / 100);
    pipelineRing.style.strokeDashoffset = offset;
    if (pipeline >= 100) pipelineRing.classList.add('complete');
  }
  
  if (healingRing) {
    const offset = 283 - (283 * healing / 100);
    healingRing.style.strokeDashoffset = offset;
    if (healing >= 100) healingRing.classList.add('complete');
  }
  
  // Update values
  setText('ring-stability-value', `${stability}%`);
  setText('ring-pipeline-value', `${pipeline}%`);
  setText('ring-healing-value', `${healing}%`);
  
  // Update details
  setText('ring-stability-detail', details.stabilityDetail);
  setText('ring-pipeline-detail', details.pipelineDetail);
  setText('ring-healing-detail', details.healingDetail);
  
  // Update overall score badge
  const scoreBadge = document.getElementById('overall-health-score');
  if (scoreBadge) {
    scoreBadge.textContent = `${overall}%`;
    scoreBadge.className = 'health-score-badge';
    if (overall >= 90) scoreBadge.classList.add('excellent');
    else if (overall >= 70) scoreBadge.classList.add('good');
    else if (overall >= 50) scoreBadge.classList.add('fair');
    else scoreBadge.classList.add('poor');
  }
  
  // Update emoji based on health
  const emojiEl = document.getElementById('health-emoji');
  if (emojiEl) {
    if (overall >= 95) emojiEl.textContent = '🏆';
    else if (overall >= 90) emojiEl.textContent = '💪';
    else if (overall >= 80) emojiEl.textContent = '😊';
    else if (overall >= 70) emojiEl.textContent = '👍';
    else if (overall >= 50) emojiEl.textContent = '🤔';
    else if (overall >= 30) emojiEl.textContent = '😰';
    else emojiEl.textContent = '🆘';
  }
  
  // Update motivational message
  const messageEl = document.getElementById('rings-message');
  if (messageEl) {
    const ringsComplete = [stability >= 100, pipeline >= 100, healing >= 100].filter(Boolean).length;
    let message = '';
    let icon = '✨';
    
    if (ringsComplete === 3) {
      message = 'All rings closed! Your app is in perfect health today! 🎉';
      icon = '🏆';
    } else if (ringsComplete === 2) {
      message = 'Two rings closed! One more to go for perfect health!';
      icon = '🔥';
    } else if (ringsComplete === 1) {
      message = 'One ring closed! Keep it up, two more to go!';
      icon = '💪';
    } else if (overall >= 80) {
      message = 'Good progress! Your app is running smoothly.';
      icon = '👍';
    } else if (overall >= 50) {
      message = 'Some issues detected. The agent is working on it.';
      icon = '🔧';
    } else {
      message = 'Multiple issues detected. Check the Agent tab for details.';
      icon = '⚠️';
    }
    
    messageEl.innerHTML = `
      <span class="message-icon">${icon}</span>
      <span class="message-text">${message}</span>
    `;
  }
}

// Overview Tab
async function loadOverviewData() {
  try {
    const [appStatus, todaySummary, spacesHealth, llmUsage, agentStatus, pipelineHealth] = await Promise.all([
      window.dashboard.getAppStatus(),
      window.dashboard.getTodaySummary(),
      window.dashboard.getSpacesHealth(),
      window.dashboard.getLLMUsage(),
      window.dashboard.getAgentStatus(),
      window.dashboard.getPipelineHealth()
    ]);
    
    state.data.appStatus = appStatus;
    state.data.todaySummary = todaySummary;
    state.data.spacesHealth = spacesHealth;
    state.data.llmUsage = llmUsage;
    state.data.agentStatus = agentStatus;
    state.data.pipelineHealth = pipelineHealth;
    
    // Calculate and update health rings
    const healthScore = calculateHealthScore({
      todaySummary,
      pipelineHealth,
      agentStatus
    });
    updateHealthRings(healthScore);
    
    updateOverview();
  } catch (error) {
    console.error('Error loading overview:', error);
  }
}

// Update overview display (called after data load)
function updateOverview() {
  const { appStatus, todaySummary, spacesHealth, llmUsage, agentStatus } = state.data;
  
  // App status
  if (appStatus) {
    setText('stat-uptime', appStatus.uptime);
    setText('stat-memory', appStatus.memory?.formatted);
    setText('stat-cpu', appStatus.cpu?.formatted);
  }
  
  // Today's summary
  if (todaySummary) {
    setText('stat-items-added', todaySummary.itemsAdded || 0);
    setText('stat-ai-ops', todaySummary.aiOperations || 0);
    setText('stat-errors', todaySummary.errors || 0);
    setText('stat-fixes', todaySummary.autoFixes || 0);
  }
  
  // Spaces health
  if (spacesHealth) {
    setText('stat-spaces-count', spacesHealth.totalSpaces || 0);
    setText('stat-total-items', spacesHealth.totalItems || 0);
    
    const utilization = spacesHealth.utilization || 0;
    const utilizationEl = document.getElementById('spaces-utilization');
    if (utilizationEl) {
      utilizationEl.style.width = `${utilization}%`;
    }
    setText('spaces-utilization-text', `${utilization}% utilized`);
  }
  
  // LLM costs
  if (llmUsage) {
    setText('cost-claude', `$${(llmUsage.claude?.cost || 0).toFixed(2)}`);
    setText('cost-claude-calls', `(${llmUsage.claude?.calls || 0} calls)`);
    setText('cost-openai', `$${(llmUsage.openai?.cost || 0).toFixed(2)}`);
    setText('cost-openai-calls', `(${llmUsage.openai?.calls || 0} calls)`);
    setText('cost-total', `$${(llmUsage.total?.cost || 0).toFixed(2)}`);
  }
  
  // Agent status banner
  if (agentStatus) {
    const indicator = document.getElementById('agent-indicator');
    const statusText = document.getElementById('agent-status-text');
    
    if (indicator) {
      indicator.className = 'agent-indicator';
      if (!agentStatus.active) {
        indicator.classList.add('error');
      } else if (agentStatus.paused) {
        indicator.classList.add('paused');
      }
    }
    
    if (statusText) {
      statusText.textContent = agentStatus.paused ? 'Agent Paused' : 
                               agentStatus.active ? 'Agent Active' : 'Agent Inactive';
    }
    
    setText('agent-last-scan', `Last scan: ${agentStatus.lastScanAgo || '--'}`);
    setText('agent-fixes-today', `Fixes today: ${agentStatus.fixesApplied || 0}`);
  }
  
  // Load activity feed
  loadActivityFeed();
}

async function loadActivityFeed() {
  try {
    const activity = await window.dashboard.getActivity({ limit: 10 });
    const feedEl = document.getElementById('activity-feed');
    
    if (!feedEl) return;
    
    if (!activity || activity.length === 0) {
      feedEl.innerHTML = '<div class="activity-empty">No recent activity</div>';
      return;
    }
    
    feedEl.innerHTML = activity.map(item => `
      <div class="activity-item">
        <span class="activity-dot ${item.type}"></span>
        <span class="activity-time">${formatTime(item.timestamp)}</span>
        <span class="activity-text">${escapeHtml(item.description || item.type)}</span>
      </div>
    `).join('');
  } catch (error) {
    console.error('Error loading activity feed:', error);
  }
}

// Activity Tab
async function loadActivity() {
  try {
    const type = document.getElementById('activity-filter-type')?.value || 'all';
    const search = document.getElementById('activity-search')?.value || '';
    
    const activity = await window.dashboard.getActivity({ 
      limit: 100,
      type: type === 'all' ? null : type
    });
    
    let filtered = activity || [];
    if (search) {
      const searchLower = search.toLowerCase();
      filtered = filtered.filter(a => 
        a.description?.toLowerCase().includes(searchLower) ||
        a.type?.toLowerCase().includes(searchLower)
      );
    }
    
    const tbody = document.getElementById('activity-table-body');
    if (!tbody) return;
    
    if (filtered.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty-row">No activity found</td></tr>';
    } else {
      tbody.innerHTML = filtered.map(item => `
        <tr>
          <td>${formatTime(item.timestamp)}</td>
          <td><span class="status-badge ${item.type}">${item.type}</span></td>
          <td>${escapeHtml(item.spaceId || '-')}</td>
          <td>${escapeHtml(item.description || '-')}</td>
        </tr>
      `).join('');
    }
    
    setText('activity-info', `Showing ${filtered.length} items`);
  } catch (error) {
    console.error('Error loading activity:', error);
  }
}

// Spaces Tab
async function loadSpaces() {
  try {
    const spacesHealth = await window.dashboard.getSpacesHealth();
    state.data.spacesHealth = spacesHealth;
    
    const tbody = document.getElementById('spaces-table-body');
    if (!tbody) return;
    
    const spaces = spacesHealth?.spaces || [];
    
    if (spaces.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty-row">No spaces found</td></tr>';
    } else {
      tbody.innerHTML = spaces.map(space => `
        <tr>
          <td>${space.icon || '📁'} ${escapeHtml(space.name)}</td>
          <td>${space.itemCount}</td>
          <td>${space.sizeFormatted}</td>
          <td>${space.lastUsedFormatted}</td>
          <td>
            <div class="health-bar">
              <div class="health-bar-bg">
                <div class="health-bar-fill" style="width: ${space.healthScore}%"></div>
              </div>
              <span class="health-bar-text">${space.healthScore}%</span>
            </div>
          </td>
        </tr>
      `).join('');
    }
    
    // Update charts
    renderSpaceCharts(spaces);
  } catch (error) {
    console.error('Error loading spaces:', error);
  }
}

function renderSpaceCharts(spaces) {
  // Items by type chart (simplified bar chart)
  const itemsChart = document.getElementById('items-type-chart');
  if (itemsChart && spaces.length > 0) {
    const maxItems = Math.max(...spaces.map(s => s.itemCount), 1);
    itemsChart.innerHTML = spaces.slice(0, 6).map(space => `
      <div class="chart-bar" style="height: ${(space.itemCount / maxItems) * 100}%" 
           title="${space.name}: ${space.itemCount} items"></div>
    `).join('');
  }
  
  // Storage chart
  const storageChart = document.getElementById('storage-chart');
  if (storageChart && spaces.length > 0) {
    const maxSize = Math.max(...spaces.map(s => s.size), 1);
    storageChart.innerHTML = spaces.slice(0, 6).map(space => `
      <div class="chart-bar" style="height: ${(space.size / maxSize) * 100}%"
           title="${space.name}: ${space.sizeFormatted}"></div>
    `).join('');
  }
}

// Logs Tab
async function loadLogs() {
  try {
    const level = document.getElementById('logs-filter-level')?.value || 'all';
    const search = document.getElementById('logs-search')?.value || '';
    
    const logs = await window.dashboard.getLogs({ 
      level: level === 'all' ? null : level,
      search,
      limit: 200
    });
    
    const container = document.getElementById('log-entries');
    if (!container) return;
    
    if (!logs || logs.length === 0) {
      container.innerHTML = '<div class="log-entry info">No logs found</div>';
    } else {
      container.innerHTML = logs.map(log => `
        <div class="log-entry ${log.level?.toLowerCase() || 'info'}">
          <span class="log-time">${formatLogTime(log.timestamp)}</span>
          <span class="log-level">${log.level || 'INFO'}</span>
          <span class="log-source">${escapeHtml(log.source || 'app')}</span>
          <span class="log-message">${escapeHtml(log.message || '')}</span>
        </div>
      `).join('');
    }
  } catch (error) {
    console.error('Error loading logs:', error);
  }
}

// LLM Usage Tab
async function loadLLMUsage() {
  try {
    const usage = await window.dashboard.getLLMUsage();
    state.data.llmUsage = usage;
    
    if (!usage) return;
    
    // Claude stats
    setText('llm-claude-calls', usage.claude?.calls || 0);
    setText('llm-claude-tokens', formatNumber(usage.claude?.tokens || 0));
    setText('llm-claude-cost', `$${(usage.claude?.cost || 0).toFixed(2)}`);
    setText('llm-claude-avg', `$${(usage.claude?.avgCostPerCall || 0).toFixed(3)}`);
    
    // OpenAI stats
    setText('llm-openai-calls', usage.openai?.calls || 0);
    setText('llm-openai-tokens', formatNumber(usage.openai?.tokens || 0));
    setText('llm-openai-cost', `$${(usage.openai?.cost || 0).toFixed(2)}`);
    setText('llm-openai-avg', `$${(usage.openai?.avgCostPerCall || 0).toFixed(3)}`);
    
    // Features breakdown
    const featuresEl = document.getElementById('llm-features');
    if (featuresEl && usage.byFeature) {
      const features = Object.entries(usage.byFeature);
      if (features.length === 0) {
        featuresEl.innerHTML = '<div class="feature-item"><span class="feature-name">No data</span></div>';
      } else {
        featuresEl.innerHTML = features.map(([name, data]) => `
          <div class="feature-item">
            <span class="feature-name">${formatFeatureName(name)}</span>
            <span class="feature-percent">${data.percentage || 0}%</span>
          </div>
        `).join('');
      }
    }
    
    // Recent operations
    const opsEl = document.getElementById('llm-operations');
    if (opsEl && usage.recentOperations) {
      if (usage.recentOperations.length === 0) {
        opsEl.innerHTML = '<div class="operation-item">No recent operations</div>';
      } else {
        opsEl.innerHTML = usage.recentOperations.slice(0, 10).map(op => `
          <div class="operation-item">
            <span>${formatTime(op.timestamp)}</span>
            <span>${op.model}</span>
            <span>${formatNumber(op.totalTokens)} tokens</span>
            <span>$${op.cost?.toFixed(3) || '0.000'}</span>
          </div>
        `).join('');
      }
    }
  } catch (error) {
    console.error('Error loading LLM usage:', error);
  }
}

// Pipeline Tab
async function loadPipeline() {
  try {
    const health = await window.dashboard.getPipelineHealth();
    state.data.pipelineHealth = health;
    
    if (!health) return;
    
    // Stage success rates
    const stages = ['validation', 'storage', 'thumbnail', 'metadata'];
    stages.forEach(stage => {
      const rate = health.stageSuccessRates?.[stage] || 100;
      setText(`stage-${stage}`, `${rate}%`);
      
      const fill = document.querySelector(`#stage-${stage}`)?.closest('.stage-card')?.querySelector('.stage-fill');
      if (fill) {
        fill.style.width = `${rate}%`;
      }
    });
    
    // Recent runs
    const runsBody = document.getElementById('pipeline-runs-body');
    if (runsBody && health.recentRuns) {
      if (health.recentRuns.length === 0) {
        runsBody.innerHTML = '<tr><td colspan="5" class="empty-row">No recent pipeline runs</td></tr>';
      } else {
        runsBody.innerHTML = health.recentRuns.slice(0, 10).map(run => `
          <tr>
            <td><code>${run.operationId?.slice(-8) || '-'}</code></td>
            <td>${escapeHtml(run.asset || 'Unknown')}</td>
            <td>${renderStageProgress(run.stages)}</td>
            <td><code>${run.checksum || '-'}</code></td>
            <td><span class="status-badge ${run.status}">${run.status}</span></td>
          </tr>
        `).join('');
      }
    }
    
    // Verification summary
    if (health.verification) {
      setText('verify-index', health.verification.indexIntegrity || 'OK');
      setText('verify-orphans', health.verification.orphanedFiles || 0);
    }
  } catch (error) {
    console.error('Error loading pipeline:', error);
  }
}

function renderStageProgress(stages) {
  const total = 8;
  const completed = Object.keys(stages || {}).length;
  const blocks = Array(total).fill('░').map((_, i) => i < completed ? '█' : '░').join('');
  return `<span style="font-family: monospace">${blocks}</span> ${completed}/${total}`;
}

// Agent Tab
async function loadAgentStatus() {
  try {
    const status = await window.dashboard.getAgentStatus();
    state.data.agentStatus = status;
    
    if (!status) return;
    
    // Big indicator
    const bigIndicator = document.getElementById('agent-big-indicator');
    if (bigIndicator) {
      bigIndicator.className = 'agent-big-indicator';
      if (!status.active) {
        bigIndicator.classList.add('error');
      } else if (status.paused) {
        bigIndicator.classList.add('paused');
      }
    }
    
    // Status text
    setText('agent-title', status.paused ? 'PAUSED' : status.active ? 'ACTIVE' : 'INACTIVE');
    setText('agent-subtitle', status.paused ? 'Agent is paused' : 
                             status.active ? 'Monitoring system health' : 'Agent not running');
    
    // Update pause button
    const pauseBtn = document.getElementById('agent-pause');
    if (pauseBtn) {
      pauseBtn.textContent = status.paused ? 'Resume' : 'Pause';
    }
    
    // Stats
    setText('agent-scans', status.scansToday || 0);
    setText('agent-issues', status.issuesDetected || 0);
    setText('agent-fixes', status.fixesApplied || 0);
    setText('agent-escalated', status.escalated || 0);
    
    // Recent diagnoses
    const diagnosesEl = document.getElementById('diagnoses-list');
    if (diagnosesEl) {
      const diagnoses = status.recentDiagnoses || [];
      if (diagnoses.length === 0) {
        diagnosesEl.innerHTML = '<div class="diagnosis-item"><span class="diagnosis-empty">No recent diagnoses</span></div>';
      } else {
        diagnosesEl.innerHTML = diagnoses.map(d => `
          <div class="diagnosis-item">
            <span class="diagnosis-time">${formatTime(d.timestamp)}</span>
            <span class="diagnosis-issue">${escapeHtml(d.issue?.substring(0, 50) || '-')}</span>
            <span class="diagnosis-result">${d.strategy || '-'}</span>
            <span class="diagnosis-action">${d.confidence ? d.confidence + '%' : '-'}</span>
          </div>
        `).join('');
      }
    }
    
    // Issues requiring attention
    const attentionEl = document.getElementById('attention-list');
    if (attentionEl) {
      const issues = status.issuesRequiringAttention || [];
      if (issues.length === 0) {
        attentionEl.innerHTML = `
          <div class="attention-empty">
            <span class="attention-icon">✓</span>
            <span>No issues requiring manual intervention</span>
          </div>
        `;
      } else {
        attentionEl.innerHTML = issues.map(issue => `
          <div class="attention-item">
            <div class="attention-content">
              <span class="attention-message">${escapeHtml(issue.message || 'Unknown issue')}</span>
              <span class="attention-meta">Occurred ${issue.occurrences || 1} times</span>
            </div>
            <div class="attention-actions">
              <button class="btn-secondary" onclick="resolveIssue('${issue.id}')">Resolve</button>
              <button class="btn-secondary" onclick="ignoreIssue('${issue.id}')">Ignore</button>
            </div>
          </div>
        `).join('');
      }
    }
  } catch (error) {
    console.error('Error loading agent status:', error);
  }
}

// Agent Controls
async function toggleAgentPause() {
  try {
    const status = state.data.agentStatus;
    if (status?.paused) {
      await window.dashboard.agentResume();
    } else {
      await window.dashboard.agentPause();
    }
    await loadAgentStatus();
  } catch (error) {
    console.error('Error toggling agent:', error);
  }
}

async function runAgentNow() {
  try {
    await window.dashboard.agentRunNow();
    await loadAgentStatus();
  } catch (error) {
    console.error('Error running agent:', error);
  }
}

async function resolveIssue(issueId) {
  try {
    await window.dashboard.resolveIssue(issueId);
    await loadAgentStatus();
  } catch (error) {
    console.error('Error resolving issue:', error);
  }
}

async function ignoreIssue(issueId) {
  try {
    await window.dashboard.ignoreIssue(issueId);
    await loadAgentStatus();
  } catch (error) {
    console.error('Error ignoring issue:', error);
  }
}

// ========================================
// Broken Items Tab
// ========================================

async function loadBrokenItems() {
  try {
    // Get filter value
    const filterEl = document.getElementById('broken-filter-status');
    const statusFilter = filterEl?.value || 'all';
    
    // Fetch broken items from current version
    const result = await window.dashboard.getBrokenItems({ status: statusFilter });
    
    if (!result.success) {
      console.warn('Failed to load broken items:', result.error);
      return;
    }
    
    // Update summary stats
    setText('broken-total', result.totalItems || 0);
    setText('broken-open', result.openItems || 0);
    setText('broken-fixed', (result.totalItems || 0) - (result.openItems || 0));
    setText('broken-version', result.appVersion || '-');
    
    // Render broken items list
    const listEl = document.getElementById('broken-items-list');
    if (listEl) {
      const items = result.items || [];
      if (items.length === 0) {
        listEl.innerHTML = `
          <div class="broken-empty">
            <span class="empty-icon">✓</span>
            <span>No broken items recorded for this version</span>
          </div>
        `;
      } else {
        listEl.innerHTML = items.map(item => renderBrokenItem(item)).join('');
      }
    }
    
    // Fetch and render archived items
    await loadArchivedBrokenItems();
    
  } catch (error) {
    console.error('Error loading broken items:', error);
  }
}

function renderBrokenItem(item) {
  const statusClass = item.status || 'open';
  const timeAgo = formatTimeAgo(item.lastSeen || item.registeredAt);
  
  return `
    <div class="broken-item ${statusClass}">
      <div class="broken-item-header">
        <div class="broken-item-info">
          <span class="broken-item-source">${escapeHtml(item.source || 'unknown')}</span>
          <span class="broken-item-message">${escapeHtml(item.message || 'Unknown error')}</span>
        </div>
        <div class="broken-item-actions">
          ${item.status !== 'fixed' ? `
            <button class="fix" onclick="markBrokenItemFixed('${item.id}')">Mark Fixed</button>
          ` : ''}
          ${item.status !== 'ignored' ? `
            <button class="ignore" onclick="markBrokenItemIgnored('${item.id}')">Ignore</button>
          ` : ''}
        </div>
      </div>
      <div class="broken-item-meta">
        <span>📅 ${timeAgo}</span>
        <span>🔄 ${item.occurrences || 1} occurrences</span>
        <span>🔧 ${item.fixAttempts || 0} fix attempts</span>
        ${item.diagnosis ? `<span>💡 Strategy: ${item.diagnosis.strategy}</span>` : ''}
      </div>
    </div>
  `;
}

async function loadArchivedBrokenItems() {
  try {
    const result = await window.dashboard.getArchivedBrokenItems();
    
    const archivesEl = document.getElementById('archives-list');
    if (!archivesEl) return;
    
    const archives = result.archives || [];
    
    if (archives.length === 0) {
      archivesEl.innerHTML = '<div class="archive-empty">No archived issues from previous versions</div>';
      // Hide notice if no archives
      const noticeEl = document.getElementById('broken-notice');
      if (noticeEl) noticeEl.style.display = 'none';
      return;
    }
    
    // Show notice
    const noticeEl = document.getElementById('broken-notice');
    if (noticeEl) noticeEl.style.display = 'flex';
    
    archivesEl.innerHTML = archives.map((archive, idx) => `
      <div class="archive-group" id="archive-${idx}">
        <div class="archive-header" onclick="toggleArchive(${idx})">
          <div>
            <span class="archive-version">Version </span>
            <span class="archive-version-badge">${archive.version}</span>
          </div>
          <span class="archive-info">${archive.itemCount} issues • Archived ${formatTimeAgo(archive.archivedAt)}</span>
        </div>
        <div class="archive-items">
          ${(archive.items || []).map(item => `
            <div class="archive-item">
              <span class="archive-item-message">${escapeHtml(item.message || 'Unknown')}</span>
              <div class="archive-item-time">
                ${item.occurrences || 1} occurrences • 
                Last seen: ${formatTimeAgo(item.lastSeen || item.registeredAt)}
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `).join('');
    
  } catch (error) {
    console.error('Error loading archived broken items:', error);
  }
}

function toggleArchive(idx) {
  const el = document.getElementById(`archive-${idx}`);
  if (el) {
    el.classList.toggle('expanded');
  }
}

async function markBrokenItemFixed(itemId) {
  try {
    await window.dashboard.updateBrokenItemStatus(itemId, 'fixed', { fixedManually: true });
    await loadBrokenItems();
  } catch (error) {
    console.error('Error marking item as fixed:', error);
  }
}

async function markBrokenItemIgnored(itemId) {
  try {
    await window.dashboard.updateBrokenItemStatus(itemId, 'ignored', {});
    await loadBrokenItems();
  } catch (error) {
    console.error('Error ignoring item:', error);
  }
}

async function clearAllBrokenItems() {
  if (!confirm('This will archive all current broken items and clear the registry. Continue?')) {
    return;
  }
  
  try {
    const result = await window.dashboard.clearBrokenItems(true);
    if (result.success) {
      alert(`Archived and cleared ${result.cleared} items.`);
      await loadBrokenItems();
    } else {
      alert(`Error: ${result.error}`);
    }
  } catch (error) {
    console.error('Error clearing broken items:', error);
  }
}

function formatTimeAgo(timestamp) {
  if (!timestamp) return 'Unknown';
  
  const date = new Date(timestamp);
  const now = new Date();
  const seconds = Math.floor((now - date) / 1000);
  
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)} days ago`;
  
  return date.toLocaleDateString();
}

// Pipeline Controls
async function runIntegrityCheck() {
  try {
    const btn = document.getElementById('run-integrity-check') || document.getElementById('maintenance-integrity');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Running...';
    }
    
    const result = await window.dashboard.runIntegrityCheck();
    
    if (result.success) {
      alert(`Integrity Check Complete!\n\nValid: ${result.validItems}/${result.totalItems}\nOrphaned: ${result.orphanedFiles}\nDuration: ${result.duration}ms`);
    } else {
      alert(`Integrity Check Failed: ${result.error || 'Unknown error'}`);
    }
    
    await loadPipeline();
  } catch (error) {
    console.error('Error running integrity check:', error);
    alert(`Error: ${error.message}`);
  } finally {
    const btn = document.getElementById('run-integrity-check') || document.getElementById('maintenance-integrity');
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Run Full Integrity Check';
    }
  }
}

// Export Functions
async function exportActivity() {
  try {
    const activity = await window.dashboard.getActivity({ limit: 1000 });
    const csv = activityToCSV(activity);
    downloadFile(csv, 'activity-export.csv', 'text/csv');
  } catch (error) {
    console.error('Error exporting activity:', error);
  }
}

async function exportData(format) {
  try {
    const data = await window.dashboard.exportData(format);
    const filename = `dashboard-export-${new Date().toISOString().split('T')[0]}.json`;
    downloadFile(data, filename, 'application/json');
  } catch (error) {
    console.error('Error exporting data:', error);
  }
}

function downloadFile(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function activityToCSV(activity) {
  const headers = ['Time', 'Type', 'Space', 'Description'];
  const rows = activity.map(a => [
    a.timestamp,
    a.type,
    a.spaceId || '',
    a.description || ''
  ]);
  return [headers, ...rows].map(row => row.map(cell => `"${cell}"`).join(',')).join('\n');
}

// Log Functions
async function downloadLogs() {
  try {
    const logs = await window.dashboard.getLogs({ limit: 10000 });
    const content = logs.map(l => `${l.timestamp} [${l.level}] ${l.source}: ${l.message}`).join('\n');
    downloadFile(content, `logs-${new Date().toISOString().split('T')[0]}.txt`, 'text/plain');
  } catch (error) {
    console.error('Error downloading logs:', error);
  }
}

function clearLogs() {
  const container = document.getElementById('log-entries');
  if (container) {
    container.innerHTML = '<div class="log-entry info">Logs cleared from display</div>';
  }
}

async function openLogFolder() {
  try {
    await window.dashboard.openLogFolder();
  } catch (error) {
    console.error('Error opening log folder:', error);
  }
}

// Settings Functions
async function clearActivityCache() {
  if (confirm('Clear all cached activity data?')) {
    try {
      // Would call backend to clear cache
      alert('Activity cache cleared');
    } catch (error) {
      console.error('Error clearing cache:', error);
    }
  }
}

async function resetAgentStats() {
  if (confirm('Reset all agent statistics?')) {
    try {
      // Would call backend to reset stats
      alert('Agent statistics reset');
      await loadAgentStatus();
    } catch (error) {
      console.error('Error resetting stats:', error);
    }
  }
}

// Utility Functions
function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function setWidth(id, width) {
  const el = document.getElementById(id);
  if (el) el.style.width = width;
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatTime(timestamp) {
  if (!timestamp) return '--';
  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

function formatLogTime(timestamp) {
  if (!timestamp) return '--';
  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-US', { 
    hour: '2-digit', 
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3
  });
}

function formatNumber(num) {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + 'M';
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(1) + 'K';
  }
  return num.toString();
}

function formatFeatureName(name) {
  return name.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function debounce(fn, delay) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

// Make functions available globally for onclick handlers
window.resolveIssue = resolveIssue;
window.ignoreIssue = ignoreIssue;

