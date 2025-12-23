// Minimal Electron test
console.log('Starting minimal electron test...');
console.log('process.type:', process.type);
console.log('process.versions.electron:', process.versions.electron);

try {
  const electron = require('electron');
  console.log('electron module:', typeof electron);
  console.log('electron keys:', Object.keys(electron).slice(0, 10));
  
  const { app } = electron;
  console.log('app:', typeof app);
  
  if (app && app.whenReady) {
    app.whenReady().then(() => {
      console.log('SUCCESS: App is ready!');
      app.quit();
    });
  } else {
    console.log('ERROR: app.whenReady not available');
    process.exit(1);
  }
} catch (e) {
  console.log('ERROR:', e.message);
  process.exit(1);
}
