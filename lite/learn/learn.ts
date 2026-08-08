/**
 * Learning Center — the main window's Home tab (2026-08-07).
 *
 * Standalone renderer: loads persisted progress + workspace signals
 * over the `window.lite.spaces.learn` bridge (this page runs with the
 * kernel preload), renders the personalized curriculum, and persists
 * every change. The curriculum itself lives in
 * lite/spaces/learn-content.ts; markdown + the hexagon logo come from
 * lite/spaces/render-shared.ts — both shared with the Spaces window,
 * so there is exactly one source of truth for each.
 *
 * The view-builder functions are a verbatim port of the (removed)
 * Spaces-window implementation, driven by module-local page state
 * instead of the Spaces renderer state.
 */

import {
  LEARNER_ROLES,
  ROLE_LABELS,
  ROLE_TAGLINES,
  effectiveDone,
  emptyLearnProgress,
  findLesson,
  nextUp,
  overallProgress,
  trackProgress,
  tracksForRole,
  type LearnLesson,
  type LearnTrack,
  type LearnerRole,
} from '../spaces/learn-content.js';
import { renderMarkdown, buildHexMazeLogo } from '../spaces/render-shared.js';
import { bootRenderer } from '../renderer-boot.js';

const pageState: {
  progress: LiteLearnProgressView | null;
  signals: LiteLearnSignalsView | null;
  loading: boolean;
  saveError: boolean;
} = { progress: null, signals: null, loading: true, saveError: false };

/** One-line inline notice when a save fails (page has no toast rail). */
function showSaveNote(): void {
  const existing = document.querySelector('.learn-save-note');
  if (existing !== null) return;
  const note = document.createElement('div');
  note.className = 'learn-save-note';
  note.textContent = 'Could not save learning progress — changes may not persist.';
  document.getElementById('learn-root')?.prepend(note);
}

function renderLearnPage(): void {
  const root = document.getElementById('learn-root');
  if (root === null) return;
  root.replaceChildren();
  root.appendChild(buildLearnView());
}

async function boot(): Promise<void> {
  renderLearnPage();
  const bridge = window.lite?.spaces?.learn;
  if (bridge === undefined) {
    pageState.loading = false;
    renderLearnPage();
    return;
  }
  const [progressRes, signalsRes] = await Promise.allSettled([
    bridge.progressGet(),
    bridge.signals(),
  ]);
  if (progressRes.status === 'fulfilled' && progressRes.value.ok) {
    pageState.progress = progressRes.value.value;
  }
  if (signalsRes.status === 'fulfilled' && signalsRes.value.ok) {
    pageState.signals = signalsRes.value.value;
  }
  pageState.loading = false;
  renderLearnPage();
}

/** Current progress, defaulting to empty until the store answers. */
function learnProgressNow(): LiteLearnProgressView {
  return pageState.progress ?? emptyLearnProgress(new Date().toISOString());
}

/** Persist progress (fire-and-forget with a one-time error toast). */
function saveLearnProgress(next: LiteLearnProgressView): void {
  pageState.progress = next;
  const bridge = window.lite?.spaces?.learn;
  if (bridge === undefined) return;
  void bridge
    .progressSave(next)
    .then((envelope) => {
      if (envelope.ok) {
        pageState.progress = envelope.value;
      } else if (!pageState.saveError) {
        pageState.saveError = true;
        showSaveNote();
      }
    })
    .catch(() => {
      if (!pageState.saveError) {
        pageState.saveError = true;
        showSaveNote();
      }
    });
}

function setLearnerRole(role: LearnerRole): void {
  const progress = { ...learnProgressNow(), role, updatedAt: new Date().toISOString() };
  saveLearnProgress(progress);
  renderLearnPage();
}

function toggleLessonDone(lessonId: string): void {
  const progress = learnProgressNow();
  const done = { ...progress.done };
  if (done[lessonId] !== undefined) {
    delete done[lessonId];
  } else {
    done[lessonId] = new Date().toISOString();
  }
  saveLearnProgress({ ...progress, done, updatedAt: new Date().toISOString() });
  renderLearnPage();
}

/** Effective completion set (manual ∪ auto-detected missions). */
function learnDoneSet(): Set<string> {
  return effectiveDone(
    { done: learnProgressNow().done },
    pageState.signals
  );
}

