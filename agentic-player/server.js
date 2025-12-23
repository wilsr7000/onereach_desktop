/**
 * Agentic Player API Server
 * 
 * A backend server that serves video clips for the Agentic Player.
 * Supports:
 * - Clip retrieval from Space storage
 * - AI-powered clip ranking/selection
 * - Session management
 * - Learning workflow integration (quiz points, chapters)
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const https = require('https');

// Configuration
const PORT = process.env.AGENTIC_PORT || 3456;
const SETTINGS_PATH = path.join(process.env.HOME || process.env.USERPROFILE, '.onereach', 'settings.json');

// In-memory session storage
const sessions = new Map();

/**
 * Load settings (API keys, etc.)
 */
function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    }
  } catch (e) {
    console.warn('[AgenticServer] Could not load settings:', e.message);
  }
  return {};
}

/**
 * Get or create a session
 */
function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      id: sessionId,
      created: Date.now(),
      watchedIds: [],
      timeWatched: 0,
      currentIndex: 0,
      clips: [],
      quizResponses: [],
      progress: {
        completedChapters: [],
        score: 0,
        totalQuestions: 0
      }
    });
  }
  return sessions.get(sessionId);
}

/**
 * Update session with watched clip info
 */
function updateSession(sessionId, watchedIds, timeWatched) {
  const session = getSession(sessionId);
  
  // Merge watched IDs
  watchedIds.forEach(id => {
    if (!session.watchedIds.includes(id)) {
      session.watchedIds.push(id);
    }
  });
  
  session.timeWatched = timeWatched;
  session.lastUpdated = Date.now();
  
  return session;
}

/**
 * Load clips/scenes from a video's metadata file
 */
function loadClipsFromFile(clipsPath) {
  try {
    if (fs.existsSync(clipsPath)) {
      const data = JSON.parse(fs.readFileSync(clipsPath, 'utf8'));
      return data.scenes || data.clips || data.markers || [];
    }
  } catch (e) {
    console.error('[AgenticServer] Error loading clips:', e.message);
  }
  return [];
}

/**
 * Rank clips based on prompt using simple keyword matching
 * For production, integrate with OpenAI/Claude for semantic search
 */
function rankClips(clips, prompt, watchedIds = []) {
  // Simple keyword scoring
  const keywords = prompt.toLowerCase().split(/\s+/);
  
  return clips
    .filter(clip => !watchedIds.includes(clip.id)) // Filter out watched
    .map(clip => {
      let score = 0;
      const text = `${clip.name} ${clip.description || ''} ${(clip.tags || []).join(' ')}`.toLowerCase();
      
      keywords.forEach(keyword => {
        if (text.includes(keyword)) {
          score += 10;
        }
      });
      
      // Bonus for chapters and key points in learning content
      if (clip.markerType === 'chapter') score += 5;
      if (clip.markerType === 'keypoint') score += 3;
      
      return { ...clip, score };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Use AI to select and rank clips (optional, requires API key)
 */
async function aiSelectClips(clips, prompt, context, settings) {
  const apiKey = settings.openaiApiKey;
  if (!apiKey) {
    return null; // Fall back to keyword matching
  }
  
  return new Promise((resolve, reject) => {
    const systemPrompt = `You are a video clip selection AI. Given a user prompt and available clips, select the most relevant clips to play next.

Return JSON with:
- selectedIds: array of clip IDs in playback order (max 5)
- reasoning: brief explanation

Rules:
- Select clips relevant to the user's request
- Maintain logical flow
- Prioritize chapters and key points for learning content
- Don't repeat clips the user has already watched`;

    const userPrompt = `User request: "${prompt}"

Available clips:
${clips.map(c => `ID: ${c.id} | ${c.name} | ${c.description || 'No description'} | Type: ${c.markerType || 'scene'}`).join('\n')}

Already watched: ${context.watchedIds?.join(', ') || 'none'}

Select the best clips to play next.`;

    const postData = JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.7,
      response_format: { type: 'json_object' }
    });

    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          resolve(null); // Fall back to keyword matching
          return;
        }
        try {
          const response = JSON.parse(data);
          const content = JSON.parse(response.choices[0].message.content);
          resolve(content);
        } catch (e) {
          resolve(null);
        }
      });
    });

    req.on('error', () => resolve(null));
    req.write(postData);
    req.end();
  });
}

/**
 * Handle API request
 */
