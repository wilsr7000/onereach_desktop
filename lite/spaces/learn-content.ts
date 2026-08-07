/**
 * Learning Center curriculum + personalization logic (pure).
 *
 * Replaces the Spaces Home page (2026-08-07). Three tracks:
 *
 *   1. The WISER Method — grounded in wisermethod.com's own language
 *      ("The AI Operations Methodology", the 5-stage maturity model,
 *      the Master Playbook, the 12 AI First Principles). The site
 *      deliberately never expands the W-I-S-E-R acronym, so neither do
 *      we — inventing an expansion would be worse than omitting it.
 *   2. Master Onereach.ai Lite — hands-on missions whose completion is
 *      AUTO-DETECTED from the user's real workspace (create a Space,
 *      add an agent, convert a transcript…). Individualized progress
 *      from actual usage, not from clicking "mark done".
 *   3. The Invisible Machines ecosystem — the book, the Invisible
 *      Machines podcast (uxmag.com/podcasts, verified 2026-08-07),
 *      articles, and the OneReach learning portal. External URLs are
 *      REUSED from lite/university/curated-content.ts so the two
 *      surfaces can never drift apart.
 *
 * Everything here is pure data + pure functions: no DOM, no Electron,
 * no I/O — the renderer and tests both consume it directly.
 */

import {
  AI_RUN_TIMES_URL,
  LMS_BASE_URL,
  WISER_METHOD_URL,
} from '../university/curated-content.js';

// ─── Model ──────────────────────────────────────────────────────────────

/** Who the learner is — picked once, changeable any time. */
export type LearnerRole = 'designer' | 'builder' | 'leader';

export const LEARNER_ROLES: ReadonlyArray<LearnerRole> = [
  'designer',
  'builder',
  'leader',
];

/** How a lesson is consumed (drives the row badge + icon). */
export type LessonKind = 'read' | 'do' | 'listen' | 'course';

/**
 * Missions auto-detected from workspace signals. Keys map 1:1 onto
 * `LearnSignals` fields/kind-counts — see `missionComplete`.
 */
export type MissionKey =
  | 'space'
  | 'asset'
  | 'playbook'
  | 'agent'
  | 'transcript'
  | 'knowledge'
  | 'journey'
  | 'share';

export interface LearnLesson {
  /** Stable id — progress is keyed on this; never rename casually. */
  id: string;
  title: string;
  kind: LessonKind;
  /** Honest estimate, minutes. */
  minutes: number;
  /** One-liner shown on the lesson row. */
  summary: string;
  /** Markdown body for in-app lessons (rendered via renderMarkdown). */
  body?: string;
  /** External destination — opened in the browser; completes on open. */
  url?: string;
  /** Auto-detection key: done the moment the workspace shows the work. */
  mission?: MissionKey;
}

export interface LearnTrack {
  id: string;
  title: string;
  subtitle: string;
  /** CSS accent hook (`learn-accent-<value>`). */
  accent: 'violet' | 'blue' | 'amber';
  /** Why this track matters for each role — shown under the title. */
  roleNote: Record<LearnerRole, string>;
  lessons: ReadonlyArray<LearnLesson>;
}

/** Workspace signals used for mission auto-detection. */
export interface LearnSignals {
  /** Live Spaces visible to the viewer. */
  spaces: number;
  /** HAS_ACCESS members (with a live grant) other than the viewer. */
  otherMembers: number;
  /** Visible, non-deleted assets by kind (`agent`, `transcript`, …). */
  kinds: Readonly<Record<string, number>>;
}

/** Persisted per-user progress (JSON under userData). */
export interface LearnProgress {
  version: 1;
  role: LearnerRole | null;
  /** lessonId → ISO timestamp completed. */
  done: Record<string, string>;
  /** Last lesson the user opened — powers the resume card. */
  lastLessonId: string | null;
  updatedAt: string;
}

export function emptyLearnProgress(now: string): LearnProgress {
  return { version: 1, role: null, done: {}, lastLessonId: null, updatedAt: now };
}

