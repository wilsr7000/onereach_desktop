/**
 * Dependency Manager - Handles checking and installing dependencies
 * Similar to how Cursor handles dependency installation via terminal
 */

const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const EventEmitter = require('events');

class DependencyManager extends EventEmitter {
  constructor() {
    super();
    this.platform = process.platform; // 'darwin', 'win32', 'linux'
    this.homeDir = os.homedir();
    this.installProcesses = new Map(); // Track running install processes
  }

  /**
   * Get platform-specific shell
   */
  getShell() {
    if (this.platform === 'win32') {
      return { shell: 'powershell.exe', shellArgs: ['-Command'] };
    }
    return { shell: '/bin/bash', shellArgs: ['-c'] };
  }

  /**
   * Execute a command and return output
   */
  execCommand(command, options = {}) {
    try {
      const result = execSync(command, {
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 30000,
        ...options,
      });
      return { success: true, output: result.trim() };
    } catch (error) {
      return { success: false, error: error.message, output: error.stdout || '' };
    }
  }

  /**
   * Check if Python 3 is installed
   */
  checkPython() {
    const result = {
      name: 'python3',
      displayName: 'Python 3',
      installed: false,
      version: null,
      path: null,
      required: true,
    };

    // Try various Python commands
    const pythonCommands = this.platform === 'win32' ? ['python', 'python3', 'py -3'] : ['python3', 'python'];

    for (const cmd of pythonCommands) {
      const check = this.execCommand(`${cmd} --version`);
      if (check.success && check.output.includes('Python 3')) {
        result.installed = true;
        result.version = check.output.replace('Python ', '').trim();

        // Get the path
        const whichCmd = this.platform === 'win32' ? 'where' : 'which';
        const pathCheck = this.execCommand(`${whichCmd} ${cmd.split(' ')[0]}`);
        if (pathCheck.success) {
          result.path = pathCheck.output.split('\n')[0].trim();
        }
        break;
      }
    }

    return result;
  }

  /**
   * Check if Homebrew is installed (macOS only)
   */
  checkHomebrew() {
    if (this.platform !== 'darwin') {
      return { name: 'homebrew', installed: false, notApplicable: true };
    }

    const result = {
      name: 'homebrew',
      displayName: 'Homebrew',
      installed: false,
      version: null,
      path: null,
      required: false, // Only required if we need to install Python
    };

    const check = this.execCommand('brew --version');
    if (check.success) {
      result.installed = true;
      result.version = check.output.split('\n')[0].replace('Homebrew ', '').trim();

      const pathCheck = this.execCommand('which brew');
      if (pathCheck.success) {
        result.path = pathCheck.output.trim();
      }
    }

    return result;
  }

  /**
   * Check if pipx is installed
   */
  checkPipx() {
    const result = {
      name: 'pipx',
      displayName: 'pipx',
      installed: false,
      version: null,
      path: null,
      required: true,
    };

    const check = this.execCommand('pipx --version');
    if (check.success) {
      result.installed = true;
      result.version = check.output.trim();

      const whichCmd = this.platform === 'win32' ? 'where' : 'which';
      const pathCheck = this.execCommand(`${whichCmd} pipx`);
      if (pathCheck.success) {
        result.path = pathCheck.output.split('\n')[0].trim();
      }
    }

    return result;
  }

  /**
   * Check if aider-chat is installed
   */
  checkAider() {
    const result = {
      name: 'aider-chat',
      displayName: 'Aider Chat',
      installed: false,
      version: null,
      path: null,
      required: true,
    };

    // Check pipx list first
    const pipxCheck = this.execCommand('pipx list');
    if (pipxCheck.success && pipxCheck.output.includes('aider-chat')) {
      result.installed = true;

      // Try to get version
      const versionMatch = pipxCheck.output.match(/aider-chat\s+([\d.]+)/);
      if (versionMatch) {
        result.version = versionMatch[1];
      }
    }

    // Also check the expected path
    const aiderPythonPath = path.join(
      this.homeDir,
      '.local',
      'pipx',
      'venvs',
      'aider-chat',
      'bin',
      this.platform === 'win32' ? 'python.exe' : 'python'
    );

    if (fs.existsSync(aiderPythonPath)) {
      result.installed = true;
      result.path = aiderPythonPath;
    }

    // Check if aider command is available
    if (!result.installed) {
      const whichCmd = this.platform === 'win32' ? 'where' : 'which';
      const aiderCheck = this.execCommand(`${whichCmd} aider`);
      if (aiderCheck.success) {
        result.installed = true;
        result.path = aiderCheck.output.split('\n')[0].trim();
      }
    }

    return result;
  }

