/**
 * LineScriptBridge.js
 * 
 * Integration bridge that connects Line Script modules with the main video editor app.
 * Handles initialization, event routing, and cross-view synchronization between
 * Line Script, Teleprompter, and Timeline views.
 */

import { LineScriptPanel } from './LineScriptPanel.js';
import { LineScriptAI } from './LineScriptAI.js';
import { SpottingController } from './SpottingController.js';
import { VoiceSpottingController } from './VoiceSpottingController.js';
import { AdaptiveModeManager } from './AdaptiveModeManager.js';
import { ContentTemplates, getTemplate, getAllTemplates } from './ContentTemplates.js';
import { HookDetector } from './HookDetector.js';
import { ZZZDetector } from './ZZZDetector.js';
import { EnergyAnalyzer } from './EnergyAnalyzer.js';
import { CustomBeatPrompts } from './CustomBeatPrompts.js';
import { QuoteFinder } from './QuoteFinder.js';
import { ProjectRating } from './ProjectRating.js';
import { RatingStorage } from './RatingStorage.js';
import { ExportPresets, EXPORT_FORMATS } from './ExportPresets.js';
import { ProductionScriptManager } from './ProductionScript.js';
import { ProductionScriptUI } from './ProductionScriptUI.js';

/**
 * Initialize all Line Script modules and attach them to the app context
 * @param {Object} app - The main video editor app object
 */
export function initLineScriptBridge(app) {
  window.logging.info('video', 'LineScriptBridge initializing Line Script modules');
  
  
  // Create app context for modules
  const appContext = {
    app,
    videoPlayer: document.getElementById('videoPlayer'),
    markerManager: app.markerManager,
    teleprompterWords: app.teleprompterWords || [],
    transcriptSegments: app.transcriptSegments || [],
    speakers: app.speakers || [],
    videoPath: app.videoPath || null,
    
    // Helper methods
    getCurrentTime: () => {
      const video = document.getElementById('videoPlayer');
      return video?.currentTime || 0;
    },
    getDuration: () => {
      const video = document.getElementById('videoPlayer');
      return video?.duration || 0;
    },
    seekTo: (time) => {
      const video = document.getElementById('videoPlayer');
      if (video) video.currentTime = time;
    },
    togglePlayback: () => {
      const video = document.getElementById('videoPlayer');
      if (video) {
        if (video.paused) video.play();
        else video.pause();
      }
    },
    showToast: (message, type) => {
      app.showToast?.(message, type);
    }
  };
  
  // Initialize storage
  const ratingStorage = new RatingStorage();
  
  // Initialize core modules
  const lineScriptPanel = new LineScriptPanel(appContext);
  const lineScriptAI = new LineScriptAI(appContext, lineScriptPanel);
  const spottingController = new SpottingController(lineScriptPanel);
  const voiceSpottingController = new VoiceSpottingController(lineScriptPanel);
  const adaptiveModeManager = new AdaptiveModeManager(lineScriptPanel);
  
  // Initialize analysis modules
  const hookDetector = new HookDetector(appContext);
  const zzzDetector = new ZZZDetector(appContext);
  const energyAnalyzer = new EnergyAnalyzer(appContext);
  const customBeatPrompts = new CustomBeatPrompts(appContext);
  const quoteFinder = new QuoteFinder(appContext);
  const projectRating = new ProjectRating(appContext, ratingStorage);
  
  // Initialize export presets
  const exportPresets = new ExportPresets(appContext);
  
  // Attach modules to app
  app.lineScriptPanel = lineScriptPanel;
  app.lineScriptAI = lineScriptAI;
  app.spottingController = spottingController;
  app.voiceSpottingController = voiceSpottingController;
  app.adaptiveModeManager = adaptiveModeManager;
  app.hookDetector = hookDetector;
  app.zzzDetector = zzzDetector;
  app.energyAnalyzer = energyAnalyzer;
  app.customBeatPrompts = customBeatPrompts;
  app.quoteFinder = quoteFinder;
  app.projectRating = projectRating;
  app.ratingStorage = ratingStorage;
  app.exportPresets = exportPresets;
  app.EXPORT_FORMATS = EXPORT_FORMATS;
  
  // Initialize the panel
  lineScriptPanel.init();
  
  // Initialize production script manager event listeners
  setupProductionScriptSync(app, lineScriptPanel.productionScriptManager);
  
  // Set up AI metadata generation handler
  setupAIGenerationHandler(app, lineScriptPanel, lineScriptAI);
  
  // Set up cross-view marker synchronization
  setupMarkerSync(app);
  
  // Set up video event handlers
  setupVideoSync(app, lineScriptPanel);
  
  // Set up transcript sync
  setupTranscriptSync(app);
  
  // Set up template switching
  setupTemplateHandlers(app, lineScriptPanel, lineScriptAI);
  
  // Set up analysis handlers
  setupAnalysisHandlers(app);
  
  // Set up export handlers
  setupExportHandlers(app, exportPresets);
  
  // Hook into layout switching
  hookLayoutSwitching(app, lineScriptPanel, adaptiveModeManager, spottingController);
  
  window.logging.info('video', 'LineScriptBridge Line Script modules initialized');
  
  return {
    lineScriptPanel,
    lineScriptAI,
    spottingController,
    voiceSpottingController,
    adaptiveModeManager,
    hookDetector,
    zzzDetector,
    energyAnalyzer,
    customBeatPrompts,
    quoteFinder,
    projectRating,
    exportPresets,
    ratingStorage
  };
}

