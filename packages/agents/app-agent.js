/**
 * App Agent - Your Personal App Guide
 * 
 * Knows everything about the GSX Power User app and can walk you through features.
 * 
 * Capabilities:
 * - Answer questions about any app feature
 * - Give guided tours of products
 * - Explain how to access features
 * - Run playbooks - step-by-step guides for tasks
 * - List available actions for each feature
 * - Track which features you've explored
 */

const { getAgentMemory } = require('../../lib/agent-memory-store');
const { learnFromInteraction } = require('../../lib/thinking-agent');
const ai = require('../../lib/ai-service');
const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();

// ==================== APP KNOWLEDGE BASE ====================

const APP_PRODUCTS = {
  'gsx-create': {
    name: 'GSX Create',
    description: 'AI-powered development assistant for building apps and agents',
    access: 'Window menu → GSX Create, or use keyboard shortcut Cmd+Shift+G',
    icon: 'code',
    features: [
      'Task queue with 7-phase workflow for complex coding tasks',
      'Real-time progress display showing what the AI is doing',
      'LLM summarization of activities',
      'Budget tracking to see how much you\'re spending on AI',
      'Work persists across restarts - never lose progress',
      'Graceful shutdown that saves your work'
    ],
    actions: [
      { name: 'Start a new coding task', command: 'Type your task in the input and press Enter' },
      { name: 'View task queue', command: 'Look at the left panel to see pending tasks' },
      { name: 'Check budget', command: 'The cost displays in the top bar' },
      { name: 'Pause/Resume work', command: 'Click the pause button in the toolbar' },
      { name: 'View activity log', command: 'Scroll down to see what the AI has done' },
      { name: 'Cancel a task', command: 'Click the X next to any queued task' },
      { name: 'Export work', command: 'Use the export button to save your session' }
    ],
    tips: [
      'Start with small tasks to understand the workflow',
      'Check the budget display to track your API costs',
      'Use the task queue for multi-step projects'
    ],
    keywords: ['gsx', 'create', 'aider', 'code', 'development', 'build', 'programming', 'ai assistant']
  },
  
  'video-editor': {
    name: 'Video Editor',
    description: 'Professional video editing with AI-powered features',
    access: 'Window menu → Video Editor, or drag a video file onto the app',
    icon: 'video',
    features: [
      'Timeline-based editing with visual waveforms',
      'Range markers with metadata for organizing clips',
      'ElevenLabs AI voice replacement with 9 different voices',
      'Smart transcription that works instantly',
      'Scene detection to find key moments',
      'YouTube video download and editing'
    ],
    actions: [
      { name: 'Load a video', command: 'Drag a file onto the editor or use File → Open' },
      { name: 'Download from YouTube', command: 'Paste a YouTube URL and click Download' },
      { name: 'Create a marker', command: 'Click the + button or press M at playhead position' },
      { name: 'Set in/out points', command: 'Press I for in-point, O for out-point' },
      { name: 'Replace audio with AI voice', command: 'Select a range → Click "Replace with AI Voice"' },
      { name: 'Get transcription', command: 'Click the Transcribe button in the toolbar' },
      { name: 'Detect scenes', command: 'Click "Scene Detection" to find key moments' },
      { name: 'Export video', command: 'File → Export or click the Export button' },
      { name: 'Adjust playback speed', command: 'Use the speed dropdown: 0.5x, 1x, 1.5x, 2x' }
    ],
    tips: [
      'Use range markers to mark sections before applying AI voices',
      'The transcription uses existing data when available for instant results',
      'Export to different formats for YouTube, social media, etc.'
    ],
    keywords: ['video', 'edit', 'editing', 'movie', 'clip', 'timeline', 'voice', 'elevenlabs', 'transcription']
  },
  
  'spaces': {
    name: 'Spaces',
    description: 'Organize and store all your content in one place',
    access: 'Always visible in the sidebar, or Cmd+1 to focus',
    icon: 'folder',
    features: [
      'Hierarchical space organization - folders within folders',
      'Drag and drop anything - files, text, images, links',
      'GSX cloud synchronization across devices',
      'Powerful search across all your content',
      'Browser extension to save from any website',
      'Bulk operations - select multiple items to move or delete',
      'Upload directly to ChatGPT or Claude from your spaces'
    ],
    actions: [
      { name: 'Create a new space', command: 'Click the + button at the top of the sidebar' },
      { name: 'Add content', command: 'Drag files, text, or images into a space' },
      { name: 'Search everything', command: 'Cmd+F or click the search icon' },
      { name: 'Move items', command: 'Drag items between spaces, or use bulk select' },
      { name: 'Bulk select', command: 'Hover over items to see checkboxes, then select multiple' },
      { name: 'Delete items', command: 'Select items → click Delete, or right-click → Delete' },
      { name: 'Sync to cloud', command: 'Click the sync icon or go to Settings → Sync' },
      { name: 'Upload to AI', command: 'Right-click an item → "Upload to ChatGPT/Claude"' },
      { name: 'Export content', command: 'Right-click → Smart Export' },
      { name: 'View item details', command: 'Click an item to see full content and metadata' }
    ],
    tips: [
      'Create a space for each project to stay organized',
      'Use the browser extension to clip content from the web',
      'Right-click items for more options like sharing and exporting'
    ],
    keywords: ['spaces', 'organize', 'store', 'storage', 'files', 'folders', 'content', 'save']
  },
  
  'clipboard-manager': {
    name: 'Clipboard Manager',
    description: 'Never lose copied content again',
    access: 'Cmd+Shift+V to open clipboard history, or View menu → Clipboard',
    icon: 'clipboard',
    features: [
      'Full clipboard history - everything you copy is saved',
      'Source detection - know where each clip came from',
      'Quick paste with keyboard shortcuts',
      'Save important clips to Spaces',
      'Search through your clipboard history'
    ],
    actions: [
      { name: 'Open clipboard history', command: 'Cmd+Shift+V from anywhere' },
      { name: 'Paste an old item', command: 'Double-click any item in history' },
      { name: 'Save to Space', command: 'Drag an item to a Space in the sidebar' },
      { name: 'Search history', command: 'Type in the search box at the top' },
      { name: 'Clear history', command: 'Click the clear button (trash icon)' },
      { name: 'Pin an item', command: 'Right-click → Pin to keep at top' },
      { name: 'View source', command: 'Hover to see where content was copied from' }
    ],
    tips: [
      'Double-click an item to paste it immediately',
      'Drag items from clipboard to a Space to save permanently',
      'Use search to find something you copied days ago'
    ],
    keywords: ['clipboard', 'copy', 'paste', 'history', 'copied']
  },
  
  'smart-export': {
    name: 'Smart Export',
    description: 'Export your content with AI-enhanced formatting',
    access: 'Right-click any content → Smart Export, or Edit menu → Smart Export',
    icon: 'export',
    features: [
      'Multiple export formats - Markdown, HTML, PDF, and more',
      'Style guide extraction from any website',
      'Import styles from a URL to match any brand',
      'Template system for consistent exports',
      'Preview before exporting'
    ],
    actions: [
      { name: 'Export to Markdown', command: 'Select content → Smart Export → Markdown' },
      { name: 'Export to PDF', command: 'Select content → Smart Export → PDF' },
      { name: 'Extract style guide', command: 'Enter a URL → "Extract Style Guide"' },
      { name: 'Apply a template', command: 'Choose from template dropdown before exporting' },
      { name: 'Save as template', command: 'Configure format → "Save as Template"' },
      { name: 'Preview export', command: 'Click Preview before final export' },
      { name: 'Batch export', command: 'Select multiple items → Smart Export' }
    ],
    tips: [
      'Use the style guide feature to match your company\'s brand',
      'Save templates for formats you use often',
      'The preview shows exactly what you\'ll get'
    ],
    keywords: ['export', 'format', 'markdown', 'pdf', 'html', 'style', 'template']
  },
  
  'idw-hub': {
    name: 'IDW Hub',
    description: 'Manage your Intelligent Digital Workers',
    access: 'IDW menu → Manage IDWs, or the IDW icon in the toolbar',
    icon: 'robot',
    features: [
      'Register and manage all your IDWs in one place',
      'Configure GSX links for each worker',
      'Handle different environments (production, staging, dev)',
      'Agent explorer to see what each IDW can do',
      'Quick switch between workers'
    ],
    actions: [
      { name: 'Add a new IDW', command: 'Click "+ Add IDW" and enter credentials' },
      { name: 'Switch IDWs', command: 'Click the IDW name in toolbar to switch' },
      { name: 'Configure GSX link', command: 'IDW settings → GSX Configuration' },
      { name: 'Explore agents', command: 'Click "Agent Explorer" to see capabilities' },
      { name: 'Set default IDW', command: 'Right-click an IDW → "Set as Default"' },
      { name: 'Test connection', command: 'Click "Test" to verify IDW is reachable' },
      { name: 'Switch environment', command: 'Use the environment dropdown (prod/staging/dev)' },
      { name: 'Remove an IDW', command: 'Right-click → Remove' }
    ],
    tips: [
      'Set up your most-used IDW as the default',
      'Use the agent explorer to discover capabilities',
      'Keep production and dev environments separate'
    ],
    keywords: ['idw', 'digital worker', 'worker', 'onereach', 'agent', 'bot']
  },
  
  'ai-agents': {
    name: 'AI Agents & Creators',
    description: 'Access all major AI services in one place',
    access: 'AI menu, or use the quick launcher with Cmd+K',
    icon: 'brain',
    features: [
      'ChatGPT, Claude, Gemini, Grok, Perplexity - all in tabs',
      'Auto-save conversations to dedicated Spaces',
      'Image AI: Midjourney, DALL-E, Ideogram, Leonardo AI',
      'Video AI: Veo3, Runway, Pika, Kling',
      'Audio AI: ElevenLabs, Suno, Udio',
      'Design AI: Stitch, Figma AI',
      'Create your own custom voice-activated agents'
    ],
    actions: [
      { name: 'Open ChatGPT', command: 'AI menu → ChatGPT, or Cmd+K then type "chatgpt"' },
      { name: 'Open Claude', command: 'AI menu → Claude' },
      { name: 'Open Gemini', command: 'AI menu → Gemini' },
      { name: 'Open image generators', command: 'AI menu → Image → choose Midjourney, DALL-E, etc.' },
      { name: 'Open video generators', command: 'AI menu → Video → choose Runway, Pika, etc.' },
      { name: 'Create custom agent', command: 'Agents menu → Create New Agent' },
      { name: 'Edit an agent', command: 'Agents menu → Manage Agents → click Edit' },
      { name: 'Find saved conversations', command: 'Open Spaces → look for "ChatGPT Conversations" etc.' },
      { name: 'Upload from Spaces', command: 'In ChatGPT/Claude, click file upload → "From Spaces"' }
    ],
    tips: [
      'Your conversations auto-save to Spaces - check ChatGPT Conversations, etc.',
      'Create custom agents for tasks you do often',
      'Use voice commands to switch between AI agents'
    ],
    keywords: ['ai', 'chatgpt', 'claude', 'gemini', 'grok', 'midjourney', 'dalle', 'agents', 'creators']
  },
  
  'budget-manager': {
    name: 'Budget Manager',
    description: 'Track and control your AI spending',
    access: 'View menu → Budget Dashboard, or click the cost display in GSX Create',
    icon: 'dollar',
    features: [
      'Real-time cost tracking for all AI operations',
      'Set budget limits to avoid surprises',
      'Visual dashboard showing spending patterns',
      'Configure pricing for different AI models',
      'See exactly what each operation costs'
    ],
    actions: [
      { name: 'View spending', command: 'View menu → Budget Dashboard' },
      { name: 'Set budget limit', command: 'Budget Dashboard → "Set Limit"' },
      { name: 'View by date', command: 'Use the date picker to see specific periods' },
      { name: 'View by model', command: 'Click "By Model" tab to see costs per AI' },
      { name: 'Configure prices', command: 'Settings → Budget → Model Pricing' },
      { name: 'Export report', command: 'Budget Dashboard → Export' },
      { name: 'Reset period', command: 'Settings → Budget → Reset Period' }
    ],
    tips: [
      'Set a daily budget limit to stay in control',
      'Check the dashboard weekly to understand your usage',
      'Different models have different costs - choose wisely'
    ],
    keywords: ['budget', 'cost', 'spending', 'money', 'price', 'expensive', 'cheap']
  },
  
  'app-health': {
    name: 'App Health Dashboard',
    description: 'Monitor your app\'s performance and troubleshoot issues',
    access: 'Help menu → App Health, or Cmd+Shift+H',
    icon: 'heart',
    features: [
      'Health metrics for the app',
      'Log viewer for debugging',
      'Error tracking and history',
      'Performance monitoring'
    ],
    actions: [
      { name: 'View health status', command: 'Help menu → App Health' },
      { name: 'Open log viewer', command: 'App Health → Logs tab' },
      { name: 'Filter logs', command: 'Use the search and filter dropdowns' },
      { name: 'Export logs', command: 'Logs tab → Export' },
      { name: 'Clear old logs', command: 'Logs tab → Clear' },
      { name: 'Check for updates', command: 'Help menu → Check for Updates' },
      { name: 'Report an issue', command: 'Help menu → Report Issue (includes logs)' }
    ],
    tips: [
      'Check here first if something seems slow',
      'The log viewer helps find specific errors',
      'Export logs when reporting issues'
    ],
    keywords: ['health', 'performance', 'slow', 'error', 'log', 'debug', 'troubleshoot', 'problem']
  },
  
  'voice-assistant': {
    name: 'Voice Assistant',
    description: 'Control the app with your voice',
    access: 'Click the orb or press and hold the spacebar',
    icon: 'microphone',
    features: [
      'Say "Hey" to wake the assistant',
      'Ask about time, weather, play music',
      'Control the app hands-free',
      'Create custom voice-activated agents',
      'Natural language understanding'
    ],
    actions: [
      { name: 'Activate voice', command: 'Click the orb or hold spacebar' },
      { name: 'Ask the time', command: 'Say "What time is it?"' },
      { name: 'Check weather', command: 'Say "What\'s the weather in [city]?"' },
      { name: 'Play music', command: 'Say "Play some music" or "Play jazz"' },
      { name: 'Control volume', command: 'Say "Volume up" or "Volume down"' },
      { name: 'Get help', command: 'Say "What can you do?"' },
      { name: 'Cancel action', command: 'Say "Cancel" or "Stop"' },
      { name: 'Create agent', command: 'Say "Create a new agent"' }
    ],
    tips: [
      'Press and hold spacebar for quick voice input',
      'Say "what can you do" for a list of commands',
      'Custom agents can handle specialized tasks'
    ],
    keywords: ['voice', 'speak', 'talk', 'microphone', 'hands free', 'orb', 'assistant']
  },
  
  'settings': {
    name: 'Settings',
    description: 'Configure app preferences and integrations',
    access: 'Cmd+, or App menu → Settings',
    icon: 'gear',
    features: [
      'General preferences',
      'API key management',
      'Sync settings',
      'Keyboard shortcuts',
      'Theme and appearance'
    ],
    actions: [
      { name: 'Open settings', command: 'Cmd+, or click gear icon' },
      { name: 'Add API key', command: 'Settings → API Keys → Add' },
      { name: 'Configure sync', command: 'Settings → Sync' },
      { name: 'Change shortcuts', command: 'Settings → Keyboard Shortcuts' },
      { name: 'Manage extensions', command: 'Settings → Extensions' },
      { name: 'Reset to defaults', command: 'Settings → Advanced → Reset' }
    ],
    tips: [
      'Keep your API keys secure',
      'Set up sync early to avoid losing data',
      'Customize shortcuts for your workflow'
    ],
    keywords: ['settings', 'preferences', 'config', 'api key', 'setup', 'configure']
  }
};

