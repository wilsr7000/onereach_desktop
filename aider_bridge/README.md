# Aider Bridge - AI Pair Programming Integration

Integrates [Aider](https://aider.chat/) into the Onereach.ai Electron app as a modular Python sidecar.

## Architecture

```
┌─────────────────────┐         JSON-RPC over stdio         ┌──────────────────┐
│                     │ <──────────────────────────────────> │                  │
│  Electron (Node.js) │                                      │  Python Sidecar  │
│                     │         (TypeScript Client)          │  (Aider Wrapper) │
│  aider-bridge-      │                                      │  server.py       │
│  client.ts          │                                      │                  │
└─────────────────────┘                                      └──────────────────┘
```

## Setup

### 1. Install Python Dependencies

```bash
cd aider_bridge
pip install -r requirements.txt
```

### 2. Configure API Keys

Aider needs API keys for AI models. Set environment variables:

```bash
# For OpenAI (GPT-4)
export OPENAI_API_KEY=your-key-here

# For Anthropic (Claude)
export ANTHROPIC_API_KEY=your-key-here
```

## Usage

### From Electron/TypeScript

```typescript
import { AiderBridgeClient } from './aider-bridge-client';

// Create client instance
const aider = new AiderBridgeClient();

// Start the Python sidecar
await aider.start();

// Initialize with a repository
const result = await aider.initialize('/path/to/repo', 'gpt-4');
console.log('Initialized:', result);

// Add files to context
await aider.addFiles(['src/index.ts', 'src/utils.ts']);

// Run a prompt
const response = await aider.runPrompt('Add error handling to the login function');
console.log('Response:', response.response);
console.log('Modified files:', response.modified_files);

// Listen for notifications
aider.on('notification', (notif) => {
  console.log('Notification:', notif);
});

// Cleanup
await aider.shutdown();
```

### Available Methods

#### `initialize(repoPath: string, modelName?: string)`
Initialize Aider with a git repository and AI model.

**Parameters:**
- `repoPath` - Path to git repository
- `modelName` - Model name (default: 'gpt-4')
  - OpenAI: `gpt-4`, `gpt-4-turbo`, `gpt-3.5-turbo`
  - Anthropic: `claude-3-opus`, `claude-3-sonnet`

**Returns:** `{ success, repo_path, model, files_in_context }`

#### `runPrompt(message: string)`
Send a coding instruction to Aider.

**Parameters:**
- `message` - Natural language instruction

**Returns:** `{ success, response, modified_files, files_in_context }`

#### `addFiles(filePaths: string[])`
Add files to Aider's context window.

**Returns:** `{ success, files_added, files_in_context }`

#### `removeFiles(filePaths: string[])`
Remove files from context.

**Returns:** `{ success, files_removed, files_in_context }`

#### `getRepoMap()`
Get a structural map of the repository.

**Returns:** `{ success, repo_map, files_in_context }`

#### `setTestCmd(command: string)`
Configure automatic testing after changes.

**Example:** `await aider.setTestCmd('npm test')`

#### `setLintCmd(command: string)`
Configure automatic linting.

**Example:** `await aider.setLintCmd('npm run lint')`

#### `shutdown()`
Clean shutdown of the Python sidecar.

## Events

The client emits these events:

- `notification` - Warnings or info from Aider
- `error` - Errors from the Python process
- `exit` - When the Python process exits

```typescript
aider.on('notification', (notif) => {
  console.log(`[${notif.params.level}]`, notif.params.message);
});

aider.on('error', (error) => {
  console.error('Aider error:', error);
});

aider.on('exit', (code) => {
  console.log('Aider exited with code:', code);
});
```

## Error Handling

All methods return objects with `success` boolean. Check before using results:

```typescript
const result = await aider.runPrompt('Fix the bug');

if (!result.success) {
  console.error('Error:', result.error);
  return;
}

console.log('Success:', result.response);
```

## Architecture Notes

### Why Python Sidecar?

1. **Aider is Python-native** - Best to use its native API
2. **Process isolation** - Electron stays responsive
3. **Easy to swap** - Can replace with different AI backend
4. **Security** - No direct file system access from renderer

### Why JSON-RPC over stdio?

1. **Simple** - No network ports, firewalls, or security concerns
2. **Reliable** - Standard stdin/stdout is battle-tested
3. **Cross-platform** - Works identically on macOS, Linux, Windows
4. **Fast** - No network latency

### Swapping the AI Backend

The architecture is designed to be modular. To swap Aider for another AI tool:

1. Keep the `AiderBridgeClient` interface unchanged
2. Replace `aider_bridge/server.py` implementation
3. Update `requirements.txt` with new dependencies
4. Electron code remains untouched!

## Development

### Testing the Python Server Directly

```bash
cd aider_bridge
python3 server.py
```

Then send JSON-RPC requests via stdin:

```json
{"jsonrpc":"2.0","method":"initialize","params":{"repo_path":"/path/to/repo","model_name":"gpt-4"},"id":1}
```

### Debugging

Enable verbose logging:

```typescript
aider.on('notification', console.log);
```

Python server logs go to stderr, visible in Electron console.

## Integration with Onereach.ai

The Aider Bridge will be integrated into:

1. **Code Generation UI** - Generate components from prompts
2. **Bug Fixing Assistant** - Analyze and fix issues
3. **Refactoring Tool** - Modernize and improve code
4. **Documentation Generator** - Auto-generate docs

## Security Considerations

- API keys stored in environment, never in code
- Python process runs with same permissions as Electron
- No remote code execution - only local file edits
- Git commits created for all changes (rollback possible)

## Performance

- Sidecar starts in < 1 second
- First AI request: 2-10 seconds (model load)
- Subsequent requests: 1-5 seconds (depending on complexity)
- Memory: ~200MB for Python + model cache

## Troubleshooting

**"Aider not installed"**
```bash
pip install aider-chat
```

**"API key not found"**
Set environment variables before starting Electron.

**"Timeout waiting for Aider Bridge"**
Check that Python 3.8+ is installed: `python3 --version`

**"Process exited with code 1"**
Check stderr in Electron console for Python errors.