async function handleRequest(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  
  const url = new URL(req.url, `http://localhost:${PORT}`);
  
  // Health check
  if (url.pathname === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', version: '1.0.0' }));
    return;
  }
  
  // Main playlist endpoint
  if (url.pathname === '/playlist' && req.method === 'POST') {
    let body = '';
    
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const request = JSON.parse(body);
        const {
          prompt = '',
          sessionId = `session_${Date.now()}`,
          watchedIds = [],
          timeWatched = 0,
          queueLength = 0,
          context = {},
          clipsSource = null // Path to clips JSON file
        } = request;
        
        console.log(`[AgenticServer] Request: prompt="${prompt}", session=${sessionId}, watched=${watchedIds.length}`);
        
        // Update session
        const session = updateSession(sessionId, watchedIds, timeWatched);
        
        // Load clips from file or use provided clips
        let allClips = [];
        if (clipsSource && fs.existsSync(clipsSource)) {
          allClips = loadClipsFromFile(clipsSource);
        } else if (context.clips) {
          allClips = context.clips;
        } else {
          // Default: load from session or return empty
          allClips = session.clips || [];
        }
        
        // Check if we should return more clips
        if (queueLength >= 3) {
          // Player has enough clips
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            scenes: [],
            done: false,
            reasoning: 'Queue has enough clips'
          }));
          return;
        }
        
        // Filter out watched clips
        const unwatchedClips = allClips.filter(c => !session.watchedIds.includes(c.id));
        
        // Check if we're done
        if (unwatchedClips.length === 0) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            scenes: [],
            done: true,
            endMessage: '🎉 You\'ve completed all the content!',
            progress: session.progress
          }));
          return;
        }
        
        // Try AI selection first
        const settings = loadSettings();
        let selectedClips = [];
        let reasoning = '';
        
        if (prompt && settings.openaiApiKey) {
          const aiResult = await aiSelectClips(unwatchedClips, prompt, {
            watchedIds: session.watchedIds,
            timeWatched
          }, settings);
          
          if (aiResult && aiResult.selectedIds) {
            selectedClips = aiResult.selectedIds
              .map(id => unwatchedClips.find(c => c.id === id))
              .filter(Boolean)
              .slice(0, 5);
            reasoning = aiResult.reasoning || 'AI-selected clips';
          }
        }
        
        // Fall back to keyword ranking if AI didn't select
        if (selectedClips.length === 0) {
          const rankedClips = rankClips(unwatchedClips, prompt, session.watchedIds);
          selectedClips = rankedClips.slice(0, 5);
          reasoning = prompt 
            ? `Clips matching: ${prompt}`
            : 'Playing next clips in sequence';
        }
        
        // Format clips for player
        const scenes = selectedClips.map(clip => ({
          id: clip.id,
          name: clip.name || 'Untitled',
          videoUrl: clip.videoUrl || clip.path || '',
          inTime: clip.inTime || clip.time || 0,
          outTime: clip.outTime || (clip.inTime || 0) + 30,
          description: clip.description || '',
          markerType: clip.markerType || 'scene',
          // Learning-specific
          quizData: clip.quizData || null,
          completed: clip.completed || false
        }));
        
        console.log(`[AgenticServer] Returning ${scenes.length} clips`);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          scenes,
          reasoning,
          done: false,
          sessionId,
          remaining: unwatchedClips.length - scenes.length
        }));
        
      } catch (error) {
        console.error('[AgenticServer] Error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
    });
    return;
  }
  
  // Quiz response endpoint
  if (url.pathname === '/quiz-response' && req.method === 'POST') {
    let body = '';
    
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { sessionId, quizId, answer, correct } = JSON.parse(body);
        
        const session = getSession(sessionId);
        session.quizResponses.push({
          quizId,
          answer,
          correct,
          timestamp: Date.now()
        });
        
        if (correct) {
          session.progress.score++;
        }
        session.progress.totalQuestions++;
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          progress: session.progress
        }));
        
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
    });
    return;
  }
  
  // Session info endpoint
  if (url.pathname.startsWith('/session/') && req.method === 'GET') {
    const sessionId = url.pathname.split('/')[2];
    const session = sessions.get(sessionId);
    
    if (session) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(session));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
    }
    return;
  }
  
  // Load clips for a session
  if (url.pathname === '/load-clips' && req.method === 'POST') {
    let body = '';
    
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { sessionId, clips } = JSON.parse(body);
        
        const session = getSession(sessionId);
        session.clips = clips;
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          clipCount: clips.length
        }));
        
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
    });
    return;
  }
  
  // Static file serving (for testing)
  if (req.method === 'GET') {
    const staticPath = path.join(__dirname, url.pathname === '/' ? 'index.html' : url.pathname);
    
    if (fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
      const ext = path.extname(staticPath);
      const contentTypes = {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.json': 'application/json'
      };
      
      res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'text/plain' });
      fs.createReadStream(staticPath).pipe(res);
      return;
    }
  }
  
  // 404 for unknown routes
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

/**
 * Start the server
 */
function startServer() {
  const server = http.createServer(handleRequest);
  
  server.listen(PORT, () => {
    console.log(`\n🎬 Agentic Player API Server running on http://localhost:${PORT}`);
    console.log(`\nEndpoints:`);
    console.log(`  POST /playlist         - Get clips for playback`);
    console.log(`  POST /quiz-response    - Submit quiz answer`);
    console.log(`  POST /load-clips       - Load clips for a session`);
    console.log(`  GET  /session/:id      - Get session info`);
    console.log(`  GET  /health           - Health check`);
    console.log(`\nExample usage:`);
    console.log(`  curl -X POST http://localhost:${PORT}/playlist \\`);
    console.log(`       -H "Content-Type: application/json" \\`);
    console.log(`       -d '{"prompt": "show me the highlights", "sessionId": "test-1"}'`);
  });
  
  return server;
}

// Export for use as module
module.exports = { startServer, getSession, updateSession, loadClipsFromFile };

// Start if run directly
if (require.main === module) {
  startServer();
}