// ─── Curriculum ─────────────────────────────────────────────────────────

const WISER_TRACK: LearnTrack = {
  id: 'wiser',
  title: 'The WISER Method',
  subtitle: 'The AI Operations Methodology — mastering perpetual innovation using AI First Principles.',
  accent: 'violet',
  roleNote: {
    designer: 'The method is the design language everything else in this app speaks.',
    builder: 'Every asset kind you can build here exists to run a piece of this method.',
    leader: 'This is the operating model — start here, then judge the tooling against it.',
  },
  lessons: [
    {
      id: 'wiser-overview',
      title: 'What the WISER Method is',
      kind: 'read',
      minutes: 4,
      summary: 'The AI operations methodology from the team behind Age of Invisible Machines.',
      body: [
        '# What the WISER Method is',
        '',
        'The WISER Method is **the AI Operations Methodology** — its own one-line definition is *"mastering perpetual innovation using AI First Principles."*',
        '',
        'It was built in the field by the team behind the bestselling *Age of Invisible Machines* (Wiley) — Robb Wilson and Josh Tyson — drawing on two decades of production AI work for Fortune 500 companies and federal agencies. It is published openly at [wisermethod.com](' + WISER_METHOD_URL + ').',
        '',
        'The method ships as a **Master Playbook** with three load-bearing parts:',
        '',
        '- **The maturity model** — five stages, from chatting with AI to automating any company (next lesson).',
        '- **The plays** — repeatable moves an organization runs to climb those stages.',
        '- **The operational patterns** — the structures that keep the plays running after the first win.',
        '',
        '> This app is the method made tangible: Spaces hold the work, playbooks hold the plays, and agents run them. The rest of this track walks that mapping.',
      ].join('\n'),
    },
    {
      id: 'wiser-maturity',
      title: 'The five-stage maturity model',
      kind: 'read',
      minutes: 6,
      summary: 'From chatting with AI to automating any company — find your stage.',
      body: [
        '# The five-stage maturity model',
        '',
        'The WISER maturity model names five stages. Read them as a ladder — each stage compounds the one before it:',
        '',
        '1. **Chatting with AI** — using AI conversationally; value stays in the chat.',
        '2. **Automate Myself** — your own recurring work runs without you touching it.',
        '3. **Automate My Team** — shared workflows; the team\'s output stops depending on any one person\'s hands.',
        '4. **Automate My Company** — cross-team operations run as orchestrated systems.',
        '5. **Automate Any Company** — the capability itself is productized; you can apply it to any organization.',
        '',
        '## Locate yourself',
        '',
        'Most people discover they are between stages 1 and 2, and most companies between 2 and 3. The honest question is not "which stage sounds like us" but "**what still breaks when a specific person goes on vacation?**" — that is the work still waiting to move up a stage.',
        '',
        '> In this app: a Space per initiative, with playbooks + agents inside it, is the unit that moves work from stage 2 to stage 3 — the work becomes visible, shareable, and runnable by someone who is not you.',
      ].join('\n'),
    },
    {
      id: 'wiser-principles',
      title: 'AI First Principles',
      kind: 'read',
      minutes: 5,
      summary: 'The constraints the method is built on — and where to read all twelve.',
      body: [
        '# AI First Principles',
        '',
        'The method rests on **12 AI First Principles** — foundational constraints that keep "perpetual innovation" from decaying into a pile of disconnected pilots.',
        '',
        'The principles are maintained as part of the open methodology, and the canonical, current list lives at [wisermethod.com](' + WISER_METHOD_URL + ') — read them there rather than from a copy that can go stale.',
        '',
        'What matters for this track is their **role**: every play in the Master Playbook is written against these constraints. When you evaluate a workflow, an agent, or a tool (including this one), the principles are the test — not taste, and not the demo.',
        '',
        '> Open the site, skim all twelve once, and pick the two that most contradict how your organization currently works. Those two are where the method will earn its keep first.',
      ].join('\n'),
      url: WISER_METHOD_URL,
    },
    {
      id: 'wiser-playbook-app',
      title: 'Plays → playbooks in this app',
      kind: 'do',
      minutes: 8,
      summary: 'Create a playbook asset — the app\'s native shape for a WISER play.',
      mission: 'playbook',
      body: [
        '# Plays → playbooks in this app',
        '',
        'A **play** is a repeatable move. In this app it lives as a **playbook asset**: a titled, stepped, shareable document that agents and people can both run.',
        '',
        '## Do it now',
        '',
        '1. Open a Space (or create one) and click **+ New**.',
        '2. Choose the document path and write a short playbook in markdown — a title, a one-line description, then numbered steps. Keep it under ten steps.',
        '3. Save it and look at its tile: playbooks get the ★ badge, the ✎ description line, and the first steps shown right on the card.',
        '',
        'This lesson completes **automatically** when a playbook exists in your workspace — the checkmark below is detection, not attendance.',
      ].join('\n'),
    },
    {
      id: 'wiser-patterns',
      title: 'Operational patterns: the meeting-to-knowledge loop',
      kind: 'read',
      minutes: 5,
      summary: 'One pattern end-to-end: meeting → transcript → knowledge → journey.',
      body: [
        '# The meeting-to-knowledge loop',
        '',
        'Operational patterns are what keep plays running after the first win. Here is one this app supports end-to-end, so you can feel the shape:',
        '',
        '1. **Meeting happens** — a recording or notes exist.',
        '2. **Transcript in** — paste or attach it; the app detects the format and converts it to clean markdown (you will do this in the app track).',
        '3. **Knowledge out** — the durable decisions and facts move into a knowledge model asset, so they outlive the meeting.',
        '4. **Journey updated** — if the meeting changed how customers or work flow, the journey map asset is where that lands.',
        '',
        'The pattern\'s test: **could someone who missed the meeting act correctly from the Space alone?** When yes, the pattern is working — the machine is invisible.',
      ].join('\n'),
    },
  ],
};

