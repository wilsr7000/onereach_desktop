/**
 * Aider Bridge TypeScript Types
 * Defines all interfaces for the Aider integration
 */

/**
 * Configuration for initializing Aider
 */
export interface AiderConfig {
  /** Path to the repository to work with */
  repoPath: string;
  
  /** AI model to use (e.g., 'gpt-4', 'claude-3-opus-20240229') */
  model?: string;
  
  /** Command to run tests (e.g., 'npm test', 'pytest') */
  testCmd?: string;
  
  /** Command to run linter (e.g., 'npm run lint', 'flake8') */
  lintCmd?: string;
  
  /** Path to Python executable (defaults to 'python3') */
  pythonPath?: string;
  
  /** Path to the aider_bridge server.py script */
  serverPath?: string;
  
  /** Timeout for RPC calls in milliseconds */
  timeout?: number;
  
  /** Whether to auto-restart on crash */
  autoRestart?: boolean;
  
  /** Maximum restart attempts */
  maxRestarts?: number;
  
  /** Environment variables to pass to Python process */
  env?: Record<string, string>;
}

/**
 * Represents a change made to a file
 */
export interface FileChange {
  /** Relative path to the file */
  path: string;
  
  /** Type of change */
  status: 'created' | 'modified' | 'deleted';
  
  /** Unified diff of the changes (if available) */
  diff?: string;
  
  /** Number of lines added */
  linesAdded?: number;
  
  /** Number of lines removed */
  linesRemoved?: number;
}

/**
 * Result of running a prompt through Aider
 */
export interface RunResult {
  /** Whether the operation succeeded */
  success: boolean;
  
  /** The AI's response text */
  response: string;
  
  /** Files that were modified */
  fileChanges: FileChange[];
  
  /** Files currently in context */
  filesInContext: string[];
  
  /** Test results if auto-test was enabled */
  testResults?: TestResult;
  
  /** Lint results if auto-lint was enabled */
  lintResults?: LintResult;
  
  /** Error message if success is false */
  error?: string;
  
  /** Token usage statistics */
  usage?: TokenUsage;
}

/**
 * Test execution results
 */
export interface TestResult {
  /** Whether tests passed */
  passed: boolean;
  
  /** Number of tests run */
  testsRun: number;
  
  /** Number of tests passed */
  testsPassed: number;
  
  /** Number of tests failed */
  testsFailed: number;
  
  /** Raw test output */
  output: string;
  
  /** Execution time in seconds */
  duration: number;
}

/**
 * Lint execution results
 */
export interface LintResult {
  /** Whether lint passed (no errors) */
  passed: boolean;
  
  /** Number of errors found */
  errorCount: number;
  
  /** Number of warnings found */
  warningCount: number;
  
  /** Individual lint issues */
  issues: LintIssue[];
  
  /** Raw lint output */
  output: string;
}

/**
 * Individual lint issue
 */
export interface LintIssue {
  /** File path */
  file: string;
  
  /** Line number */
  line: number;
  
  /** Column number */
  column?: number;
  
  /** Severity level */
  severity: 'error' | 'warning' | 'info';
  
  /** Issue message */
  message: string;
  
  /** Rule ID if available */
  rule?: string;
}

/**
 * Token usage statistics
 */
export interface TokenUsage {
  /** Tokens in the prompt */
  promptTokens: number;
  
  /** Tokens in the completion */
  completionTokens: number;
  
  /** Total tokens used */
  totalTokens: number;
  
  /** Estimated cost in USD */
  estimatedCost?: number;
}

/**
 * Entry in the repository map
 */
export interface RepoMapEntry {
  /** File path relative to repo root */
  path: string;
  
  /** File type/language */
  language?: string;
  
  /** Symbols defined in the file */
  symbols: RepoSymbol[];
  
  /** Number of lines in the file */
  lineCount?: number;
  
  /** Whether file is in current context */
  inContext: boolean;
}

/**
 * Symbol in a repository file
 */
export interface RepoSymbol {
  /** Symbol name */
  name: string;
  
  /** Symbol type */
  type: 'class' | 'function' | 'method' | 'variable' | 'constant' | 'interface' | 'type' | 'other';
  
  /** Line number where symbol is defined */
  line: number;
  
  /** End line (for multi-line definitions) */
  endLine?: number;
  
  /** Parent symbol (for methods in classes) */
  parent?: string;
  
  /** Symbol signature/parameters */
  signature?: string;
}

/**
 * JSON-RPC 2.0 Request
 */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown> | unknown[];
}

/**
 * JSON-RPC 2.0 Response
 */
export interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: T;
  error?: JsonRpcError;
}

/**
 * JSON-RPC 2.0 Error
 */
export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * JSON-RPC 2.0 Notification (no id, no response expected)
 */
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown> | unknown[];
}

/**
 * Events emitted by AiderClient
 */
export interface AiderEvents {
  /** Emitted when connection is established */
  ready: void;
  
  /** Emitted on streaming content */
  stream: string;
  
  /** Emitted when a file is modified */
  fileChanged: FileChange;
  
  /** Emitted on error */
  error: Error;
  
  /** Emitted when process exits */
  exit: { code: number | null; signal: string | null };
  
  /** Emitted when process restarts */
  restart: { attempt: number; maxAttempts: number };
  
  /** Emitted on status change */
  status: AiderStatus;
}

/**
 * Aider client status
 */
export type AiderStatus = 
  | 'disconnected'
  | 'starting'
  | 'ready'
  | 'busy'
  | 'error'
  | 'restarting'
  | 'shutdown';

/**
 * Initialize result from server
 */
export interface InitializeResult {
  success: boolean;
  repo_path?: string;
  model?: string;
  files_in_context?: string[];
  error?: string;
}

/**
 * Add/Remove files result
 */
export interface FilesResult {
  success: boolean;
  files_added?: string[];
  files_removed?: string[];
  files_in_context?: string[];
  error?: string;
}

/**
 * Prompt result from server
 */
export interface PromptResult {
  success: boolean;
  response?: string;
  modified_files?: string[];
  files_in_context?: string[];
  error?: string;
}

/**
 * Repo map result from server
 */
export interface RepoMapResult {
  success: boolean;
  repo_map?: string;
  files?: string[];
  error?: string;
}

/**
 * Ping/pong health check result
 */
export interface PingResult {
  success: boolean;
  pong: boolean;
  timestamp: number;
  initialized: boolean;
  aider_available: boolean;
  pid: number;
  files_in_context: number;
}

/**
 * Installation check result
 */
export interface InstallationCheckResult {
  success: boolean;
  aider_installed: boolean;
  aider_version: string | null;
  python_version: string;
  python_executable: string;
  missing_packages: string[];
  error: string | null;
  install_instructions: {
    pip: string;
    pip3: string;
    pipx: string;
    note: string;
  } | null;
  api_keys: {
    openai: boolean;
    anthropic: boolean;
    azure: boolean;
  };
  warning?: string;
}

/**
 * Stream notification from server
 */
export interface StreamNotification {
  type: 'start' | 'token' | 'complete' | 'error';
  content: string;
  timestamp: number;
}

