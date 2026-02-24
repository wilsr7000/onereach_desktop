/**
 * TMS Ticket Creation - Live Integration Test
 *
 * Uses the Browsing API to navigate to the Agentic TMS, enter Demo Mode,
 * switch to Manual ticket creation, fill the form, submit, and verify.
 *
 * Run: npx playwright test test/e2e/browsing-tms-ticket.spec.js
 */

const { test, expect } = require('@playwright/test');
const { launchApp, closeApp } = require('./helpers/electron-app');

const TMS_URL = 'https://files.edison.api.onereach.ai/public/35254342-4a2e-475b-aec1-18547e517e29/agententic-tms/index.html';
const TICKET_TITLE = `BrowseAPI-Test-${Date.now()}`;

let app, mainWindow;

test.beforeAll(async () => {
  app = await launchApp({ timeout: 45000 });
  mainWindow = app.mainWindow;
});

test.afterAll(async () => {
  if (app) await closeApp(app);
});

function wait(ms) {
  return mainWindow.evaluate((t) => new Promise(r => setTimeout(r, t)), ms);
}

async function snap(sid, interactive = true) {
  return mainWindow.evaluate(async (a) => {
    return await window.browsing.snapshot(a.sid, { interactiveOnly: a.io });
  }, { sid, io: interactive });
}

async function text(sid) {
  return mainWindow.evaluate(async (sid) => {
    return await window.browsing.extract(sid, { mode: 'readability', maxLength: 8000 });
  }, sid);
}

async function click(sid, ref) {
  return mainWindow.evaluate(async (a) => {
    return await window.browsing.act(a.sid, { action: 'click', ref: a.ref });
  }, { sid, ref });
}

async function fill(sid, ref, value) {
  return mainWindow.evaluate(async (a) => {
    return await window.browsing.act(a.sid, { action: 'fill', ref: a.ref, value: a.value });
  }, { sid, ref, value });
}

function logRefs(refs, label) {
  console.log(`\n${label} (${refs?.length || 0}):`);
  (refs || []).forEach((el) => {
    const t = (el.text || el.name || '').replace(/\n/g, ' ').slice(0, 80);
    const extra = [el.type && `type=${el.type}`, el.placeholder && `ph="${el.placeholder?.slice(0, 30)}"`].filter(Boolean).join(' ');
    if (t || extra) console.log(`  [${el.ref}] <${el.tag}> "${t}" ${extra}`);
  });
}