const APP_TRACK: LearnTrack = {
  id: 'app',
  title: 'Master Onereach.ai Lite',
  subtitle: 'Hands-on missions — each one checks itself off when your workspace shows the work.',
  accent: 'blue',
  roleNote: {
    designer: 'Learn the material you will be designing with — by touching all of it once.',
    builder: 'The fastest path: every mission below leaves a real artifact behind.',
    leader: 'Thirty minutes here and every demo you are shown becomes legible.',
  },
  lessons: [
    {
      id: 'app-space',
      title: 'Create your first Space',
      kind: 'do',
      minutes: 3,
      summary: 'Spaces are project places — a channel where assets stay findable forever.',
      mission: 'space',
      body: [
        '# Create your first Space',
        '',
        'A **Space** is a project place you share with people and agents. Unlike a chat channel, what you put in stays findable — assets do not sink under new messages.',
        '',
        '## Do it now',
        '',
        '1. Click **+ New Space** (top right).',
        '2. Name it after a real initiative — not "test" (you already have one of those). Add an objective when asked: objectives surface as hover text on every asset later.',
        '',
        '✓ Detected automatically once a Space exists.',
      ].join('\n'),
    },
    {
      id: 'app-asset',
      title: 'Add any asset — and read its tile',
      kind: 'do',
      minutes: 4,
      summary: 'Drop a file in and the tile shows a real preview, not a generic icon.',
      mission: 'asset',
      body: [
        '# Add any asset — and read its tile',
        '',
        'Drop a PDF, an image, a video, a markdown file — anything — into a Space with **+ New**, or paste text straight in.',
        '',
        'Then actually look at the tile: PDFs show their first page, videos a real frame grab, text files their opening lines, and every file carries an extension badge. Tiles are the Space\'s at-a-glance memory — a wall of generic icons tells you nothing; these tell you what is inside.',
        '',
        '✓ Detected automatically once any asset exists.',
      ].join('\n'),
    },
    {
      id: 'app-agent',
      title: 'Add an agent from the library',
      kind: 'do',
      minutes: 5,
      summary: 'Agents are teammates: pick one from your account\'s graph, endpoints included.',
      mission: 'agent',
      body: [
        '# Add an agent from the library',
        '',
        'Agents in a Space are working members, not decorations. The hexagon-logo tile shows the agent\'s type and how it is reachable (MCP, API, skill).',
        '',
        '## Do it now',
        '',
        '1. In a Space, click **+ New → Agent → From library**.',
        '2. Search — the list is your account\'s real agent graph.',
        '3. Add one relevant to the Space. Its endpoints come along automatically.',
        '',
        '✓ Detected automatically once an agent asset exists.',
      ].join('\n'),
    },
    {
      id: 'app-transcript',
      title: 'Turn a transcript into markdown',
      kind: 'do',
      minutes: 4,
      summary: 'Paste any meeting transcript — the app detects the format and converts it.',
      mission: 'transcript',
      body: [
        '# Turn a transcript into markdown',
        '',
        'Paste a transcript (or attach a .vtt / .srt / .txt) into **+ New**. The app detects the format, offers the conversion, and stores clean markdown with a teal transcript tile showing speakers and opening turns.',
        '',
        'This is step one of the meeting-to-knowledge loop from the WISER track — raw record in, durable artifact out.',
        '',
        '✓ Detected automatically once a transcript asset exists.',
      ].join('\n'),
    },
    {
      id: 'app-knowledge',
      title: 'Add a knowledge model',
      kind: 'do',
      minutes: 4,
      summary: 'Give a Space its brain: what this project knows, as an asset.',
      mission: 'knowledge',
      body: [
        '# Add a knowledge model',
        '',
        'A knowledge model asset describes what a project *knows* — the durable facts, decisions, and definitions that agents and people should share. Its emerald tile describes the knowledge right on the card.',
        '',
        'Create one via **+ New → Knowledge** in any Space.',
        '',
        '✓ Detected automatically once a knowledge asset exists.',
      ].join('\n'),
    },
    {
      id: 'app-journey',
      title: 'Map a journey',
      kind: 'do',
      minutes: 5,
      summary: 'Journey maps and service blueprints as first-class, staged assets.',
      mission: 'journey',
      body: [
        '# Map a journey',
        '',
        'Journey and service-blueprint assets get a staged tile — Awareness → Signup → Activation → … — so the flow is readable from the grid without opening it.',
        '',
        'Create one via **+ New → Journey** and name the real stages of a flow you own.',
        '',
        '✓ Detected automatically once a journey asset exists.',
      ].join('\n'),
    },
    {
      id: 'app-share',
      title: 'Share a Space — with an expiry',
      kind: 'do',
      minutes: 4,
      summary: 'Invite a teammate from the graph and give access a deliberate end date.',
      mission: 'share',
      body: [
        '# Share a Space — with an expiry',
        '',
        'Open a Space\'s members panel and add someone — the picker searches your account\'s real people and agents. Choose an access duration; the chip will read like *"until 14 Aug"*, and access can be renewed deliberately instead of lingering forever.',
        '',
        '✓ Detected automatically once anyone besides you holds live access to a Space.',
      ].join('\n'),
    },
    {
      id: 'app-organize',
      title: 'Uncategorized, search, and what delete really does',
      kind: 'read',
      minutes: 3,
      summary: 'Where things live when they are nowhere, and why delete never strands work.',
      body: [
        '# Uncategorized, search, and what delete really does',
        '',
        '- **Uncategorized** is the intake tray: everything that is in no live Space. Nothing has to be filed before it can exist.',
        '- **Search this space / all spaces** finds assets by content, and the *Existing* tab lets a Space adopt assets that already live elsewhere — one asset can belong to many Spaces.',
        '- **Deleting a Space** never destroys its assets: they surface under Uncategorized until you restore the Space (Undo brings everything back exactly as it was). The confirm dialog tells you this every time.',
        '',
        'And if a window ever ends up somewhere you cannot reach it: **app menu → Bring Windows Into View**.',
      ].join('\n'),
    },
  ],
};

