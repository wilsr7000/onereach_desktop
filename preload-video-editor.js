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
  
  // Editing operations
  trim: (videoPath, options) => ipcRenderer.invoke('video-editor:trim', videoPath, options),
  transcode: (videoPath, options) => ipcRenderer.invoke('video-editor:transcode', videoPath, options),
  extractAudio: (videoPath, options) => ipcRenderer.invoke('video-editor:extract-audio', videoPath, options),
  compress: (videoPath, options) => ipcRenderer.invoke('video-editor:compress', videoPath, options),
  changeSpeed: (videoPath, options) => ipcRenderer.invoke('video-editor:change-speed', videoPath, options),
  reverse: (videoPath, options) => ipcRenderer.invoke('video-editor:reverse', videoPath, options),
  splice: (videoPath, options) => ipcRenderer.invoke('video-editor:splice', videoPath, options),
  replaceAudioWithElevenLabs: (videoPath, options) => ipcRenderer.invoke('video-editor:replace-audio-elevenlabs', videoPath, options),
  exportPlaylist: (videoPath, options) => ipcRenderer.invoke('video-editor:export-playlist', videoPath, options),
  buildPlaylistWithAI: (options) => ipcRenderer.invoke('video-editor:build-playlist-ai', options),
  transcribeRange: (videoPath, options) => ipcRenderer.invoke('video-editor:transcribe-range', videoPath, options),
  generateScreengrabs: (videoPath, options) => ipcRenderer.invoke('video-editor:generate-screengrabs', videoPath, options),
  openExportFolder: (folderPath) => ipcRenderer.invoke('video-editor:open-folder', folderPath),
  addWatermark: (videoPath, watermarkPath, options) => ipcRenderer.invoke('video-editor:watermark', videoPath, watermarkPath, options),
  concatenate: (videoPaths, options) => ipcRenderer.invoke('video-editor:concatenate', videoPaths, options),
  createSlideshow: (imagePaths, options) => ipcRenderer.invoke('video-editor:slideshow', imagePaths, options),
  
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
  
  // Get video from space with existing scenes
  getSpaceVideo: (itemId) => 
    ipcRenderer.invoke('video-editor:get-space-video', itemId),
  
  // Save scenes only (without re-encoding video)
  saveScenesOnly: (itemId, scenes) => 
    ipcRenderer.invoke('video-editor:save-scenes-only', itemId, scenes),
  
  // ==================== END WORKFLOW ====================
  
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
  })
});

// Expose spaces integration
contextBridge.exposeInMainWorld('spaces', {
  getAll: () => ipcRenderer.invoke('clipboard:get-spaces'),
  getItems: (spaceId) => ipcRenderer.invoke('clipboard:get-space-items', spaceId),
  getVideos: (spaceId) => ipcRenderer.invoke('clipboard:get-space-videos', spaceId),
  getVideoPath: (itemId) => ipcRenderer.invoke('clipboard:get-video-path', itemId),
  addFile: (data) => ipcRenderer.invoke('black-hole:add-file', data)
});

// Expose clipboard API for transcription access
contextBridge.exposeInMainWorld('clipboard', {
  getTranscription: (itemId) => ipcRenderer.invoke('clipboard:get-transcription', itemId),
  getMetadata: (itemId) => ipcRenderer.invoke('clipboard:get-metadata', itemId)
});

// Expose electron shell
contextBridge.exposeInMainWorld('electron', {
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  showItemInFolder: (path) => ipcRenderer.invoke('video-editor:reveal-file', path)
});

console.log('[VideoEditor Preload] APIs exposed');

