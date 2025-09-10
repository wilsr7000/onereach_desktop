const { app, BrowserWindow } = require('electron');
const path = require('path');

console.log('Starting Simple External AI Test...');

app.whenReady().then(() => {
  console.log('App is ready, creating window...');
  
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  console.log('Loading HTML file...');
  const htmlPath = path.join(__dirname, 'external-ai-test-ui.html');
  console.log('HTML path:', htmlPath);
  
  mainWindow.loadFile(htmlPath);
  
  mainWindow.webContents.on('did-finish-load', () => {
    console.log('HTML loaded successfully');
  });
  
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error('Failed to load:', errorCode, errorDescription);
  });
  
  // Open DevTools
  mainWindow.webContents.openDevTools();
  
  mainWindow.on('closed', () => {
    console.log('Window closed');
    app.quit();
  });
});

app.on('window-all-closed', () => {
  console.log('All windows closed');
  app.quit();
}); 