// ==================== PLAYBOOKS ====================
// Step-by-step guides for common tasks

const PLAYBOOKS = {
  'first-time-setup': {
    name: 'First Time Setup',
    description: 'Get the app configured for first use',
    keywords: ['setup', 'first time', 'getting started', 'new user', 'beginner', 'start'],
    steps: [
      { title: 'Welcome', instruction: 'Welcome to GSX Power User! Let\'s get you set up. First, open Settings with Cmd+comma.' },
      { title: 'Add API Keys', instruction: 'Go to Settings → API Keys. Add your OpenAI key for AI features. You can also add ElevenLabs for voice features.' },
      { title: 'Create Your First Space', instruction: 'Click the + button in the sidebar to create a Space. Name it something like "My Projects" or "General".' },
      { title: 'Try the Clipboard', instruction: 'Copy some text from anywhere. Then press Cmd+Shift+V to see your clipboard history. Everything you copy is saved!' },
      { title: 'Explore AI Agents', instruction: 'Open the AI menu to see ChatGPT, Claude, and other AI tools. Your conversations auto-save to Spaces.' },
      { title: 'Try Voice Commands', instruction: 'Click the orb or hold spacebar, then say "What can you do?" to learn voice commands.' },
      { title: 'You\'re Ready!', instruction: 'Setup complete! Explore the app and ask me anytime you need help. Say "give me a tour" to learn more about any feature.' }
    ]
  },
  
  'edit-video-with-ai-voice': {
    name: 'Replace Video Audio with AI Voice',
    description: 'Use ElevenLabs to replace audio in your video',
    keywords: ['video', 'voice', 'ai voice', 'elevenlabs', 'replace audio', 'dub', 'voiceover'],
    steps: [
      { title: 'Open Video Editor', instruction: 'Go to Window menu → Video Editor, or drag your video file onto the app.' },
      { title: 'Load Your Video', instruction: 'Click "Open Video" or drag your video file into the editor. Wait for it to load with waveform.' },
      { title: 'Get Transcription', instruction: 'Click the "Transcribe" button. This converts the audio to text that the AI voice will speak.' },
      { title: 'Set Range', instruction: 'Move the playhead to where you want AI voice to start. Press I for in-point. Move to end, press O for out-point.' },
      { title: 'Replace with AI Voice', instruction: 'With your range selected, click "Replace with AI Voice". Choose a voice from the dropdown.' },
      { title: 'Preview', instruction: 'Play back the section to hear the AI voice. If you don\'t like it, use undo and try a different voice.' },
      { title: 'Export', instruction: 'When satisfied, go to File → Export to save your video with the new audio.' }
    ]
  },
  
  'organize-with-spaces': {
    name: 'Organize Your Content with Spaces',
    description: 'Set up a productive organization system',
    keywords: ['organize', 'spaces', 'folders', 'content', 'files', 'structure'],
    steps: [
      { title: 'Plan Your Structure', instruction: 'Think about how you work. Common spaces: Projects, Reference, Ideas, Archive. We\'ll create these.' },
      { title: 'Create Main Spaces', instruction: 'Click + in the sidebar. Create spaces for your main categories. Start with "Active Projects" and "Reference".' },
      { title: 'Add Content', instruction: 'Drag files, images, or text into your spaces. You can also copy text and use Cmd+Shift+V to save from clipboard.' },
      { title: 'Use Browser Extension', instruction: 'Install the browser extension from Settings → Extensions. Now you can save web content directly to Spaces.' },
      { title: 'Search Everything', instruction: 'Press Cmd+F to search across all your spaces. The search finds text inside documents too.' },
      { title: 'Set Up Sync', instruction: 'Go to Settings → Sync to enable GSX cloud sync. Your content will be backed up and available across devices.' },
      { title: 'Done!', instruction: 'Your organization system is ready! Remember: drag to add, Cmd+F to find, and everything is searchable.' }
    ]
  },
  
  'build-with-gsx-create': {
    name: 'Build an App with GSX Create',
    description: 'Use AI to help you code',
    keywords: ['code', 'build', 'programming', 'gsx create', 'development', 'app'],
    steps: [
      { title: 'Open GSX Create', instruction: 'Press Cmd+Shift+G or go to Window → GSX Create to open the coding assistant.' },
      { title: 'Describe Your Task', instruction: 'Type what you want to build in plain English. Be specific: "Create a Python script that downloads images from URLs in a text file."' },
      { title: 'Watch the Workflow', instruction: 'GSX Create uses a 7-phase workflow. Watch the progress panel to see what the AI is doing at each step.' },
      { title: 'Review the Code', instruction: 'When complete, review the generated code. The AI explains what it created and why.' },
      { title: 'Make Changes', instruction: 'Not quite right? Add another task: "Make the script also resize images to 800px width." It builds on previous work.' },
      { title: 'Monitor Budget', instruction: 'Check the cost display in the top bar. Complex tasks use more tokens. Set a budget limit in Settings if needed.' },
      { title: 'Export Your Work', instruction: 'Use the Export button to save your code and the AI conversation. Work persists even if you close the app.' }
    ]
  },
  
  'create-custom-agent': {
    name: 'Create a Custom Voice Agent',
    description: 'Build your own voice-activated assistant',
    keywords: ['custom agent', 'voice agent', 'create agent', 'build agent', 'assistant'],
    steps: [
      { title: 'Open Agent Manager', instruction: 'Go to Agents menu → Create New Agent, or say "Create a new agent" to the voice assistant.' },
      { title: 'Name Your Agent', instruction: 'Give it a clear name like "Email Helper" or "Meeting Scheduler". This is what you\'ll say to activate it.' },
      { title: 'Define Keywords', instruction: 'Add keywords that trigger your agent: "email", "send", "compose" for an email agent. Multiple keywords help recognition.' },
      { title: 'Write the Prompt', instruction: 'Describe what your agent does and how it should respond. Be specific about the task and tone.' },
      { title: 'Choose a Voice', instruction: 'Select a voice personality. Different voices work better for different tasks - "nova" for friendly, "onyx" for professional.' },
      { title: 'Test It', instruction: 'Click Test to try your agent. Speak naturally and see if it responds correctly.' },
      { title: 'Refine and Save', instruction: 'Adjust keywords and prompt based on testing. When satisfied, click Save. Your agent is now live!' }
    ]
  },
  
  'save-ai-conversations': {
    name: 'Save and Organize AI Conversations',
    description: 'Never lose your ChatGPT, Claude, or other AI chats',
    keywords: ['save conversation', 'chatgpt', 'claude', 'backup', 'history', 'ai chat'],
    steps: [
      { title: 'Auto-Save is On', instruction: 'Good news - conversations auto-save! Every chat with ChatGPT, Claude, Gemini, Grok, and Perplexity is captured.' },
      { title: 'Find Your Conversations', instruction: 'Open Spaces. Look for "ChatGPT Conversations", "Claude Conversations", etc. Each AI has its own Space.' },
      { title: 'Browse History', instruction: 'Click a conversation Space to see all your chats. They\'re organized by date and topic.' },
      { title: 'Search Conversations', instruction: 'Use Cmd+F to search. Find that brilliant prompt or answer you had last week.' },
      { title: 'Organize Further', instruction: 'Drag important conversations to project-specific Spaces. Create a "Best Prompts" Space for your favorites.' },
      { title: 'Export if Needed', instruction: 'Right-click any conversation → Smart Export to get Markdown, PDF, or other formats.' },
      { title: 'Done!', instruction: 'Your AI conversations are automatically saved and searchable. Never lose a good chat again!' }
    ]
  },
  
  'track-ai-spending': {
    name: 'Track and Control AI Spending',
    description: 'Monitor costs and set budget limits',
    keywords: ['budget', 'cost', 'spending', 'money', 'track', 'limit'],
    steps: [
      { title: 'Open Budget Dashboard', instruction: 'Go to View menu → Budget Dashboard. This shows all your AI spending.' },
      { title: 'View Current Spending', instruction: 'The dashboard shows today, this week, and this month. See which AI services cost the most.' },
      { title: 'View by Model', instruction: 'Click the "By Model" tab. GPT-4 costs more than GPT-3.5. See where your money goes.' },
      { title: 'Set a Limit', instruction: 'Click "Set Limit" and enter a daily or monthly budget. You\'ll get warnings when approaching it.' },
      { title: 'Configure Alerts', instruction: 'In Settings → Budget, set up alerts at 50%, 75%, and 90% of your limit.' },
      { title: 'Optimize Usage', instruction: 'For cheaper operations, use GPT-3.5 instead of GPT-4 when possible. GSX Create shows cost per task.' },
      { title: 'Review Weekly', instruction: 'Check the dashboard weekly. Export reports for expense tracking. Stay in control!' }
    ]
  },
  
  'troubleshoot-issues': {
    name: 'Troubleshoot App Problems',
    description: 'Fix common issues and get help',
    keywords: ['problem', 'issue', 'error', 'not working', 'broken', 'fix', 'help', 'troubleshoot'],
    steps: [
      { title: 'Check App Health', instruction: 'Press Cmd+Shift+H to open App Health. Look for any red indicators or error counts.' },
      { title: 'View Recent Errors', instruction: 'In App Health → Logs, filter by "Error" to see recent problems. Read the messages for clues.' },
      { title: 'Try Restarting', instruction: 'Many issues fix with a restart. Quit the app fully (Cmd+Q) and reopen. This clears temporary state.' },
      { title: 'Check Connectivity', instruction: 'AI features need internet. Check your connection. API errors often mean network issues.' },
      { title: 'Verify API Keys', instruction: 'Go to Settings → API Keys. Make sure keys are valid and not expired. Test each one.' },
      { title: 'Export Logs', instruction: 'If problems persist, go to App Health → Logs → Export. This creates a file for support.' },
      { title: 'Get Help', instruction: 'Help menu → Report Issue attaches logs automatically. Or ask me - say "I\'m having a problem with [feature]".' }
    ]
  },
  
  'keyboard-shortcuts': {
    name: 'Master Keyboard Shortcuts',
    description: 'Speed up your workflow with shortcuts',
    keywords: ['shortcuts', 'keyboard', 'hotkeys', 'fast', 'quick', 'keys'],
    steps: [
      { title: 'Essential Shortcuts', instruction: 'The most important ones: Cmd+Shift+V (clipboard), Cmd+K (quick launcher), Cmd+, (settings).' },
      { title: 'Navigation', instruction: 'Cmd+1 focuses Spaces sidebar. Cmd+2-9 switch between open tabs. Cmd+W closes current tab.' },
      { title: 'GSX Create', instruction: 'Cmd+Shift+G opens GSX Create. Cmd+Enter sends your task. Escape cancels current operation.' },
      { title: 'Video Editor', instruction: 'Space plays/pauses. I sets in-point. O sets out-point. M creates marker. Left/Right arrows step frames.' },
      { title: 'Search Everywhere', instruction: 'Cmd+F searches in current view. Cmd+Shift+F searches all Spaces. Type immediately to filter.' },
      { title: 'Quick Launcher', instruction: 'Cmd+K opens the launcher. Type any feature name to jump there instantly. "chatgpt", "video", "settings".' },
      { title: 'View All Shortcuts', instruction: 'Go to Settings → Keyboard Shortcuts for the complete list. You can customize any shortcut there.' }
    ]
  },
  
  'export-content': {
    name: 'Export Content in Any Format',
    description: 'Use Smart Export to share your work',
    keywords: ['export', 'share', 'pdf', 'markdown', 'format', 'download'],
    steps: [
      { title: 'Select Content', instruction: 'First, select what you want to export. This can be from Spaces, clipboard, or any editor.' },
      { title: 'Open Smart Export', instruction: 'Right-click the content → Smart Export. Or use Edit menu → Smart Export.' },
      { title: 'Choose Format', instruction: 'Select your format: Markdown for docs, PDF for sharing, HTML for web. Each has different options.' },
      { title: 'Apply Style Guide', instruction: 'Want to match a brand? Enter a URL and click "Extract Style Guide". It copies fonts, colors, and formatting.' },
      { title: 'Use a Template', instruction: 'Or choose a saved template from the dropdown. Templates remember your preferred formatting.' },
      { title: 'Preview', instruction: 'Click Preview to see exactly what you\'ll get. Make adjustments if needed.' },
      { title: 'Export', instruction: 'Click Export and choose where to save. Your formatted content is ready to share!' }
    ]
  }
};

