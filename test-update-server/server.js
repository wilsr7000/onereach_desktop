#!/usr/bin/env node
/**
 * Local Update Server for Testing Auto-Update
 * 
 * This serves update files locally so you can test auto-update
 * without publishing to GitHub.
 * 
 * Usage:
 *   1. Build your app: npm run package:mac
 *   2. Copy files to updates/ folder
 *   3. Start server: node test-update-server/server.js
 *   4. Run your app in dev mode: npm run dev
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8080;
const UPDATES_DIR = path.join(__dirname, 'updates');

// Create updates directory if it doesn't exist
if (!fs.existsSync(UPDATES_DIR)) {
  fs.mkdirSync(UPDATES_DIR, { recursive: true });
  console.log(`✓ Created updates directory: ${UPDATES_DIR}`);
}

const server = http.createServer((req, res) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  
  // Handle CORS for local testing
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  // Serve files from updates directory
  let filePath = path.join(UPDATES_DIR, req.url === '/' ? 'latest-mac.yml' : req.url);
  
  // Check if file exists
  if (!fs.existsSync(filePath)) {
    console.log(`  ✗ File not found: ${filePath}`);
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('File not found');
    return;
  }
  
  // Determine content type
  const ext = path.extname(filePath);
  const contentTypes = {
    '.yml': 'text/yaml',
    '.yaml': 'text/yaml',
    '.zip': 'application/zip',
    '.dmg': 'application/x-apple-diskimage',
    '.blockmap': 'application/octet-stream'
  };
  
  const contentType = contentTypes[ext] || 'application/octet-stream';
  
  // Read and serve file
  fs.readFile(filePath, (err, data) => {
    if (err) {
      console.log(`  ✗ Error reading file: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal server error');
      return;
    }
    
    console.log(`  ✓ Served: ${path.basename(filePath)} (${data.length} bytes)`);
    res.writeHead(200, { 
      'Content-Type': contentType,
      'Content-Length': data.length
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log('='.repeat(60));
  console.log('🚀 Local Update Server Running');
  console.log('='.repeat(60));
  console.log(`📍 Server: http://localhost:${PORT}`);
  console.log(`📁 Serving: ${UPDATES_DIR}`);
  console.log('');
  console.log('📋 Files available:');
  
  try {
    const files = fs.readdirSync(UPDATES_DIR);
    if (files.length === 0) {
      console.log('  (No files yet - add your build files to updates/ folder)');
    } else {
      files.forEach(file => {
        const stats = fs.statSync(path.join(UPDATES_DIR, file));
        const size = (stats.size / 1024 / 1024).toFixed(2);
        console.log(`  ✓ ${file} (${size} MB)`);
      });
    }
  } catch (err) {
    console.log('  (Error reading directory)');
  }
  
  console.log('');
  console.log('🔄 To test auto-update:');
  console.log('  1. Uncomment lines in dev-app-update.yml');
  console.log('  2. Build: npm run package:mac');
  console.log('  3. Copy dist/*.yml and *.zip to updates/');
  console.log('  4. Run app: npm run dev');
  console.log('='.repeat(60));
  console.log('');
  console.log('Press Ctrl+C to stop server');
  console.log('');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`✗ Port ${PORT} is already in use`);
    console.error('  Stop the other process or change the PORT in server.js');
  } else {
    console.error('✗ Server error:', err);
  }
  process.exit(1);
});




