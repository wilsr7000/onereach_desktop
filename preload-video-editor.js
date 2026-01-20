/**
 * Preload script for Video Editor
 * Exposes safe IPC methods to the renderer process
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('videoEditor', {
  // Video info
  getInfo: (videoPath) => ipcRenderer.invoke('video-editor:get-info', videoPath),
  
  // Thumbnails
  generateThumbnails: (videoPath, options) => ipcRenderer.invoke('video-editor:generate-thumbnails', videoPath, options),
  generateThumbnail: (videoPath, timestamp) => ipcRenderer.invoke('video-editor:generate-thumbnail', videoPath, timestamp),
  getTimelineThumbnails: (videoPath, options) => ipcRenderer.invoke('video-editor:timeline-thumbnails', videoPath, options),
  
  // Audio waveform
  getWaveform: (videoPath, options) => ipcRenderer.invoke('video-editor:waveform', videoPath, options),
  
  // Waveform cache (persistent to disk)
  saveWaveformCache: (videoPath, cacheData) => ipcRenderer.invoke('video-editor:save-waveform-cache', videoPath, cacheData),
  loadWaveformCache: (videoPath) => ipcRenderer.invoke('video-editor:load-waveform-cache', videoPath),
  saveWaveformImage: (videoPath, imageKey, dataUrl) => ipcRenderer.invoke('video-editor:save-waveform-image', videoPath, imageKey, dataUrl),
  loadWaveformImage: (videoPath, imageKey) => ipcRenderer.invoke('video-editor:load-waveform-image', videoPath, imageKey),
  deleteWaveformCache: (videoPath) => ipcRenderer.invoke('video-editor:delete-waveform-cache', videoPath),

  // Thumbnail cache (persistent to disk)
  saveThumbnailCache: (videoPath, cacheData) => ipcRenderer.invoke('video-editor:save-thumbnail-cache', videoPath, cacheData),
  loadThumbnailCache: (videoPath) => ipcRenderer.invoke('video-editor:load-thumbnail-cache', videoPath),
  
  // Thumbnail strip images (save/load actual image data)
  saveThumbnailStrip: (videoPath, tierName, dataUrl) => ipcRenderer.invoke('video-editor:save-thumbnail-strip', videoPath, tierName, dataUrl),
  loadThumbnailStrip: (videoPath, tierName) => ipcRenderer.invoke('video-editor:load-thumbnail-strip', videoPath, tierName),

  // Editing operations
  trim: (videoPath, options) => ipcRenderer.invoke('video-editor:trim', videoPath, options),
  transcode: (videoPath, options) => ipcRenderer.invoke('video-editor:transcode', videoPath, options),
  extractAudio: (videoPath, options) => ipcRenderer.invoke('video-editor:extract-audio', videoPath, options),
  
  // ==================== AUDIO CACHE FOR GUIDE/MASTER TRACKS ====================
  // Check if cached audio exists for a video
  checkAudioCache: (videoPath) => ipcRenderer.invoke('video-editor:check-audio-cache', videoPath),
  
  // Extract audio with caching (check cache first, extract if missing)
  extractAudioCached: (videoPath) => ipcRenderer.invoke('video-editor:extract-audio-cached', videoPath),
  
  // Listen for extraction progress updates
  onExtractionProgress: (callback) => {
    const handler = (event, progress) => callback(progress);
    ipcRenderer.on('video-editor:extraction-progress', handler);
    return () => ipcRenderer.removeListener('video-editor:extraction-progress', handler);
  },
  // ==================== END AUDIO CACHE ====================
  
  extractSpeakerAudio: (videoPath, segments, options) => ipcRenderer.invoke('video-editor:extract-speaker-audio', videoPath, segments, options),
  compress: (videoPath, options) => ipcRenderer.invoke('video-editor:compress', videoPath, options),
  changeSpeed: (videoPath, options) => ipcRenderer.invoke('video-editor:change-speed', videoPath, options),
  reverse: (videoPath, options) => ipcRenderer.invoke('video-editor:reverse', videoPath, options),
  splice: (videoPath, options) => ipcRenderer.invoke('video-editor:splice', videoPath, options),
  replaceAudioWithElevenLabs: (videoPath, options) => ipcRenderer.invoke('video-editor:replace-audio-elevenlabs', videoPath, options),
  checkElevenLabsApiKey: () => ipcRenderer.invoke('video-editor:check-elevenlabs-key'),
  generateElevenLabsAudio: (options) => ipcRenderer.invoke('video-editor:generate-elevenlabs-audio', options),
  createCustomVoice: (options) => ipcRenderer.invoke('video-editor:create-custom-voice', options),
  findQuietSections: (videoPath, options) => ipcRenderer.invoke('video-editor:find-quiet-sections', videoPath, options),
  exportWithADRTracks: (videoPath, exportData) => ipcRenderer.invoke('video-editor:export-adr-tracks', videoPath, exportData),
  exportWithAudioReplacements: (videoPath, replacements) => ipcRenderer.invoke('video-editor:export-with-audio-replacements', videoPath, replacements),
  
  // Multi-track export (video + multiple audio tracks combined)
  exportMultiTrack: (videoPath, options) => ipcRenderer.invoke('video-editor:export-multitrack', videoPath, options),
  
  // Concatenate multiple video clips (multi-source editing)
  concatenateClips: (clips, sources, options) => ipcRenderer.invoke('video-editor:concatenate-clips', clips, sources, options),
  
  // Replace video segment with new video content
  replaceVideoSegment: (videoPath, options) => ipcRenderer.invoke('video-editor:replace-segment', videoPath, options),
  
  // ==================== ELEVENLABS NEW APIS ====================
  
  // Generate sound effect from text prompt
  generateSFX: (options) => ipcRenderer.invoke('video-editor:generate-sfx', options),

  // Generate music from text prompt (Eleven Music)
  generateMusic: (options) => ipcRenderer.invoke('video-editor:generate-music', options),

  // Get music composition plan/suggestions from ElevenLabs
  getMusicPlan: (options) => ipcRenderer.invoke('video-editor:get-music-plan', options),

  // Get AI-generated audio suggestions (music or SFX) for a marker
  getAudioSuggestions: (options) => ipcRenderer.invoke('video-editor:get-audio-suggestions', options),

  // Speech-to-Speech voice transformation
  speechToSpeech: (options) => ipcRenderer.invoke('video-editor:speech-to-speech', options),
  
  // Audio isolation (remove background noise/isolate vocals)
  isolateAudio: (audioPath, options) => ipcRenderer.invoke('video-editor:isolate-audio', audioPath, options),
  
  // Dubbing - create project
  createDubbing: (options) => ipcRenderer.invoke('video-editor:create-dubbing', options),
  
  // Dubbing - get status
  getDubbingStatus: (dubbingId) => ipcRenderer.invoke('video-editor:get-dubbing-status', dubbingId),
  
  // Dubbing - download dubbed audio
  downloadDubbedAudio: (dubbingId, languageCode) => ipcRenderer.invoke('video-editor:download-dubbed-audio', dubbingId, languageCode),

  // Generate TTS with duration constraint (for voice change feature)
  generateTimedTTS: (options) => ipcRenderer.invoke('video-editor:generate-timed-tts', options),

  // Extract audio segment from video
  extractAudioSegment: (videoPath, startTime, endTime) => ipcRenderer.invoke('video-editor:extract-audio-segment', videoPath, startTime, endTime),

  // List all available voices (dynamic from API)
  listVoices: () => ipcRenderer.invoke('video-editor:list-voices'),
  
  // Get user subscription info (quota/limits)
  getSubscription: () => ipcRenderer.invoke('video-editor:get-subscription'),
  
  // Get user info
  getUserInfo: () => ipcRenderer.invoke('video-editor:get-user-info'),
  
  // Get usage statistics
  getUsageStats: (options) => ipcRenderer.invoke('video-editor:get-usage-stats', options),

  // Transcribe audio using ElevenLabs Scribe (replaces Whisper)
  // Now automatically identifies speaker names using LLM if multiple speakers detected
  transcribeScribe: (audioPath, options) => ipcRenderer.invoke('video-editor:transcribe-scribe', audioPath, options),
  
  // Identify speaker names from existing transcription result
  // Use this to re-identify speakers with additional context
  identifySpeakers: (transcriptionResult, options) => ipcRenderer.invoke('video-editor:identify-speakers', transcriptionResult, options),

  // ==================== ELEVENLABS STUDIO PROJECTS ====================
  
  // Create a Studio project
  createStudioProject: (name, options) => ipcRenderer.invoke('video-editor:elevenlabs-create-studio-project', name, options),
  
  // Get a Studio project by ID
  getStudioProject: (projectId) => ipcRenderer.invoke('video-editor:elevenlabs-get-studio-project', projectId),
  
  // List all Studio projects
  listStudioProjects: () => ipcRenderer.invoke('video-editor:elevenlabs-list-studio-projects'),
  
  // Delete a Studio project
  deleteStudioProject: (projectId) => ipcRenderer.invoke('video-editor:elevenlabs-delete-studio-project', projectId),

  // ==================== ELEVENLABS VOICE CLONING ====================
  
  // Clone a voice from audio samples
  cloneVoice: (name, audioFilePaths, options) => ipcRenderer.invoke('video-editor:elevenlabs-clone-voice', name, audioFilePaths, options),
  
  // Delete a voice
  deleteVoice: (voiceId) => ipcRenderer.invoke('video-editor:elevenlabs-delete-voice', voiceId),
  
  // Edit voice settings
  editVoice: (voiceId, updates) => ipcRenderer.invoke('video-editor:elevenlabs-edit-voice', voiceId, updates),
  
  // Get voice details
  getVoice: (voiceId) => ipcRenderer.invoke('video-editor:elevenlabs-get-voice', voiceId),

  // ==================== ELEVENLABS VOICE DESIGN ====================
  
  // Design a new voice from parameters (gender, age, accent)
  designVoice: (options) => ipcRenderer.invoke('video-editor:elevenlabs-design-voice', options),
  
  // Save a designed voice to your library
  saveDesignedVoice: (generatedVoiceId, name, description) => 
    ipcRenderer.invoke('video-editor:elevenlabs-save-designed-voice', generatedVoiceId, name, description),

  // ==================== ELEVENLABS LANGUAGE DETECTION ====================
  
  // Detect language in an audio file
  detectLanguage: (audioPath) => ipcRenderer.invoke('video-editor:elevenlabs-detect-language', audioPath),

  // ==================== ELEVENLABS MODELS ====================
  
  // List all available TTS models
  listModels: () => ipcRenderer.invoke('video-editor:elevenlabs-list-models'),

  // ==================== ELEVENLABS STREAMING TTS ====================
  
  // Generate audio with streaming (for real-time playback)
  generateAudioStream: (text, voice, options) => ipcRenderer.invoke('video-editor:elevenlabs-generate-stream', text, voice, options),
  
  // Listen for audio stream chunks (for real-time playback)
  onAudioStreamChunk: (callback) => {
    const handler = (event, chunk) => callback(chunk);
    ipcRenderer.on('video-editor:audio-stream-chunk', handler);
    return () => ipcRenderer.removeListener('video-editor:audio-stream-chunk', handler);
  },

  // ==================== ELEVENLABS HISTORY ====================
  
  // Get generation history
  getHistory: (options) => ipcRenderer.invoke('video-editor:elevenlabs-get-history', options),
  
  // Get a specific history item
  getHistoryItem: (historyItemId) => ipcRenderer.invoke('video-editor:elevenlabs-get-history-item', historyItemId),
  
  // Get audio for a history item
  getHistoryItemAudio: (historyItemId) => ipcRenderer.invoke('video-editor:elevenlabs-get-history-audio', historyItemId),
  
  // Delete a history item
  deleteHistoryItem: (historyItemId) => ipcRenderer.invoke('video-editor:elevenlabs-delete-history-item', historyItemId),
  
  // Delete multiple history items
  deleteHistoryItems: (historyItemIds) => ipcRenderer.invoke('video-editor:elevenlabs-delete-history-items', historyItemIds),

  // ==================== END ELEVENLABS NEW APIS ====================
  exportPlaylist: (videoPath, options) => ipcRenderer.invoke('video-editor:export-playlist', videoPath, options),
  buildPlaylistWithAI: (options) => ipcRenderer.invoke('video-editor:build-playlist-ai', options),
  transcribeRange: (videoPath, options) => ipcRenderer.invoke('video-editor:transcribe-range', videoPath, options),
  generateSceneDescription: (options) => ipcRenderer.invoke('video-editor:generate-scene-description', options),
  generateScreengrabs: (videoPath, options) => ipcRenderer.invoke('video-editor:generate-screengrabs', videoPath, options),
  openExportFolder: (folderPath) => ipcRenderer.invoke('video-editor:open-folder', folderPath),
  addWatermark: (videoPath, watermarkPath, options) => ipcRenderer.invoke('video-editor:watermark', videoPath, watermarkPath, options),
  concatenate: (videoPaths, options) => ipcRenderer.invoke('video-editor:concatenate', videoPaths, options),
  createSlideshow: (imagePaths, options) => ipcRenderer.invoke('video-editor:slideshow', imagePaths, options),

  // ==================== AUDIO-TO-VIDEO ====================
  
  // Create video from audio file with various backgrounds
  createVideoFromAudio: (audioPath, options) => ipcRenderer.invoke('video-editor:create-video-from-audio', audioPath, options),
  
  // Select single image file (for audio-to-video)
  selectImage: () => ipcRenderer.invoke('video-editor:select-image'),
  
  // Select multiple images (for slideshow)
  selectImages: () => ipcRenderer.invoke('video-editor:select-images'),

  // ==================== TWO-STEP VIDEO WORKFLOW ====================
  
  // Step 1: Process edit list - combine selected segments into a single video
  processEditList: (videoPath, editList, options) => 
    ipcRenderer.invoke('video-editor:process-edit-list', videoPath, editList, options),
  
  // Step 2: Finalize - replace video in space and save scene list
  finalizeWorkflow: (spaceItemId, editedVideoPath, scenes) => 
    ipcRenderer.invoke('video-editor:finalize-workflow', spaceItemId, editedVideoPath, scenes),
  
  // Auto-detect scene boundaries
  detectScenes: (videoPath, options) => 
    ipcRenderer.invoke('video-editor:detect-scenes', videoPath, options),
  
  // ==================== TRANSLATION PIPELINE ====================
  
  // Full translation with quality loop (TEaR)
  translateWithQuality: (sourceText, options) =>
    ipcRenderer.invoke('video-editor:translate-with-quality', sourceText, options),
  
  // Single translation (no quality loop)
  translateText: (sourceText, options) =>
    ipcRenderer.invoke('video-editor:translate-text', sourceText, options),
  
  // Evaluate translation quality
  evaluateTranslation: (sourceText, translatedText, options) =>
    ipcRenderer.invoke('video-editor:evaluate-translation', sourceText, translatedText, options),
  
  // Get video from space with existing scenes
  getSpaceVideo: (itemId) => 
    ipcRenderer.invoke('video-editor:get-space-video', itemId),
  
  // Save scenes only (without re-encoding video)
  saveScenesOnly: (itemId, scenes) => 
    ipcRenderer.invoke('video-editor:save-scenes-only', itemId, scenes),
  
  // ==================== END WORKFLOW ====================
  
  // ==================== RELEASE & VERSIONING ====================
  
  // Get release options for current project (branches and their release status)
  getReleaseOptions: () => 
    ipcRenderer.invoke('video-editor:get-release-options'),
  
  // Release current video directly (without project/branch system)
  releaseCurrentVideo: (videoPath, destination, metadata) =>
    ipcRenderer.invoke('video-editor:release-current-video', videoPath, destination, metadata),
  
  // Release a specific branch version
  releaseBranch: (branchId, destination, metadata) =>
    ipcRenderer.invoke('video-editor:release-branch', branchId, destination, metadata),
  
  // Get upload service status (YouTube/Vimeo)
  getUploadServiceStatus: (service) =>
    ipcRenderer.invoke('video-editor:get-upload-service-status', service),
  
  // Authenticate upload service (YouTube/Vimeo OAuth)
  authenticateUploadService: (service) =>
    ipcRenderer.invoke('video-editor:authenticate-upload-service', service),
  
  // Listen for release progress updates
  onReleaseProgress: (callback) => {
    const handler = (event, progress) => callback(progress);
    ipcRenderer.on('video-editor:release-progress', handler);
    return () => ipcRenderer.removeListener('video-editor:release-progress', handler);
  },
  
  // ==================== VERSION/BRANCH MANAGEMENT ====================
  
  // Create new project from video
  createVideoProject: (sourceVideoPath, projectName) =>
    ipcRenderer.invoke('video-editor:create-project', sourceVideoPath, projectName),
  
  // Get all projects
  getVideoProjects: () =>
    ipcRenderer.invoke('video-editor:get-projects'),
  
  // Create branch (variant cut)
  createBranch: (name, type, forkFromBranch, forkFromVersion) =>
    ipcRenderer.invoke('video-editor:create-branch', name, type, forkFromBranch, forkFromVersion),
  
  // Get all branches for current project
  getBranches: () =>
    ipcRenderer.invoke('video-editor:get-branches'),
  
  // Save a new version of current branch
  saveVersion: (branchId, edlData, message) =>
    ipcRenderer.invoke('video-editor:save-version', branchId, edlData, message),
  
  // Load EDL for a specific version
  loadEDL: (branchId, version) =>
    ipcRenderer.invoke('video-editor:load-edl', branchId, version),
  
  // ==================== END RELEASE & VERSIONING ====================
  
  // Job management
  cancelJob: (jobId) => ipcRenderer.invoke('video-editor:cancel', jobId),
  
  // File management
  getExports: () => ipcRenderer.invoke('video-editor:get-exports'),
  getOutputDir: () => ipcRenderer.invoke('video-editor:get-output-dir'),
  revealFile: (filePath) => ipcRenderer.invoke('video-editor:reveal-file', filePath),
  
  // Progress updates
  onProgress: (callback) => {
    ipcRenderer.on('video-editor:progress', (event, progress) => callback(progress));
  },
  
  // Transcription progress (chunk-by-chunk updates)
  onTranscriptionProgress: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('video-editor:transcription-progress', handler);
    // Return cleanup function
    return () => ipcRenderer.removeListener('video-editor:transcription-progress', handler);
  },
  
  // Load file event (when opened from Spaces)
  onLoadFile: (callback) => {
    ipcRenderer.on('video-editor:load-file', (event, filePath) => callback(filePath));
  },
  
  // File dialog
  openFile: () => ipcRenderer.invoke('dialog:open-file', {
    filters: [
      { name: 'Video Files', extensions: ['mp4', 'avi', 'mov', 'wmv', 'flv', 'mkv', 'webm', 'm4v', 'mpg', 'mpeg'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  }),
  
  openImage: () => ipcRenderer.invoke('dialog:open-file', {
    filters: [
      { name: 'Image Files', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] }
    ]
  }),
  
  saveFile: (defaultName) => ipcRenderer.invoke('dialog:save-file', {
    defaultPath: defaultName,
    filters: [
      { name: 'MP4', extensions: ['mp4'] },
      { name: 'WebM', extensions: ['webm'] },
      { name: 'MOV', extensions: ['mov'] },
      { name: 'AVI', extensions: ['avi'] }
    ]
  }),
  
  // Open the standalone recorder
  openRecorder: (options) => ipcRenderer.invoke('recorder:open', options),

  // Debug logger (writes NDJSON via main process)
  debugLog: (payload) => ipcRenderer.send('debug:log', payload),
  
  // ==================== DETACHED VIDEO PLAYER ====================
  
  // Detach video player to separate window
  detachVideoPlayer: (videoPath, currentTime, playing, playbackRate) => 
    ipcRenderer.invoke('video-editor:detach-player', videoPath, currentTime, playing, playbackRate),
  
  // Attach (close) detached video player
  attachVideoPlayer: () => 
    ipcRenderer.invoke('video-editor:attach-player'),
  
  // Sync playback state to detached window
  syncPlayback: (state) => 
    ipcRenderer.invoke('video-editor:sync-playback', state),
  
  // Update video source in detached window
  updateDetachedSource: (videoPath) => 
    ipcRenderer.invoke('video-editor:update-detached-source', videoPath),
  
  // Check if video is currently detached
  isDetached: () => 
    ipcRenderer.invoke('video-editor:is-detached'),
  
  // Listen for player attached event (detached window closed)
  onPlayerAttached: (callback) => {
    const handler = (event) => callback();
    ipcRenderer.on('video-editor:player-attached', handler);
    return () => ipcRenderer.removeListener('video-editor:player-attached', handler);
  },
  
  // Listen for time updates from detached window
  onDetachedTimeUpdate: (callback) => {
    const handler = (event, currentTime) => callback(currentTime);
    ipcRenderer.on('detached-video:time-update', handler);
    return () => ipcRenderer.removeListener('detached-video:time-update', handler);
  },
  
  // Listen for play state changes from detached window
  onDetachedPlayState: (callback) => {
    const handler = (event, playing) => callback(playing);
    ipcRenderer.on('detached-video:play-state', handler);
    return () => ipcRenderer.removeListener('detached-video:play-state', handler);
  },
  
  // ==================== END DETACHED VIDEO PLAYER ====================
  
  // ==================== PROJECT PERSISTENCE ====================
  
  // Save project state to file (alongside video)
  saveProject: (videoPath, projectData) => 
    ipcRenderer.invoke('save-video-project', { videoPath, projectData }),
  
  // Load project state from file
  loadProject: (videoPath) => 
    ipcRenderer.invoke('load-video-project', { videoPath }),
  
  // Delete project file
  deleteProject: (videoPath) => 
    ipcRenderer.invoke('delete-video-project', { videoPath })
  
  // ==================== END PROJECT PERSISTENCE ====================
});

// Expose spaces integration (Universal Spaces API)
contextBridge.exposeInMainWorld('spaces', {
  // Legacy methods (maintained for compatibility)
  getAll: () => ipcRenderer.invoke('clipboard:get-spaces'),
  getItems: (spaceId) => ipcRenderer.invoke('clipboard:get-space-items', spaceId),
  getVideos: (spaceId) => ipcRenderer.invoke('clipboard:get-space-videos', spaceId),
  getAudio: (spaceId) => ipcRenderer.invoke('clipboard:get-space-audio', spaceId),
  getVideoPath: (itemId) => ipcRenderer.invoke('clipboard:get-video-path', itemId),
  getItemPath: (itemId) => ipcRenderer.invoke('clipboard:get-item-path', itemId),
  addFile: (data) => ipcRenderer.invoke('black-hole:add-file', data),
  
  // Universal Spaces API methods
  api: {
    // Convenience method for getting video paths (wraps legacy for now)
    getVideoPath: (itemId) => ipcRenderer.invoke('spaces-api:getVideoPath', itemId),
    
    // Space management
    list: () => ipcRenderer.invoke('spaces-api:list'),
    get: (spaceId) => ipcRenderer.invoke('spaces-api:get', spaceId),
    create: (name, options) => ipcRenderer.invoke('spaces-api:create', name, options),
    update: (spaceId, data) => ipcRenderer.invoke('spaces-api:update', spaceId, data),
    delete: (spaceId) => ipcRenderer.invoke('spaces-api:delete', spaceId),
    
    // Item management
    items: {
      list: (spaceId, options) => ipcRenderer.invoke('spaces-api:items:list', spaceId, options),
      get: (spaceId, itemId) => ipcRenderer.invoke('spaces-api:items:get', spaceId, itemId),
      add: (spaceId, item) => ipcRenderer.invoke('spaces-api:items:add', spaceId, item),
      update: (spaceId, itemId, data) => ipcRenderer.invoke('spaces-api:items:update', spaceId, itemId, data),
      delete: (spaceId, itemId) => ipcRenderer.invoke('spaces-api:items:delete', spaceId, itemId),
      move: (itemId, fromSpaceId, toSpaceId) => ipcRenderer.invoke('spaces-api:items:move', itemId, fromSpaceId, toSpaceId)
    },
    
    // File access
    files: {
      getSpacePath: (spaceId) => ipcRenderer.invoke('spaces-api:files:getSpacePath', spaceId),
      list: (spaceId, subPath) => ipcRenderer.invoke('spaces-api:files:list', spaceId, subPath),
      read: (spaceId, filePath) => ipcRenderer.invoke('spaces-api:files:read', spaceId, filePath),
      write: (spaceId, filePath, content) => ipcRenderer.invoke('spaces-api:files:write', spaceId, filePath, content)
    }
  }
});

// Expose clipboard API for transcription access
contextBridge.exposeInMainWorld('clipboard', {
  getTranscription: (itemId) => ipcRenderer.invoke('clipboard:get-transcription', itemId),
  getMetadata: (itemId) => {
    // #region agent log
    console.log('[DEBUG-H5] clipboard.getMetadata called from preload with itemId:', itemId);
    // #endregion
    return ipcRenderer.invoke('clipboard:get-metadata', itemId);
  },
  updateMetadata: (itemId, updates) => ipcRenderer.invoke('clipboard:update-metadata', itemId, updates),
  saveTranscription: (options) => ipcRenderer.invoke('clipboard:save-transcription', options)
});

// Expose electron shell
contextBridge.exposeInMainWorld('electron', {
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  showItemInFolder: (path) => ipcRenderer.invoke('video-editor:reveal-file', path)
});

// ═══════════════════════════════════════════════════════════
// STATE MANAGER API - Auto-save, Undo/Redo, Snapshots
// ═══════════════════════════════════════════════════════════
contextBridge.exposeInMainWorld('stateManager', {
  // Save a snapshot to disk
  saveSnapshot: (editorId, snapshot) => 
    ipcRenderer.invoke('stateManager:saveSnapshot', editorId, snapshot),
  
  // List all snapshots for an editor (metadata only)
  listSnapshots: (editorId) => 
    ipcRenderer.invoke('stateManager:listSnapshots', editorId),
  
  // Get a specific snapshot with full state
  getSnapshot: (editorId, snapshotId) => 
    ipcRenderer.invoke('stateManager:getSnapshot', editorId, snapshotId),
  
  // Delete a snapshot
  deleteSnapshot: (editorId, snapshotId) => 
    ipcRenderer.invoke('stateManager:deleteSnapshot', editorId, snapshotId),
  
  // Rename a snapshot
  renameSnapshot: (editorId, snapshotId, newName) => 
    ipcRenderer.invoke('stateManager:renameSnapshot', editorId, snapshotId, newName),
  
  // Get storage statistics
  getStats: (editorId) => 
    ipcRenderer.invoke('stateManager:getStats', editorId),
  
  // Clear all snapshots for an editor
  clearSnapshots: (editorId) => 
    ipcRenderer.invoke('stateManager:clearSnapshots', editorId)
});

// ═══════════════════════════════════════════════════════════
// BUDGET API - Cost tracking and budget management
// ═══════════════════════════════════════════════════════════
contextBridge.exposeInMainWorld('budgetAPI', {
  // Get cost summary for a period
  getCostSummary: (period) => ipcRenderer.invoke('budget:getCostSummary', period),
  
  // Estimate cost before making API call
  estimateCost: (provider, params) => ipcRenderer.invoke('budget:estimateCost', provider, params),
  
  // Check if operation is within budget
  checkBudget: (provider, estimatedCost) => ipcRenderer.invoke('budget:checkBudget', provider, estimatedCost),
  
  // Track usage (called after API calls)
  trackUsage: (provider, projectId, usage) => ipcRenderer.invoke('budget:trackUsage', provider, projectId, usage),
  
  // Register project for tracking
  registerProject: (projectId, name) => ipcRenderer.invoke('budget:registerProject', projectId, name),
  
  // Get project costs
  getProjectCosts: (projectId) => ipcRenderer.invoke('budget:getProjectCosts', projectId),
  
  // Get all budget limits
  getAllBudgetLimits: () => ipcRenderer.invoke('budget:getAllBudgetLimits'),
  
  // Open budget dashboard
  openDashboard: () => ipcRenderer.send('open-budget-dashboard')
});

// ═══════════════════════════════════════════════════════════
// PROJECT API - Project/Version management
// ═══════════════════════════════════════════════════════════
contextBridge.exposeInMainWorld('projectAPI', {
  // ==================== PROJECT OPERATIONS ====================
  
  // Create a new project
  createProject: (options) => ipcRenderer.invoke('project:create', options),
  
  // Get a project by ID
  getProject: (projectId) => ipcRenderer.invoke('project:get', projectId),
  
  // Get all projects
  getAllProjects: () => ipcRenderer.invoke('project:getAll'),
  
  // Get projects for a specific space
  getProjectsBySpace: (spaceId) => ipcRenderer.invoke('project:getBySpace', spaceId),
  
  // Update a project
  updateProject: (projectId, updates) => ipcRenderer.invoke('project:update', projectId, updates),
  
  // Rename a project
  renameProject: (projectId, newName) => ipcRenderer.invoke('project:rename', projectId, newName),
  
  // Delete a project
  deleteProject: (projectId) => ipcRenderer.invoke('project:delete', projectId),
  
  // ==================== ASSET OPERATIONS ====================
  
  // Add an asset to a project
  addAsset: (projectId, filePath, type) => ipcRenderer.invoke('project:addAsset', projectId, filePath, type),
  
  // Remove an asset from a project
  removeAsset: (projectId, assetId) => ipcRenderer.invoke('project:removeAsset', projectId, assetId),
  
  // Get project assets
  getProjectAssets: (projectId) => ipcRenderer.invoke('project:getAssets', projectId),
  
  // ==================== VERSION OPERATIONS ====================
  
  // Create a new version
  createVersion: (projectId, options) => ipcRenderer.invoke('project:createVersion', projectId, options),
  
  // Get a version by ID
  getVersion: (versionId) => ipcRenderer.invoke('project:getVersion', versionId),
  
  // Get all versions for a project
  getProjectVersions: (projectId) => ipcRenderer.invoke('project:getVersions', projectId),
  
  // Update a version
  updateVersion: (versionId, updates) => ipcRenderer.invoke('project:updateVersion', versionId, updates),
  
  // Rename a version
  renameVersion: (versionId, newName) => ipcRenderer.invoke('project:renameVersion', versionId, newName),
  
  // Delete a version
  deleteVersion: (versionId) => ipcRenderer.invoke('project:deleteVersion', versionId),
  
  // Branch (fork) a version
  branchVersion: (sourceVersionId, newName) => ipcRenderer.invoke('project:branchVersion', sourceVersionId, newName),
  
  // Set default version for a project
  setDefaultVersion: (projectId, versionId) => ipcRenderer.invoke('project:setDefaultVersion', projectId, versionId),
  
  // Get version tree for a project
  getVersionTree: (projectId) => ipcRenderer.invoke('project:getVersionTree', projectId),
  
  // ==================== SESSION OPERATIONS ====================
  
  // Load a project and version into session
  loadSession: (projectId, versionId) => ipcRenderer.invoke('project:loadSession', projectId, versionId),
  
  // Save current session state
  saveSession: (state) => ipcRenderer.invoke('project:saveSession', state),
  
  // Close current session
  closeSession: (state) => ipcRenderer.invoke('project:closeSession', state),
  
  // Get current session info
  getCurrentSession: () => ipcRenderer.invoke('project:getCurrentSession'),
  
  // ==================== EXPORT/IMPORT ====================
  
  // Export a project to JSON
  exportProject: (projectId) => ipcRenderer.invoke('project:export', projectId),
  
  // Import a project from JSON
  importProject: (data) => ipcRenderer.invoke('project:import', data),
  
  // Get storage statistics
  getStats: () => ipcRenderer.invoke('project:getStats'),

  // ==================== LINE SCRIPT SYSTEM ====================
  
  // Capture a frame at a specific time (for AI analysis)
  captureFrameAtTime: (videoPath, timestamp, options) => 
    ipcRenderer.invoke('video-editor:capture-frame-at-time', videoPath, timestamp, options),
  
  // Analyze scene with GPT Vision (frame + transcript)
  analyzeSceneWithVision: (options) => 
    ipcRenderer.invoke('video-editor:analyze-scene-with-vision', options),
  
  // Find quotes in transcript (AI-powered)
  findQuotes: (options) => 
    ipcRenderer.invoke('video-editor:find-quotes', options),
  
  // Detect topics in transcript (AI-powered)
  detectTopics: (options) => 
    ipcRenderer.invoke('video-editor:detect-topics', options),
  
  // Analyze hooks throughout video (AI-powered)
  analyzeHooks: (options) => 
    ipcRenderer.invoke('video-editor:analyze-hooks', options),
  
  // Rate project with AI against criteria
  rateProject: (options) => 
    ipcRenderer.invoke('video-editor:rate-project', options)
});

console.log('[VideoEditor Preload] APIs exposed (including StateManager, Budget, Project, and Line Script)');

