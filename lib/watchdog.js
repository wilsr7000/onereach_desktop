/**
 * External Watchdog Process
 *
 * Spawned as a detached child process from main.js. Monitors the health
 * endpoint and restarts the app if the main process becomes unresponsive.
 *
 * Usage (from main.js):
 *   const { fork } = require('child_process');
 *   const wd = fork(path.join(__dirname, 'lib/watchdog.js'),
 *     [String(process.pid), '47292', app.getPath('userData')],
 *     { detached: true, stdio: 'ignore' });
 *   wd.unref();
 *
 * Arguments:
 *   argv[2] = parent PID to monitor
 *   argv[3] = health endpoint port (default 47292)
 *   argv[4] = userData path for crash-recovery.json
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PARENT_PID = parseInt(process.argv[2], 10);
const PORT = parseInt(process.argv[3], 10) || 47292;
const USER_DATA = process.argv[4] || '';
const PING_INTERVAL_MS = 15000;
const PING_TIMEOUT_MS = 5000;
const MAX_FAILURES = 3;
const STARTUP_GRACE_MS = 30000;

let consecutiveFailures = 0;
let lastHealthResponse = null;
let started = Date.now();

function isParentAlive() {
  try {
    process.kill(PARENT_PID, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function pingHealth() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${PORT}/health`, { timeout: PING_TIMEOUT_MS }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          lastHealthResponse = JSON.parse(body);
          resolve(true);
        } catch (_) {
          resolve(true);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function writeCrashRecovery(reason) {
  if (!USER_DATA) return;
  try {
    const data = {
      reason,
      timestamp: new Date().toISOString(),
      pid: PARENT_PID,
      consecutiveFailures,
      lastHealthResponse,
      watchdogUptime: Math.round((Date.now() - started) / 1000),
    };
    fs.writeFileSync(path.join(USER_DATA, 'crash-recovery.json'), JSON.stringify(data, null, 2));
  } catch (_) {
    // Best effort
  }
}

function killAndRelaunch() {
  writeCrashRecovery(`Main process unresponsive for ${MAX_FAILURES * PING_INTERVAL_MS / 1000}s`);

  try {
    process.kill(PARENT_PID, 'SIGTERM');
  } catch (_) { /* already dead */ }

  setTimeout(() => {
    try {
      process.kill(PARENT_PID, 'SIGKILL');
    } catch (_) { /* already dead */ }
  }, 3000);

  setTimeout(() => {
    try {
      const { execFile, exec } = require('child_process');
      const appPath = path.resolve(__dirname, '..');
      const devElectron = path.join(appPath, 'node_modules', '.bin', 'electron');

      if (fs.existsSync(devElectron)) {
        execFile(devElectron, [appPath], { detached: true, stdio: 'ignore' });
      } else if (process.platform === 'darwin') {
        // Packaged macOS app -- relaunch via open command
        const appBundle = appPath.match(/^(.*?\.app)\//);
        if (appBundle) {
          exec(`open -n "${appBundle[1]}"`, { detached: true });
        }
      }
    } catch (_) {
      // Could not relaunch -- crash-recovery.json persists for next manual start
    }
    process.exit(0);
  }, 5000);
}

async function check() {
  if (!isParentAlive()) {
    process.exit(0);
  }

  // Grace period during startup
  if (Date.now() - started < STARTUP_GRACE_MS) {
    return;
  }

  const ok = await pingHealth();
  if (ok) {
    consecutiveFailures = 0;
  } else {
    consecutiveFailures++;
    if (consecutiveFailures >= MAX_FAILURES) {
      killAndRelaunch();
    }
  }
}

const timer = setInterval(check, PING_INTERVAL_MS);
timer.unref();

// Exit cleanly if parent sends a message
process.on('message', (msg) => {
  if (msg === 'shutdown') {
    clearInterval(timer);
    process.exit(0);
  }
});

process.on('disconnect', () => {
  // Parent closed the IPC channel -- check if parent is still alive
  if (!isParentAlive()) {
    clearInterval(timer);
    process.exit(0);
  }
});