const IM_TRACK: LearnTrack = {
  id: 'im',
  title: 'Invisible Machines ecosystem',
  subtitle: 'The book, the podcast, and the article stream the method grew out of.',
  accent: 'amber',
  roleNote: {
    designer: 'The design conversation happens here — episodes and articles, weekly.',
    builder: 'Where the patterns you are building get named, argued, and stress-tested.',
    leader: 'The strategic layer: what invisible machines mean for an organization.',
  },
  lessons: [
    {
      id: 'im-book',
      title: 'Age of Invisible Machines — the book',
      kind: 'read',
      minutes: 10,
      summary: 'The bestselling Wiley book behind the method, by Robb Wilson with Josh Tyson.',
      url: WISER_METHOD_URL,
      body: [
        '# Age of Invisible Machines',
        '',
        '*Age of Invisible Machines* (Wiley) is the bestselling book the WISER Method grew out of — the case for organizations run on orchestrated, conversational AI that disappears into the work. By Robb Wilson with Josh Tyson.',
        '',
        'The methodology site carries the current edition and how it connects to the Master Playbook — the button below takes you there.',
      ].join('\n'),
    },
    {
      id: 'im-podcast',
      title: 'The Invisible Machines podcast',
      kind: 'listen',
      minutes: 45,
      summary: 'The ongoing conversation — new episodes weekly on UX Magazine.',
      url: `${AI_RUN_TIMES_URL}/podcasts`,
      body: [
        '# The Invisible Machines podcast',
        '',
        'The podcast is where the ecosystem thinks out loud — practitioners, authors, and operators arguing the real questions, currently deep into season seven.',
        '',
        'Listening to one episode a week keeps you current with the method as it evolves. The button below opens the show on UX Magazine.',
      ].join('\n'),
    },
    {
      id: 'im-agent-runtimes',
      title: 'A Brief History of Agent Runtimes',
      kind: 'read',
      minutes: 8,
      summary: 'Robb Wilson on how agent runtimes evolved — and where they are going.',
      url: `${AI_RUN_TIMES_URL}/articles/a-brief-history-of-agent-runtimes`,
    },
    {
      id: 'im-articles',
      title: 'The article stream on UX Magazine',
      kind: 'read',
      minutes: 8,
      summary: 'The long-running home of the ecosystem\'s writing — browse and pick one.',
      url: AI_RUN_TIMES_URL,
    },
    {
      id: 'im-lms',
      title: 'OneReach learning portal',
      kind: 'course',
      minutes: 30,
      summary: 'Structured courses — getting started, first agent, workflow basics.',
      url: `${LMS_BASE_URL}/`,
    },
  ],
};

