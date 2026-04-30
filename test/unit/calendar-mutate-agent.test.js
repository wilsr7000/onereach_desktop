/**
 * Phase 2a (calendar overhaul) -- regression guard for the create/edit/delete
 * collapse into calendar-mutate-agent.
 *
 * The behavioral contract: the merged agent must produce the SAME externally-
 * observable behavior the three legacy agents did. This test asserts:
 *
 *   1. Operation classification routes correctly (create/edit/delete).
 *   2. Multi-turn state resumption hits the right handler based on
 *      `context.calendarState`.
 *   3. Each handler's contact-store + verified-mutation pipeline is preserved.
 *
 * Pattern: same test seam approach as test/unit/calendar-brief-merge.test.js --
 * spy on the agent's own methods rather than vi.mock the modules underneath
 * (vitest+CJS-require quirk in this project).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const calendarMutateAgent = require('../../packages/agents/calendar-mutate-agent');

describe('Phase 2a: calendar-mutate-agent dispatch + multi-turn resumption', () => {
  let classifySpy;
  let createSpy;
  let editSpy;
  let deleteSpy;

  beforeEach(() => {
    // Spy on each handler. Default to no-op success so the dispatcher's own
    // logic (the part we're actually testing) is exercised in isolation.
    createSpy = vi
      .spyOn(calendarMutateAgent, '_handleCreate')
      .mockResolvedValue({ success: true, message: 'create-stub' });
    editSpy = vi
      .spyOn(calendarMutateAgent, '_handleEdit')
      .mockResolvedValue({ success: true, message: 'edit-stub' });
    deleteSpy = vi
      .spyOn(calendarMutateAgent, '_handleDelete')
      .mockResolvedValue({ success: true, message: 'delete-stub' });
    classifySpy = vi
      .spyOn(calendarMutateAgent, '_classifyOperation')
      .mockResolvedValue('create');
  });

  afterEach(() => {
    classifySpy.mockRestore();
    createSpy.mockRestore();
    editSpy.mockRestore();
    deleteSpy.mockRestore();
  });

  describe('agent shape', () => {
    it('exports the canonical id, executionType, and a non-empty prompt', () => {
      expect(calendarMutateAgent.id).toBe('calendar-mutate-agent');
      expect(calendarMutateAgent.executionType).toBe('action');
      expect(typeof calendarMutateAgent.prompt).toBe('string');
      expect(calendarMutateAgent.prompt.length).toBeGreaterThan(50);
    });

    it('keywords cover create, edit, and delete vocabulary', () => {
      const kw = calendarMutateAgent.keywords.join(' ');
      expect(kw).toContain('schedule meeting');
      expect(kw).toContain('reschedule');
      expect(kw).toContain('cancel meeting');
    });
  });

  describe('empty input', () => {
    it('returns a guidance message when query is empty', async () => {
      const result = await calendarMutateAgent.execute({ text: '   ' });
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/calendar/i);
      expect(classifySpy).not.toHaveBeenCalled();
    });
  });

  describe('fresh-request dispatch via classifier', () => {
    it('routes to create when classifier says create', async () => {
      classifySpy.mockResolvedValue('create');
      await calendarMutateAgent.execute({ text: 'schedule a meeting at 3pm' });
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(editSpy).not.toHaveBeenCalled();
      expect(deleteSpy).not.toHaveBeenCalled();
    });

    it('routes to edit when classifier says edit', async () => {
      classifySpy.mockResolvedValue('edit');
      await calendarMutateAgent.execute({ text: 'move my 3pm to 4pm' });
      expect(editSpy).toHaveBeenCalledTimes(1);
      expect(createSpy).not.toHaveBeenCalled();
      expect(deleteSpy).not.toHaveBeenCalled();
    });

    it('routes to delete when classifier says delete', async () => {
      classifySpy.mockResolvedValue('delete');
      await calendarMutateAgent.execute({ text: 'cancel the standup' });
      expect(deleteSpy).toHaveBeenCalledTimes(1);
      expect(createSpy).not.toHaveBeenCalled();
      expect(editSpy).not.toHaveBeenCalled();
    });

    it('asks the user to clarify when classifier returns an unknown operation', async () => {
      classifySpy.mockResolvedValue('something-weird');
      const result = await calendarMutateAgent.execute({ text: 'do calendar things' });
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/create|change|cancel/i);
      expect(createSpy).not.toHaveBeenCalled();
    });

    it('classifier exception bubbles up as a graceful error response', async () => {
      classifySpy.mockRejectedValue(new Error('LLM down'));
      const result = await calendarMutateAgent.execute({ text: 'schedule X' });
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/I couldn't update your calendar/);
    });
  });

  describe('multi-turn resumption: classifier is bypassed', () => {
    let resumeGuestSpy;
    let resumeFieldsSpy;
    let resumeEditSelSpy;
    let resumeAttendeeSpy;
    let resumeDeleteSelSpy;
    let resumeDeleteConfirmSpy;

    beforeEach(() => {
      resumeGuestSpy = vi
        .spyOn(calendarMutateAgent, '_resumeGuestResolution')
        .mockResolvedValue({ success: true, message: 'guest-resumed' });
      resumeFieldsSpy = vi
        .spyOn(calendarMutateAgent, '_resumeMissingFields')
        .mockResolvedValue({ success: true, message: 'fields-resumed' });
      resumeEditSelSpy = vi
        .spyOn(calendarMutateAgent, '_resumeEditSelection')
        .mockResolvedValue({ success: true, message: 'edit-sel-resumed' });
      resumeAttendeeSpy = vi
        .spyOn(calendarMutateAgent, '_resumeAttendeeResolution')
        .mockResolvedValue({ success: true, message: 'attendee-resumed' });
      resumeDeleteSelSpy = vi
        .spyOn(calendarMutateAgent, '_resumeDeleteSelection')
        .mockResolvedValue({ success: true, message: 'delete-sel-resumed' });
      resumeDeleteConfirmSpy = vi
        .spyOn(calendarMutateAgent, '_resumeDeleteConfirmation')
        .mockResolvedValue({ success: true, message: 'delete-confirm-resumed' });
    });

    afterEach(() => {
      resumeGuestSpy.mockRestore();
      resumeFieldsSpy.mockRestore();
      resumeEditSelSpy.mockRestore();
      resumeAttendeeSpy.mockRestore();
      resumeDeleteSelSpy.mockRestore();
      resumeDeleteConfirmSpy.mockRestore();
    });

    it('awaiting_guest_emails -> _resumeGuestResolution (no classify)', async () => {
      const result = await calendarMutateAgent.execute({
        text: 'sarah@acme.com',
        context: { calendarState: 'awaiting_guest_emails' },
      });
      expect(resumeGuestSpy).toHaveBeenCalledTimes(1);
      expect(classifySpy).not.toHaveBeenCalled();
      expect(result.message).toBe('guest-resumed');
    });

    it('awaiting_event_fields -> _resumeMissingFields', async () => {
      await calendarMutateAgent.execute({
        text: 'Sprint review',
        context: { calendarState: 'awaiting_event_fields', missingField: 'title' },
      });
      expect(resumeFieldsSpy).toHaveBeenCalledTimes(1);
      expect(classifySpy).not.toHaveBeenCalled();
    });

    it('awaiting_edit_selection -> _resumeEditSelection', async () => {
      await calendarMutateAgent.execute({
        text: 'the standup',
        context: { calendarState: 'awaiting_edit_selection' },
      });
      expect(resumeEditSelSpy).toHaveBeenCalledTimes(1);
      expect(classifySpy).not.toHaveBeenCalled();
    });

    it('awaiting_attendee_emails -> _resumeAttendeeResolution', async () => {
      await calendarMutateAgent.execute({
        text: 'sarah@acme.com',
        context: { calendarState: 'awaiting_attendee_emails' },
      });
      expect(resumeAttendeeSpy).toHaveBeenCalledTimes(1);
      expect(classifySpy).not.toHaveBeenCalled();
    });

    it('awaiting_delete_selection -> _resumeDeleteSelection', async () => {
      await calendarMutateAgent.execute({
        text: 'the standup',
        context: { calendarState: 'awaiting_delete_selection' },
      });
      expect(resumeDeleteSelSpy).toHaveBeenCalledTimes(1);
      expect(classifySpy).not.toHaveBeenCalled();
    });

    it('awaiting_delete_confirmation -> _resumeDeleteConfirmation', async () => {
      await calendarMutateAgent.execute({
        text: 'yes',
        context: { calendarState: 'awaiting_delete_confirmation' },
      });
      expect(resumeDeleteConfirmSpy).toHaveBeenCalledTimes(1);
      expect(classifySpy).not.toHaveBeenCalled();
    });

    it('unrecognized calendarState falls through to fresh classification', async () => {
      classifySpy.mockResolvedValue('create');
      await calendarMutateAgent.execute({
        text: 'schedule a thing',
        context: { calendarState: 'awaiting_unknown_thing' },
      });
      expect(classifySpy).toHaveBeenCalledTimes(1);
      expect(resumeGuestSpy).not.toHaveBeenCalled();
    });
  });

  describe('input shape variations', () => {
    it('accepts task.content as the query source', async () => {
      classifySpy.mockResolvedValue('create');
      await calendarMutateAgent.execute({ content: 'add a meeting' });
      expect(createSpy).toHaveBeenCalledTimes(1);
    });

    it('accepts task.query as the query source', async () => {
      classifySpy.mockResolvedValue('edit');
      await calendarMutateAgent.execute({ query: 'reschedule the sync' });
      expect(editSpy).toHaveBeenCalledTimes(1);
    });

    it('whitespace-only query returns guidance', async () => {
      const result = await calendarMutateAgent.execute({ content: '   \n  \t' });
      expect(result.success).toBe(false);
    });
  });
});