/**
 * Set up production script synchronization
 */
function setupProductionScriptSync(app, productionScriptManager) {
  // Save production directions when they change
  productionScriptManager.on('directionAdded', () => {
    if (app.lineScriptPanel) {
      app.lineScriptPanel.saveProductionDirections();
    }
  });
  
  productionScriptManager.on('directionUpdated', () => {
    if (app.lineScriptPanel) {
      app.lineScriptPanel.saveProductionDirections();
    }
  });
  
  productionScriptManager.on('directionDeleted', () => {
    if (app.lineScriptPanel) {
      app.lineScriptPanel.saveProductionDirections();
    }
  });
  
  window.logging.info('video', 'LineScriptBridge production script sync initialized');
}

/**
 * Set up AI metadata generation handler
 */
function setupAIGenerationHandler(app, lineScriptPanel, lineScriptAI) {
  // Listen for generateAIMetadata event from the panel
  lineScriptPanel.on('generateAIMetadata', async () => {
    window.logging.info('video', 'LineScriptBridge generate AI metadata requested');
    
    // Get transcript data
    const words = lineScriptPanel.words || [];
    const transcriptSegments = app.transcriptSegments || [];
    
    if (words.length === 0) {
      app.showToast?.('No transcript data available for AI analysis', 'warning');
      return;
    }
    
    try {
      // Show progress state on panel
      lineScriptPanel.aiGenerating = true;
      lineScriptPanel.render();
      
      // Analyze and chunk the transcript
      await lineScriptAI.analyzeAndChunk(transcriptSegments, words);
      
      if (lineScriptAI.chunks.length === 0) {
        app.showToast?.('No chunks created from transcript', 'warning');
        lineScriptPanel.aiGenerating = false;
        lineScriptPanel.render();
        return;
      }
      
      app.showToast?.(`Analyzing ${lineScriptAI.chunks.length} segments...`, 'info');
      
      // Set up progress handler
      lineScriptAI.on('progress', (data) => {
        lineScriptPanel.aiProgress = { current: data.current, total: data.total };
        window.logging.info('video', 'LineScriptBridge AI progress', { current: data.current, total: data.total });
      });
      
      // Set up approval handler - auto-approve for now
      lineScriptAI.on('awaitingApproval', (data) => {
        // Auto-approve each chunk (user can review markers later)
        window.logging.info('video', 'LineScriptBridge auto-approving chunk', { chunkId: data.result.chunkId });
        lineScriptAI.approveChunk();
      });
      
      // Start processing
      const results = await lineScriptAI.startProcessing();
      
      // Apply results to markers
      if (results && results.length > 0 && app.markerManager) {
        lineScriptAI.applyResultsToMarkers(app.markerManager);
        app.showToast?.(`Generated metadata for ${results.length} segments`, 'success');
      }
      
      // Reset state
      lineScriptPanel.aiGenerating = false;
      lineScriptPanel.aiProgress = { current: 0, total: 0 };
      lineScriptPanel.loadMarkers();
      lineScriptPanel.render();
      
    } catch (error) {
      window.logging.error('video', 'LineScriptBridge AI generation error', { error: error.message || error });
      app.showToast?.('AI generation failed: ' + error.message, 'error');
      lineScriptPanel.aiGenerating = false;
      lineScriptPanel.render();
    }
  });
  
  window.logging.info('video', 'LineScriptBridge AI generation handler initialized');
}

