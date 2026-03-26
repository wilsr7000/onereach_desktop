/**
 * Teacher Agent -- GSX Power User Tutor
 *
 * Structured, curriculum-based teaching agent that walks users through
 * learning GSX Power User from scratch. Tracks progress in memory,
 * delivers lessons with hands-on exercises, and answers questions
 * about any topic in the curriculum.
 *
 * 8 modules, each with 3-5 lessons. Each lesson has:
 * - Overview and key concepts
 * - Guided walkthrough
 * - Practice exercise
 */

const { getAgentMemory } = require('../../lib/agent-memory-store');
const ai = require('../../lib/ai-service');
const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();

// ==================== CURRICULUM ====================

const CURRICULUM = [
  {
    id: 'getting-started',
    name: 'Getting Started',
    description: 'Learn the basics of GSX Power User -- app layout, voice orb, command palette, and settings',
    lessons: [
      {
        id: 'gs-1',
        title: 'App Layout and Navigation',
        overview: 'GSX Power User is built around a tabbed browser window. The main window has tabs for browsing, and a menu bar for accessing all products and tools.',
        concepts: ['Main window with tabbed browsing', 'Menu bar: App, IDW, GSX, Agentic University, Manage Spaces, Tools, Help, Share', 'Keyboard shortcuts for fast navigation', 'Multiple product windows can be open simultaneously'],
        walkthrough: 'Try this: Look at the menu bar at the top. Click through each menu to see what is available. Notice that Tools contains your creative products (Video Editor, GSX Create, Voice Orb) while Manage Spaces is your content organizer.',
        exercise: 'Open the Settings window using Cmd+, (comma). Explore the tabs on the left sidebar. Then close it and try opening it again from the App menu.',
        action: 'open-settings',
      },
      {
        id: 'gs-2',
        title: 'The Voice Orb',
        overview: 'The Voice Orb is your always-available AI assistant. It floats on screen, listens for voice commands, and routes tasks to the right agent automatically.',
        concepts: ['Toggle with Cmd+Shift+O or from Tools menu', 'Click to start/stop listening', 'Draggable to any screen position', 'Routes tasks to 20+ specialized agents via the Task Exchange', 'Shows a HUD with task progress and results'],
        walkthrough: 'The orb appears as a small floating circle. When you click it, it starts listening. Speak naturally -- say things like "What time is it?" or "Open settings" or "What is on my calendar today?"',
        exercise: 'Toggle the Voice Orb on using Cmd+Shift+O. Click it and say "What can you do?" to hear about available agents. Then try "Open the video editor" to see it launch a product.',
        action: 'voice-orb-show',
      },
      {
        id: 'gs-3',
        title: 'Command Palette',
        overview: 'The Command Palette (Cmd+K) is a Spotlight-style search overlay that finds any feature, agent, space, or action instantly.',
        concepts: ['Opens with Cmd+K from anywhere', 'Fuzzy search across all features', 'Categories: Actions, Agents, Spaces, Products, Settings', 'Keyboard navigation (arrow keys + Enter)', 'Type to filter, Enter to execute'],
        walkthrough: 'Press Cmd+K. Start typing "video" and watch results filter. You will see Video Editor, video-related agents, and video actions. Press Enter on any result to execute it.',
        exercise: 'Open Command Palette with Cmd+K. Search for "budget" and open the Budget Dashboard. Then reopen Cmd+K and search for "agent" to see all agent-related actions.',
      },
      {
        id: 'gs-4',
        title: 'Settings and Configuration',
        overview: 'Settings control your AI providers, voice, budget limits, browser automation, and all app preferences.',
        concepts: ['LLM provider selection (Anthropic, OpenAI)', 'API key management with encryption', 'Budget controls and cost tracking', 'Voice and capture settings', 'Browser automation configuration', 'Desktop Autopilot toggles'],
        walkthrough: 'Open Settings (Cmd+,). The most important tab is LLM where you set your API keys. Without an API key, AI features will not work. The Budget tab lets you set spending limits. The Automation tab controls Desktop Autopilot.',
        exercise: 'Open Settings. Verify your API key is configured (LLM tab). Then check the Budget tab to see your current spending. Finally, look at the Automation tab to see the Desktop Autopilot controls.',
        action: 'open-settings',
      },
    ],
  },
  {
    id: 'power-user',
    name: 'GSX Power User',
    description: 'Master keyboard shortcuts, multi-window workflows, tabs, and productivity tips',
    lessons: [
      {
        id: 'pu-1',
        title: 'Essential Keyboard Shortcuts',
        overview: 'GSX Power User is designed for keyboard-driven workflows. Learning the shortcuts will make you dramatically faster.',
        concepts: [
          'Cmd+K -- Command Palette (search everything)',
          'Cmd+Shift+O -- Toggle Voice Orb',
          'Cmd+Shift+V -- Clipboard/Spaces Manager',
          'Cmd+Shift+B -- Black Hole (quick paste to Spaces)',
          'Cmd+Shift+H -- Health Dashboard',
          'Cmd+, -- Settings',
          'Cmd+T -- New browser tab',
          'Cmd+W -- Close current tab',
        ],
        walkthrough: 'The most powerful shortcut is Cmd+K. It replaces menu navigation entirely. Instead of clicking through menus, press Cmd+K and type what you want. The Black Hole (Cmd+Shift+B) is great for quickly saving content -- paste anything and it goes straight to your Spaces.',
        exercise: 'Practice this sequence: Cmd+K to open palette, type "health", Enter to open Health Dashboard. Then Cmd+Shift+B to open Black Hole. Then Cmd+Shift+V to open Spaces Manager.',
      },
      {
        id: 'pu-2',
        title: 'Multi-Window Workflows',
        overview: 'GSX Power User supports multiple product windows simultaneously. You can have the Video Editor, GSX Create, Spaces, and the main browser all open at once.',
        concepts: ['Each product opens in its own window', 'Windows persist across focus changes', 'Voice Orb works from any window', 'Command Palette works from any window', 'Drag windows to different monitors for multi-display setups'],
        walkthrough: 'Try opening GSX Create (Cmd+Shift+G), then the Video Editor (from Tools menu), then Spaces (Cmd+Shift+V). Each opens in its own window. The Voice Orb floats above all of them. You can speak commands from any window.',
        exercise: 'Open three products simultaneously: GSX Create, Video Editor, and Spaces Manager. Arrange them on your screen. Use the Voice Orb to ask "What time is it?" while each product is in focus.',
      },
      {
        id: 'pu-3',
        title: 'Browser Tabs and Web Tools',
        overview: 'The main window is a full browser with tabs. You can open web apps, AI tools, and external services as tabs alongside your local tools.',
        concepts: ['Tabbed browsing built into the app', 'Web tools registered in Module Manager', 'AI tabs: ChatGPT, Claude, Gemini, Grok, Perplexity accessible from menu', 'IDW environments open as browser tabs', 'Custom web tools can be added'],
        walkthrough: 'Open the main browser window. Try opening an AI tab -- go to Tools menu and look for ChatGPT or Claude. These open as tabs in the main browser, keeping everything in one app.',
        exercise: 'Open ChatGPT as a tab (from the AI menu or Command Palette). Then open the Module Manager (Tools menu) and browse what web tools are installed.',
        action: 'open-chatgpt',
      },
    ],
  },
  {
    id: 'building-agents',
    name: 'Building Agents',
    description: 'Learn to create your own AI agents -- from simple voice commands to complex multi-step automations',
    lessons: [
      {
        id: 'ba-1',
        title: 'Agent Anatomy',
        overview: 'Every agent in GSX has the same structure: a name, description, keywords for routing, a prompt that defines its behavior, and an execute function.',
        concepts: ['Name and description (what the agent does)', 'Keywords (when to activate -- the Task Exchange uses these)', 'Prompt (the system instruction that defines behavior)', 'Execution type: conversational, action, shell, or automation', 'Categories for grouping (productivity, creative, system, etc.)'],
        walkthrough: 'Open the Agent Manager (Tools > Manage Agents). Look at the built-in agents. Click on any agent to see its configuration. Notice the prompt field -- this is the most important part. The prompt tells the AI exactly how to behave when this agent is activated.',
        exercise: 'Open Agent Manager. Find the "Time Agent" and read its prompt. Notice how specific and concise it is. Then look at the "Weather Agent" to compare prompt styles.',
        action: 'open-agent-manager',
      },
      {
        id: 'ba-2',
        title: 'Creating Your First Agent',
        overview: 'You can create agents manually in the Agent Manager or use the Agent Composer (Cmd+Shift+G) to have AI build one for you.',
        concepts: ['Agent Composer: describe what you want, AI writes the agent', 'Manual creation: fill in name, prompt, keywords, execution type', 'Test immediately after creation -- no restart needed', 'Agents can have memory, voice personality, and multi-turn conversations', 'Agents can use tools: shell_exec, file_read, web_search, desktop_browse, and more'],
        walkthrough: 'Open Agent Composer (Cmd+Shift+G or Tools > Create Agent with AI). Describe what you want: "An agent that tells me a random fun fact about any topic I ask about." The Composer will generate the name, prompt, keywords, and test scenarios.',
        exercise: 'Use Agent Composer to create a "Fun Facts" agent. After it is created, test it by saying "Tell me a fun fact about octopuses" to the Voice Orb. Check that it responds correctly.',
        action: 'open-claude-code-ui',
      },
      {
        id: 'ba-3',
        title: 'Agent Prompt Engineering',
        overview: 'The prompt is the heart of your agent. A well-crafted prompt produces reliable, focused, high-quality responses.',
        concepts: [
          'Be specific about the agent role and boundaries',
          'Include output format instructions (JSON, brief text, HTML)',
          'Set constraints: what the agent should NOT do',
          'Include examples of expected input/output',
          'Use the agent memory for persistent context',
        ],
        walkthrough: 'A good prompt has three parts: (1) Role definition -- "You are a..." (2) Behavior rules -- "Always respond with..." "Never..." (3) Output format -- "Respond with JSON:" or "Keep responses under 2 sentences." Compare a vague prompt ("help with email") vs a specific one ("You are an email drafting assistant. Given a topic and recipient, draft a professional email. Keep it under 150 words. Use a friendly but professional tone.").',
        exercise: 'Edit your Fun Facts agent in Agent Manager. Improve its prompt to include: (1) A personality (enthusiastic science communicator), (2) A format rule (start with the fact, then explain why it is interesting), (3) A constraint (facts must be verifiable). Test again and compare the quality.',
      },
      {
        id: 'ba-4',
        title: 'Testing and Debugging Agents',
        overview: 'Every agent should be tested before relying on it. GSX has built-in testing tools.',
        concepts: ['Test phrase from Agent Manager (single phrase test)', 'Test against all agents (see which agent wins the bid)', 'Agent Composer generates test scenarios automatically', 'Check the Log Viewer for agent errors', 'Agent bid history shows routing decisions'],
        walkthrough: 'In Agent Manager, select your agent and use the test phrase input. Type a phrase and see if your agent responds correctly. Then use "Test All" to see how your agent competes with built-in agents for the same phrase. If another agent wins, adjust your keywords.',
        exercise: 'Test your Fun Facts agent with 5 different phrases. Then test one of those phrases against all agents to see the bid results. Adjust keywords if needed so your agent wins the right phrases.',
      },
    ],
  },
  {
    id: 'building-skills',
    name: 'Building Skills',
    description: 'Create reusable automation skills that agents can call as tools',
    lessons: [
      {
        id: 'bs-1',
        title: 'What Are Skills?',
        overview: 'Skills are reusable automations that agents can invoke as tools. Think of them as functions that agents can call -- "search the web," "read a file," "browse a website."',
        concepts: ['Skills are registered in the Agent Tool Registry (lib/agent-tools.js)', 'Each skill has: name, description, input schema, execute function', 'Agents declare skills via the tools property: tools: ["web_search", "file_read"]', 'Built-in skills: shell_exec, file_read, file_write, file_list, web_search, spaces_search, spaces_add_item, get_current_time', 'Desktop Autopilot skills: desktop_browse, desktop_app_action, desktop_applescript, desktop_mouse, desktop_keyboard'],
        walkthrough: 'Skills bridge the gap between "thinking" (LLM) and "doing" (executing code). When an agent has tools, the LLM can decide to call them during execution. For example, an agent with web_search can search the internet to answer questions.',
        exercise: 'Create a new agent in Agent Composer with tools enabled. Give it the web_search and get_current_time tools. Ask it "What is the latest news about AI?" and watch it use the web search tool.',
      },
      {
        id: 'bs-2',
        title: 'Desktop Autopilot as a Skill',
        overview: 'The Desktop Autopilot (desktop_browse) is the most powerful skill. It gives agents the ability to open a real browser, navigate websites, fill forms, and extract data.',
        concepts: ['desktop_browse: navigate, screenshot, extract content, run full browser tasks', 'desktop_app_action: control the app itself (open windows, change settings)', 'desktop_applescript: run AppleScript for macOS automation', 'Three-tier execution: cached script (2s) -> Claude direct (5s) -> browser-use (3min)', 'Scripts are cached after first run for instant replay'],
        walkthrough: 'Enable Desktop Autopilot in Settings > Automation. Then create an agent with tools: ["desktop_browse"]. This agent can now autonomously browse the web. Ask it to "Go to berkeleyrep.org and list current shows" -- it will open a browser, navigate, and extract the data.',
        exercise: 'Enable Desktop Autopilot in Settings. Then use the REST API to run a browser task: POST to http://127.0.0.1:47292/app/desktop/browser/task with {"task":"Go to example.com and get the page title"}. Check the result.',
      },
      {
        id: 'bs-3',
        title: 'Creating Custom Skills',
        overview: 'You can register new skills at runtime using the registerTool function in lib/agent-tools.js.',
        concepts: ['A skill needs: name (string), description (for LLM context), inputSchema (JSON Schema), execute (async function)', 'Register with registerTool() at runtime', 'Skills are immediately available to agents that declare them', 'Keep skill descriptions clear -- the LLM uses them to decide when to call the skill'],
        walkthrough: 'Look at the existing skills in lib/agent-tools.js for the pattern. Each skill is a self-contained object with a description that helps the LLM understand when to use it, a JSON schema for inputs, and an execute function that does the work.',
        exercise: 'Read the source code of lib/agent-tools.js. Identify the pattern used by shell_exec and web_search. Think about a skill you would like to add -- what would its name, description, and input schema look like?',
      },
    ],
  },
  {
    id: 'creating-idw',
    name: 'Creating Your IDW',
    description: 'Set up Intelligent Digital Worker environments for your team',
    lessons: [
      {
        id: 'idw-1',
        title: 'What is an IDW?',
        overview: 'An IDW (Intelligent Digital Worker) is a web-based AI application built on the OneReach.ai platform. IDWs are accessed through your GSX Power User browser as tabs.',
        concepts: ['IDWs are hosted web apps built with OneReach Edison visual builder', 'Each IDW has a URL, name, and optional auto-login credentials', 'IDWs appear in the IDW menu for quick access', 'The IDW Store lets you browse and install pre-built IDWs', 'IDWs can be connected to agents via GSX Agent Connections'],
        walkthrough: 'Open the IDW menu in the menu bar. You will see any configured environments. If none are configured, you can add one using Manage Environments or browse the IDW Store.',
        exercise: 'Open the IDW Store from the menu bar (or Command Palette, search "IDW Store"). Browse the available environments. Note the different categories and capabilities offered.',
        action: 'open-idw-store',
      },
      {
        id: 'idw-2',
        title: 'Adding and Managing Environments',
        overview: 'You can add IDW environments manually or install them from the IDW Store.',
        concepts: ['Manage Environments: add URL, name, and credentials', 'Auto-login: GSX can automatically log into your IDW', 'Credential Manager stores login details securely', 'Multiple environments: dev, staging, production', 'GSX Agent Connections: link agents to IDW flows'],
        walkthrough: 'Go to Manage Environments (from IDW menu or Command Palette). To add an environment, you need the IDW URL and optionally login credentials. Once added, it appears in the IDW menu for one-click access.',
        exercise: 'Open Manage Environments and review the interface. If you have an IDW URL from your team, add it. Otherwise, install one from the IDW Store and verify it appears in the IDW menu.',
        action: 'manage-environments',
      },
      {
        id: 'idw-3',
        title: 'Building for Your Team',
        overview: 'Creating an IDW for your team means building a flow on the OneReach platform and deploying it as a web app that your team accesses through GSX.',
        concepts: ['Edison visual flow builder (onereach.ai platform)', 'Flows define conversation logic and integrations', 'Deploy as a web widget with a unique URL', 'Team members add the URL to their GSX app', 'GSX handles authentication and session management'],
        walkthrough: 'The full IDW building process happens on the OneReach.ai platform using the Edison visual builder. GSX Power User is the client that accesses and manages your IDWs. The Dev Tools menu in GSX has tools for inspecting flows, viewing logs, and debugging.',
        exercise: 'Open Dev Tools from the menu (or Command Palette). Explore the SDK Dashboard, Build Step Template, and Flow Validator. These tools help you develop and debug IDW flows.',
      },
    ],
  },
  {
    id: 'app-capabilities',
    name: 'App Capabilities',
    description: 'Deep dive into every major product: Video Editor, Smart Export, Recorder, Budget Manager, Health Dashboard, and Black Hole',
    lessons: [
      {
        id: 'ac-1',
        title: 'Video Editor',
        overview: 'A full non-linear video editor built into GSX. Trim, cut, add transitions, generate captions, and produce professional videos without leaving the app.',
        concepts: ['Timeline-based editing with multi-track support', 'AI-powered scene detection and smart cuts', 'Automatic transcription and captioning', 'ADR (Automated Dialogue Replacement) workflow', 'Export to multiple formats'],
        walkthrough: 'Open the Video Editor from Tools menu. Import a video file. The timeline appears at the bottom. Use the blade tool to cut, drag clips to rearrange, and use the Transcribe button for AI captions.',
        exercise: 'Open Video Editor. Import any video file from your computer. Try trimming the first 5 seconds using the blade tool. Then generate a transcription using the Transcribe button.',
        action: 'open-video-editor',
      },
      {
        id: 'ac-2',
        title: 'Smart Export and Content Pipeline',
        overview: 'Smart Export transforms your content into different formats using AI. Convert documents to presentations, extract key points, generate summaries.',
        concepts: ['AI-enhanced content transformation', 'Multiple export formats: PPTX, PDF, HTML, Markdown', 'Template-based exports with customizable styles', 'Batch processing for multiple items', 'Style guide enforcement'],
        walkthrough: 'Smart Export works with content from Spaces. Select items in Spaces Manager, then use the Export action. Choose a template and target format. The AI will transform your content while maintaining the key information.',
        exercise: 'Save some text content to a Space (use Black Hole -- Cmd+Shift+B -- to quickly paste text). Then open Spaces Manager (Cmd+Shift+V) and find the export options for that content.',
      },
      {
        id: 'ac-3',
        title: 'Budget Manager and Cost Tracking',
        overview: 'Every AI call costs money. The Budget Manager tracks your spending across all AI operations in real-time.',
        concepts: ['Real-time cost tracking per AI call', 'Breakdown by feature, model, and provider', 'Daily/weekly/monthly spending summaries', 'Budget limits with confirmation prompts', 'Cost-per-feature analysis to optimize spending'],
        walkthrough: 'Open the Budget Dashboard (from menu or Command Palette). It shows your current spending, broken down by which features are costing the most. You can set limits in Settings > Budget to get warnings before expensive operations.',
        exercise: 'Open Budget Dashboard and review your current spending. Then go to Settings > Budget and set a confirmation threshold (e.g., $0.05) so the app asks before expensive AI calls.',
        action: 'open-budget',
      },
      {
        id: 'ac-4',
        title: 'Health Dashboard and Diagnostics',
        overview: 'The Health Dashboard shows system status, errors, performance metrics, and helps you diagnose issues.',
        concepts: ['Real-time error monitoring', 'Log viewer with filtering', 'Agent health status', 'API connection status', 'Diagnostic logging levels'],
        walkthrough: 'Open Health Dashboard (Cmd+Shift+H). It shows a summary of errors, warnings, and system status. The Log Viewer (also in Help menu) gives detailed access to every log entry with category and level filtering.',
        exercise: 'Open Health Dashboard and check for any errors. Then open the Log Viewer and filter by category "agent" to see recent agent activity. Try changing the diagnostic logging level in Settings.',
        action: 'open-app-health',
      },
    ],
  },
  {
    id: 'knowledge-models',
    name: 'Knowledge Models',
    description: 'Use Spaces as structured knowledge stores with AI-powered metadata, tagging, and semantic search',
    lessons: [
      {
        id: 'km-1',
        title: 'Spaces as Knowledge Stores',
        overview: 'Spaces are not just clipboard history -- they are structured knowledge stores. Each Space can hold text, code, URLs, images, and files, all enriched with AI-generated metadata.',
        concepts: ['Spaces organize content by topic or project', 'Each item has: content, type, tags, metadata, timestamps', 'AI auto-generates metadata: summaries, categories, key terms', 'Semantic search finds content by meaning, not just keywords', 'API access on port 47291 for programmatic use'],
        walkthrough: 'Open Spaces Manager (Cmd+Shift+V). Create a new Space. Add several items -- paste text, save URLs, add code snippets. Notice how each item gets a type badge and the AI generates metadata automatically.',
        exercise: 'Create a new Space called "Learning Notes." Add 5 different items: a text note, a URL, a code snippet, and two more of your choice. Then use the search box to find one by meaning.',
        action: 'open-spaces',
      },
      {
        id: 'km-2',
        title: 'Tagging and Organization',
        overview: 'Tags are the primary way to organize and filter content in Spaces. Tags can be added manually or auto-generated by AI.',
        concepts: ['Manual tags for your own categories', 'AI-suggested tags based on content analysis', 'Filter by tag to find related items', 'Tags work across Spaces for cross-project search', 'Pinning highlights important items'],
        walkthrough: 'In Spaces Manager, select an item and look at its tags. You can add custom tags. The AI might suggest tags based on the content. Use the tag filter to show only items matching specific tags.',
        exercise: 'In your Learning Notes space, add tags to each item (e.g., "important", "reference", "code-example"). Then use the filter to show only items tagged "important."',
      },
      {
        id: 'km-3',
        title: 'Building a Knowledge Base',
        overview: 'By systematically organizing Spaces with consistent tagging, you build a searchable knowledge base that agents can query.',
        concepts: ['Consistent tagging creates a taxonomy', 'Agents can search Spaces via the spaces_search tool', 'Import/Export for backup and sharing', 'Spaces API for automation', 'Integration with Smart Export for knowledge extraction'],
        walkthrough: 'The real power comes when agents can access your knowledge. Create an agent with tools: ["spaces_search", "spaces_add_item"]. This agent can look up information in your Spaces and add new findings. Your knowledge base grows as you and your agents work together.',
        exercise: 'Create an agent with the spaces_search tool. Ask it "What do I have saved about [topic]?" where topic matches something in your Spaces. Verify it finds and returns the right content.',
      },
    ],
  },
  {
    id: 'using-spaces',
    name: 'Using Spaces',
    description: 'Master the Spaces system -- CRUD operations, import/export, API access, and advanced workflows',
    lessons: [
      {
        id: 'us-1',
        title: 'Spaces CRUD',
        overview: 'Create, read, update, and delete Spaces and items through the UI or the REST API.',
        concepts: ['Create Space: name, description, optional icon', 'Add items: text, URL, code, image, file', 'Edit items: update content, type, tags, metadata', 'Delete items and Spaces (with confirmation)', 'Black Hole: Cmd+Shift+B for instant capture'],
        walkthrough: 'The quickest way to add content is the Black Hole (Cmd+Shift+B). Paste anything -- text, URLs, images -- and it goes straight to your default Space. For more control, use Spaces Manager to create dedicated Spaces and organize items.',
        exercise: 'Use the Black Hole to quickly save 3 things: some text you copy, a URL, and a code snippet. Then open Spaces Manager and find them. Move one to a different Space.',
        action: 'open-black-hole',
      },
      {
        id: 'us-2',
        title: 'Import and Export',
        overview: 'Spaces can be exported for backup, sharing, or migration. Import lets you bring in content from files or other sources.',
        concepts: ['Export: JSON, text, or markdown format', 'Import: JSON files, clipboard, drag-and-drop', 'Bulk operations for multiple items', 'Smart Export for AI-enhanced content transformation', 'File upload integration'],
        walkthrough: 'In Spaces Manager, look for the export options on a Space. You can export all items as a JSON file. To import, use the import button or drag files directly into the Spaces Manager window.',
        exercise: 'Export your Learning Notes space to a JSON file. Then create a new Space and import the JSON file into it. Verify all items transferred correctly.',
      },
      {
        id: 'us-3',
        title: 'Spaces REST API',
        overview: 'The Spaces API on port 47291 gives you full programmatic access to create, read, update, and delete Spaces and items.',
        concepts: [
          'GET /api/spaces -- list all Spaces',
          'POST /api/spaces -- create a Space',
          'GET /api/spaces/:id/items -- list items',
          'POST /api/spaces/:id/items -- add an item',
          'GET /api/search?q=query -- semantic search',
        ],
        walkthrough: 'The API is running on localhost:47291 whenever the app is open. You can use curl, Postman, or any HTTP client to interact with it. Try: curl http://127.0.0.1:47291/api/spaces to see all your Spaces as JSON.',
        exercise: 'Open a terminal and run: curl http://127.0.0.1:47291/api/spaces | python3 -m json.tool. Then create a new Space via the API: curl -X POST http://127.0.0.1:47291/api/spaces -H "Content-Type: application/json" -d \'{"name":"API Test"}\'',
      },
    ],
  },
];