  /**
   * Check all dependencies
   */
  checkAllDependencies() {
    const python = this.checkPython();
    const homebrew = this.checkHomebrew();
    const pipx = this.checkPipx();
    const aider = this.checkAider();

    const dependencies = [python, pipx, aider];

    // Only include homebrew on macOS if Python is missing
    if (this.platform === 'darwin' && !python.installed) {
      dependencies.splice(1, 0, homebrew);
    }

    const allInstalled = dependencies.filter((d) => d.required).every((d) => d.installed);
    const missing = dependencies.filter((d) => d.required && !d.installed);

    return {
      allInstalled,
      missing,
      dependencies,
      platform: this.platform,
    };
  }

  /**
   * Get the install command for a dependency
   */
  getInstallCommand(depName) {
    const commands = {
      python3: {
        darwin: 'brew install python3',
        win32: 'winget install Python.Python.3.12 --accept-source-agreements --accept-package-agreements',
        linux: 'sudo apt-get update && sudo apt-get install -y python3 python3-pip',
      },
      homebrew: {
        darwin: '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
        win32: null,
        linux: null,
      },
      pipx: {
        darwin: 'python3 -m pip install --user pipx && python3 -m pipx ensurepath',
        win32: 'python -m pip install --user pipx && python -m pipx ensurepath',
        linux: 'python3 -m pip install --user pipx && python3 -m pipx ensurepath',
      },
      'aider-chat': {
        darwin: 'pipx install aider-chat',
        win32: 'pipx install aider-chat',
        linux: 'pipx install aider-chat',
      },
    };

    const platformCommands = commands[depName];
    if (!platformCommands) {
      return null;
    }

    return platformCommands[this.platform] || null;
  }