/**
 * Set up marker synchronization between views
 */
function setupMarkerSync(app) {
  if (!app.markerManager) {
    window.logging.warn('video', 'LineScriptBridge MarkerManager not available for sync');
    return;
  }
  
  // Listen to marker changes from MarkerManager
  app.markerManager.on('markerAdded', (data) => {
    window.logging.info('video', 'LineScriptBridge marker added', { markerId: data.marker.id });
    
    // Update Line Script panel
    if (app.lineScriptPanel) {
      app.lineScriptPanel.onMarkerAdded(data.marker);
    }
    
    // Update timeline if available
    app.updateTimeline?.();
    
    // Update teleprompter markers
    updateTeleprompterMarkers(app);
  });
  
  app.markerManager.on('markerUpdated', (data) => {
    window.logging.info('video', 'LineScriptBridge marker updated', { markerId: data.marker.id });
    
    if (app.lineScriptPanel) {
      app.lineScriptPanel.onMarkerUpdated(data.marker);
    }
    
    app.updateTimeline?.();
    updateTeleprompterMarkers(app);
  });
  
  app.markerManager.on('markerDeleted', (data) => {
    window.logging.info('video', 'LineScriptBridge marker deleted', { markerId: data.markerId });
    
    if (app.lineScriptPanel) {
      app.lineScriptPanel.onMarkerDeleted(data.markerId);
    }
    
    app.updateTimeline?.();
    updateTeleprompterMarkers(app);
  });
}

/**
 * Update teleprompter markers display
 */
function updateTeleprompterMarkers(app) {
  // This integrates with the existing teleprompter system
  // to show markers inline with the transcript
  const teleprompterWords = document.getElementById('teleprompterWords');
  if (!teleprompterWords || !app.markerManager) return;
  
  // Clear existing marker indicators
  teleprompterWords.querySelectorAll('.marker-indicator').forEach(el => el.remove());
  
  // Get markers and add indicators
  const markers = app.markerManager.getAll();
  markers.forEach(marker => {
    // Find the word element closest to this marker time
    const wordElements = teleprompterWords.querySelectorAll('.teleprompter-word');
    let closestWord = null;
    let minDiff = Infinity;
    
    wordElements.forEach(word => {
      const wordTime = parseFloat(word.dataset.start);
      if (!isNaN(wordTime)) {
        const diff = Math.abs(wordTime - marker.time);
        if (diff < minDiff) {
          minDiff = diff;
          closestWord = word;
        }
      }
    });
    
    if (closestWord && minDiff < 0.5) {
      // Add marker indicator
      const indicator = document.createElement('span');
      indicator.className = 'marker-indicator';
      indicator.style.cssText = `
        display: inline-block;
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: ${marker.color || '#4a9eff'};
        margin-left: 2px;
        vertical-align: middle;
      `;
      indicator.title = marker.name || 'Marker';
      closestWord.appendChild(indicator);
    }
  });
}

/**
 * Set up video playback synchronization
 */
