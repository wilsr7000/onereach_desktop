/**
 * Memory Agent Cross-Agent Orchestration Tests
 *
 * Tests the memory-agent's ability to:
 *   - Load all agent memories + user profile (context gathering)
 *   - Use Claude 4.6 Opus with adaptive thinking
 *   - Apply cross-agent changes (profile + per-agent memory updates)
 *   - Handle view, update, delete, and clear_all flows
 *
 * Uses dependency injection (_setDeps) to mock the AI service and stores.
 *
 * Run:  npx vitest run test/unit/memory-agent-cross-agent.test.js
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Silence logging
vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createMockMemory(agentId, sections = {}) {
  const _sections = { ...sections };
  const saveFn = vi.fn();
  return {
    agentId,
    _sections,
    saveFn,
    load: vi.fn(async () => {}),
    getRaw: vi.fn(() =>
      Object.entries(_sections)
        .map(([name, content]) => `## ${name}\n\n${content}`)
        .join('\n\n')
    ),
    getSection: vi.fn((name) => _sections[name] || null),
    updateSection: vi.fn((name, content) => {
      _sections[name] = content;
    }),
    getSectionNames: vi.fn(() => Object.keys(_sections)),
    parseSectionAsKeyValue: vi.fn(() => ({})),
    updateSectionAsKeyValue: vi.fn(),
    isDirty: vi.fn(() => false),
    save: saveFn,
    setRaw: vi.fn(),
  };
}

function createMockProfile(initialFacts = {}) {
  const _facts = { ...initialFacts };
  const updateFact = vi.fn((key, value) => {
    _facts[key] = value;
  });
  const save = vi.fn(async () => true);
  const storeUpdateSection = vi.fn();
  const storeParseSectionAsKeyValue = vi.fn((section) => {
    if (section === 'Identity') return { Name: _facts.Name || '(not yet learned)' };
    if (section === 'Locations') return { 'Home City': _facts['Home City'] || '(not yet learned)' };
    if (section === 'Preferences') return { 'Temperature Units': _facts['Temperature Units'] || 'Fahrenheit' };
    return {};
  });

  return {
    _facts,
    updateFact,
    save,
    storeUpdateSection,
    storeParseSectionAsKeyValue,
    instance: {
      isLoaded: () => true,
      load: vi.fn(async () => true),
      getFacts: vi.fn(() => ({ ..._facts })),
      updateFact,
      save,
      _store: {
        parseSectionAsKeyValue: storeParseSectionAsKeyValue,
        updateSection: storeUpdateSection,
        updateSectionAsKeyValue: vi.fn(),
      },
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Memory Agent: Cross-Agent Orchestration', () => {
  let agent;
  let mockProfile;
  let mockWeather, mockDailyBrief, mockDJ, mockSelfMemory;
  let mockAiJson;

  beforeEach(() => {
    vi.resetModules();

    // Must re-require after resetModules to get a fresh agent
    agent = require('../../packages/agents/memory-agent');
    agent.memory = null;

    // Create mock stores
    mockProfile = createMockProfile({
      Name: 'Isaac',
      'Home City': 'Berkeley',
      'Temperature Units': 'Fahrenheit',
    });

    mockWeather = createMockMemory('weather-agent', {
      'Learned Preferences': '- Home Location: Berkeley',
      'Favorite Locations': '- Home: Berkeley\n- Work: San Francisco',
    });

    mockDailyBrief = createMockMemory('daily-brief-agent', {
      'Briefing Preferences': '- Style: radio-morning-show\n- Length: standard (80-150 words)',
      'Learned Patterns': '*Patterns learned from user feedback*',
    });

    mockDJ = createMockMemory('dj-agent', {
      'Learned Preferences': '- Favorite Genre: jazz\n- Volume: 50%',
    });

    mockSelfMemory = createMockMemory('memory-agent', {
      'Change Log': '*No changes yet.*',
      'Deleted Facts': '*No deletions yet.*',
    });

    // Default AI mock
    mockAiJson = vi.fn(async () => ({
      action: 'view',
      response: 'ok',
      profileChanges: { facts: {}, deleteKeys: [] },
      agentChanges: [],
    }));

    // Inject mocks
    agent._setDeps({
      getUserProfile: () => mockProfile.instance,
      getAgentMemory: (agentId) => {
        if (agentId === 'memory-agent') return mockSelfMemory;
        if (agentId === 'weather-agent') return mockWeather;
        if (agentId === 'daily-brief-agent') return mockDailyBrief;
        if (agentId === 'dj-agent') return mockDJ;
        return createMockMemory(agentId, {});
      },
      listAgentMemories: () => ['weather-agent', 'daily-brief-agent', 'dj-agent', 'memory-agent', 'user-profile'],
      aiJson: mockAiJson,
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Context Gathering
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Context Gathering', () => {
    it('should load user profile facts', async () => {
      const { factsStr, currentFacts } = await agent._loadUserProfile();
      expect(currentFacts.Name).toBe('Isaac');
      expect(currentFacts['Home City']).toBe('Berkeley');
      expect(factsStr).toContain('Name: Isaac');
      expect(factsStr).toContain('Home City: Berkeley');
    });

    it('should exclude "not yet learned" placeholders from profile string', async () => {
      mockProfile._facts['Work City'] = '(not yet learned)';
      const { factsStr } = await agent._loadUserProfile();
      expect(factsStr).not.toContain('not yet learned');
    });

    it('should load all agent memories except self and user-profile', async () => {
      const memories = await agent._loadAllAgentMemories();
      expect(memories.has('weather-agent')).toBe(true);
      expect(memories.has('daily-brief-agent')).toBe(true);
      expect(memories.has('dj-agent')).toBe(true);
      expect(memories.has('memory-agent')).toBe(false);
      expect(memories.has('user-profile')).toBe(false);
      expect(memories.size).toBe(3);
    });

    it('should format agent memories with delimiters per agent', async () => {
      const memories = await agent._loadAllAgentMemories();
      const formatted = agent._formatAgentMemories(memories);
      expect(formatted).toContain('=== weather-agent ===');
      expect(formatted).toContain('Home Location: Berkeley');
      expect(formatted).toContain('=== daily-brief-agent ===');
      expect(formatted).toContain('radio-morning-show');
      expect(formatted).toContain('=== dj-agent ===');
      expect(formatted).toContain('jazz');
    });

    it('should return placeholder for empty memories map', () => {
      expect(agent._formatAgentMemories(new Map())).toBe('(no agent memories found)');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Update Flow
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Update Flow', () => {
    it('should update user profile on name change', async () => {
      mockAiJson.mockResolvedValueOnce({
        action: 'update',
        response: 'Updated your name to Robb.',
        profileChanges: { facts: { Name: 'Robb' }, deleteKeys: [] },
        agentChanges: [],
      });

      const result = await agent.execute({ content: 'My name is Robb' });
      expect(result.success).toBe(true);
      expect(result.message).toContain('Robb');
      expect(mockProfile.updateFact).toHaveBeenCalledWith('Name', 'Robb');
      expect(mockProfile.save).toHaveBeenCalled();
    });

    it('should update profile AND weather agent on city change', async () => {
      mockAiJson.mockResolvedValueOnce({
        action: 'update',
        response: 'Updated your city to Portland everywhere.',
        profileChanges: { facts: { 'Home City': 'Portland' }, deleteKeys: [] },
        agentChanges: [
          {
            agentId: 'weather-agent',
            reason: 'User changed home city',
            sectionUpdates: {
              'Learned Preferences': '- Home Location: Portland',
              'Favorite Locations': '- Home: Portland\n- Work: San Francisco',
            },
          },
        ],
      });

      const result = await agent.execute({ content: 'I moved to Portland' });
      expect(result.success).toBe(true);

      // Profile updated
      expect(mockProfile.updateFact).toHaveBeenCalledWith('Home City', 'Portland');
      expect(mockProfile.save).toHaveBeenCalled();

      // Weather agent memory updated
      expect(mockWeather._sections['Learned Preferences']).toBe('- Home Location: Portland');
      expect(mockWeather._sections['Favorite Locations']).toContain('Portland');
      expect(mockWeather.saveFn).toHaveBeenCalled();
    });

    it('should update multiple agents simultaneously', async () => {
      mockAiJson.mockResolvedValueOnce({
        action: 'update',
        response: 'Updated everything.',
        profileChanges: { facts: { 'Home City': 'Portland' }, deleteKeys: [] },
        agentChanges: [
          {
            agentId: 'weather-agent',
            reason: 'city',
            sectionUpdates: { 'Learned Preferences': '- Home Location: Portland' },
          },
          {
            agentId: 'daily-brief-agent',
            reason: 'style',
            sectionUpdates: { 'Briefing Preferences': '- Style: concise\n- Length: short' },
          },
        ],
      });

      const result = await agent.execute({ content: 'I moved to Portland and make my brief shorter' });
      expect(result.success).toBe(true);
      expect(mockWeather._sections['Learned Preferences']).toContain('Portland');
      expect(mockDailyBrief._sections['Briefing Preferences']).toContain('concise');
      expect(mockWeather.saveFn).toHaveBeenCalled();
      expect(mockDailyBrief.saveFn).toHaveBeenCalled();
    });

    it('should skip unknown agent IDs gracefully', async () => {
      mockAiJson.mockResolvedValueOnce({
        action: 'update',
        response: 'Done.',
        profileChanges: { facts: {}, deleteKeys: [] },
        agentChanges: [{ agentId: 'nonexistent-agent', reason: 'test', sectionUpdates: { Foo: 'bar' } }],
      });

      const result = await agent.execute({ content: 'test' });
      expect(result.success).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // View Flow
  // ═══════════════════════════════════════════════════════════════════════════

  describe('View Flow', () => {
    it('should return synthesized view without modifying anything', async () => {
      mockAiJson.mockResolvedValueOnce({
        action: 'view',
        response: 'Your name is Isaac, you live in Berkeley. Weather uses Berkeley. DJ prefers jazz.',
        profileChanges: { facts: {}, deleteKeys: [] },
        agentChanges: [],
      });

      const result = await agent.execute({ content: 'What do you know about me?' });
      expect(result.success).toBe(true);
      expect(result.message).toContain('Isaac');
      expect(result.message).toContain('Berkeley');
      expect(mockProfile.updateFact).not.toHaveBeenCalled();
      expect(mockProfile.save).not.toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Delete Flow
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Delete Flow', () => {
    it('should delete from profile and clean agent memories', async () => {
      mockAiJson.mockResolvedValueOnce({
        action: 'delete',
        response: 'Forgotten your home city.',
        profileChanges: { facts: {}, deleteKeys: ['Home City'] },
        agentChanges: [
          {
            agentId: 'weather-agent',
            reason: 'Remove city',
            sectionUpdates: { 'Learned Preferences': '*No preferences learned yet.*' },
          },
        ],
      });

      const result = await agent.execute({ content: 'Forget my home city' });
      expect(result.success).toBe(true);
      expect(mockProfile.save).toHaveBeenCalled();
      expect(mockWeather._sections['Learned Preferences']).toContain('No preferences learned yet');
      expect(mockWeather.saveFn).toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Clear All Flow
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Clear All Flow', () => {
    it('should reset profile and all agent learned preferences', async () => {
      mockAiJson.mockResolvedValueOnce({
        action: 'clear_all',
        response: 'All memory wiped.',
        profileChanges: { facts: {}, deleteKeys: [] },
        agentChanges: [],
      });

      const result = await agent.execute({ content: 'Clear everything' });
      expect(result.success).toBe(true);

      // Profile sections reset
      expect(mockProfile.storeUpdateSection).toHaveBeenCalledWith('Identity', '- Name: (not yet learned)');
      expect(mockProfile.storeUpdateSection).toHaveBeenCalledWith('Key Facts', '*No facts learned yet.*');
      expect(mockProfile.save).toHaveBeenCalled();

      // Agent learned preferences cleared
      expect(mockWeather._sections['Learned Preferences']).toContain('No preferences learned yet');
      expect(mockDJ._sections['Learned Preferences']).toContain('No preferences learned yet');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // LLM Call Verification
  // ═══════════════════════════════════════════════════════════════════════════

  describe('LLM Call Verification', () => {
    it('should use standard profile for orchestration', async () => {
      await agent.execute({ content: 'test' });
      expect(mockAiJson).toHaveBeenCalledTimes(1);

      const [_prompt, options] = mockAiJson.mock.calls[0];
      expect(options.profile).toBe('standard');
      expect(options.feature).toBe('memory-agent-orchestrator');
    });

    it('should include all agent memories and profile in the prompt', async () => {
      await agent.execute({ content: 'What do you know?' });

      const [prompt] = mockAiJson.mock.calls[0];
      expect(prompt).toContain('GLOBAL USER PROFILE');
      expect(prompt).toContain('AGENT MEMORIES');
      expect(prompt).toContain('Name: Isaac');
      expect(prompt).toContain('Home Location: Berkeley');
      expect(prompt).toContain('radio-morning-show');
      expect(prompt).toContain('jazz');
      expect(prompt).toContain('What do you know?');
    });

    it('should include conversation history', async () => {
      await agent.execute({
        content: 'My name is Robb',
        conversationHistory: [
          { role: 'user', content: 'Call me Robb please' },
          { role: 'assistant', content: 'Sure.' },
        ],
      });

      const [prompt] = mockAiJson.mock.calls[0];
      expect(prompt).toContain('Call me Robb please');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Edge Cases
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Edge Cases', () => {
    it('should handle empty content', async () => {
      const result = await agent.execute({ content: '' });
      expect(result.success).toBe(false);
    });

    it('should handle AI returning null', async () => {
      mockAiJson.mockResolvedValueOnce(null);
      const result = await agent.execute({ content: 'test' });
      expect(result.success).toBe(false);
    });

    it('should handle AI returning no action', async () => {
      mockAiJson.mockResolvedValueOnce({ response: 'dunno' });
      const result = await agent.execute({ content: 'test' });
      expect(result.success).toBe(false);
    });

    it('should handle AI throwing an error', async () => {
      mockAiJson.mockRejectedValueOnce(new Error('API down'));
      const result = await agent.execute({ content: 'test' });
      expect(result.success).toBe(false);
      expect(result.message).toContain('trouble');
    });

    it('should handle empty agentChanges from AI', async () => {
      mockAiJson.mockResolvedValueOnce({
        action: 'update',
        response: 'Nothing needed.',
        profileChanges: { facts: {}, deleteKeys: [] },
        agentChanges: [],
      });
      const result = await agent.execute({ content: 'test' });
      expect(result.success).toBe(true);
    });

    it('should handle missing profileChanges from AI', async () => {
      mockAiJson.mockResolvedValueOnce({
        action: 'update',
        response: 'Done.',
        // no profileChanges
        agentChanges: [],
      });
      const result = await agent.execute({ content: 'test' });
      expect(result.success).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Passive Observation (observeConversation)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Passive Observation', () => {
    beforeEach(() => {
      // Reset observation state between tests
      agent._lastObservationTime = 0;
      agent._recentObservations = [];
    });

    it('should learn a new fact from a weather conversation', async () => {
      mockAiJson.mockResolvedValueOnce({
        shouldUpdate: true,
        reasoning: 'User mentioned they live in Portland now',
        profileChanges: { facts: { 'Home City': 'Portland' } },
        agentChanges: [
          {
            agentId: 'weather-agent',
            reason: 'New home city',
            sectionUpdates: { 'Learned Preferences': '- Home Location: Portland' },
          },
        ],
      });

      const result = await agent.observeConversation(
        { content: "What's the weather in Portland? I just moved there" },
        { success: true, message: "It's 55F and cloudy in Portland." },
        'weather-agent'
      );

      expect(result.learned).toBe(true);
      expect(result.changes.length).toBeGreaterThan(0);
      expect(mockProfile.updateFact).toHaveBeenCalledWith('Home City', 'Portland');
      expect(mockProfile.save).toHaveBeenCalled();
      expect(mockWeather._sections['Learned Preferences']).toContain('Portland');
    });

    it('should skip trivial conversations', async () => {
      const result = await agent.observeConversation(
        { content: 'hi' },
        { success: true, message: 'Hello!' },
        'smalltalk-agent'
      );

      expect(result.learned).toBe(false);
      expect(result.reason).toBe('trivial');
      expect(mockAiJson).not.toHaveBeenCalled();
    });

    it('should skip failed task results', async () => {
      const result = await agent.observeConversation(
        { content: 'What is the weather in Tokyo?' },
        { success: false, message: 'API error' },
        'weather-agent'
      );

      expect(result.learned).toBe(false);
      expect(result.reason).toBe('trivial');
    });

    it('should skip self-observation (memory-agent)', async () => {
      const result = await agent.observeConversation(
        { content: 'My name is Robb' },
        { success: true, message: 'Updated your name.' },
        'memory-agent'
      );

      expect(result.learned).toBe(false);
      expect(result.reason).toBe('self');
    });

    it('should respect cooldown between observations', async () => {
      // First observation succeeds
      mockAiJson.mockResolvedValueOnce({
        shouldUpdate: false,
        reasoning: 'Nothing new',
        profileChanges: { facts: {} },
        agentChanges: [],
      });

      await agent.observeConversation(
        { content: 'What time is it in New York?' },
        { success: true, message: "It's 3:15 PM EST." },
        'time-agent'
      );

      // Second observation within cooldown should be skipped
      const result2 = await agent.observeConversation(
        { content: 'And the weather?' },
        { success: true, message: 'Sunny and 72F.' },
        'weather-agent'
      );

      expect(result2.learned).toBe(false);
      expect(result2.reason).toBe('cooldown');
      // AI should only have been called once
      expect(mockAiJson).toHaveBeenCalledTimes(1);
    });

    it('should deduplicate similar messages', async () => {
      // First observation
      mockAiJson.mockResolvedValueOnce({
        shouldUpdate: false,
        reasoning: 'Routine check',
        profileChanges: { facts: {} },
        agentChanges: [],
      });

      await agent.observeConversation(
        { content: 'What time is it?' },
        { success: true, message: '3 PM.' },
        'time-agent'
      );

      // Reset cooldown but same message
      agent._lastObservationTime = 0;

      const result2 = await agent.observeConversation(
        { content: 'What time is it?' },
        { success: true, message: '3:01 PM.' },
        'time-agent'
      );

      expect(result2.learned).toBe(false);
      expect(result2.reason).toBe('dedup');
    });

    it('should not update when AI says shouldUpdate: false', async () => {
      mockAiJson.mockResolvedValueOnce({
        shouldUpdate: false,
        reasoning: 'Routine weather check, nothing personal',
        profileChanges: { facts: {} },
        agentChanges: [],
      });

      const result = await agent.observeConversation(
        { content: "What's the weather?" },
        { success: true, message: 'Sunny and 72F in Berkeley.' },
        'weather-agent'
      );

      expect(result.learned).toBe(false);
      expect(mockProfile.updateFact).not.toHaveBeenCalled();
    });

    it('should skip profile updates that match existing values', async () => {
      // Profile already has Name: Isaac
      mockAiJson.mockResolvedValueOnce({
        shouldUpdate: true,
        reasoning: 'Agent addressed user by name',
        profileChanges: { facts: { Name: 'Isaac' } }, // same as existing
        agentChanges: [],
      });

      const result = await agent.observeConversation(
        { content: "Good morning Isaac, here's your brief" },
        { success: true, message: 'Morning brief delivered.' },
        'daily-brief-agent'
      );

      // learned should be false because nothing actually changed
      expect(result.learned).toBe(false);
      expect(mockProfile.updateFact).not.toHaveBeenCalled();
    });

    it('should update multiple agents from a single observation', async () => {
      mockAiJson.mockResolvedValueOnce({
        shouldUpdate: true,
        reasoning: 'User revealed preference for Celsius and Portland location',
        profileChanges: { facts: { 'Temperature Units': 'Celsius', 'Home City': 'Portland' } },
        agentChanges: [
          {
            agentId: 'weather-agent',
            reason: 'New city + units',
            sectionUpdates: { 'Learned Preferences': '- Home Location: Portland\n- Units: Celsius' },
          },
          {
            agentId: 'daily-brief-agent',
            reason: 'User moved',
            sectionUpdates: { 'Learned Patterns': '- User relocated to Portland' },
          },
        ],
      });

      const result = await agent.observeConversation(
        { content: "Give me the Portland weather in Celsius, that's where I live now" },
        { success: true, message: '12C and rainy in Portland.' },
        'weather-agent'
      );

      expect(result.learned).toBe(true);
      expect(result.changes.length).toBeGreaterThanOrEqual(3); // 2 profile + at least 1 agent
      expect(mockWeather._sections['Learned Preferences']).toContain('Portland');
      expect(mockDailyBrief._sections['Learned Patterns']).toContain('Portland');
    });

    it('should include the prompt context to the AI', async () => {
      mockAiJson.mockResolvedValueOnce({
        shouldUpdate: false,
        reasoning: 'Nothing new',
        profileChanges: { facts: {} },
        agentChanges: [],
      });

      await agent.observeConversation(
        { content: 'Play some jazz music' },
        { success: true, message: 'Playing jazz playlist.' },
        'dj-agent'
      );

      const [prompt, options] = mockAiJson.mock.calls[0];
      // Should include the conversation
      expect(prompt).toContain('Play some jazz music');
      expect(prompt).toContain('Playing jazz playlist');
      expect(prompt).toContain('dj-agent');
      // Should include existing memories for context
      expect(prompt).toContain('CURRENT USER PROFILE');
      expect(prompt).toContain('ALL AGENT MEMORIES');
      // Should use fast profile (not powerful -- observation is lightweight)
      expect(options.profile).toBe('fast');
      expect(options.feature).toBe('memory-agent-observer');
    });

    it('should handle AI errors gracefully', async () => {
      mockAiJson.mockRejectedValueOnce(new Error('API timeout'));

      const result = await agent.observeConversation(
        { content: 'Something interesting happened' },
        { success: true, message: 'Indeed it did.' },
        'help-agent'
      );

      expect(result.learned).toBe(false);
      expect(result.reason).toContain('API timeout');
    });

    it('should accept result.output as the agent response', async () => {
      mockAiJson.mockResolvedValueOnce({
        shouldUpdate: false,
        reasoning: 'Routine',
        profileChanges: { facts: {} },
        agentChanges: [],
      });

      await agent.observeConversation(
        { content: 'Play my favorite playlist' },
        { success: true, output: 'Now playing jazz favorites.', message: '' },
        'dj-agent'
      );

      const [prompt] = mockAiJson.mock.calls[0];
      expect(prompt).toContain('Now playing jazz favorites');
    });

    it('should evict oldest dedup entries after buffer exceeds 20', async () => {
      // Fill the dedup buffer with 20 unique entries
      for (let i = 0; i < 20; i++) {
        agent._recentObservations.push(`msg-${i}|agent-${i}`);
      }
      expect(agent._recentObservations.length).toBe(20);
      const firstEntry = agent._recentObservations[0];

      // Observe one more -- should push out the oldest
      mockAiJson.mockResolvedValueOnce({
        shouldUpdate: false,
        reasoning: 'nothing',
        profileChanges: { facts: {} },
        agentChanges: [],
      });

      await agent.observeConversation(
        { content: 'A brand new unique message here' },
        { success: true, message: 'Response.' },
        'help-agent'
      );

      expect(agent._recentObservations.length).toBe(20);
      expect(agent._recentObservations).not.toContain(firstEntry);
      expect(agent._recentObservations[agent._recentObservations.length - 1]).toContain('a brand new unique message');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Truncation and Error Resilience
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Truncation and Error Resilience', () => {
    it('should truncate agent memories exceeding per-agent char limit', async () => {
      // Create a mock memory with content > 2000 chars
      const longContent = 'x'.repeat(3000);
      const longMemory = createMockMemory('long-agent', {
        'Learned Preferences': longContent,
      });

      agent._setDeps({
        getUserProfile: () => mockProfile.instance,
        getAgentMemory: (agentId) => {
          if (agentId === 'memory-agent') return mockSelfMemory;
          if (agentId === 'long-agent') return longMemory;
          return createMockMemory(agentId, {});
        },
        listAgentMemories: () => ['long-agent', 'memory-agent', 'user-profile'],
        aiJson: mockAiJson,
      });

      const memories = await agent._loadAllAgentMemories();
      expect(memories.has('long-agent')).toBe(true);
      const { raw } = memories.get('long-agent');
      // Should be truncated to ~2000 + "... (truncated)" suffix
      expect(raw.length).toBeLessThanOrEqual(2020);
      expect(raw).toContain('... (truncated)');
    });

    it('should stop loading agents when total char budget is reached', async () => {
      // Create many agents that each produce ~1500 chars
      const agentIds = [];
      const mems = {};
      for (let i = 0; i < 30; i++) {
        const id = `agent-${i}`;
        agentIds.push(id);
        mems[id] = createMockMemory(id, {
          Data: 'y'.repeat(1500),
        });
      }
      agentIds.push('memory-agent', 'user-profile');

      agent._setDeps({
        getUserProfile: () => mockProfile.instance,
        getAgentMemory: (agentId) => {
          if (agentId === 'memory-agent') return mockSelfMemory;
          return mems[agentId] || createMockMemory(agentId, {});
        },
        listAgentMemories: () => agentIds,
        aiJson: mockAiJson,
      });

      const memories = await agent._loadAllAgentMemories();
      // 30 agents * ~1500 chars each = ~45000 chars total, but budget is 30000
      // So not all 30 should be loaded
      expect(memories.size).toBeLessThan(30);
      expect(memories.size).toBeGreaterThan(0);
    });

    it('should continue loading if one agent memory fails', async () => {
      const failingMemory = createMockMemory('failing-agent', {});
      failingMemory.load = vi.fn(async () => {
        throw new Error('Corrupted file');
      });

      agent._setDeps({
        getUserProfile: () => mockProfile.instance,
        getAgentMemory: (agentId) => {
          if (agentId === 'memory-agent') return mockSelfMemory;
          if (agentId === 'failing-agent') return failingMemory;
          if (agentId === 'weather-agent') return mockWeather;
          return createMockMemory(agentId, {});
        },
        listAgentMemories: () => ['failing-agent', 'weather-agent', 'memory-agent', 'user-profile'],
        aiJson: mockAiJson,
      });

      const memories = await agent._loadAllAgentMemories();
      // failing-agent should be skipped, weather-agent should still load
      expect(memories.has('failing-agent')).toBe(false);
      expect(memories.has('weather-agent')).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Audit Trail
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Audit Trail', () => {
    it('should log changes to Change Log after execute() update', async () => {
      mockAiJson.mockResolvedValueOnce({
        action: 'update',
        response: 'Updated name.',
        profileChanges: { facts: { Name: 'Robb' }, deleteKeys: [] },
        agentChanges: [],
      });

      await agent.execute({ content: 'My name is Robb' });

      // The memory-agent's own Change Log should have been updated
      expect(mockSelfMemory._sections['Change Log']).toContain('update');
      expect(mockSelfMemory._sections['Change Log']).toContain('[profile]');
      expect(mockSelfMemory.saveFn).toHaveBeenCalled();
    });

    it('should log changes to Change Log after observeConversation()', async () => {
      agent._lastObservationTime = 0;
      agent._recentObservations = [];

      mockAiJson.mockResolvedValueOnce({
        shouldUpdate: true,
        reasoning: 'User said their name',
        profileChanges: { facts: { Name: 'Robb' } },
        agentChanges: [],
      });

      await agent.observeConversation(
        { content: 'Hey, my name is Robb by the way' },
        { success: true, message: 'Nice to meet you, Robb!' },
        'smalltalk-agent'
      );

      expect(mockSelfMemory._sections['Change Log']).toContain('observe');
      expect(mockSelfMemory._sections['Change Log']).toContain('[profile]');
      expect(mockSelfMemory.saveFn).toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // clear_all and _findFactSection edge cases
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Additional Edge Cases', () => {
    it('should not crash on clear_all when agent has no Learned Preferences section', async () => {
      // Create an agent with no Learned Preferences
      const bareMemory = createMockMemory('bare-agent', {
        'User Notes': 'Some notes',
      });

      agent._setDeps({
        getUserProfile: () => mockProfile.instance,
        getAgentMemory: (agentId) => {
          if (agentId === 'memory-agent') return mockSelfMemory;
          if (agentId === 'bare-agent') return bareMemory;
          return createMockMemory(agentId, {});
        },
        listAgentMemories: () => ['bare-agent', 'memory-agent', 'user-profile'],
        aiJson: mockAiJson,
      });

      mockAiJson.mockResolvedValueOnce({
        action: 'clear_all',
        response: 'All cleared.',
        profileChanges: { facts: {}, deleteKeys: [] },
        agentChanges: [],
      });

      const result = await agent.execute({ content: 'Clear everything' });
      expect(result.success).toBe(true);
      // bare-agent should not have gained a Learned Preferences section
      // (clear_all only resets sections that already exist)
      expect(bareMemory._sections['Learned Preferences']).toBeUndefined();
    });

    it('should return null from _findFactSection for unknown keys', () => {
      const section = agent._findFactSection(mockProfile.instance, 'NonexistentKey');
      expect(section).toBeNull();
    });
  });
});