// Quick reference for common questions
const QUICK_ANSWERS = {
  'how do i open': 'Which feature would you like to open? Say "how do I open" followed by the feature name, like "how do I open the video editor".',
  'where is': 'What are you looking for? Tell me what you want to find and I\'ll show you where it is.',
  'how do i use': 'Which feature do you want to learn about? I can walk you through any of our tools.',
  'what can this app do': 'GSX Power User is an AI-powered creative workstation. Main features include: GSX Create for AI coding, Video Editor, Spaces for organization, Clipboard Manager, Smart Export, IDW Hub, AI Agents, Budget Manager, and App Health monitoring. Want me to tell you more about any of these?',
  'getting started': 'Welcome! I recommend starting with Spaces to organize your content, then try the Clipboard Manager. For AI features, check out GSX Create or the AI Agents menu. Would you like a guided tour of any feature?',
  'what playbooks': 'I have step-by-step playbooks for: First Time Setup, Edit Video with AI Voice, Organize with Spaces, Build with GSX Create, Create Custom Agent, Save AI Conversations, Track AI Spending, Troubleshoot Issues, Keyboard Shortcuts, and Export Content. Which would you like?',
  'list playbooks': 'Available playbooks: First Time Setup, Edit Video with AI Voice, Organize with Spaces, Build with GSX Create, Create Custom Agent, Save AI Conversations, Track AI Spending, Troubleshoot Issues, Keyboard Shortcuts, and Export Content. Say "run playbook" followed by the name.',
  'what can i do with': 'Tell me which feature and I\'ll list all the actions you can take. For example: "What can I do with the video editor?"'
};