function setupVideoSync(app, lineScriptPanel) {
  const video = document.getElementById('videoPlayer');
  if (!video) return;
  
  // Time update - sync current position
  video.addEventListener('timeupdate', () => {
    if (lineScriptPanel) {
      lineScriptPanel.onTimeUpdate(video.currentTime);
    }
    
    // Update timecode displays
    updateTimecodeDisplay(video.currentTime, video.duration);
  });
  
  // Play/pause state changes
  video.addEventListener('play', () => {
    if (app.adaptiveModeManager) {
      app.adaptiveModeManager.addSignal('video-playing');
    }
    if (lineScriptPanel) {
      lineScriptPanel.onPlaybackStateChange(true);
    }
  });
  
  video.addEventListener('pause', () => {
    if (app.adaptiveModeManager) {
      app.adaptiveModeManager.removeSignal('video-playing');
    }
    if (lineScriptPanel) {
      lineScriptPanel.onPlaybackStateChange(false);
    }
  });
  
  // Video loaded
  video.addEventListener('loadedmetadata', () => {
    if (lineScriptPanel) {
      lineScriptPanel.onVideoLoaded({
        duration: video.duration,
        path: app.videoPath
      });
    }
    
    // Update duration display
    updateTimecodeDisplay(0, video.duration);
  });
}

/**
 * Update timecode display elements
 */
function updateTimecodeDisplay(currentTime, duration) {
  const currentEl = document.getElementById('lineScriptCurrentTime');
  const totalEl = document.getElementById('lineScriptTotalTime');
  
  if (currentEl) {
    currentEl.textContent = formatTimecode(currentTime);
  }
  if (totalEl) {
    totalEl.textContent = formatTimecode(duration || 0);
  }
}

/**
 * Format time to SMPTE-style timecode
 */
function formatTimecode(seconds, fps = 30) {
  if (!seconds || isNaN(seconds)) return '00:00:00:00';
  
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const f = Math.floor((seconds % 1) * fps);
  
  return [
    h.toString().padStart(2, '0'),
    m.toString().padStart(2, '0'),
    s.toString().padStart(2, '0'),
    f.toString().padStart(2, '0')
  ].join(':');
}

/**
 * Set up transcript data synchronization
 */
function setupTranscriptSync(app) {
  // Watch for transcript updates
  const originalSetTranscript = app.setTranscript?.bind(app);
  if (originalSetTranscript) {
    app.setTranscript = function(transcriptData) {
      originalSetTranscript(transcriptData);
      
      // Update Line Script panel with new transcript
      if (app.lineScriptPanel) {
        app.lineScriptPanel.loadTranscriptData();
        app.lineScriptPanel.render();
      }
    };
  }
  
  // Also watch for teleprompter word updates
  const originalRenderTeleprompterWords = app.renderTeleprompterWords?.bind(app);
  if (originalRenderTeleprompterWords) {
    app.renderTeleprompterWords = function() {
      originalRenderTeleprompterWords();
      
      // Sync to Line Script - reload transcript data from main app
      if (app.lineScriptPanel) {
        app.lineScriptPanel.loadTranscriptData();
        if (app.lineScriptPanel.visible) {
          app.lineScriptPanel.render();
        }
      }
    };
  }
  
  // Add a method to manually refresh transcript in Line Script
  app.refreshLineScriptTranscript = function() {
    if (app.lineScriptPanel) {
      window.logging.info('video', 'LineScriptBridge manually refreshing transcript');
      app.lineScriptPanel.loadTranscriptData();
      if (app.lineScriptPanel.visible) {
        app.lineScriptPanel.render();
      }
    }
  };
}

/**
 * Set up template switching handlers
 */
function setupTemplateHandlers(app, lineScriptPanel, lineScriptAI) {
  // Template button click handlers
  const templateButtons = document.querySelectorAll('#lineScriptTemplateButtons .template-btn');
  templateButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const templateId = btn.dataset.template;
      
      // Update button states
      templateButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      
      // Switch template in modules
      lineScriptPanel.setTemplate(templateId);
      lineScriptAI.setTemplate(templateId);
      
      if (app.voiceSpottingController) {
        app.voiceSpottingController.setTemplate(templateId);
      }
      if (app.spottingController) {
        app.spottingController.loadShortcuts(templateId);
      }
      
      window.logging.info('video', 'LineScriptBridge switched to template', { templateId });
    });
  });
}

/**
 * Set up analysis feature handlers
 */
