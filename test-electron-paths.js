// This needs to be run from within Electron
console.log('Testing Electron paths...');
const { app } = require('electron');

if (!app.isReady()) {
  app.whenReady().then(() => {
    console.log('App ready, testing paths:');
    console.log('documents:', app.getPath('documents'));
    console.log('desktop:', app.getPath('desktop'));
    console.log('userData:', app.getPath('userData'));
    console.log('home:', app.getPath('home'));
    app.quit();
  });
} else {
  console.log('App already ready:');
  console.log('documents:', app.getPath('documents'));
  console.log('desktop:', app.getPath('desktop'));
  console.log('userData:', app.getPath('userData'));
  console.log('home:', app.getPath('home'));
}
