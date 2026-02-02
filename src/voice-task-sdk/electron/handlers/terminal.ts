/**
 * Terminal Handler
 * 
 * Executes shell commands with proper error handling.
 */

import { ipcMain } from 'electron'
import { exec, spawn, type ChildProcess } from 'child_process'
import { promisify } from 'util'
import type { TerminalResult } from '../types'

const execAsync = promisify(exec)

// Track running processes for cancellation
const runningProcesses = new Map<string, ChildProcess>()

/**
 * Execute a terminal command
 */
export async function execCommand(
  command: string, 
  cwd?: string,
  timeout = 30000
): Promise<TerminalResult> {
  try {
    const options: { cwd?: string; timeout: number; maxBuffer: number } = {
      timeout,
      maxBuffer: 10 * 1024 * 1024, // 10MB
    }

    if (cwd) {
      options.cwd = cwd
    }

    const { stdout, stderr } = await execAsync(command, options)

    return {
      success: true,
      stdout: stdout.trim(),
      stderr: stderr.trim() || undefined,
      exitCode: 0,
    }
  } catch (error: unknown) {
    const execError = error as { code?: number; stdout?: string; stderr?: string; message?: string }
    
    return {
      success: false,
      stdout: execError.stdout?.trim(),
      stderr: execError.stderr?.trim(),
      exitCode: execError.code ?? 1,
      error: execError.message || 'Command failed',
    }
  }
}

/**
 * Execute a command with streaming output
 */
export function execStreaming(
  command: string,
  cwd?: string,
  onStdout?: (data: string) => void,
  onStderr?: (data: string) => void,
  onExit?: (code: number | null) => void
): string {
  const id = crypto.randomUUID()
  
  const args = process.platform === 'win32' 
    ? ['/c', command]
    : ['-c', command]
  
  const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'
  
  const child = spawn(shell, args, {
    cwd,
    env: process.env,
  })

  runningProcesses.set(id, child)

  child.stdout?.on('data', (data: Buffer) => {
    onStdout?.(data.toString())
  })

  child.stderr?.on('data', (data: Buffer) => {
    onStderr?.(data.toString())
  })

  child.on('exit', (code) => {
    runningProcesses.delete(id)
    onExit?.(code)
  })

  child.on('error', (err) => {
    runningProcesses.delete(id)
    onStderr?.(err.message)
    onExit?.(1)
  })

  return id
}

/**
 * Cancel a running process
 */
export function cancelProcess(id: string): boolean {
  const process = runningProcesses.get(id)
  if (process) {
    process.kill('SIGTERM')
    runningProcesses.delete(id)
    return true
  }
  return false
}

/**
 * Register IPC handlers for terminal
 */
export function registerTerminalHandlers(): void {
  ipcMain.handle('terminal:exec', async (_event, command: string, cwd?: string) => {
    return execCommand(command, cwd)
  })

  ipcMain.handle('terminal:cancel', async (_event, id: string) => {
    return cancelProcess(id)
  })
}

// ============================================================================
// COMMON TERMINAL HELPERS
// ============================================================================

/**
 * Check if a command exists
 */
export async function commandExists(command: string): Promise<boolean> {
  const checkCommand = process.platform === 'win32' 
    ? `where ${command}` 
    : `which ${command}`
  
  const result = await execCommand(checkCommand)
  return result.success
}

/**
 * Get the current working directory
 */
export async function getCurrentDirectory(): Promise<string | null> {
  const result = await execCommand('pwd')
  return result.success ? result.stdout ?? null : null
}

/**
 * Get environment variable
 */
export async function getEnvVar(name: string): Promise<string | null> {
  const command = process.platform === 'win32' 
    ? `echo %${name}%` 
    : `echo $${name}`
  
  const result = await execCommand(command)
  return result.success ? result.stdout ?? null : null
}