function setupAnalysisHandlers(app) {
  // Hook Detection
  app.runHookDetection = async function() {
    if (!app.hookDetector || !app.videoPath) {
      app.showToast?.('Hook detection requires a loaded video', 'warning');
      return null;
    }
    
    try {
      app.showToast?.('Analyzing for hooks...', 'info');
      const results = await app.hookDetector.analyzeVideo(
        app.videoPath,
        app.transcriptSegments || []
      );
      
      if (results.bestOpening) {
        app.showToast?.(`Found ${results.hooks.length} hooks. Best opening at ${formatTimecode(results.bestOpening.time)}`, 'success');
      }
      
      return results;
    } catch (error) {
      window.logging.error('video', 'LineScriptBridge Hook detection error', { error: error.message || error });
      app.showToast?.('Hook detection failed: ' + error.message, 'error');
      return null;
    }
  };
  
  // ZZZ Detection
  app.runZZZDetection = async function() {
    if (!app.zzzDetector || !app.videoPath) {
      app.showToast?.('ZZZ detection requires a loaded video', 'warning');
      return null;
    }
    
    try {
      app.showToast?.('Analyzing for low-energy sections...', 'info');
      const results = await app.zzzDetector.analyze(
        app.videoPath,
        app.transcriptSegments || []
      );
      
      if (results.autoEditList.length > 0) {
        app.showToast?.(`Found ${results.zzzSections.length} ZZZ sections with ${results.autoEditList.length} suggested edits`, 'success');
      } else {
        app.showToast?.('No low-energy sections detected', 'success');
      }
      
      return results;
    } catch (error) {
      window.logging.error('video', 'LineScriptBridge ZZZ detection error', { error: error.message || error });
      app.showToast?.('ZZZ detection failed: ' + error.message, 'error');
      return null;
    }
  };
  
  // Energy Analysis
  app.runEnergyAnalysis = async function() {
    if (!app.energyAnalyzer || !app.videoPath) {
      app.showToast?.('Energy analysis requires a loaded video', 'warning');
      return null;
    }
    
    try {
      app.showToast?.('Running energy analysis...', 'info');
      const results = await app.energyAnalyzer.analyzeFullVideo(
        app.videoPath,
        app.transcriptSegments || []
      );
      
      app.showToast?.(`Energy analysis complete: Average ${Math.round(results.averageEnergy * 100)}%`, 'success');
      
      return results;
    } catch (error) {
      window.logging.error('video', 'LineScriptBridge Energy analysis error', { error: error.message || error });
      app.showToast?.('Energy analysis failed: ' + error.message, 'error');
      return null;
    }
  };
  
  // Quote Finding (Podcast)
  app.findQuotes = async function(options = {}) {
    if (!app.quoteFinder) {
      app.showToast?.('Quote finder not available', 'warning');
      return null;
    }
    
    try {
      app.showToast?.('Finding quotable moments...', 'info');
      const quotes = await app.quoteFinder.findBestQuotes(
        app.transcriptSegments || [],
        options
      );
      
      app.showToast?.(`Found ${quotes.length} quotable moments`, 'success');
      
      return quotes;
    } catch (error) {
      window.logging.error('video', 'LineScriptBridge Quote finding error', { error: error.message || error });
      app.showToast?.('Quote finding failed: ' + error.message, 'error');
      return null;
    }
  };
  
  // Topic Detection
  app.detectTopics = async function() {
    if (!app.quoteFinder) {
      app.showToast?.('Topic detection not available', 'warning');
      return null;
    }
    
    try {
      app.showToast?.('Detecting topics...', 'info');
      const topics = await app.quoteFinder.detectTopics(
        app.transcriptSegments || []
      );
      
      app.showToast?.(`Detected ${topics.length} topic segments`, 'success');
      
      return topics;
    } catch (error) {
      window.logging.error('video', 'LineScriptBridge Topic detection error', { error: error.message || error });
      app.showToast?.('Topic detection failed: ' + error.message, 'error');
      return null;
    }
  };
  
  // Custom Beat Detection
  app.runCustomBeatDetection = async function(templateId) {
    if (!app.customBeatPrompts) {
      app.showToast?.('Custom beat detection not available', 'warning');
      return null;
    }
    
    try {
      app.showToast?.('Running beat detection...', 'info');
      const beats = await app.customBeatPrompts.runDetection(
        templateId,
        app.transcriptSegments || []
      );
      
      app.showToast?.(`Found ${beats.length} beats`, 'success');
      
      return beats;
    } catch (error) {
      window.logging.error('video', 'LineScriptBridge Beat detection error', { error: error.message || error });
      app.showToast?.('Beat detection failed: ' + error.message, 'error');
      return null;
    }
  };
  
  // Project Rating
  app.rateCurrentProject = async function(customCriteria = null) {
    if (!app.projectRating) {
      app.showToast?.('Project rating not available', 'warning');
      return null;
    }
    
    try {
      app.showToast?.('Rating project...', 'info');
      
      // Build project data
      const projectData = {
        id: app.currentProjectId || Date.now().toString(),
        name: app.videoPath?.split('/').pop() || 'Untitled',
        templateId: app.lineScriptPanel?.currentTemplate || 'podcast',
        videoPath: app.videoPath,
        transcriptSegments: app.transcriptSegments || [],
        markers: app.markerManager?.getAll() || [],
        duration: document.getElementById('videoPlayer')?.duration || 0
      };
      
      // Set custom criteria if provided
      if (customCriteria) {
        app.projectRating.setCustomCriteria(customCriteria);
      }
      
      const rating = await app.projectRating.rateProject(
        projectData,
        projectData.templateId,
        {
          hooks: app.lastHookResults,
          zzz: app.lastZZZResults,
          energy: app.lastEnergyResults
        }
      );
      
      app.showToast?.(`Project rated: ${rating.overallScore.toFixed(1)}/5`, 'success');
      
      return rating;
    } catch (error) {
      window.logging.error('video', 'LineScriptBridge Project rating error', { error: error.message || error });
      app.showToast?.('Project rating failed: ' + error.message, 'error');
      return null;
    }
  };
}

