"use strict";
/**
 * Aider Bridge Client - TypeScript/Electron side
 * Communicates with Python sidecar via JSON-RPC over stdio
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AiderBridgeClient = void 0;
const child_process_1 = require("child_process");
const events_1 = require("events");
const path = require("path");
class AiderBridgeClient extends events_1.EventEmitter {
    constructor(pythonPath = 'python3') {
        super();
        this.pythonPath = pythonPath;
        this.process = null;
        this.requestId = 0;
        this.pendingRequests = new Map();
        this.buffer = '';
    }
    /**
     * Start the Python sidecar process
     */
    async start() {
        return new Promise((resolve, reject) => {
            const scriptPath = path.join(__dirname, '../aider_bridge/server.py');
            // Spawn Python process
            this.process = (0, child_process_1.spawn)(this.pythonPath, [scriptPath], {
                stdio: ['pipe', 'pipe', 'pipe']
            });
            if (!this.process.stdout || !this.process.stdin || !this.process.stderr) {
                reject(new Error('Failed to create process stdio'));
                return;
            }
            // Handle stdout (responses)
            this.process.stdout.on('data', (data) => {
                this.handleData(data.toString());
            });
            // Handle stderr (logs)
            this.process.stderr.on('data', (data) => {
                console.error('[Aider Bridge stderr]:', data.toString());
                this.emit('error', new Error(data.toString()));
            });
            // Handle process exit
            this.process.on('exit', (code) => {
                console.log(`[Aider Bridge] Process exited with code ${code}`);
                this.emit('exit', code);
            });
            // Handle errors
            this.process.on('error', (error) => {
                console.error('[Aider Bridge] Process error:', error);
                this.emit('error', error);
                reject(error);
            });
            // Wait for ready signal
            const readyHandler = (notification) => {
                if (notification.method === 'ready') {
                    this.removeListener('notification', readyHandler);
                    resolve();
                }
            };
            this.on('notification', readyHandler);
            // Timeout after 10 seconds
            setTimeout(() => {
                this.removeListener('notification', readyHandler);
                reject(new Error('Timeout waiting for Aider Bridge to start'));
            }, 10000);
        });
    }
    /**
     * Handle incoming data from Python process
     */
    handleData(data) {
        this.buffer += data;
        // Process complete lines
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() || ''; // Keep incomplete line in buffer
        for (const line of lines) {
            if (!line.trim())
                continue;
            try {
                const message = JSON.parse(line);
                // Handle notification
                if ('method' in message && !('id' in message)) {
                    this.emit('notification', message);
                    continue;
                }
                // Handle response
                const response = message;
                const pending = this.pendingRequests.get(response.id);
                if (pending) {
                    this.pendingRequests.delete(response.id);
                    if (response.error) {
                        pending.reject(new Error(response.error.message));
                    }
                    else {
                        pending.resolve(response.result);
                    }
                }
            }
            catch (error) {
                console.error('[Aider Bridge] Failed to parse message:', line, error);
            }
        }
    }
    /**
     * Send a JSON-RPC request to Python process
     */
    async sendRequest(method, params) {
        if (!this.process || !this.process.stdin) {
            throw new Error('Aider Bridge not started');
        }
        const id = ++this.requestId;
        const request = {
            jsonrpc: '2.0',
            method,
            params,
            id
        };
        return new Promise((resolve, reject) => {
            this.pendingRequests.set(id, { resolve, reject });
            // Send request
            this.process.stdin.write(JSON.stringify(request) + '\n');
            // Timeout after 60 seconds
            setTimeout(() => {
                if (this.pendingRequests.has(id)) {
                    this.pendingRequests.delete(id);
                    reject(new Error(`Request timeout: ${method}`));
                }
            }, 60000);
        });
    }
    /**
     * Initialize Aider with a repository
     */
    async initialize(repoPath, modelName = 'gpt-4') {
        return this.sendRequest('initialize', { repo_path: repoPath, model_name: modelName });
    }
    /**
     * Run a prompt through Aider
     */
    async runPrompt(message) {
        return this.sendRequest('run_prompt', { message });
    }
    /**
     * Add files to Aider's context
     */
    async addFiles(filePaths) {
        return this.sendRequest('add_files', { file_paths: filePaths });
    }
    /**
     * Remove files from Aider's context
     */
    async removeFiles(filePaths) {
        return this.sendRequest('remove_files', { file_paths: filePaths });
    }
    /**
     * Get the repository map
     */
    async getRepoMap() {
        return this.sendRequest('get_repo_map');
    }
    /**
     * Set auto-test command
     */
    async setTestCmd(command) {
        return this.sendRequest('set_test_cmd', { command });
    }
    /**
     * Set auto-lint command
     */
    async setLintCmd(command) {
        return this.sendRequest('set_lint_cmd', { command });
    }
    /**
     * Shutdown the Aider bridge
     */
    async shutdown() {
        if (!this.process)
            return;
        try {
            await this.sendRequest('shutdown');
        }
        catch (error) {
            console.error('[Aider Bridge] Error during shutdown:', error);
        }
        // Send exit signal
        if (this.process.stdin) {
            this.process.stdin.write('__EXIT__\n');
        }
        // Kill process if still running after 2 seconds
        setTimeout(() => {
            if (this.process && !this.process.killed) {
                this.process.kill();
            }
        }, 2000);
    }
    /**
     * Check if the process is running
     */
    isRunning() {
        return this.process !== null && !this.process.killed;
    }
}
exports.AiderBridgeClient = AiderBridgeClient;