  /**
   * Install a dependency with streaming output
   * Returns a promise that resolves when installation completes
   */
  installDependency(depName, outputCallback) {
    return new Promise((resolve, reject) => {
      const command = this.getInstallCommand(depName);

      if (!command) {
        reject(new Error(`No install command for ${depName} on ${this.platform}`));
        return;
      }

      console.log(`[DependencyManager] Installing ${depName}: ${command}`);

      if (outputCallback) {
        outputCallback({ type: 'start', message: `Installing ${depName}...`, command });
      }

      const { shell, shellArgs } = this.getShell();

      // For pipx ensurepath, we need to handle it specially
      const fullCommand = command;

      const proc = spawn(shell, [...shellArgs, fullCommand], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PATH: this.getEnhancedPath() },
      });

      this.installProcesses.set(depName, proc);

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        const text = data.toString();
        stdout += text;
        if (outputCallback) {
          outputCallback({ type: 'stdout', data: text });
        }
        this.emit('install-output', { depName, type: 'stdout', data: text });
      });

      proc.stderr.on('data', (data) => {
        const text = data.toString();
        stderr += text;
        if (outputCallback) {
          outputCallback({ type: 'stderr', data: text });
        }
        this.emit('install-output', { depName, type: 'stderr', data: text });
      });

      proc.on('close', (code) => {
        this.installProcesses.delete(depName);

        if (code === 0) {
          if (outputCallback) {
            outputCallback({ type: 'success', message: `${depName} installed successfully!` });
          }
          this.emit('install-complete', { depName, success: true });
          resolve({ success: true, output: stdout });
        } else {
          const error = `Installation failed with code ${code}`;
          if (outputCallback) {
            outputCallback({ type: 'error', message: error, stderr });
          }
          this.emit('install-complete', { depName, success: false, error });
          reject(new Error(`${error}\n${stderr}`));
        }
      });

      proc.on('error', (error) => {
        this.installProcesses.delete(depName);
        if (outputCallback) {
          outputCallback({ type: 'error', message: error.message });
        }
        this.emit('install-complete', { depName, success: false, error: error.message });
        reject(error);
      });
    });
  }

  /**
   * Get enhanced PATH including common install locations
   */
  getEnhancedPath() {
    const currentPath = process.env.PATH || '';
    const additionalPaths = [];

    if (this.platform === 'darwin' || this.platform === 'linux') {
      additionalPaths.push(path.join(this.homeDir, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin');
    } else if (this.platform === 'win32') {
      additionalPaths.push(
        path.join(this.homeDir, 'AppData', 'Local', 'Programs', 'Python', 'Python312'),
        path.join(this.homeDir, 'AppData', 'Local', 'Programs', 'Python', 'Python311'),
        path.join(this.homeDir, '.local', 'bin')
      );
    }

    return [...additionalPaths, currentPath].join(path.delimiter);
  }

  /**
   * Install all missing dependencies in order
   */
  async installAllMissing(outputCallback) {
    const status = this.checkAllDependencies();
    const results = [];

    for (const dep of status.missing) {
      try {
        if (outputCallback) {
          outputCallback({ type: 'info', message: `\n--- Installing ${dep.displayName} ---\n` });
        }

        const result = await this.installDependency(dep.name, outputCallback);
        results.push({ name: dep.name, success: true, ...result });

        // Re-check to update paths
        await this.refreshPath();
      } catch (error) {
        results.push({ name: dep.name, success: false, error: error.message });

        // If a required dependency fails, we might need to stop
        if (dep.required && dep.name !== 'homebrew') {
          if (outputCallback) {
            outputCallback({
              type: 'error',
              message: `Failed to install ${dep.displayName}. Cannot continue.`,
            });
          }
          break;
        }
      }
    }

    // Final status check
    const finalStatus = this.checkAllDependencies();

    return {
      results,
      finalStatus,
      allSuccessful: finalStatus.allInstalled,
    };
  }

  /**
   * Refresh PATH by re-sourcing shell config
   */
  async refreshPath() {
    // This helps pick up new PATH entries after pipx ensurepath
    if (this.platform !== 'win32') {
      const shellConfig = path.join(this.homeDir, '.zshrc');
      if (fs.existsSync(shellConfig)) {
        try {
          this.execCommand(`source ${shellConfig}`);
        } catch (_e) {
          // Ignore errors from sourcing
        }
      }
    }
  }

  /**
   * Cancel an ongoing installation
   */
  cancelInstall(depName) {
    const proc = this.installProcesses.get(depName);
    if (proc) {
      proc.kill('SIGTERM');
      this.installProcesses.delete(depName);
      return true;
    }
    return false;
  }

  /**
   * Get the Python path for aider (used by BranchAiderManager)
   */
  getAiderPythonPath() {
    const aider = this.checkAider();

    if (aider.path) {
      return aider.path;
    }

    // Check common locations
    const possiblePaths = [
      path.join(this.homeDir, '.local', 'pipx', 'venvs', 'aider-chat', 'bin', 'python3'),
      path.join(this.homeDir, '.local', 'pipx', 'venvs', 'aider-chat', 'bin', 'python'),
    ];

    if (this.platform === 'win32') {
      possiblePaths.push(path.join(this.homeDir, '.local', 'pipx', 'venvs', 'aider-chat', 'Scripts', 'python.exe'));
    }

    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }

    // Fall back to system Python
    const python = this.checkPython();
    return python.path || 'python3';
  }
}

// Singleton instance
let dependencyManagerInstance = null;

function getDependencyManager() {
  if (!dependencyManagerInstance) {
    dependencyManagerInstance = new DependencyManager();
  }
  return dependencyManagerInstance;
}

module.exports = { DependencyManager, getDependencyManager };