// ==================== AGENT DEFINITION ====================

const teacherAgent = {
  id: 'teacher-agent',
  name: 'GSX Teacher',
  description:
    'Interactive tutor for GSX Power User -- teaches you how to build agents, use Spaces, create IDWs, master keyboard shortcuts, and get the most out of every feature through structured lessons with hands-on exercises',
  voice: 'echo',
  acks: ['Let me prepare your lesson.', 'Great question -- let me walk you through that.', 'Here is what you need to know.'],
  categories: ['learning', 'help', 'tutorial', 'education'],
  keywords: [
    'teach',
    'learn',
    'how to',
    'tutorial',
    'lesson',
    'guide',
    'show me',
    'explain',
    'what is',
    'get started',
    'getting started',
    'beginner',
    'power user',
    'tips',
    'curriculum',
    'course',
    'training',
    'build an agent',
    'create an agent',
    'build a skill',
    'create IDW',
    'use spaces',
    'knowledge model',
    'capabilities',
    'what can you do',
    'help me learn',
  ],
  executionType: 'conversational',
  capabilities: [
    'structured curriculum with 8 modules and 28 lessons',
    'progress tracking across sessions',
    'hands-on exercises with guided walkthroughs',
    'answer questions about any GSX feature',
    'open relevant app windows to demonstrate features',
    'remember what you have already learned',
  ],

  prompt: `GSX Teacher is an interactive tutor for GSX Power User. It teaches through structured lessons with hands-on exercises, tracks your progress, and can answer questions about any feature.

Curriculum modules: Getting Started, GSX Power User, Building Agents, Building Skills, Creating IDW, App Capabilities, Knowledge Models, Using Spaces.

The teacher delivers lessons one at a time, explains concepts clearly, provides guided walkthroughs, and gives practice exercises. It remembers what you have learned and picks up where you left off.`,

  memory: null,

  async initialize() {
    if (!this.memory) {
      this.memory = getAgentMemory('teacher-agent', { displayName: 'GSX Teacher' });
      await this.memory.load();
      this._ensureMemorySections();
    }
    return this.memory;
  },

  _ensureMemorySections() {
    const sections = this.memory.getSectionNames();

    if (!sections.includes('Completed Lessons')) {
      this.memory.updateSection('Completed Lessons', '*No lessons completed yet*');
    }
    if (!sections.includes('Current Module')) {
      this.memory.updateSection('Current Module', 'Not started');
    }
    if (!sections.includes('Questions Asked')) {
      this.memory.updateSection('Questions Asked', '*Questions you have asked will appear here*');
    }
    if (this.memory.isDirty()) {
      this.memory.save();
    }
  },

  async execute(task, context = {}) {
    const { heartbeat = () => {} } = context;
    const userRequest = task.content || task.text || '';

    if (!this.memory) {
      await this.initialize();
    }

    try {
      heartbeat('Thinking about your request...');
      const intent = await this._classifyIntent(userRequest);

      switch (intent.type) {
        case 'next_lesson':
          return this._deliverNextLesson(heartbeat);

        case 'specific_lesson':
          return this._deliverSpecificLesson(intent.topic, heartbeat);

        case 'list_modules':
          return this._listModules();

        case 'progress':
          return this._showProgress();

        case 'question':
          return this._answerQuestion(userRequest, heartbeat);

        case 'exercise':
          return this._showExercise(intent.topic, heartbeat);

        default:
          return this._listModules();
      }
    } catch (error) {
      log.error('agent', 'Teacher agent error', { error: error.message });
      return {
        success: false,
        message: 'I had trouble with that request. Try asking me to "show the curriculum" or "teach me about agents."',
      };
    }
  },

  async _classifyIntent(userRequest) {
    try {
      const result = await ai.json(
        `Classify this learning request:

USER: "${userRequest}"

Types:
- next_lesson: wants to continue learning, start next lesson, keep going
- specific_lesson: wants to learn about a specific topic (extract the topic)
- list_modules: wants to see available modules/curriculum overview
- progress: wants to see what they have learned, their progress
- question: has a specific question about a feature or concept
- exercise: wants a practice exercise on a topic

Respond: {"type":"<type>","topic":"<topic if specific, else null>"}`,
        { profile: 'fast', temperature: 0.1, feature: 'teacher-agent' }
      );
      return result || { type: 'list_modules', topic: null };
    } catch {
      return { type: 'list_modules', topic: null };
    }
  },

  _getCompletedLessons() {
    if (!this.memory) return [];
    const section = this.memory.getSection('Completed Lessons') || '';
    const matches = section.match(/- \d{4}-\d{2}-\d{2}: (.+?)$/gm) || [];
    return matches.map((m) => m.replace(/^- \d{4}-\d{2}-\d{2}: /, '').trim());
  },

  _findNextLesson() {
    const completed = this._getCompletedLessons();
    for (const module of CURRICULUM) {
      for (const lesson of module.lessons) {
        if (!completed.includes(lesson.id)) {
          return { module, lesson };
        }
      }
    }
    return null;
  },

  _findLessonByTopic(topic) {
    const lower = topic.toLowerCase();
    for (const module of CURRICULUM) {
      if (module.name.toLowerCase().includes(lower) || module.id.includes(lower)) {
        const completed = this._getCompletedLessons();
        const next = module.lessons.find((l) => !completed.includes(l.id));
        return { module, lesson: next || module.lessons[0] };
      }
      for (const lesson of module.lessons) {
        if (lesson.title.toLowerCase().includes(lower)) {
          return { module, lesson };
        }
      }
    }

    for (const module of CURRICULUM) {
      for (const lesson of module.lessons) {
        const content = `${lesson.overview} ${lesson.concepts.join(' ')}`.toLowerCase();
        if (content.includes(lower)) {
          return { module, lesson };
        }
      }
    }

    return null;
  },

  async _deliverNextLesson(heartbeat) {
    const next = this._findNextLesson();
    if (!next) {
      return {
        success: true,
        message: 'Congratulations -- you have completed the entire GSX Power User curriculum! You can ask me questions about any topic or say "show my progress" to see everything you have learned.',
      };
    }
    return this._deliverLesson(next.module, next.lesson, heartbeat);
  },

  async _deliverSpecificLesson(topic, heartbeat) {
    if (!topic) return this._listModules();
    const found = this._findLessonByTopic(topic);
    if (!found) {
      return {
        success: true,
        message: `I could not find a lesson matching "${topic}". Here are the available modules:\n\n${this._formatModuleList()}\n\nSay the module name to start, or ask me a specific question.`,
      };
    }
    return this._deliverLesson(found.module, found.lesson, heartbeat);
  },

  async _deliverLesson(module, lesson, heartbeat) {
    heartbeat(`Preparing lesson: ${lesson.title}...`);

    const completed = this._getCompletedLessons();
    const moduleProgress = module.lessons.filter((l) => completed.includes(l.id)).length;
    const lessonIndex = module.lessons.indexOf(lesson) + 1;

    let response = `**${module.name} -- Lesson ${lessonIndex}/${module.lessons.length}**\n`;
    response += `# ${lesson.title}\n\n`;
    response += `${lesson.overview}\n\n`;
    response += `**Key Concepts:**\n`;
    for (const concept of lesson.concepts) {
      response += `  - ${concept}\n`;
    }
    response += `\n**Walkthrough:**\n${lesson.walkthrough}\n\n`;
    response += `**Exercise:**\n${lesson.exercise}\n\n`;
    response += `---\n*Progress: ${moduleProgress + 1}/${module.lessons.length} in ${module.name} | ${completed.length + 1}/${this._totalLessons()} overall*`;

    this._markLessonComplete(lesson.id);

    const result = {
      success: true,
      message: response,
    };

    if (lesson.action) {
      result.data = {
        action: { type: lesson.action },
      };

      try {
        const { executeAction } = require('../../action-executor');
        await executeAction(lesson.action, {});
      } catch {
        // Non-critical if action fails
      }
    }

    return result;
  },

  _markLessonComplete(lessonId) {
    try {
      if (!this.memory) return;
      const timestamp = new Date().toISOString().split('T')[0];
      this.memory.appendToSection('Completed Lessons', `- ${timestamp}: ${lessonId}`, 100);

      const next = this._findNextLesson();
      if (next) {
        this.memory.updateSection('Current Module', `${next.module.name} -- ${next.lesson.title}`);
      } else {
        this.memory.updateSection('Current Module', 'All modules completed');
      }

      this.memory.save();
    } catch {
      // Non-fatal
    }
  },

  _totalLessons() {
    return CURRICULUM.reduce((sum, m) => sum + m.lessons.length, 0);
  },

  _listModules() {
    const completed = this._getCompletedLessons();
    let message = '**GSX Power User Curriculum**\n\n';
    message += this._formatModuleList(completed);
    message += `\n---\n*${completed.length}/${this._totalLessons()} lessons completed*\n\n`;
    message += 'Say "next lesson" to continue, or name a module to start there (e.g., "teach me about building agents").';

    return { success: true, message };
  },

  _formatModuleList(completed) {
    if (!completed) completed = this._getCompletedLessons();
    let text = '';
    for (let i = 0; i < CURRICULUM.length; i++) {
      const mod = CURRICULUM[i];
      const done = mod.lessons.filter((l) => completed.includes(l.id)).length;
      const status = done === mod.lessons.length ? '[DONE]' : done > 0 ? `[${done}/${mod.lessons.length}]` : '';
      text += `${i + 1}. **${mod.name}** ${status}\n   ${mod.description}\n\n`;
    }
    return text;
  },

  _showProgress() {
    const completed = this._getCompletedLessons();
    const total = this._totalLessons();

    let message = `**Your Learning Progress**\n\n`;
    message += `Lessons completed: ${completed.length}/${total}\n\n`;

    for (const mod of CURRICULUM) {
      const done = mod.lessons.filter((l) => completed.includes(l.id)).length;
      const bar = '='.repeat(done) + '-'.repeat(mod.lessons.length - done);
      message += `**${mod.name}** [${bar}] ${done}/${mod.lessons.length}\n`;
      for (const lesson of mod.lessons) {
        const check = completed.includes(lesson.id) ? '[x]' : '[ ]';
        message += `  ${check} ${lesson.title}\n`;
      }
      message += '\n';
    }

    const next = this._findNextLesson();
    if (next) {
      message += `\n**Next up:** ${next.module.name} -- ${next.lesson.title}\nSay "next lesson" to continue.`;
    } else {
      message += '\nYou have completed the entire curriculum!';
    }

    return { success: true, message };
  },

  async _answerQuestion(question, heartbeat) {
    heartbeat('Looking up the answer...');

    let relevantContent = '';
    const lower = question.toLowerCase();
    for (const mod of CURRICULUM) {
      for (const lesson of mod.lessons) {
        const content = `${lesson.title} ${lesson.overview} ${lesson.concepts.join(' ')} ${lesson.walkthrough}`;
        if (content.toLowerCase().includes(lower.split(' ').filter((w) => w.length > 3).join('|') || lower)) {
          relevantContent += `\n[${mod.name} - ${lesson.title}]\n${lesson.overview}\n${lesson.concepts.join('. ')}\n`;
        }
      }
    }

    if (!relevantContent) {
      for (const mod of CURRICULUM) {
        relevantContent += `\n[${mod.name}] ${mod.description}`;
      }
    }

    try {
      const answer = await ai.complete(
        `A user is learning GSX Power User and asked: "${question}"

Here is relevant curriculum content:
${relevantContent.slice(0, 3000)}

Answer their question clearly and concisely. If the answer involves using a feature, include the keyboard shortcut or menu path. Keep it practical and actionable.`,
        {
          profile: 'standard',
          feature: 'teacher-agent',
          maxTokens: 1000,
        }
      );

      this._trackQuestion(question);

      return {
        success: true,
        message: answer || 'I could not find a specific answer. Try rephrasing or say "show curriculum" to browse topics.',
      };
    } catch {
      return {
        success: true,
        message: 'I had trouble looking that up. Try saying "teach me about [topic]" for a structured lesson.',
      };
    }
  },

  _trackQuestion(question) {
    try {
      if (!this.memory) return;
      const timestamp = new Date().toISOString().split('T')[0];
      this.memory.appendToSection('Questions Asked', `- ${timestamp}: ${question.slice(0, 80)}`, 30);
      this.memory.save();
    } catch {
      // Non-fatal
    }
  },

  async _showExercise(topic, _heartbeat) {
    if (!topic) {
      const next = this._findNextLesson();
      if (next) {
        return {
          success: true,
          message: `**Exercise from ${next.module.name} -- ${next.lesson.title}**\n\n${next.lesson.exercise}`,
        };
      }
      return { success: true, message: 'Say "teach me about [topic]" first, and I will give you exercises on that topic.' };
    }

    const found = this._findLessonByTopic(topic);
    if (!found) {
      return { success: true, message: `I could not find exercises for "${topic}". Try one of the module names from the curriculum.` };
    }

    return {
      success: true,
      message: `**Exercise: ${found.lesson.title}**\n\n${found.lesson.exercise}`,
    };
  },
};

module.exports = teacherAgent;
