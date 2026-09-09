/**
 * ADR-098 — the Details section: an asset's typed fields shown with
 * the control their type deserves and edited in place through the
 * metadata callbacks; link-based kinds edit their address.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from 'vitest';
import { buildKindDetails } from '../../spaces/asset-details.js';

function rows(section: HTMLElement): string[] {
  return Array.from(section.querySelectorAll<HTMLElement>('.spaces-detail-kinddetails-row')).map((r) => r.getAttribute('data-key') ?? '');
}

describe('buildKindDetails', () => {
  it('returns null for kinds with nothing typed (playbook), a section for the rest', () => {
    expect(buildKindDetails({ id: 'a', kind: 'playbook' })).toBeNull();
    const tool = buildKindDetails({ id: 'a', kind: 'tool', metadata: { tool_type: 'mcp', tool_endpoint: 'https://x.example.com/mcp' } });
    expect(tool).not.toBeNull();
    expect(tool?.querySelector('h3')?.textContent).toBe('Tool details');
    expect(rows(tool as HTMLElement)).toContain('tool_type');
    expect(rows(tool as HTMLElement)[0]).toBe('sourceUrl');
  });

  it('formats values by type and shows unset fields as —', () => {
    const el = buildKindDetails({
      id: 'a',
      kind: 'meeting',
      metadata: { meeting_at: '2026-09-09T17:00:00.000Z', meeting_duration: 2700, meeting_attendees: ['Ada', 'Grace'] },
    }) as HTMLElement;
    const value = (key: string): string => el.querySelector(`[data-key="${key}"] .spaces-detail-kinddetails-value`)?.textContent ?? '';
    expect(value('meeting_at')).toMatch(/2026/);
    expect(value('meeting_duration')).toBe('45m');
    expect(value('meeting_attendees')).toBe('Ada, Grace');
    expect(value('meeting_organizer')).toBe('—');
  });

  it('read-only fields get no edit button; editable ones do when a callback is wired', () => {
    const el = buildKindDetails({ id: 'a', kind: 'video', metadata: { durationSeconds: 90 } }, { onMetadataValueEdit: async () => undefined }) as HTMLElement;
    const ro = el.querySelector('[data-key="durationSeconds"]') as HTMLElement;
    expect(ro.classList.contains('is-readonly')).toBe(true);
    expect(ro.querySelector('button')).toBeNull();
    const poster = el.querySelector('[data-key="video_poster"]') as HTMLElement;
    expect(poster.querySelector('button')?.textContent).toBe('Set');
    // Without callbacks the section is read-only.
    const plain = buildKindDetails({ id: 'a', kind: 'video' }) as HTMLElement;
    expect(plain.querySelectorAll('button').length).toBe(0);
  });

  it('editing a select saves the option value through onMetadataValueEdit', async () => {
    const onEdit = vi.fn(async () => undefined);
    const el = buildKindDetails({ id: 'a', kind: 'tool', metadata: {} }, { onMetadataValueEdit: onEdit }) as HTMLElement;
    document.body.appendChild(el);
    const row = el.querySelector('[data-key="tool_type"]') as HTMLElement;
    (row.querySelector('button') as HTMLButtonElement).click();
    const select = row.querySelector('select') as HTMLSelectElement;
    expect(select).not.toBeNull();
    select.value = 'api';
    select.dispatchEvent(new Event('change'));
    await Promise.resolve();
    expect(onEdit).toHaveBeenCalledWith('tool_type', 'api');
  });

  it('editing a duration parses what was typed; a blank removes the key', async () => {
    const onEdit = vi.fn(async () => undefined);
    const onRemove = vi.fn(async () => undefined);
    const el = buildKindDetails({ id: 'a', kind: 'meeting', metadata: { meeting_duration: 600 } }, { onMetadataValueEdit: onEdit, onMetadataRemove: onRemove }) as HTMLElement;
    document.body.appendChild(el);
    const row = el.querySelector('[data-key="meeting_duration"]') as HTMLElement;
    (row.querySelector('button') as HTMLButtonElement).click();
    const input = row.querySelector('input') as HTMLInputElement;
    input.value = '1h 5m';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    // The save settles over several microtasks before the editor closes.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onEdit).toHaveBeenCalledWith('meeting_duration', '3900');
    expect(row.classList.contains('is-editing')).toBe(false);
    (row.querySelector('button') as HTMLButtonElement).click();
    const again = row.querySelector('input') as HTMLInputElement;
    again.value = '';
    (row.querySelector('.spaces-detail-kinddetails-save') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onRemove).toHaveBeenCalledWith('meeting_duration');
  });

  it('an unreadable value shows an inline error and keeps the editor open', async () => {
    const onEdit = vi.fn(async () => undefined);
    const el = buildKindDetails({ id: 'a', kind: 'presentation', metadata: {} }, { onMetadataValueEdit: onEdit }) as HTMLElement;
    document.body.appendChild(el);
    const row = el.querySelector('[data-key="slide_count"]') as HTMLElement;
    (row.querySelector('button') as HTMLButtonElement).click();
    const input = row.querySelector('input') as HTMLInputElement;
    input.value = 'twelve';
    (row.querySelector('.spaces-detail-kinddetails-save') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    expect(onEdit).not.toHaveBeenCalled();
    const error = row.querySelector('.spaces-detail-kinddetails-error') as HTMLElement;
    expect(error.hidden).toBe(false);
    expect(error.textContent).toMatch(/number/);
    expect(row.querySelector('input')).not.toBeNull();
  });

  it('the Link row edits sourceUrl and defaults the scheme', async () => {
    const onSourceUrlSave = vi.fn(async () => undefined);
    const el = buildKindDetails({ id: 'a', kind: 'url', sourceUrl: 'https://old.example.com' }, { onSourceUrlSave }) as HTMLElement;
    document.body.appendChild(el);
    const row = el.querySelector('[data-key="sourceUrl"]') as HTMLElement;
    expect(row.querySelector('a')?.getAttribute('href')).toBe('https://old.example.com');
    (row.querySelector('button') as HTMLButtonElement).click();
    const input = row.querySelector('input') as HTMLInputElement;
    input.value = 'new.example.com/page';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await Promise.resolve();
    expect(onSourceUrlSave).toHaveBeenCalledWith('https://new.example.com/page');
  });

  it('Escape cancels an edit and restores the value cell', () => {
    const el = buildKindDetails({ id: 'a', kind: 'code', metadata: { code_purpose: 'x' } }, { onMetadataValueEdit: async () => undefined }) as HTMLElement;
    document.body.appendChild(el);
    const row = el.querySelector('[data-key="code_purpose"]') as HTMLElement;
    (row.querySelector('button') as HTMLButtonElement).click();
    expect(row.classList.contains('is-editing')).toBe(true);
    (row.querySelector('input') as HTMLInputElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(row.classList.contains('is-editing')).toBe(false);
    expect(row.querySelector('.spaces-detail-kinddetails-value')?.textContent).toBe('x');
  });
});