// ==================== APP AGENT ====================

const appAgent = {
  id: 'app-agent',
  name: 'App Guide',
  description: 'Opens any app or menu item by name using intelligent matching. Handles AI services, image/video generators, IDW environments, and app features. Also gives tours and playbooks for all features.',
  voice: 'nova',  // Warm, helpful guide voice
  acks: ["Let me help with that.", "I can show you.", "Opening that for you."],
  categories: ['system', 'app', 'help', 'tutorial', 'ai'],
  keywords: [
    'app', 'feature', 'how to', 'where is', 'show me', 'explain', 'tutorial',
    'tour', 'guide', 'learn', 'help with', 'what is', 'how does', 'open', 'launch', 'start',
    'find', 'use', 'access', 'navigate', 'getting started', 'beginner',
    'playbook', 'step by step', 'actions', 'what can i do',
    ...Object.values(APP_PRODUCTS).flatMap(p => p.keywords),
    ...Object.values(PLAYBOOKS).flatMap(p => p.keywords)
  ],
  executionType: 'action',  // Opens windows, navigates menus
  
  prompt: `App Guide opens app windows, navigates to features, and gives tours.

HIGH CONFIDENCE (0.85+) for:
- "Open settings" / "Open the settings" → opens the Settings window
- "Show me the video editor" → opens Video Editor
- "Open spaces" / "Show clipboard" → opens Spaces/Clipboard
- "Launch GSX Create" → opens the coding assistant
- "Open ChatGPT" / "Open Claude" → opens AI service tabs
- "Give me a tour" / "Show me around" → interactive feature tour
- Any request to OPEN, LAUNCH, SHOW, or NAVIGATE TO a specific app feature

This agent can OPEN and NAVIGATE to any part of the app. It knows all features.

LOW CONFIDENCE (0.00) -- do NOT bid on:
- Actual tasks: "What time is it?" (time agent does that)
- Weather queries: "What's the weather?" (weather agent)
- Greetings: "Hello" (smalltalk agent)
- General questions about capabilities: "What can you do?" (help agent)
- Playing music: "Play jazz" (DJ agent)`,
  
  // Memory for tracking user's learning progress
  memory: null,
  
  /**
   * Initialize memory
   */
  async initialize() {
    if (!this.memory) {
      this.memory = getAgentMemory('app-agent', { displayName: 'App Guide' });
      await this.memory.load();
      this._ensureMemorySections();
    }
    return this.memory;
  },
  
  /**
   * Ensure required memory sections exist
   */
  _ensureMemorySections() {
    const sections = this.memory.getSectionNames();
    
    if (!sections.includes('Features Explored')) {
      this.memory.updateSection('Features Explored', `*Features you've asked about will be tracked here*`);
    }
    
    if (!sections.includes('Tours Completed')) {
      this.memory.updateSection('Tours Completed', `*Guided tours you've completed*`);
    }
    
    if (!sections.includes('Preferences')) {
      this.memory.updateSection('Preferences', `- Detail Level: Normal
- Show Tips: Yes`);
    }
    
    if (this.memory.isDirty()) {
      this.memory.save();
    }
  },
  
  // NO bid() method - let the unified LLM bidder handle all routing
  // The LLM uses our description, prompt, and capabilities to decide when to route to us
  
  // Track last discussed product for context
  _lastDiscussedProduct: null,
  
  /**
   * Execute the task - uses LLM to classify intent, no keyword matching
   */
  async execute(task, context = {}) {
    try {
      // Initialize memory
      if (!this.memory) {
        await this.initialize();
      }
      
      // Handle ongoing conversations (context-driven, not keyword-driven)
      if (task.context?.tourState) {
        return this._continueTour(task.context.tourState, task);
      }
      
      if (task.context?.playbookState) {
        return this._continuePlaybook(task.context.playbookState, task);
      }
      
      if (task.context?.pendingState === 'awaiting_product') {
        const productInput = task.context?.userInput || task.content;
        return this._handleProductSelection(productInput);
      }
      
      if (task.context?.pendingState === 'awaiting_playbook') {
        const playbookInput = task.context?.userInput || task.content;
        return this._handlePlaybookSelection(playbookInput);
      }
      
      // Use LLM to classify intent and route appropriately
      const intent = await this._classifyIntent(task.content);
      log.info('agent', `LLM classified intent: ${intent.type} (confidence: ${intent.confidence})`);
      
      switch (intent.type) {
        case 'open_app':
          // Try to find and open a menu item
          const menuResult = await this._openMenuItemWithLLM(task.content);
          if (menuResult) return menuResult;
          // Fall through to ask what to open
          return {
            success: true,
            needsInput: {
              prompt: `I couldn't find that app or tool. What would you like me to open?`,
              agentId: this.id,
              context: { pendingState: 'awaiting_product' }
            }
          };
          
        case 'run_tutorial':
          return this._handlePlaybookRequest(task);
          
        case 'list_tutorials':
          return this._listPlaybooks();
          
        case 'tour':
          return this._handleTourRequest(task);
          
        case 'list_actions':
          return this._handleActionsRequest(task);
          
        case 'search':
          return this._handleSearchRequest(task);
          
        case 'question':
          // Try to answer a question about a product
          const product = this._findProduct(task.content.toLowerCase());
          if (product) {
            return this._answerProductQuestion(product, task.content.toLowerCase(), task);
          }
          // Generic question
          return this._handleGenericQuestion(task);
          
        default:
          // Try menu item match as fallback
          const fallbackResult = await this._openMenuItemWithLLM(task.content);
          if (fallbackResult) return fallbackResult;
          
          // Fallback - offer to help
          return {
            success: true,
            needsInput: {
              prompt: "I can open apps, run tutorials, or answer questions about features. What would you like?",
              agentId: this.id,
              context: { pendingState: 'awaiting_product' }
            }
          };
      }
      
    } catch (error) {
      log.error('agent', 'Error', { error });
      return { success: false, message: "I had trouble understanding that. Could you rephrase your question?" };
    }
  },
  
  /**
   * Use LLM to classify user intent - no keyword matching
   */
  async _classifyIntent(userRequest) {
    try {
      const prompt = `Classify this user request into ONE of these intent types:
- open_app: User wants to open/launch an app, tool, or feature
- run_tutorial: User wants a step-by-step guide or playbook tutorial
- list_tutorials: User wants to see available tutorials/playbooks
- tour: User wants a tour or walkthrough of the app
- list_actions: User wants to know what actions/commands are available
- search: User wants to search for content
- question: User has a question about a feature or how to do something

USER REQUEST: "${userRequest}"

Respond with JSON only:
{"type": "<intent_type>", "confidence": <0.0-1.0>}`;

      const result = await ai.chat({
        profile: 'fast',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        maxTokens: 50,
        jsonMode: true,
        feature: 'app-agent-intent'
      });
      
      const content = result.content || '';
      
      // Parse response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      
      return { type: 'open_app', confidence: 0.5 };
      
    } catch (error) {
      log.error('agent', 'Intent classification error', { error: error.message });
      return { type: 'open_app', confidence: 0.5 };
    }
  },
  
  /**
   * Handle generic questions using LLM
   */
  async _handleGenericQuestion(task) {
    // Just provide helpful guidance
    return {
      success: true,
      message: "I'm the App Guide. I can open any app or tool for you, give tours of features, or run step-by-step tutorials. What would you like to do?"
    };
  },
  
  /**
   * Check if the query mentions a specific product
   */
  _hasSpecificProduct(lower) {
    for (const product of Object.values(APP_PRODUCTS)) {
      if (product.keywords.some(k => lower.includes(k))) {
        return true;
      }
    }
    return false;
  },
  
  /**
   * Check if the query mentions a specific playbook
   */
  _hasSpecificPlaybook(lower) {
    for (const playbook of Object.values(PLAYBOOKS)) {
      if (playbook.keywords.some(k => lower.includes(k))) {
        return true;
      }
    }
    return false;
  },
  
  /**
   * Find which playbook matches the query
   */
  _findPlaybook(text) {
    const lower = text.toLowerCase();
    
    for (const [id, playbook] of Object.entries(PLAYBOOKS)) {
      // Check name match
      if (lower.includes(playbook.name.toLowerCase())) {
        return { id, ...playbook };
      }
      
      // Check keywords - need at least 2 keyword matches for better accuracy
      let matches = 0;
      for (const keyword of playbook.keywords) {
        if (lower.includes(keyword.toLowerCase())) {
          matches++;
        }
      }
      if (matches >= 2) {
        return { id, ...playbook };
      }
    }
    
    return null;
  },
  
  /**
   * Use LLM to find and open a menu item based on user's request
   * @param {string} userRequest - What the user said
   * @returns {Promise<Object|null>} - Agent response or null if no match
   */
  async _openMenuItemWithLLM(userRequest) {
    try {
      // Use MenuDataManager for menu item search (LLM-based)
      let menuItem;
      log.info('agent', `Using LLM to find menu item for: "${userRequest}"`);
      if (global.menuDataManager) {
        menuItem = await global.menuDataManager.findMenuItem(userRequest);
      } else {
        const { findMenuItem } = require('../../menu.js');
        menuItem = await findMenuItem(userRequest);
      }
      
      if (menuItem) {
        log.info('agent', `LLM matched to: ${menuItem.name} (${menuItem.type})`);
        return {
          success: true,
          message: `Opening ${menuItem.name} for you.`,
          data: {
            action: {
              type: 'open-menu-item',
              query: menuItem.name,
              matchedItem: menuItem
            }
          }
        };
      }
      
      log.info('agent', `LLM found no menu item match for: "${userRequest}"`);
      return null;
      
    } catch (error) {
      log.error('agent', 'Error in LLM menu matching', { error: error.message });
      return null;
    }
  },

  /**
   * Find which product the user is asking about
   */
  _findProduct(text) {
    const lower = text.toLowerCase();
    
    for (const [id, product] of Object.entries(APP_PRODUCTS)) {
      // Check exact name match first
      if (lower.includes(product.name.toLowerCase())) {
        return { id, ...product };
      }
      
      // Check keywords
      for (const keyword of product.keywords) {
        if (lower.includes(keyword.toLowerCase())) {
          return { id, ...product };
        }
      }
    }
    
    return null;
  },
  
  /**
   * Find product when user asks how to access something
   */
  _findProductForAccess(text) {
    return this._findProduct(text);
  },
  
  /**
   * Answer a question about a specific product
   */
  async _answerProductQuestion(product, query, task) {
    const lower = query.toLowerCase();
    
    // Track that user explored this feature
    const timestamp = new Date().toISOString().split('T')[0];
    this.memory.appendToSection('Features Explored', `- ${timestamp}: ${product.name}`, 30);
    await this.memory.save();
    
    // How to access/open
    if (lower.includes('open') || lower.includes('access') || lower.includes('where') || lower.includes('find')) {
      return this._explainAccess(product);
    }
    
    // What can it do / features
    if (lower.includes('what') || lower.includes('feature') || lower.includes('can')) {
      return this._explainFeatures(product);
    }
    
    // How to use / tips
    if (lower.includes('tip') || lower.includes('best') || lower.includes('should')) {
      return this._giveTips(product);
    }
    
    // Default: give overview with offer for tour
    return {
      success: true,
      message: `${product.name}: ${product.description}. ${product.access}. Would you like a guided tour of ${product.name}?`,
      data: { productId: product.id }
    };
  },
  
  /**
   * Explain how to access a product
   */
  _explainAccess(product) {
    return {
      success: true,
      message: `To open ${product.name}: ${product.access}`
    };
  },
  
  /**
   * Explain product features
   */
  _explainFeatures(product) {
    const featuresText = product.features.slice(0, 4).join('. ');
    const moreCount = product.features.length > 4 ? product.features.length - 4 : 0;
    
    let message = `${product.name} features: ${featuresText}.`;
    if (moreCount > 0) {
      message += ` And ${moreCount} more features. Want the full tour?`;
    }
    
    return { success: true, message };
  },
  
  /**
   * Give tips for a product
   */
  _giveTips(product) {
    const tipsText = product.tips.join(' ');
    return {
      success: true,
      message: `Tips for ${product.name}: ${tipsText}`
    };
  },
  
  /**
   * Handle tour request
   */
  _handleTourRequest(task) {
    const lower = task.content.toLowerCase();
    const product = this._findProduct(lower);
    
    if (product) {
      return this._startTour(product);
    }
    
    // Ask what they want a tour of
    const productNames = Object.values(APP_PRODUCTS).map(p => p.name).join(', ');
    return {
      success: true,
      needsInput: {
        prompt: `Which feature would you like a tour of? I can show you: ${productNames}`,
        agentId: this.id,
        context: { 
          pendingState: 'awaiting_product',
          forTour: true
        }
      }
    };
  },
  
  /**
   * Start a guided tour
   */
  _startTour(product) {
    const tourSteps = [
      {
        step: 1,
        total: 4,
        content: `Welcome to the ${product.name} tour! ${product.description}. Ready to learn how to access it?`
      },
      {
        step: 2,
        total: 4,
        content: `How to open ${product.name}: ${product.access}. Say "next" to see the features.`
      },
      {
        step: 3,
        total: 4,
        content: `Key features: ${product.features.slice(0, 3).join('. ')}. ${product.features.length > 3 ? `Plus ${product.features.length - 3} more capabilities.` : ''} Say "next" for pro tips.`
      },
      {
        step: 4,
        total: 4,
        content: `Pro tips: ${product.tips.join(' ')} That's the ${product.name} tour! Say "another tour" to explore a different feature.`
      }
    ];
    
    return {
      success: true,
      message: tourSteps[0].content,
      needsInput: {
        prompt: 'Say "next" to continue, or "skip" to end the tour.',
        agentId: this.id,
        context: {
          tourState: {
            productId: product.id,
            productName: product.name,
            currentStep: 1,
            steps: tourSteps
          }
        }
      }
    };
  },
  
  /**
   * Continue an active tour
   */
  async _continueTour(tourState, task) {
    const input = (task.context?.userInput || task.content).toLowerCase();
    
    // Skip/end tour
    if (input.includes('skip') || input.includes('end') || input.includes('stop') || input.includes('cancel')) {
      return { success: true, message: `Tour ended. Feel free to ask me anything about the app anytime!` };
    }
    
    // Another tour
    if (input.includes('another tour') || input.includes('different feature')) {
      return this._handleTourRequest(task);
    }
    
    // Next step
    const nextStep = tourState.currentStep + 1;
    
    if (nextStep > tourState.steps.length) {
      // Tour complete
      const timestamp = new Date().toISOString().split('T')[0];
      this.memory.appendToSection('Tours Completed', `- ${timestamp}: ${tourState.productName}`, 20);
      await this.memory.save();
      
      return { 
        success: true, 
        message: `You've completed the ${tourState.productName} tour! Want to tour another feature?` 
      };
    }
    
    const step = tourState.steps[nextStep - 1];
    
    return {
      success: true,
      message: step.content,
      needsInput: nextStep < tourState.steps.length ? {
        prompt: 'Say "next" to continue, or "skip" to end.',
        agentId: this.id,
        context: {
          tourState: {
            ...tourState,
            currentStep: nextStep
          }
        }
      } : undefined
    };
  },
  
  /**
   * Handle product selection from user input
   */
  _handleProductSelection(input) {
    const product = this._findProduct(input);
    
    if (product) {
      return this._startTour(product);
    }
    
    return {
      success: true,
      message: `I didn't recognize that feature. Try saying the name directly, like "Video Editor" or "Spaces".`,
      needsInput: {
        prompt: 'Which feature would you like to learn about?',
        agentId: this.id,
        context: { pendingState: 'awaiting_product' }
      }
    };
  },
  
  /**
   * Give app overview
   */
  _giveOverview() {
    const mainProducts = ['gsx-create', 'video-editor', 'spaces', 'ai-agents'];
    const highlights = mainProducts.map(id => {
      const p = APP_PRODUCTS[id];
      return `${p.name} for ${p.description.toLowerCase().split(' ').slice(0, 5).join(' ')}`;
    }).join(', ');
    
    return {
      success: true,
      message: `GSX Power User is an AI-powered creative workstation. Main features include ${highlights}, plus Clipboard Manager, Smart Export, Budget tracking, and more. Would you like a tour, playbook, or to see actions for any feature?`
    };
  },
  
  // ==================== PLAYBOOK METHODS ====================
  
  /**
   * List all available playbooks
   */
  _listPlaybooks() {
    const playbookList = Object.values(PLAYBOOKS)
      .map(p => p.name)
      .join(', ');
    
    return {
      success: true,
      message: `Available playbooks: ${playbookList}. Say "run" followed by the playbook name, like "run first time setup" or "help me track spending".`
    };
  },
  
  /**
   * Handle playbook request
   */
  _handlePlaybookRequest(task) {
    const lower = task.content.toLowerCase();
    const playbook = this._findPlaybook(lower);
    
    if (playbook) {
      return this._startPlaybook(playbook);
    }
    
    // Ask which playbook they want
    return {
      success: true,
      needsInput: {
        prompt: `Which playbook would you like? I have: First Time Setup, Edit Video with AI Voice, Organize with Spaces, Build with GSX Create, Create Custom Agent, Save AI Conversations, Track AI Spending, Troubleshoot Issues, Keyboard Shortcuts, and Export Content.`,
        agentId: this.id,
        context: { pendingState: 'awaiting_playbook' }
      }
    };
  },
  
  /**
   * Handle playbook selection from user input
   */
  _handlePlaybookSelection(input) {
    const playbook = this._findPlaybook(input);
    
    if (playbook) {
      return this._startPlaybook(playbook);
    }
    
    return {
      success: true,
      message: `I didn't find that playbook. Try saying the name directly, like "first time setup" or "edit video".`,
      needsInput: {
        prompt: 'Which playbook would you like to run?',
        agentId: this.id,
        context: { pendingState: 'awaiting_playbook' }
      }
    };
  },
  
  /**
   * Start a playbook
   */
  _startPlaybook(playbook) {
    const totalSteps = playbook.steps.length;
    const firstStep = playbook.steps[0];
    
    return {
      success: true,
      message: `Starting playbook: ${playbook.name}. Step 1 of ${totalSteps}: ${firstStep.title}. ${firstStep.instruction}`,
      needsInput: {
        prompt: 'Say "next" when ready, or "skip" to end the playbook.',
        agentId: this.id,
        context: {
          playbookState: {
            playbookId: playbook.id,
            playbookName: playbook.name,
            currentStep: 1,
            totalSteps: totalSteps,
            steps: playbook.steps
          }
        }
      }
    };
  },
  
  /**
   * Continue an active playbook
   */
  async _continuePlaybook(playbookState, task) {
    const input = (task.context?.userInput || task.content).toLowerCase();
    
    // Skip/end playbook
    if (input.includes('skip') || input.includes('end') || input.includes('stop') || input.includes('cancel')) {
      return { success: true, message: `Playbook ended. Feel free to ask me anything or run another playbook anytime!` };
    }
    
    // Another playbook
    if (input.includes('another playbook') || input.includes('different playbook')) {
      return this._listPlaybooks();
    }
    
    // Next step
    const nextStep = playbookState.currentStep + 1;
    
    if (nextStep > playbookState.totalSteps) {
      // Playbook complete
      const timestamp = new Date().toISOString().split('T')[0];
      this.memory.appendToSection('Tours Completed', `- ${timestamp}: Playbook - ${playbookState.playbookName}`, 20);
      await this.memory.save();
      
      return { 
        success: true, 
        message: `Playbook complete! You've finished "${playbookState.playbookName}". Want to run another playbook or explore a feature?` 
      };
    }
    
    const step = playbookState.steps[nextStep - 1];
    
    return {
      success: true,
      message: `Step ${nextStep} of ${playbookState.totalSteps}: ${step.title}. ${step.instruction}`,
      needsInput: nextStep < playbookState.totalSteps ? {
        prompt: 'Say "next" when ready, or "skip" to end.',
        agentId: this.id,
        context: {
          playbookState: {
            ...playbookState,
            currentStep: nextStep
          }
        }
      } : undefined
    };
  },
  
  // ==================== ACTION METHODS ====================
  
  // Map product IDs to executable app actions
  _productActions: {
    'gsx-create': { type: 'open-gsx-create' },
    'video-editor': { type: 'open-video-editor' },
    'spaces': { type: 'open-spaces' },
    'clipboard-manager': { type: 'open-spaces' },
    'smart-export': { type: 'open-spaces' }, // Smart export is accessed through Spaces
    'idw-hub': null, // IDW is in the menu
    'ai-agents': null, // AI menu
    'budget-manager': { type: 'open-budget' },
    'app-health': { type: 'open-app-health' },
    'voice-assistant': null, // Orb is always visible
    'settings': { type: 'open-settings' },
    // AI Services - direct open
    'chatgpt': { type: 'open-chatgpt' },
    'claude': { type: 'open-claude' },
    'gemini': { type: 'open-gemini' },
    'grok': { type: 'open-grok' },
    'perplexity': { type: 'open-perplexity' },
  },
  
  /**
   * Handle request for actions list
   */
  _handleActionsRequest(task) {
    const lower = task.content.toLowerCase();
    const product = this._findProduct(lower);
    
    if (product && product.actions) {
      return this._listActions(product);
    }
    
    // Ask which feature
    return {
      success: true,
      needsInput: {
        prompt: `Which feature would you like to see actions for? GSX Create, Video Editor, Spaces, Clipboard, Smart Export, IDW Hub, AI Agents, Budget Manager, App Health, Voice Assistant, or Settings?`,
        agentId: this.id,
        context: { 
          pendingState: 'awaiting_product',
          showActions: true
        }
      }
    };
  },
  
  /**
   * List actions for a product
   */
  _listActions(product) {
    if (!product.actions || product.actions.length === 0) {
      return {
        success: true,
        message: `${product.name} is available at: ${product.access}. Would you like a tour instead?`
      };
    }
    
    // List first 5 actions with commands
    const actionList = product.actions.slice(0, 5)
      .map(a => `${a.name}: ${a.command}`)
      .join('. ');
    
    const moreCount = product.actions.length > 5 ? product.actions.length - 5 : 0;
    
    let message = `Actions for ${product.name}: ${actionList}.`;
    if (moreCount > 0) {
      message += ` Plus ${moreCount} more actions. Say "more actions" to hear the rest.`;
    }
    
    return { 
      success: true, 
      message,
      data: { productId: product.id, actions: product.actions }
    };
  },
  
  /**
   * Execute an action - actually opens the feature
   */
  _executeAction(productId) {
    const action = this._productActions[productId];
    if (!action) {
      return null; // No direct action available
    }
    return action;
  },
  
  /**
   * Answer a question about a specific product - enhanced with actions
   */
  async _answerProductQuestion(product, query, task) {
    const lower = query.toLowerCase();
    
    // Track last discussed product for "open" context
    this._lastDiscussedProduct = product.id;
    
    // Track that user explored this feature
    const timestamp = new Date().toISOString().split('T')[0];
    this.memory.appendToSection('Features Explored', `- ${timestamp}: ${product.name}`, 30);
    await this.memory.save();
    
    // Actions request
    if (lower.includes('action') || lower.includes('what can i do') || lower.includes('commands')) {
      return this._listActions(product);
    }
    
    // OPEN REQUEST - Actually open the feature!
    if (lower.includes('open') || lower.includes('launch') || lower.includes('start') || lower.includes('show me')) {
      const action = this._executeAction(product.id);
      if (action) {
        return {
          success: true,
          message: `Opening ${product.name} for you.`,
          data: { 
            productId: product.id,
            action: action  // This triggers the actual window opening
          }
        };
      }
      // No direct action, just explain access
      return this._explainAccess(product);
    }
    
    // How to access (but not open)
    if (lower.includes('access') || lower.includes('where') || lower.includes('find')) {
      return this._explainAccess(product);
    }
    
    // What can it do / features
    if (lower.includes('what') || lower.includes('feature') || lower.includes('can')) {
      return this._explainFeatures(product);
    }
    
    // How to use / tips
    if (lower.includes('tip') || lower.includes('best') || lower.includes('should')) {
      return this._giveTips(product);
    }
    
    // Default: give overview with all options
    const hasActions = product.actions && product.actions.length > 0;
    const actionCount = hasActions ? product.actions.length : 0;
    const canOpen = !!this._productActions[product.id];
    
    return {
      success: true,
      message: `${product.name}: ${product.description}.${canOpen ? ' Say "open" and I\'ll launch it.' : ''} ${product.access}.${hasActions ? ` ${actionCount} actions available.` : ''} Would you like a tour, see the actions, or run a playbook?`,
      data: { productId: product.id }
    };
  },
  
  /**
   * Handle search request
   */
  _handleSearchRequest(task) {
    const lower = task.content.toLowerCase();
    
    // Extract search query
    let searchQuery = '';
    const searchMatch = lower.match(/search\s+(?:for\s+)?(.+)/i);
    if (searchMatch) {
      searchQuery = searchMatch[1].trim();
    }
    
    return {
      success: true,
      message: searchQuery ? `Searching Spaces for "${searchQuery}".` : `Opening Spaces search.`,
      data: {
        action: { 
          type: 'search-spaces',
          query: searchQuery
        }
      }
    };
  }
};

module.exports = appAgent;