export const LEARN_TRACKS: ReadonlyArray<LearnTrack> = [
  WISER_TRACK,
  APP_TRACK,
  IM_TRACK,
];

// ─── Personalization + progress (pure) ──────────────────────────────────

/** Track order per role — the recommendation, not a restriction. */
export const ROLE_TRACK_ORDER: Readonly<Record<LearnerRole, ReadonlyArray<string>>> = {
  designer: ['wiser', 'app', 'im'],
  builder: ['app', 'wiser', 'im'],
  leader: ['wiser', 'im', 'app'],
};

export const ROLE_LABELS: Readonly<Record<LearnerRole, string>> = {
  designer: 'Designer',
  builder: 'Builder',
  leader: 'Leader',
};

export const ROLE_TAGLINES: Readonly<Record<LearnerRole, string>> = {
  designer: 'I design agentic experiences',
  builder: 'I build agents and workflows',
  leader: 'I lead an organization through this',
};

/** Is a mission satisfied by the current workspace signals? */
export function missionComplete(key: MissionKey, signals: LearnSignals): boolean {
  switch (key) {
    case 'space':
      return signals.spaces >= 1;
    case 'share':
      return signals.otherMembers >= 1;
    case 'asset': {
      let total = 0;
      for (const n of Object.values(signals.kinds)) total += n;
      return total >= 1;
    }
    default:
      return (signals.kinds[key] ?? 0) >= 1;
  }
}