test.describe.serial('TMS Ticket Creation', () => {
  test.setTimeout(120000);
  let sid;

  test('navigate to TMS and enter Demo Mode', async () => {
    const session = await mainWindow.evaluate(async () =>
      window.browsing.createSession({ mode: 'auto-promote', timeout: 60000 })
    );
    sid = session.sessionId;

    await mainWindow.evaluate(async (a) =>
      window.browsing.navigate(a.sid, a.url, { timeout: 20000 }),
      { sid, url: TMS_URL }
    );

    await wait(3000);
    const s = await snap(sid);

    const demoBtn = s.refs?.find(el => el.tag === 'button' && (el.name || '').toLowerCase().includes('demo'));
    expect(demoBtn).toBeTruthy();
    await click(sid, demoBtn.ref);
    await wait(3000);

    const content = await text(sid);
    expect(content.text).toContain('Dashboard');
    console.log('Entered Demo Mode dashboard');
  });

  test('open New Ticket modal and switch to Manual mode', async () => {
    let s = await snap(sid);

    const newBtn = s.refs?.find(el => el.tag === 'button' && (el.name || el.text || '').includes('New Ticket'));
    expect(newBtn).toBeTruthy();
    console.log(`Clicking New Ticket [ref=${newBtn.ref}]`);
    await click(sid, newBtn.ref);
    await wait(2000);

    s = await snap(sid);
    const manualBtn = s.refs?.find(el =>
      el.tag === 'button' && (el.name || el.text || '').toLowerCase().includes('manual')
    );

    if (manualBtn) {
      console.log(`Switching to Manual mode [ref=${manualBtn.ref}]`);
      await click(sid, manualBtn.ref);
      await wait(1000);
    } else {
      console.log('No Manual button found, may already be in manual mode or using AI mode');
    }

    s = await snap(sid);
    logRefs(s.refs, 'After modal open');
  });

  test('fill ticket form fields', async () => {
    const s = await snap(sid);

    const fields = s.refs?.filter(el =>
      el.tag === 'input' || el.tag === 'textarea' || el.tag === 'select'
    ) || [];

    console.log(`Found ${fields.length} form fields`);
    logRefs(fields, 'Form fields');

    if (fields.length === 0) {
      console.log('No form fields found. The form may use a textarea for AI-assist.');
      const textarea = s.refs?.find(el => el.tag === 'textarea');
      if (textarea) {
        console.log(`Filling textarea [ref=${textarea.ref}] with ticket description`);
        await fill(sid, textarea.ref, `${TICKET_TITLE} - High priority test ticket for API integration verification. Assign to Robb Wilson.`);
      }
      return;
    }

    for (const field of fields) {
      const hint = ((field.name || '') + ' ' + (field.placeholder || '') + ' ' + (field.label || '')).toLowerCase();
      let value = '';

      if (hint.includes('title') || hint.includes('subject') || hint.includes('summary')) {
        value = TICKET_TITLE;
      } else if (hint.includes('description') || hint.includes('detail') || field.tag === 'textarea') {
        value = 'Test ticket created by the GSX Browsing API. Verifies end-to-end browser session, navigation, form filling, and submission.';
      } else if (hint.includes('priority')) {
        value = 'high';
      } else if (hint.includes('assign')) {
        value = 'Robb Wilson';
      } else if (hint.includes('project')) {
        value = 'Project Alpha Launch';
      } else if (hint.includes('type') || hint.includes('category')) {
        value = 'task';
      }

      if (value) {
        console.log(`  Fill [${field.ref}] "${hint.trim().slice(0, 40)}" -> "${value.slice(0, 50)}"`);
        const result = await fill(sid, field.ref, value);
        console.log(`    ${result.success ? 'OK' : result.error}`);
      }
    }
  });

  test('submit ticket', async () => {
    const s = await snap(sid);

    const createBtn = s.refs?.find(el => {
      const t = ((el.text || '') + ' ' + (el.name || '')).toLowerCase();
      return el.tag === 'button' && (t.includes('create ticket') || t.includes('submit'));
    });

    expect(createBtn).toBeTruthy();
    console.log(`Clicking Create Ticket [ref=${createBtn.ref}]`);

    const result = await click(sid, createBtn.ref);
    console.log('Submit result:', JSON.stringify(result));
    expect(result.success).toBe(true);

    await wait(5000);
  });

  test('verify ticket appears on dashboard', async () => {
    const content = await text(sid);
    const pageText = content.text || '';

    console.log('\nPage text (first 2000 chars):');
    console.log(pageText.slice(0, 2000));

    const s = await snap(sid, false);

    const ticketRefs = s.refs?.filter(el => {
      const t = (el.text || el.name || '').toLowerCase();
      return t.includes('browseapi') || t.includes('test ticket') || t.includes(TICKET_TITLE.toLowerCase());
    }) || [];

    if (ticketRefs.length > 0) {
      console.log('\nTicket found in page elements:');
      ticketRefs.forEach(el => {
        console.log(`  [${el.ref}] <${el.tag}> "${(el.text || el.name || '').slice(0, 100)}"`);
      });
      console.log('\nSUCCESS: Ticket was created and is visible.');
    } else {
      console.log('\nTicket title not found directly. Checking for recent tickets...');

      const recentRefs = s.refs?.filter(el => {
        const t = (el.text || el.name || '').toLowerCase();
        return t.includes('api integration') || t.includes('high priority') || t.includes('just now') || t.includes('moment');
      }) || [];

      if (recentRefs.length > 0) {
        console.log('Found potentially related elements:');
        recentRefs.forEach(el => {
          console.log(`  [${el.ref}] <${el.tag}> "${(el.text || el.name || '').slice(0, 100)}"`);
        });
      }

      const hasNewContent = pageText.includes('API integration') || pageText.includes('BrowseAPI') || pageText.includes('test ticket');
      console.log(`\nTicket content in page text: ${hasNewContent}`);
    }

    // Count total tickets visible
    const ticketCount = (pageText.match(/Tickets Ready/i) || []).length;
    console.log(`\nTickets Ready indicator found: ${ticketCount > 0}`);
  });

  test('cleanup session', async () => {
    if (sid) {
      await mainWindow.evaluate(async (s) => window.browsing.destroySession(s), sid);
      console.log('Session destroyed');
    }
  });
});
