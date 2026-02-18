#!/usr/bin/env node

/**
 * Script to run IDW automated tests
 * Usage: node test/run-idw-tests.js
 */

const { app, BrowserWindow } = require('electron');
const path = require('path');

let testWindow;

app.whenReady().then(() => {
  console.log('Running IDW automated tests...\n');

  // Create test runner window
  testWindow = new BrowserWindow({
    width: 1200,
    height: 900,
    show: false, // Run headless
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '..', 'preload.js'),
    },
  });

  // Load test runner
  testWindow.loadFile('test-runner.html');

  // When loaded, run IDW tests
  testWindow.webContents.once('did-finish-load', () => {
    console.log('Test runner loaded, executing IDW tests...\n');

    // Execute IDW tests via console
    testWindow.webContents
      .executeJavaScript(
        `
            (async () => {
                // Get test runner instance
                const runner = window.testRunner;
                if (!runner) {
                    console.error('Test runner not initialized');
                    return;
                }
                
                // Run IDW tests in sequence
                const idwTests = [
                    'get-idw-list',
                    'add-idw',
                    'edit-idw',
                    'remove-idw',
                    'idw-navigation',
                    'idw-gsx-links'
                ];
                
                console.log('Running ${idwTests.length} IDW tests...\\n');
                
                for (const testId of idwTests) {
                    console.log('\\n--- Running test: ' + testId + ' ---');
                    try {
                        await runner.runSingleTest(testId);
                        // Wait a bit between tests
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    } catch (error) {
                        console.error('Test failed:', error);
                    }
                }
                
                // Get results summary
                const results = runner.results;
                const passed = results.filter(r => r.status === 'passed').length;
                const failed = results.filter(r => r.status === 'failed').length;
                
                console.log('\\n=== Test Results ===');
                console.log('Total: ' + results.length);
                console.log('Passed: ' + passed);
                console.log('Failed: ' + failed);
                
                // Return results for process exit code
                return { passed, failed };
            })();
        `
      )
      .then((results) => {
        console.log('\nTests completed!');

        // Exit with appropriate code
        const exitCode = results.failed > 0 ? 1 : 0;

        setTimeout(() => {
          app.quit();
          process.exit(exitCode);
        }, 2000);
      })
      .catch((error) => {
        console.error('Error running tests:', error);
        app.quit();
        process.exit(1);
      });
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