function buildLearnView(): HTMLElement {
  const root = document.createElement('div');
  root.className = 'learn-root';
  const progress = learnProgressNow();
  const doneSet = learnDoneSet();

  root.appendChild(buildLearnHero(progress, doneSet));

  if (progress.role === null) {
    root.appendChild(buildRolePicker());
  }

  for (const track of tracksForRole(progress.role)) {
    root.appendChild(buildLearnTrack(track, doneSet));
  }
  return root;
}

/** Hero: ring, headline, next-up / resume actions, role chip. */
function buildLearnHero(
  progress: LiteLearnProgressView,
  doneSet: ReadonlySet<string>
): HTMLElement {
  const hero = document.createElement('section');
  hero.className = 'learn-hero';
  hero.setAttribute('aria-label', 'Learning progress');

  const overall = overallProgress(doneSet);
  hero.appendChild(buildProgressRing(overall.pct));

  const copy = document.createElement('div');
  copy.className = 'learn-hero-copy';

  const kicker = document.createElement('div');
  kicker.className = 'learn-hero-kicker';
  kicker.textContent = 'Learning Center';
  copy.appendChild(kicker);

  const title = document.createElement('h2');
  title.className = 'learn-hero-title';
  title.textContent =
    overall.done === 0
      ? 'Learn the method behind the machine'
      : overall.pct === 100
        ? 'Everything complete — well run'
        : `${overall.done} of ${overall.total} lessons complete`;
  copy.appendChild(title);

  const sub = document.createElement('p');
  sub.className = 'learn-hero-sub';
  sub.textContent =
    'The WISER Method, this app, and the Invisible Machines ecosystem — with hands-on missions that check themselves off as your workspace grows.';
  copy.appendChild(sub);

  const actions = document.createElement('div');
  actions.className = 'learn-hero-actions';

  const next = nextUp(progress.role, doneSet);
  if (next !== null) {
    const cta = document.createElement('button');
    cta.type = 'button';
    cta.className = 'learn-cta';
    cta.textContent =
      overall.done === 0 ? `Start: ${next.lesson.title}` : `Next up: ${next.lesson.title}`;
    cta.addEventListener('click', () => openLesson(next.lesson.id));
    actions.appendChild(cta);
  }

  const last = progress.lastLessonId !== null ? findLesson(progress.lastLessonId) : null;
  if (last !== null && next !== null && last.lesson.id !== next.lesson.id) {
    const resume = document.createElement('button');
    resume.type = 'button';
    resume.className = 'learn-resume';
    resume.textContent = `Resume: ${last.lesson.title}`;
    resume.addEventListener('click', () => openLesson(last.lesson.id));
    actions.appendChild(resume);
  }

  if (progress.role !== null) {
    const roleChip = document.createElement('button');
    roleChip.type = 'button';
    roleChip.className = 'learn-role-chip';
    roleChip.title = 'Change how the tracks are ordered for you';
    roleChip.textContent = `Learning as: ${ROLE_LABELS[progress.role]} · change`;
    roleChip.addEventListener('click', () => {
      saveLearnProgress({
        ...learnProgressNow(),
        role: null,
        updatedAt: new Date().toISOString(),
      });
      renderLearnPage();
    });
    actions.appendChild(roleChip);
  }

  copy.appendChild(actions);
  hero.appendChild(copy);

  const logo = document.createElement('div');
  logo.className = 'learn-hero-logo';
  logo.appendChild(buildHexMazeLogo());
  hero.appendChild(logo);

  return hero;
}

/** SVG progress ring — conic stroke over a faint track. */
function buildProgressRing(pct: number): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'learn-ring';
  const size = 92;
  const stroke = 7;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, pct));
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  const track = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  track.setAttribute('cx', String(size / 2));
  track.setAttribute('cy', String(size / 2));
  track.setAttribute('r', String(r));
  track.setAttribute('class', 'learn-ring-track');
  track.setAttribute('stroke-width', String(stroke));
  svg.appendChild(track);
  const arc = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  arc.setAttribute('cx', String(size / 2));
  arc.setAttribute('cy', String(size / 2));
  arc.setAttribute('r', String(r));
  arc.setAttribute('class', 'learn-ring-arc');
  arc.setAttribute('stroke-width', String(stroke));
  arc.setAttribute('stroke-dasharray', `${(clamped / 100) * c} ${c}`);
  arc.setAttribute('transform', `rotate(-90 ${size / 2} ${size / 2})`);
  svg.appendChild(arc);
  wrap.appendChild(svg);
  const label = document.createElement('div');
  label.className = 'learn-ring-label';
  label.textContent = `${clamped}%`;
  wrap.appendChild(label);
  return wrap;
}