/**
 * The effective completed set: manually-completed lessons UNION
 * mission lessons the workspace already satisfies. Signals may be null
 * before the first fetch — then only manual completions count.
 */
export function effectiveDone(
  progress: Pick<LearnProgress, 'done'>,
  signals: LearnSignals | null
): Set<string> {
  const done = new Set(Object.keys(progress.done));
  if (signals !== null) {
    for (const track of LEARN_TRACKS) {
      for (const lesson of track.lessons) {
        if (lesson.mission !== undefined && missionComplete(lesson.mission, signals)) {
          done.add(lesson.id);
        }
      }
    }
  }
  return done;
}

export interface TrackProgress {
  done: number;
  total: number;
  /** 0..100, rounded. */
  pct: number;
}

export function trackProgress(track: LearnTrack, doneSet: ReadonlySet<string>): TrackProgress {
  const total = track.lessons.length;
  let done = 0;
  for (const lesson of track.lessons) if (doneSet.has(lesson.id)) done++;
  return { done, total, pct: total === 0 ? 0 : Math.round((done / total) * 100) };
}

export function overallProgress(doneSet: ReadonlySet<string>): TrackProgress {
  let done = 0;
  let total = 0;
  for (const track of LEARN_TRACKS) {
    total += track.lessons.length;
    for (const lesson of track.lessons) if (doneSet.has(lesson.id)) done++;
  }
  return { done, total, pct: total === 0 ? 0 : Math.round((done / total) * 100) };
}

/** Tracks in the role's recommended order (unknown role → default order). */
export function tracksForRole(role: LearnerRole | null): ReadonlyArray<LearnTrack> {
  if (role === null) return LEARN_TRACKS;
  const order = ROLE_TRACK_ORDER[role];
  const byId = new Map(LEARN_TRACKS.map((t) => [t.id, t]));
  const ordered: LearnTrack[] = [];
  for (const id of order) {
    const track = byId.get(id);
    if (track !== undefined) ordered.push(track);
  }
  // Defensive: any track missing from the order list still shows.
  for (const track of LEARN_TRACKS) {
    if (!order.includes(track.id)) ordered.push(track);
  }
  return ordered;
}

/**
 * The single recommended next lesson: first incomplete lesson walking
 * the role's track order. Null when everything is done.
 */
export function nextUp(
  role: LearnerRole | null,
  doneSet: ReadonlySet<string>
): { track: LearnTrack; lesson: LearnLesson } | null {
  for (const track of tracksForRole(role)) {
    for (const lesson of track.lessons) {
      if (!doneSet.has(lesson.id)) return { track, lesson };
    }
  }
  return null;
}

/** Find a lesson (and its track) by id. */
export function findLesson(
  lessonId: string
): { track: LearnTrack; lesson: LearnLesson } | null {
  for (const track of LEARN_TRACKS) {
    for (const lesson of track.lessons) {
      if (lesson.id === lessonId) return { track, lesson };
    }
  }
  return null;
}

/** Sanitize anything read from disk into a valid LearnProgress. */
export function normalizeLearnProgress(raw: unknown, now: string): LearnProgress {
  const empty = emptyLearnProgress(now);
  if (typeof raw !== 'object' || raw === null) return empty;
  const record = raw as Record<string, unknown>;
  const role =
    typeof record.role === 'string' && (LEARNER_ROLES as string[]).includes(record.role)
      ? (record.role as LearnerRole)
      : null;
  const done: Record<string, string> = {};
  if (typeof record.done === 'object' && record.done !== null) {
    for (const [k, v] of Object.entries(record.done as Record<string, unknown>)) {
      // Only keep completions for lessons that still exist.
      if (typeof v === 'string' && findLesson(k) !== null) done[k] = v;
    }
  }
  const lastLessonId =
    typeof record.lastLessonId === 'string' && findLesson(record.lastLessonId) !== null
      ? record.lastLessonId
      : null;
  return { version: 1, role, done, lastLessonId, updatedAt: now };
}
