#!/usr/bin/env node

const { notarize } = require('@electron/notarize');
const path = require('path');
const fs = require('fs');

async function notarizeApp() {
  // Check environment variables
  if (!process.env.APPLE_ID || !process.env.APPLE_APP_SPECIFIC_PASSWORD || !process.env.APPLE_TEAM_ID) {
    console.error('❌ Missing required environment variables:');
    console.error('   APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID must be set');
    process.exit(1);
  }

  const distDir = path.join(__dirname, '../dist');
  const candidates = ['mac-universal', 'mac-arm64', 'mac-x64', 'mac'].map(
    (d) => path.join(distDir, d, 'Onereach.ai.app')
  );
  const appPath = candidates.find((p) => fs.existsSync(p));

  if (!appPath) {
    console.error('App not found. Checked:', candidates.join(', '));
    console.error('Please run "npm run package:mac" first');
    process.exit(1);
  }

  console.log('🔐 Starting manual notarization...');
  console.log(`   App: Onereach.ai`);
  console.log(`   Path: ${appPath}`);
  console.log(`   Bundle ID: com.gsx.poweruser`);
  console.log(`   Apple ID: ${process.env.APPLE_ID}`);
  console.log(`   Team ID: ${process.env.APPLE_TEAM_ID}`);

  try {
    await notarize({
      appBundleId: 'com.gsx.poweruser',
      appPath: appPath,
      appleId: process.env.APPLE_ID,
      appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
      teamId: process.env.APPLE_TEAM_ID,
    });

    console.log('✅ Notarization successful!');
    console.log('');
    console.log('📦 Next steps:');
    console.log('   1. The DMG file at dist/Onereach.ai-1.0.3-arm64.dmg is now notarized');
    console.log('   2. Users can install without the "unidentified developer" warning');
    console.log('');
    console.log('🚀 Ready for distribution!');
  } catch (error) {
    console.error('❌ Notarization failed:', error.message);
    console.error('');
    console.error('Common issues:');
    console.error('- Invalid app-specific password');
    console.error('- Apple Developer account not active');
    console.error('- Network connectivity issues');
    console.error('- Apple notarization service issues');
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  notarizeApp();
}
