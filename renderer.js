// This file is loaded by index.html and will
// be executed in the renderer process for that window.
// All of the Node.js APIs are available in this process.

document.addEventListener('DOMContentLoaded', () => {
  // Get UI elements
  const startButton = document.getElementById('start-btn');
  const openTestButton = document.getElementById('open-test-btn');

  // Add event listeners
  if (startButton) {
    startButton.addEventListener('click', () => {
      console.log('Get Started button clicked');
      // Example of using the exposed IPC API
      window.api.send('user-action', {
        action: 'start-app',
        timestamp: new Date().toISOString(),
      });
    });
  }

  // Add event listener for the test button
  if (openTestButton) {
    openTestButton.addEventListener('click', () => {
      console.log('Open Test Window button clicked');
      window.api.send('user-action', {
        action: 'open-data-tests',
        timestamp: new Date().toISOString(),
      });
    });
  }

  // Add CSP Test button to dev controls if it exists
  const devControls = document.getElementById('dev-controls');
  if (devControls) {
    const cspTestButton = document.createElement('button');
    cspTestButton.id = 'open-csp-test-btn';
    cspTestButton.textContent = 'Test CSP Settings';
    cspTestButton.style.marginLeft = '10px';

    cspTestButton.addEventListener('click', () => {
      console.log('Open CSP Test button clicked');
      window.api.send('user-action', {
        action: 'open-csp-test',
        timestamp: new Date().toISOString(),
      });
    });

    devControls.appendChild(cspTestButton);

    // Add Test IDW Load button
    const testIDWButton = document.createElement('button');
    testIDWButton.id = 'test-idw-load-btn';
    testIDWButton.textContent = 'Test IDW Load';
    testIDWButton.style.marginLeft = '10px';
    testIDWButton.style.background = '#ff9900';

    testIDWButton.addEventListener('click', () => {
      console.log('Test IDW Load button clicked');
      window.api.send('test-idw-load');
    });

    devControls.appendChild(testIDWButton);

    // Add Add Test IDW Environment button
    const addTestEnvButton = document.createElement('button');
    addTestEnvButton.id = 'add-test-env-btn';
    addTestEnvButton.textContent = 'Add Test IDW';
    addTestEnvButton.style.marginLeft = '10px';
    addTestEnvButton.style.background = '#00cc66';

    addTestEnvButton.addEventListener('click', () => {
      console.log('Add Test IDW Environment button clicked');
      const result = addTestIDWEnvironment();
      if (result) {
        showNotification(
          'Test Environment Added',
          'A test IDW environment has been added. Please restart the app to see it in the menu.'
        );
      } else {
        showNotification('Info', 'No test environment was added (environments may already exist).');
      }
    });

    devControls.appendChild(addTestEnvButton);
  }

  // Listen for messages from the main process
  window.api.receive('app-response', (data) => {
    console.log('Received response from main process:', data);
    // Handle responses from the main process here
  });

  // Listen for IDW environments request
  window.api.receive('request-idw-environments', () => {
    console.log('Main process requested IDW environments');
    try {
      // Get IDW environments from localStorage
      const idwEnvironments = JSON.parse(localStorage.getItem('idwEnvironments') || '[]');
      console.log(`Sending ${idwEnvironments.length} IDW environments to main process`);

      // Send the environments back to the main process
      window.api.send('idw-environments-response', idwEnvironments);
    } catch (error) {
      console.error('Error sending IDW environments to main process:', error);
      window.api.send('idw-environments-response', []);
    }
  });

  // Listen for menu actions
  window.api.receive('menu-action', (data) => {
    console.log('Received menu action:', data);

    // Handle different menu actions
    switch (data.action) {
      // IDW menu actions
      case 'new-bot':
        handleNewBot();
        break;
      case 'import-bot':
        handleImportBot();
        break;
      case 'deploy-bot':
        handleDeployBot();
        break;
      case 'publish-bot':
        handlePublishBot();
        break;
      case 'add-remove':
        handleAddRemove();
        break;
      case 'open-data-tests':
        // This is handled in main.js, but we can do additional UI updates here if needed
        console.log('Opening data validation test page');
        break;
      case 'open-idw-url':
        // This action is primarily handled by main.js to load URL in the main window
        console.log(`Opening IDW URL: ${data.url}`);
        // We can show a loading indicator or update UI state here if needed
        showNotification('Opening IDW', `Loading ${data.label || 'environment'}...`);
        break;
      case 'open-external-bot':
        // Handle opening external bot in a new tab
        console.log(`Opening external bot: ${data.label} at ${data.url}`);
        showNotification('Opening External Bot', `Loading ${data.label}...`);
        // The URL should be opened in a new tab
        console.log('Sending open-in-new-tab via window.api');
        if (window.api && window.api.send) {
          window.api.send('open-in-new-tab', data.url);
          console.log('Sent open-in-new-tab message for:', data.url);
        } else {
          console.error('window.api or window.api.send is not available');
        }
        break;
      case 'open-gsx-url':
        // Handle opening GSX URLs
        console.log(`Opening GSX URL: ${data.url}`);
        showNotification('Opening GSX', `Loading ${data.label || 'link'}...`);
        // Use our direct GSX opener function instead of open-in-new-tab
        if (window.api && window.api.openGSXLink) {
          // Extract environment from the URL for proper session isolation
          let environment = null;
          try {
            const urlObj = new URL(data.url);
            const hostParts = urlObj.hostname.split('.');
            environment = hostParts.find((part) => ['staging', 'edison', 'production'].includes(part)) || null;
          } catch (err) {
            console.error('Error extracting environment from GSX URL:', err);
          }

          window.api.openGSXLink(data.url, data.label || 'GSX', {
            environment: environment,
          });
        }
        break;

      // Original menu actions (repurposed or kept for reference)
      case 'new-project':
        handleNewBot(); // Redirect to new handler
        break;
      case 'open-project':
        handleImportBot(); // Redirect to new handler
        break;
      case 'save':
        handleDeployBot(); // Redirect to new handler
        break;
      case 'open-preferences':
        handlePreferences();
        break;
      case 'check-updates':
        handleCheckUpdates();
        break;
      case 'open-ai-insights':
        console.log('Opening AI Run Times');
        // Create a new window for AI Run Times
        const aiWindow = new BrowserWindow({
          width: 1200,
          height: 800,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            webSecurity: true,
            preload: path.join(__dirname, 'preload.js'),
          },
        });

        // Load the UXmag.html file
        aiWindow.loadFile('Flipboard-IDW-Feed/uxmag.html');
        break;
      default:
        // Handle dynamic IDW menu items
        if (data.action && data.action.startsWith('idw-')) {
          const idwLabel = data.action.replace('idw-', '');
          handleOpenIDW(idwLabel);
        } else {
          console.log('Unknown menu action:', data.action);
        }
    }
  });

  // Listen for notification requests
  window.api.receive('show-notification', (data) => {
    // Handle various notification formats and prevent undefined values
    const title = data?.title || data?.message || '';
    const body = data?.body || data?.text || '';

    // Only show if we have at least some content
    if (title || body) {
      showNotification(title, body);
    } else {
      console.warn('[Notification] Received empty notification:', data);
    }
  });

  // Generate dynamic menus based on localStorage data
  initializeDynamicMenus();

  // Example of dynamic content updates
  function updateUIState(state) {
    // Update UI based on application state
    console.log('Updating UI with state:', state);
  }

  // Initialize UI
  updateUIState({ status: 'ready' });

  // Function to show a notification
  function showNotification(title, message) {
    // Create notification element if it doesn't exist
    let notificationContainer = document.getElementById('notification-container');

    if (!notificationContainer) {
      notificationContainer = document.createElement('div');
      notificationContainer.id = 'notification-container';
      notificationContainer.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        z-index: 1000;
        width: 300px;
      `;
      document.body.appendChild(notificationContainer);
    }

    // Create new notification
    const notification = document.createElement('div');
    notification.style.cssText = `
      background-color: #1a1a1a;
      color: white;
      border-left: 4px solid #0099ff;
      padding: 16px;
      margin-bottom: 10px;
      border-radius: 4px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
      opacity: 0;
      transform: translateX(50px);
      transition: opacity 0.3s, transform 0.3s;
    `;

    // Add notification content
    notification.innerHTML = `
      <h3 style="margin: 0 0 8px 0; font-size: 16px;">${title}</h3>
      <p style="margin: 0; font-size: 14px; opacity: 0.8;">${message}</p>
    `;

    // Add to container
    notificationContainer.appendChild(notification);

    // Trigger animation
    setTimeout(() => {
      notification.style.opacity = '1';
      notification.style.transform = 'translateX(0)';
    }, 10);

    // Auto-remove after 3 seconds
    setTimeout(() => {
      notification.style.opacity = '0';
      notification.style.transform = 'translateX(50px)';

      setTimeout(() => {
        if (notification.parentNode) {
          notification.parentNode.removeChild(notification);
        }
      }, 300);
    }, 3000);
  }

  // Handler functions for IDW menu actions
  function handleNewBot() {
    console.log('Creating new bot');
    // Implementation for creating a new bot
    alert('Creating new bot...');
  }

  function handleImportBot() {
    console.log('Importing bot');
    // Implementation for importing a bot
    alert('Importing bot...');
  }

  function handleDeployBot() {
    console.log('Deploying bot');
    // Implementation for deploying the bot
    alert('Deploying bot...');
  }

  function handlePublishBot() {
    console.log('Publishing bot');
    // Implementation for publishing the bot
    alert('Publishing bot...');
  }

  function handleAddRemove() {
    console.log('Opening Add/Remove dialog');
    // Send a direct request to the main process to open the setup wizard
    window.api.send('open-setup-wizard', {
      timestamp: new Date().toISOString(),
    });
  }

  function handleOpenIDW(idwLabel) {
    console.log(`Opening IDW environment: ${idwLabel}`);
    // Get IDW environments from localStorage
    const idwEnvironments = JSON.parse(localStorage.getItem('idwEnvironments') || '[]');
    const environment = idwEnvironments.find((env) => env.label === idwLabel);

    if (environment) {
      // Use the chat URL if available, otherwise use home URL
      const url = environment.chatUrl || environment.homeUrl;

      // Here you would handle opening a tab or navigating to the IDW environment
      alert(`Opening IDW: ${environment.label} (${url})`);

      // Example: You could send a message to the main process to open this URL
      window.api.send('user-action', {
        action: 'open-idw-environment',
        url: url,
        label: environment.label,
        timestamp: new Date().toISOString(),
      });
    } else {
      console.error(`IDW environment not found: ${idwLabel}`);
    }
  }

  // Generate dynamic menus from localStorage data
  function initializeDynamicMenus() {
    try {
      // Get IDW environments from localStorage
      const idwEnvironments = JSON.parse(localStorage.getItem('idwEnvironments') || '[]');
      const gsxLinks = JSON.parse(localStorage.getItem('gsxLinks') || '[]');

      if (idwEnvironments.length > 0) {
        console.log(`Found ${idwEnvironments.length} IDW environments for dynamic menus`);

        // Send these environments to the main process to update the IDW menu dynamically
        window.api.send('user-action', {
          action: 'update-idw-menu',
          environments: idwEnvironments,
          timestamp: new Date().toISOString(),
        });

        // Also create tabs or other UI elements based on these environments
        createIDWTabs(idwEnvironments);
      } else {
        console.log('No IDW environments found for dynamic menus');
      }

      // Setup GSX menu if there are GSX links
      if (gsxLinks.length > 0) {
        console.log(`Found ${gsxLinks.length} GSX links for dynamic menus`);

        // Send GSX links to the main process to update the GSX menu dynamically
        window.api.send('user-action', {
          action: 'update-gsx-menu',
          links: gsxLinks,
          timestamp: new Date().toISOString(),
        });
      }
    } catch (error) {
      console.error('Error initializing dynamic menus:', error);
    }
  }

  // Create tabs for each IDW environment
  function createIDWTabs(environments) {
    // This would be implemented based on your UI framework
    console.log('Creating tabs for IDW environments:', environments);

    // Example implementation (pseudocode):
    // const tabContainer = document.getElementById('idw-tabs');
    // if (tabContainer) {
    //   environments.forEach(env => {
    //     const tab = document.createElement('div');
    //     tab.className = 'idw-tab';
    //     tab.textContent = env.label;
    //     tab.addEventListener('click', () => handleOpenIDW(env.label));
    //     tabContainer.appendChild(tab);
    //   });
    // }
  }

  // Handler functions for other menu actions
  function handlePreferences() {
    console.log('Opening preferences');
    // Open the setup wizard for managing environments
    window.api.send('open-setup-wizard', {
      timestamp: new Date().toISOString(),
    });
  }

  function handleCheckUpdates() {
    console.log('Checking for updates');

    // First, check if we need to create an update UI element if it doesn't exist
    let updateContainer = document.getElementById('update-container');
    if (!updateContainer) {
      updateContainer = document.createElement('div');
      updateContainer.id = 'update-container';
      updateContainer.style.cssText = `
        position: fixed;
        bottom: 20px;
        right: 20px;
        background: rgba(0, 0, 0, 0.8);
        border-radius: 8px;
        padding: 15px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
        color: white;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 14px;
        max-width: 300px;
        z-index: 9999;
        border: 1px solid rgba(255, 255, 255, 0.1);
        display: none;
      `;
      document.body.appendChild(updateContainer);

      // Close button
      const closeBtn = document.createElement('button');
      closeBtn.innerText = '×';
      closeBtn.style.cssText = `
        position: absolute;
        top: 5px;
        right: 5px;
        background: none;
        border: none;
        color: rgba(255, 255, 255, 0.6);
        font-size: 16px;
        cursor: pointer;
        padding: 5px;
      `;
      closeBtn.addEventListener('click', () => {
        updateContainer.style.display = 'none';
      });
      updateContainer.appendChild(closeBtn);
    }

    // Setup listener for update status if not already set
    if (!window.updaterInitialized) {
      // Remove any existing listeners first to prevent duplicates
      if (window.updateStatusListener) {
        // Note: We can't actually remove IPC listeners in this context,
        // but we can prevent duplicate initialization
        console.warn('Update listener already exists, skipping re-initialization');
        window.api.send('update-action', { action: 'check' });
        return;
      }

      window.updateStatusListener = (data) => {
        console.log('Received update status:', data);
        updateContainer.style.display = 'block';

        if (data.status === 'checking') {
          updateContainer.innerHTML = `
            <button class="close-btn" style="
              position: absolute;
              top: 5px;
              right: 5px;
              background: none;
              border: none;
              color: rgba(255, 255, 255, 0.6);
              font-size: 16px;
              cursor: pointer;
              padding: 5px;
            ">×</button>
            <span style="font-weight: bold;">Checking for updates...</span>
            <div style="padding-top: 10px;">Please wait...</div>
          `;
          // Re-add close button event listener
          updateContainer.querySelector('.close-btn').addEventListener('click', () => {
            updateContainer.style.display = 'none';
          });
        } else if (data.status === 'available') {
          updateContainer.innerHTML = `
            <button class="close-btn" style="
              position: absolute;
              top: 5px;
              right: 5px;
              background: none;
              border: none;
              color: rgba(255, 255, 255, 0.6);
              font-size: 16px;
              cursor: pointer;
              padding: 5px;
            ">×</button>
            <span style="font-weight: bold;">Update Available!</span>
            <div style="padding-top: 10px;">Version ${data.info && data.info.version ? data.info.version : 'Unknown'} is available.</div>
            <div style="margin-top: 15px;">
              <button id="download-update-btn" style="
                background: #0099ff;
                border: none;
                color: white;
                padding: 8px 15px;
                border-radius: 4px;
                cursor: pointer;
              ">Download Update</button>
            </div>
          `;
          // Re-add close button event listener
          updateContainer.querySelector('.close-btn').addEventListener('click', () => {
            updateContainer.style.display = 'none';
          });

          document.getElementById('download-update-btn').addEventListener('click', () => {
            // Send message to main process to download the update
            window.api.send('update-action', { action: 'download' });

            // Update the UI
            updateContainer.innerHTML = `
              <span style="font-weight: bold;">Downloading Update...</span>
              <div style="padding-top: 10px;">Please wait...</div>
              <div class="progress-bar" style="
                height: 4px;
                background: rgba(255, 255, 255, 0.1);
                border-radius: 2px;
                margin: 10px 0;
                overflow: hidden;
              ">
                <div class="progress" style="
                  height: 100%;
                  background: #0099ff;
                  width: 0%;
                  transition: width 0.3s ease;
                "></div>
              </div>
            `;
          });
        } else if (data.status === 'not-available') {
          updateContainer.innerHTML = `
            <span style="font-weight: bold;">No Updates Available</span>
            <div style="padding-top: 10px;">You're running the latest version.</div>
          `;

          // Automatically hide after 3 seconds
          setTimeout(() => {
            updateContainer.style.display = 'none';
          }, 3000);
        } else if (data.status === 'error') {
          updateContainer.innerHTML = `
            <button class="close-btn" style="
              position: absolute;
              top: 5px;
              right: 5px;
              background: none;
              border: none;
              color: rgba(255, 255, 255, 0.6);
              font-size: 16px;
              cursor: pointer;
              padding: 5px;
            ">×</button>
            <span style="font-weight: bold;">Update Error</span>
            <div style="padding-top: 10px;">${data.info.error || 'An error occurred while checking for updates.'}</div>
          `;
          // Re-add close button event listener
          updateContainer.querySelector('.close-btn').addEventListener('click', () => {
            updateContainer.style.display = 'none';
          });
        } else if (data.status === 'progress') {
          // Update progress bar
          const progressBar = updateContainer.querySelector('.progress');
          if (progressBar && data.info && typeof data.info.percent === 'number') {
            const percent = Math.max(0, Math.min(100, data.info.percent));
            progressBar.style.width = `${percent}%`;
          }
        } else if (data.status === 'downloaded') {
          const backupMessage = data.info.backupCreated
            ? `<div style="padding-top: 5px; color: #4ade80; font-size: 12px;">✓ Backup of v${data.info.currentVersion} created</div>`
            : data.info.backupCreated === false
              ? `<div style="padding-top: 5px; color: #facc15; font-size: 12px;">⚠ Backup failed but update can proceed</div>`
              : '';

          updateContainer.innerHTML = `
            <button class="close-btn" style="
              position: absolute;
              top: 5px;
              right: 5px;
              background: none;
              border: none;
              color: rgba(255, 255, 255, 0.6);
              font-size: 16px;
              cursor: pointer;
              padding: 5px;
            ">×</button>
            <span style="font-weight: bold;">Update Ready!</span>
            <div style="padding-top: 10px;">Update has been downloaded. Restart to install.</div>
            ${backupMessage}
            <div style="margin-top: 15px;">
              <button id="install-update-btn" style="
                background: #0099ff;
                border: none;
                color: white;
                padding: 8px 15px;
                border-radius: 4px;
                cursor: pointer;
              ">Restart & Install</button>
            </div>
          `;
          // Re-add close button event listener
          updateContainer.querySelector('.close-btn').addEventListener('click', () => {
            updateContainer.style.display = 'none';
          });

          document.getElementById('install-update-btn').addEventListener('click', () => {
            // Send message to main process to install the update
            window.api.send('update-action', { action: 'install' });
          });
        }
      };

      window.api.receive('update-status', window.updateStatusListener);
      window.updaterInitialized = true;
    }

    // Send message to main process to check for updates
    window.api.send('update-action', { action: 'check' });
  }

  // Function to add a test IDW environment if none exist
  function addTestIDWEnvironment() {
    try {
      const idwEnvironments = JSON.parse(localStorage.getItem('idwEnvironments') || '[]');

      if (idwEnvironments.length === 0) {
        console.log('No IDW environments found, adding a test environment');

        // Create a test IDW environment
        const testEnvironment = {
          id: 'marvin-2',
          label: 'Marvin-2',
          environment: 'edison',
          homeUrl: 'https://idw.edison.onereach.ai/marvin-2',
          chatUrl: 'https://flow-desc.chat.edison.onereach.ai/marvin-2',
        };

        // Add the test environment to the array
        idwEnvironments.push(testEnvironment);

        // Save the updated environments to localStorage
        localStorage.setItem('idwEnvironments', JSON.stringify(idwEnvironments));

        console.log('Test IDW environment added. Environments:', idwEnvironments);

        // Update the menus with the new environment
        window.api.send('user-action', {
          action: 'update-idw-menu',
          environments: idwEnvironments,
          timestamp: new Date().toISOString(),
        });

        // Also create tabs or other UI elements based on these environments
        createIDWTabs(idwEnvironments);

        return true;
      } else {
        console.log('IDW environments already exist, not adding test environment');
        return false;
      }
    } catch (error) {
      console.error('Error adding test IDW environment:', error);
      return false;
    }
  }

  // Add global link click interceptor to catch GSX URLs
  document.addEventListener(
    'click',
    (event) => {
      // Find the closest anchor element
      let target = event.target;
      while (target && target.tagName !== 'A') {
        target = target.parentElement;
      }

      // If we found a link
      if (target && target.tagName === 'A' && target.href) {
        const url = target.href;

        // Check if it's a GSX URL
        if (
          url.includes('.onereach.ai/') &&
          (url.includes('actiondesk.') ||
            url.includes('studio.') ||
            url.includes('hitl.') ||
            url.includes('tickets.') ||
            url.includes('calendar.') ||
            url.includes('docs.'))
        ) {
          console.log('Intercepted click on GSX URL:', url);

          // Prevent default action (browser navigation)
          event.preventDefault();

          // Extract GSX app name from URL for title
          let title = 'GSX';
          if (url.includes('actiondesk.')) title = 'Action Desk';
          else if (url.includes('studio.')) title = 'Designer';
          else if (url.includes('hitl.')) title = 'HITL';
          else if (url.includes('tickets.')) title = 'Tickets';
          else if (url.includes('calendar.')) title = 'Calendar';
          else if (url.includes('docs.')) title = 'Developer';

          // Extract environment from the URL for proper session isolation
          let environment = null;
          try {
            const urlObj = new URL(url);
            const hostParts = urlObj.hostname.split('.');
            environment = hostParts.find((part) => ['staging', 'edison', 'production'].includes(part)) || null;
          } catch (err) {
            console.error('Error extracting environment from GSX URL:', err);
          }

          // Open in GSX window
          if (window.api && window.api.openGSXLink) {
            window.api.openGSXLink(url, title, {
              environment: environment,
            });
          }
        }
      }
    },
    true
  );

  // Add click handler for Settings link in navigation
  const settingsLink = document.querySelector('nav a[href="#"]:nth-child(1)');
  if (!settingsLink) {
    // More specific selector for the Settings link
    const navLinks = document.querySelectorAll('nav a');
    navLinks.forEach((link) => {
      if (link.textContent.trim() === 'Settings') {
        link.addEventListener('click', (e) => {
          e.preventDefault();
          console.log('Settings link clicked, opening settings window');
          if (window.api && window.api.send) {
            window.api.send('open-settings');
            showNotification('Opening Settings', 'Loading settings window...');
          }
        });
      }
    });
  }

  // Add keyboard shortcut for manual menu refresh (debug)
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.altKey && e.key === 'r') {
      console.log('Manual menu refresh requested');
      if (window.api && window.api.send) {
        window.api.send('refresh-menu');
        showNotification('Menu Refresh', 'Menu refresh triggered');
      }
    }
  });

  console.log('Renderer process started');
});