/**
 * Set up export handlers for Line Script exports
 */
function setupExportHandlers(app, exportPresets) {
  /**
   * Get available export formats for current template
   */
  app.getExportFormats = function(templateId = null) {
    const template = templateId || app.lineScriptPanel?.currentTemplate || 'podcast';
    return exportPresets.getFormatsForTemplate(template);
  };
  
  /**
   * Generate and preview an export
   */
  app.previewExport = async function(formatId, templateId = null) {
    const template = templateId || app.lineScriptPanel?.currentTemplate || 'podcast';
    
    try {
      // Build export data
      const data = buildExportData(app, template);
      
      // Generate export content
      const content = await exportPresets.generateExport(formatId, template, data);
      
      // Show in preview area
      const previewEl = document.getElementById('lineScriptExportPreview');
      if (previewEl) {
        previewEl.textContent = content;
      }
      
      return content;
    } catch (error) {
      window.logging.error('video', 'LineScriptBridge Export preview error', { error: error.message || error });
      app.showToast?.('Export preview failed: ' + error.message, 'error');
      return null;
    }
  };
  
  /**
   * Export Line Script in the specified format
   */
  app.exportLineScript = async function(formatId = null, templateId = null) {
    const template = templateId || app.lineScriptPanel?.currentTemplate || 'podcast';
    const formats = exportPresets.getFormatsForTemplate(template);
    
    // If no format specified, use the first available
    const format = formatId ? formats[formatId] : Object.values(formats)[0];
    if (!format) {
      app.showToast?.('No export format selected', 'warning');
      return;
    }
    
    try {
      app.showToast?.(`Generating ${format.name}...`, 'info');
      
      // Build export data
      const data = buildExportData(app, template);
      
      // Generate export content
      const content = await exportPresets.generateExport(format.id, template, data);
      
      // Create filename
      const videoName = app.videoPath?.split('/').pop()?.replace(/\.[^.]+$/, '') || 'export';
      const filename = `${videoName}-${format.id}.${format.extension}`;
      
      // Download file
      exportPresets.downloadExport(content, filename, format.mimeType);
      
      app.showToast?.(`${format.name} exported successfully`, 'success');
      
      return { content, filename };
    } catch (error) {
      window.logging.error('video', 'LineScriptBridge Export error', { error: error.message || error });
      app.showToast?.('Export failed: ' + error.message, 'error');
      return null;
    }
  };
  
  /**
   * Copy Line Script export to clipboard
   */
  app.copyLineScriptToClipboard = async function(formatId = null, templateId = null) {
    const template = templateId || app.lineScriptPanel?.currentTemplate || 'podcast';
    const formats = exportPresets.getFormatsForTemplate(template);
    
    // Default to YouTube chapters for quick copy
    const format = formatId ? formats[formatId] : formats['youtube-chapters'] || Object.values(formats)[0];
    if (!format) {
      app.showToast?.('No export format available', 'warning');
      return false;
    }
    
    try {
      // Build export data
      const data = buildExportData(app, template);
      
      // Generate export content
      const content = await exportPresets.generateExport(format.id, template, data);
      
      // Copy to clipboard
      const success = await exportPresets.copyToClipboard(content);
      
      if (success) {
        app.showToast?.(`${format.name} copied to clipboard`, 'success');
      } else {
        app.showToast?.('Failed to copy to clipboard', 'error');
      }
      
      return success;
    } catch (error) {
      window.logging.error('video', 'LineScriptBridge Copy error', { error: error.message || error });
      app.showToast?.('Copy failed: ' + error.message, 'error');
      return false;
    }
  };
  
  /**
   * Export all formats for a template
   */
  app.exportAllFormats = async function(templateId = null) {
    const template = templateId || app.lineScriptPanel?.currentTemplate || 'podcast';
    const formats = exportPresets.getFormatsForTemplate(template);
    
    const results = [];
    
    for (const format of Object.values(formats)) {
      try {
        const result = await app.exportLineScript(format.id, template);
        if (result) {
          results.push({ format: format.id, success: true, filename: result.filename });
        }
      } catch (error) {
        results.push({ format: format.id, success: false, error: error.message });
      }
    }
    
    const successCount = results.filter(r => r.success).length;
    app.showToast?.(`Exported ${successCount}/${results.length} formats`, successCount > 0 ? 'success' : 'error');
    
    return results;
  };
  
  /**
   * Export production script as formatted document
   */
  app.exportProductionScriptDocument = function() {
    if (!app.lineScriptPanel) {
      app.showToast?.('Production script not available', 'warning');
      return;
    }
    
    return app.lineScriptPanel.exportProductionScript();
  };
  
  /**
   * Export shot list from production script
   */
  app.exportProductionShotList = function() {
    if (!app.lineScriptPanel) {
      app.showToast?.('Production script not available', 'warning');
      return;
    }
    
    return app.lineScriptPanel.exportShotList();
  };
  
  /**
   * Export camera report
   */
  app.exportCameraReport = function() {
    if (!app.lineScriptPanel?.productionScriptManager) {
      app.showToast?.('No camera directions to export', 'warning');
      return;
    }
    
    const directions = app.lineScriptPanel.productionScriptManager.getAll();
    if (directions.length === 0) {
      app.showToast?.('No camera directions to export', 'warning');
      return;
    }
    
    // Generate camera report grouped by type
    let report = '# CAMERA REPORT\n\n';
    report += `Generated: ${new Date().toLocaleString()}\n`;
    report += `Total Directions: ${directions.length}\n\n`;
    report += '---\n\n';
    
    // Group by shot type
    const shotTypes = {};
    const movements = {};
    const angles = {};
    
    directions.forEach(dir => {
      if (dir.shotType) {
        shotTypes[dir.shotType] = (shotTypes[dir.shotType] || 0) + 1;
      }
      if (dir.cameraMovement) {
        movements[dir.cameraMovement] = (movements[dir.cameraMovement] || 0) + 1;
      }
      if (dir.cameraAngle) {
        angles[dir.cameraAngle] = (angles[dir.cameraAngle] || 0) + 1;
      }
    });
    
    report += '## Shot Types\n\n';
    Object.entries(shotTypes).forEach(([type, count]) => {
      report += `- ${type}: ${count}\n`;
    });
    
    report += '\n## Camera Movements\n\n';
    Object.entries(movements).forEach(([movement, count]) => {
      report += `- ${movement}: ${count}\n`;
    });
    
    report += '\n## Camera Angles\n\n';
    Object.entries(angles).forEach(([angle, count]) => {
      report += `- ${angle}: ${count}\n`;
    });
    
    report += '\n---\n\n## Detailed Shot Log\n\n';
    directions.forEach((dir, idx) => {
      const timecode = app.lineScriptPanel.formatTimecode(dir.time);
      report += `${idx + 1}. [${timecode}] ${dir.getFullName()}\n`;
      if (dir.description) {
        report += `   ${dir.description}\n`;
      }
      report += '\n';
    });
    
    // Download
    const blob = new Blob([report], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'camera-report.txt';
    a.click();
    URL.revokeObjectURL(url);
    
    app.showToast?.('Camera report exported', 'success');
  };
  
  /**
   * Populate export format buttons in the UI
   */
  app.populateExportFormats = function(templateId = null) {
    const template = templateId || app.lineScriptPanel?.currentTemplate || 'podcast';
    const formats = exportPresets.getFormatsForTemplate(template);
    
    const container = document.getElementById('lineScriptExportFormats');
    if (!container) return;
    
    container.innerHTML = '';
    
    Object.values(formats).forEach(format => {
      const btn = document.createElement('button');
      btn.className = 'export-btn';
      btn.dataset.format = format.id;
      btn.innerHTML = `
        <span class="export-icon">${format.icon}</span>
        <span class="export-name">${format.name}</span>
        <span class="export-format">.${format.extension}</span>
      `;
      btn.title = format.description;
      btn.onclick = () => {
        // Preview on click
        app.previewExport(format.id, template);
        // Highlight selected
        container.querySelectorAll('.export-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        // Store selected format
        app._selectedExportFormat = format.id;
      };
      
      container.appendChild(btn);
    });
  };
  
  window.logging.info('video', 'LineScriptBridge Export handlers initialized');
}

/**
 * Build export data from app state
 */
function buildExportData(app, templateId) {
  return {
    title: app.videoPath?.split('/').pop()?.replace(/\.[^.]+$/, '') || 'Video',
    duration: document.getElementById('videoPlayer')?.duration || 0,
    markers: app.markerManager?.getAll() || [],
    segments: app.transcriptSegments || [],
    speakers: app.speakers || [],
    topics: app.lastTopicResults || [],
    quotes: app.lastQuoteResults || [],
    hooks: app.lastHookResults?.allHooks || [],
    templateId
  };
}

/**
 * Hook into layout switching to show/hide Line Script
 */
function hookLayoutSwitching(app, lineScriptPanel, adaptiveModeManager, spottingController) {
  const originalSwitchLayout = app.switchLayout?.bind(app);
  
  if (typeof originalSwitchLayout === 'function') {
    app.switchLayout = function(layout) {
      originalSwitchLayout(layout);
      
      if (layout === 'linescript') {
        
        // Show Line Script panel
        lineScriptPanel.show();
        
        // Initialize adaptive mode
        adaptiveModeManager.init();
        
        // Initialize spotting controller
        spottingController.init();
        
        // Load current transcript if available - always reload from main app
        lineScriptPanel.loadTranscriptData();
        window.logging.info('video', 'LineScriptBridge Transcript data reloaded for linescript layout');
        
        window.logging.info('video', 'LineScriptBridge Line Script layout activated');
      } else {
        // Hide Line Script panel
        lineScriptPanel.hide();
        
        // Deactivate spotting
        spottingController.deactivate?.();
        
        // Stop voice spotting if active
        if (app.voiceSpottingController?.isActive) {
          app.voiceSpottingController.stop();
        }
      }
    };
    
    window.logging.info('video', 'LineScriptBridge Hooked switchLayout for Line Script');
  }
}

/**
 * Export the bridge initialization function
 */
export default initLineScriptBridge;