/** First-visit role picker — three cards, one click, changeable later. */
function buildRolePicker(): HTMLElement {
  const section = document.createElement('section');
  section.className = 'learn-role-picker';
  section.setAttribute('aria-label', 'Choose your learning path');

  const heading = document.createElement('h3');
  heading.className = 'learn-role-heading';
  heading.textContent = 'What brings you here?';
  section.appendChild(heading);

  const sub = document.createElement('p');
  sub.className = 'learn-role-sub';
  sub.textContent = 'One click orders the tracks for you. Change it any time.';
  section.appendChild(sub);

  const row = document.createElement('div');
  row.className = 'learn-role-row';
  for (const role of LEARNER_ROLES) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'learn-role-card';
    card.setAttribute('data-role', role);
    const name = document.createElement('span');
    name.className = 'learn-role-name';
    name.textContent = ROLE_LABELS[role];
    card.appendChild(name);
    const tagline = document.createElement('span');
    tagline.className = 'learn-role-tagline';
    tagline.textContent = ROLE_TAGLINES[role];
    card.appendChild(tagline);
    card.addEventListener('click', () => setLearnerRole(role));
    row.appendChild(card);
  }
  section.appendChild(row);
  return section;
}

const LESSON_KIND_LABEL: Record<string, string> = {
  read: 'Read',
  do: 'Do',
  listen: 'Listen',
  course: 'Course',
};

function buildLearnTrack(track: LearnTrack, doneSet: ReadonlySet<string>): HTMLElement {
  const section = document.createElement('section');
  section.className = `learn-track learn-accent-${track.accent}`;
  section.setAttribute('data-track-id', track.id);

  const head = document.createElement('header');
  head.className = 'learn-track-head';

  const titles = document.createElement('div');
  titles.className = 'learn-track-titles';
  const title = document.createElement('h3');
  title.className = 'learn-track-title';
  title.textContent = track.title;
  titles.appendChild(title);
  const subtitle = document.createElement('p');
  subtitle.className = 'learn-track-subtitle';
  subtitle.textContent = track.subtitle;
  titles.appendChild(subtitle);
  const role = learnProgressNow().role;
  if (role !== null) {
    const note = document.createElement('p');
    note.className = 'learn-track-rolenote';
    note.textContent = track.roleNote[role];
    titles.appendChild(note);
  }
  head.appendChild(titles);

  const progress = trackProgress(track, doneSet);
  const meter = document.createElement('div');
  meter.className = 'learn-track-meter';
  const meterLabel = document.createElement('span');
  meterLabel.className = 'learn-track-meter-label';
  meterLabel.textContent = `${progress.done}/${progress.total}`;
  meter.appendChild(meterLabel);
  const bar = document.createElement('div');
  bar.className = 'learn-track-bar';
  const fill = document.createElement('div');
  fill.className = 'learn-track-bar-fill';
  fill.style.width = `${progress.pct}%`;
  bar.appendChild(fill);
  meter.appendChild(bar);
  head.appendChild(meter);

  section.appendChild(head);

  const list = document.createElement('div');
  list.className = 'learn-lessons';
  for (const lesson of track.lessons) {
    list.appendChild(buildLessonRow(lesson, doneSet.has(lesson.id)));
  }
  section.appendChild(list);
  return section;
}

function buildLessonRow(lesson: LearnLesson, isDone: boolean): HTMLElement {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'learn-lesson';
  row.classList.toggle('is-done', isDone);
  row.setAttribute('data-lesson-id', lesson.id);

  const check = document.createElement('span');
  check.className = 'learn-lesson-check';
  check.textContent = isDone ? '✓' : '';
  row.appendChild(check);

  const main = document.createElement('span');
  main.className = 'learn-lesson-main';
  const title = document.createElement('span');
  title.className = 'learn-lesson-title';
  title.textContent = lesson.title;
  main.appendChild(title);
  const summary = document.createElement('span');
  summary.className = 'learn-lesson-summary';
  summary.textContent = lesson.summary;
  main.appendChild(summary);
  row.appendChild(main);

  const meta = document.createElement('span');
  meta.className = 'learn-lesson-meta';
  if (lesson.mission !== undefined) {
    const auto = document.createElement('span');
    auto.className = 'learn-lesson-auto';
    auto.title = 'Completes automatically when your workspace shows the work';
    auto.textContent = isDone ? 'detected' : 'auto-detects';
    meta.appendChild(auto);
  }
  const kind = document.createElement('span');
  kind.className = `learn-lesson-kind learn-kind-${lesson.kind}`;
  kind.textContent = LESSON_KIND_LABEL[lesson.kind] ?? lesson.kind;
  meta.appendChild(kind);
  const minutes = document.createElement('span');
  minutes.className = 'learn-lesson-minutes';
  minutes.textContent = `${lesson.minutes}m`;
  meta.appendChild(minutes);
  row.appendChild(meta);

  row.addEventListener('click', () => openLesson(lesson.id));
  return row;
}

