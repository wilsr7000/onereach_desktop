const { app } = require('electron');
console.log('app type:', typeof app);
if (app) {
  console.log('app.quit:', typeof app.quit);
}