/** Open a lesson: modal for bodies, browser for pure links. */
function openLesson(lessonId: string): void {
  const found = findLesson(lessonId);
  if (found === null) return;
  const { lesson } = found;

  saveLearnProgress({
    ...learnProgressNow(),
    lastLessonId: lesson.id,
    updatedAt: new Date().toISOString(),
  });

  if (lesson.body === undefined && lesson.url !== undefined) {
    // Pure external lesson: opening IS the action — count it done.
    window.open(lesson.url);
    if (learnProgressNow().done[lesson.id] === undefined) {
      toggleLessonDone(lesson.id);
    } else {
      renderLearnPage();
    }
    return;
  }
  openLessonModal(lesson);
}

function openLessonModal(lesson: LearnLesson): void {
  document.querySelector('.learn-modal-backdrop')?.remove();
  const backdrop = document.createElement('div');
  backdrop.className = 'learn-modal-backdrop';

  const modal = document.createElement('div');
  modal.className = 'learn-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', lesson.title);

  const close = (): void => {
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
    renderLearnPage();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });

  const bar = document.createElement('div');
  bar.className = 'learn-modal-bar';
  const kind = document.createElement('span');
  kind.className = `learn-lesson-kind learn-kind-${lesson.kind}`;
  kind.textContent = LESSON_KIND_LABEL[lesson.kind] ?? lesson.kind;
  bar.appendChild(kind);
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'learn-modal-close';
  closeBtn.setAttribute('aria-label', 'Close lesson');
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', close);
  bar.appendChild(closeBtn);
  modal.appendChild(bar);

  const body = document.createElement('div');
  body.className = 'learn-modal-body';
  if (lesson.body !== undefined) {
    body.appendChild(renderMarkdown(lesson.body));
  } else {
    const p = document.createElement('p');
    p.textContent = lesson.summary;
    body.appendChild(p);
  }
  modal.appendChild(body);

  const foot = document.createElement('div');
  foot.className = 'learn-modal-foot';

  if (lesson.url !== undefined) {
    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'learn-cta';
    openBtn.textContent = lesson.kind === 'listen' ? 'Open the podcast' : 'Open in browser';
    openBtn.addEventListener('click', () => {
      window.open(lesson.url);
      if (learnProgressNow().done[lesson.id] === undefined) {
        toggleLessonDone(lesson.id);
      }
    });
    foot.appendChild(openBtn);
  }

  const doneBtn = document.createElement('button');
  doneBtn.type = 'button';
  doneBtn.className = 'learn-done-toggle';
  const refreshDoneLabel = (): void => {
    const isDone = learnProgressNow().done[lesson.id] !== undefined;
    const detected =
      lesson.mission !== undefined && learnDoneSet().has(lesson.id) && !isDone;
    doneBtn.textContent = detected
      ? 'Auto-detected ✓'
      : isDone
        ? 'Completed ✓ (click to undo)'
        : 'Mark complete';
    doneBtn.disabled = detected;
  };
  refreshDoneLabel();
  doneBtn.addEventListener('click', () => {
    toggleLessonDone(lesson.id);
    refreshDoneLabel();
  });
  foot.appendChild(doneBtn);

  modal.appendChild(foot);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
}

// ─── Boot + test escape hatch ───────────────────────────────────────────

declare global {
  interface Window {
    __learnPageForTesting?: { reinitForTesting(): Promise<void> };
  }
}

window.__learnPageForTesting = {
  async reinitForTesting(): Promise<void> {
    pageState.progress = null;
    pageState.signals = null;
    pageState.loading = true;
    pageState.saveError = false;
    await boot();
  },
};

// Shared crash surface (`lite/renderer-boot.ts`): fatal-error banner +
// window error/unhandledrejection listeners (2026-08-08 hardening
// review -- previously only the Spaces renderer had this guard).
bootRenderer({
  scope: 'learn',
  title: 'Learn failed to load',
  init: () => boot(),
});
