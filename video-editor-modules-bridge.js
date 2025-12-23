/**
 * Video Editor Modules Bridge
 *
 * Wires the modular implementation in `src/video-editor/*` into the existing
 * legacy `video-editor-app.js` runtime, without forcing a big-bang rewrite.
 *
 * Loaded as an ES module from `video-editor.html` after `video-editor-app.js`.
 */
import { initVideoEditorModules } from './src/video-editor/index.js';
import { StoryBeatsEditor, EditToolbar, VideoSyncEngine, MiniTimeline } from './src/video-editor/storybeats/index.js';
import { StateManager } from './src/state-manager/StateManager.js';
import { DeploymentVersionManager } from './src/state-manager/DeploymentVersionManager.js';

// Line Script Bridge is loaded dynamically to prevent import errors from breaking other features
let initLineScriptBridge = null;

function getApp() {
  return window.app;
}

const app = getApp();

if (!app) {
  // Keep the editor working even if this loads early / app boot changes.
  console.warn('[VideoEditorModulesBridge] window.app not found; modules not initialized');
} else {
  try {
    initVideoEditorModules(app);
    
    console.log('[VideoEditorModulesBridge] Modules initialized:', {
      teleprompter: !!app.teleprompter,
      transcriptSync: !!app.transcriptSync,
      teleprompterMarkers: !!app.teleprompterMarkers,
      waveform: !!app.waveform,
      markerManager: !!app.markerManager,
      markerRenderer: !!app.markerRenderer,
      markerModal: !!app.markerModal,
    });
    
    // ============================================================
    // STORY BEATS EDITOR MODULE
    // ============================================================
    
    // Initialize story beats components
    app.storyBeatsEditor = new StoryBeatsEditor(app);
    app.storyBeatsToolbar = new EditToolbar(app);
    app.videoSyncEngine = new VideoSyncEngine(app);
    app.storyBeatsMiniTimeline = new MiniTimeline(app);
    
    console.log('[VideoEditorModulesBridge] Story Beats modules initialized');
    
    // Story Beats helper methods
    
    /**
     * Initialize the story beats editor when switching to beats layout
     * Passes transcript with speaker identification data
     */
    app.initStoryBeatsEditor = function() {
      if (!app.storyBeatsEditor) return;
      
      // Pass speaker identification data to the editor
      // These are set when transcript is loaded or speakers are identified
      app.storyBeatsEditor.app = {
        ...app,
        // Transcript data
        teleprompterWords: app.teleprompterWords || [],
        transcriptSegments: app.transcriptSegments || [],
        // Speaker identification
        speakers: app.currentVideoMetadata?.speakers || app.speakers || [],
        speakersIdentified: app.currentVideoMetadata?.speakersIdentified || app.speakersIdentified || false,
        rawTranscript: app.currentVideoMetadata?.transcript || app.rawTranscript || '',
        // Markers become scenes
        markers: app.markers || [],
        markerManager: app.markerManager
      };
      
      app.storyBeatsEditor.init();
      app.storyBeatsMiniTimeline?.init();
      
      // Set video duration for sync engine
      const video = document.getElementById('videoPlayer');
      if (video?.duration) {
        app.videoSyncEngine?.init(video.duration);
        app.storyBeatsMiniTimeline?.setOriginalDuration(video.duration);
        app.storyBeatsMiniTimeline?.startPlayheadTracking();
      }
      
      // Update script stats display
      const wordCount = document.getElementById('storyBeatsWordCount');
      if (wordCount) {
        const words = app.storyBeatsEditor.words?.length || 0;
        const scenes = app.storyBeatsEditor.markers?.length || 0;
        const speakers = app.storyBeatsEditor.speakers?.length || 0;
        
        let statsText = `${words} words`;
        if (scenes > 0) statsText += ` • ${scenes} scenes`;
        if (speakers > 0) statsText += ` • ${speakers} speakers`;
        
        wordCount.textContent = statsText;
      }
    };
    
    /**
     * Show the story beats editor
     */
    app.showStoryBeatsEditor = function() {
      app.storyBeatsEditor?.show();
      app.storyBeatsMiniTimeline?.show();
      app.initStoryBeatsEditor();
    };
    
    /**
     * Hide the story beats editor
     */
    app.hideStoryBeatsEditor = function() {
      app.storyBeatsEditor?.hide();
      app.storyBeatsMiniTimeline?.hide();
    };
    
    /**
     * Refresh the story beats editor
     */
    app.refreshStoryBeatsEditor = function() {
      app.storyBeatsEditor?.refresh();
    };
    
    /**
     * Scroll to current playhead time in editor
     */
    app.scrollToCurrentTime = function() {
      const video = document.getElementById('videoPlayer');
      if (video) {
        app.storyBeatsEditor?.scrollToTime(video.currentTime);
      }
    };
    
    /**
     * Export the script from story beats editor in screenplay format
     */
    app.exportStoryBeatsTranscript = function() {
      const editor = app.storyBeatsEditor;
      
      if (!editor?.words?.length && !editor?.dialogueBlocks?.length) {
        app.showToast?.('error', 'No script to export');
        return;
      }
      
      let output = '';
      const title = app.videoInfo?.name || app.currentVideoMetadata?.title || 'Untitled';
      
      // Script header
      output += `${title.toUpperCase()}\n`;
      output += `${'='.repeat(title.length)}\n\n`;
      output += `Generated: ${new Date().toLocaleString()}\n`;
      if (editor.speakers?.length > 0) {
        output += `Speakers: ${editor.speakers.join(', ')}\n`;
      }
      output += `\n${'─'.repeat(60)}\n\n`;
      
      // If we have dialogue blocks with speakers, export in screenplay format
      if (editor.dialogueBlocks?.length > 0) {
        let sceneNumber = 0;
        let lastMarkerId = null;
        
        editor.dialogueBlocks.forEach((block, idx) => {
          const blockTime = block.startTime || 0;
          
          // Check for scene header
          const marker = editor.getMarkerAtTime?.(blockTime);
          if (marker && marker.id !== lastMarkerId) {
            sceneNumber++;
            const sceneType = editor.getSceneType?.(marker) || 'SCENE';
            const name = (marker.name || 'Scene').toUpperCase();
            output += `\n${sceneType} ${sceneNumber}: ${name}\n`;
            output += `[${editor.formatTimecode(marker.inTime)} - ${editor.formatTimecode(marker.outTime)}]\n\n`;
            lastMarkerId = marker.id;
          }
          
          // Character cue
          if (block.speaker) {
            output += `\n                    ${block.speaker.toUpperCase()}\n`;
          }
          
          // Dialogue (indented)
          const lines = block.text.match(/.{1,50}(?:\\s|$)/g) || [block.text];
          lines.forEach(line => {
            output += `          ${line.trim()}\n`;
          });
        });
      } else {
        // Fall back to plain transcript
        output += editor.words.map(w => w.text).join(' ');
      }
      
      // Create and download
      const blob = new Blob([output], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${title.replace(/[^a-z0-9]/gi, '_')}_script.txt`;
      a.click();
      URL.revokeObjectURL(url);
      
      app.showToast?.('success', 'Script exported');
    };
    
    /**
     * Apply all story beats edits to the video
     */
    app.applyStoryBeatsEdits = async function() {
      if (!app.videoSyncEngine?.hasEdits()) {
        app.showToast?.('info', 'No edits to apply');
        return;
      }
      
      // Confirm before applying
      const summary = app.videoSyncEngine.getEditSummary();
      const message = `Apply ${summary.deletionCount + summary.gapCount + summary.replacementCount} edit(s)?\\n\\n` +
        `- ${summary.deletionCount} deletion(s) (${summary.totalCutTime.toFixed(1)}s)\\n` +
        `- ${summary.gapCount} gap(s) (${summary.totalGapTime.toFixed(1)}s)\\n\\n` +
        `New duration: ${(summary.newDuration / 60).toFixed(1)} min`;
      
      if (!confirm(message)) {
        return;
      }
      
      await app.videoSyncEngine.applyAllEdits();
    };
    
    /**
     * Clear all story beats edits
     */
    app.clearStoryBeatsEdits = function() {
      if (!app.videoSyncEngine?.hasEdits()) {
        app.showToast?.('info', 'No edits to clear');
        return;
      }
      
      if (confirm('Clear all pending edits?')) {
        app.videoSyncEngine.clearAllEdits();
        app.showToast?.('success', 'Edits cleared');
      }
    };
    
    // Hook into layout switching to show/hide story beats editor
    const originalSwitchLayout = app.switchLayout;
    if (typeof originalSwitchLayout === 'function') {
      app.switchLayout = function(layout) {
        originalSwitchLayout.call(app, layout);
        
        if (layout === 'beats') {
          app.showStoryBeatsEditor();
        } else {
          app.hideStoryBeatsEditor();
        }
      };
      console.log('[VideoEditorModulesBridge] Hooked switchLayout for story beats');
    }
    
    // Initialize story beats when video is loaded
    const videoForStoryBeats = document.getElementById('videoPlayer');
    if (videoForStoryBeats) {
      videoForStoryBeats.addEventListener('loadedmetadata', () => {
        // Initialize sync engine with video duration
        if (app.videoSyncEngine && videoForStoryBeats.duration) {
          app.videoSyncEngine.init(videoForStoryBeats.duration);
        }
        if (app.storyBeatsMiniTimeline && videoForStoryBeats.duration) {
          app.storyBeatsMiniTimeline.setOriginalDuration(videoForStoryBeats.duration);
        }
      });
    }
    
    // ============================================================
    // END STORY BEATS EDITOR MODULE
    // ============================================================

    // ============================================================
    // LINE SCRIPT SYSTEM MODULE (loaded dynamically)
    // ============================================================
    
    // Dynamically import Line Script to prevent import errors from breaking other features
    (async () => {
      try {
        const lineScriptModule = await import('./src/video-editor/linescript/LineScriptBridge.js');
        initLineScriptBridge = lineScriptModule.initLineScriptBridge;
        
        if (initLineScriptBridge) {
          const lineScriptModules = initLineScriptBridge(app);
          console.log('[VideoEditorModulesBridge] Line Script modules initialized:', {
            lineScriptPanel: !!lineScriptModules.lineScriptPanel,
            lineScriptAI: !!lineScriptModules.lineScriptAI,
            hookDetector: !!lineScriptModules.hookDetector,
            zzzDetector: !!lineScriptModules.zzzDetector,
            energyAnalyzer: !!lineScriptModules.energyAnalyzer,
            voiceSpottingController: !!lineScriptModules.voiceSpottingController,
            projectRating: !!lineScriptModules.projectRating
          });
        }
      } catch (lineScriptError) {
        console.warn('[VideoEditorModulesBridge] Line Script modules failed to initialize:', lineScriptError);
        // Line Script is optional, don't block other features
      }
    })();
    
    // ============================================================
    // END LINE SCRIPT SYSTEM MODULE
    // ============================================================

    // Add safe aliases only if the legacy app doesn't already provide them.
    // These are used by inline onclick handlers in `video-editor.html`.
    const aliasesBefore = {
      toggleTeleprompter: !!app.toggleTeleprompter,
      openWaveformSettings: !!app.openWaveformSettings,
      closeWaveformSettings: !!app.closeWaveformSettings,
      setWaveformType: !!app.setWaveformType
    };
    
    if (!app.toggleTeleprompter && app.teleprompter) {
      app.toggleTeleprompter = () => app.teleprompter.toggle();
    }
    if (!app.openWaveformSettings && app.waveform) {
      app.openWaveformSettings = () => app.waveform.openSettings();
    }
    if (!app.closeWaveformSettings && app.waveform) {
      app.closeWaveformSettings = () => app.waveform.closeSettings();
    }
    if (!app.setWaveformType && app.waveform) {
      app.setWaveformType = (type) => app.waveform.setType(type);
    }
    
    // Track if we're inside setZoomToTime to avoid override conflicts
    let inSetZoomToTime = false;
    
    // Time-based zoom: show a specific duration in the visible timeline
    // seconds = 0 means "Fit" (show entire video)
    // seconds > 0 means show that many seconds visible in the timeline
    // If video is shorter than the selected time, empty track space will be shown
    app.setZoomToTime = function(seconds) {
      const video = document.getElementById('videoPlayer');
      const videoDuration = app.videoInfo?.duration || video?.duration || 0;
      
      if (!videoDuration || videoDuration <= 0) {
        console.warn('[Zoom] No video duration available');
        return;
      }
      
      let newZoom;
      let displayLabel;
      
      if (seconds === 0) {
        // "Fit" mode - show entire video
        newZoom = 1;
        displayLabel = 'Fit';
      } else {
        // Time-based zoom: always show exactly this many seconds
        // If video is shorter, clip will only fill part of timeline (showing empty space)
        // If video is longer, clip will extend beyond visible area (scrollable)
        newZoom = videoDuration / seconds;
        // Display label based on seconds
        if (seconds < 60) {
          displayLabel = `${seconds}s`;
        } else {
          displayLabel = `${Math.round(seconds / 60)}m`;
        }
      }
      
      // Mark that we're in setZoomToTime so the override doesn't clear our settings
      inSetZoomToTime = true;
      
      // BYPASS the capped setZoom - directly apply zoom without limits
      // The original setZoom caps at maxZoom (20), but time-based zoom needs higher values
      app.zoom = newZoom;
      app.timelineZoom = newZoom;
      
      // Update timeline content width (this is the main container that holds everything)
      const content = document.getElementById('timelineContent');
      if (content) {
        content.style.width = `${newZoom * 100}%`;
      }
      
      // Update ruler (timecode track)
      if (typeof app.updateTimelineRuler === 'function') {
        app.updateTimelineRuler();
      }
      
      // Re-render markers
      if (typeof app.renderMarkers === 'function') {
        app.renderMarkers();
      }
      
      // Update segments if they exist
      if (app.segments && app.segments.length > 1 && typeof app.renderSegments === 'function') {
        app.renderSegments();
      }
      
      // Update waveform for new zoom tier (debounced)
      if (typeof app.debouncedWaveformRegenerate === 'function') {
        app.debouncedWaveformRegenerate();
      }
      
      // Update thumbnails (debounced)
      if (typeof app.debouncedThumbnailReload === 'function') {
        app.debouncedThumbnailReload();
      }
      
      // Keep playhead centered during zoom
      if (typeof app.scrollToPlayhead === 'function') {
        app.scrollToPlayhead();
      }
      
      inSetZoomToTime = false;
      
      // Update zoom slider (clamped to slider's visual range, but actual zoom is unlimited)
      const zoomSlider = document.getElementById('zoomSlider');
      if (zoomSlider) {
        zoomSlider.value = Math.max(0.1, Math.min(newZoom, 20));
      }
      
      // Update zoom level display with time label
      const zoomLevelEl = document.getElementById('zoomLevel');
      if (zoomLevelEl) {
        zoomLevelEl.textContent = displayLabel;
      }
      
      // Update active preset button
      document.querySelectorAll('.zoom-preset-btn').forEach(btn => {
        const btnTime = parseInt(btn.dataset.time, 10);
        btn.classList.toggle('active', btnTime === seconds);
      });
      
      console.log(`[Zoom] Set to ${displayLabel} (${newZoom.toFixed(2)}x zoom for ${videoDuration.toFixed(0)}s video, showing ${seconds}s)`);
    };
    
    // Override setZoom to update the display label properly (only when using slider directly)
    const originalSetZoom = app.setZoom;
    if (typeof originalSetZoom === 'function') {
      app.setZoom = function(zoomLevel) {
        originalSetZoom.call(app, zoomLevel);
        
        // Skip label updates if called from setZoomToTime (it handles its own labels)
        if (inSetZoomToTime) {
          return;
        }
        
        // Calculate what time range this zoom level shows
        const video = document.getElementById('videoPlayer');
        const videoDuration = app.videoInfo?.duration || video?.duration || 0;
        
        if (videoDuration > 0) {
          const visibleSeconds = videoDuration / zoomLevel;
          const zoomLevelEl = document.getElementById('zoomLevel');
          
          if (zoomLevelEl) {
            if (zoomLevel <= 1.1) {
              zoomLevelEl.textContent = 'Fit';
            } else if (visibleSeconds < 60) {
              zoomLevelEl.textContent = `${Math.round(visibleSeconds)}s`;
            } else {
              zoomLevelEl.textContent = `${Math.round(visibleSeconds / 60)}m`;
            }
          }
        }
        
        // Clear active state from time-based presets when using slider
        document.querySelectorAll('.zoom-preset-btn').forEach(btn => {
          btn.classList.remove('active');
        });
      };
    }
    
    // ============================================================
    // AUDIO TRACK PERSISTENCE - Save and restore tracks
    // ============================================================
    
    /**
     * Serialize audio tracks for saving (removes non-serializable properties)
     * @returns {Array} Serializable array of track data
     */
    app.serializeAudioTracks = function() {
      const tracks = app.audioTracks || [];
      return tracks.map(track => ({
        id: track.id,
        type: track.type || 'original',
        name: track.name || `Track ${track.id}`,
        muted: track.muted || false,
        solo: track.solo || false,
        volume: track.volume || 1.0,
        sourceTrackId: track.sourceTrackId || null,
        clips: (track.clips || []).map(clip => ({
          id: clip.id,
          type: clip.type,
          name: clip.name,
          startTime: clip.startTime,
          endTime: clip.endTime,
          duration: clip.duration,
          sourceTrackId: clip.sourceTrackId,
          isVisualOnly: clip.isVisualOnly || false,
          audioPath: clip.audioPath || null
        }))
      }));
    };
    
    /**
     * Get project data including audio tracks for saving
     * This can be merged with the existing project save data
     */
    app.getAudioTracksForSave = function() {
      return {
        audioTracks: app.serializeAudioTracks(),
        nextTrackId: app.nextTrackId || 2
      };
    };
    
    /**
     * Deserialize audio tracks from saved data (e.g., for undo/redo)
     * Ensures A1 (original) track always exists
     * @param {Array} savedTracks - Serialized track data
     */
    app.deserializeAudioTracks = function(savedTracks) {
      const defaultA1 = { id: 'A1', type: 'original', name: 'Original', muted: false, solo: false, volume: 1.0, clips: [] };
      
      if (!savedTracks || !Array.isArray(savedTracks)) {
        console.warn('[deserializeAudioTracks] Invalid tracks data, ensuring A1 exists');
        // Even with invalid data, ensure A1 exists
        if (!app.audioTracks || app.audioTracks.length === 0) {
          app.audioTracks = [defaultA1];
        } else if (!app.audioTracks.some(t => t.id === 'A1')) {
          app.audioTracks = [defaultA1, ...app.audioTracks];
        }
        return;
      }
      
      // Ensure A1 (original) track exists
      const hasA1 = savedTracks.some(t => t.id === 'A1');
      if (hasA1) {
        app.audioTracks = savedTracks;
      } else {
        // Prepend default A1 track if missing
        app.audioTracks = [defaultA1, ...savedTracks];
      }
      
      // Final safety check - ensure A1 is present
      if (!app.audioTracks.some(t => t.id === 'A1')) {
        app.audioTracks = [defaultA1, ...app.audioTracks];
      }
      
      // Update nextTrackId based on highest track number
      const maxId = Math.max(...app.audioTracks.map(t => {
        const num = parseInt(t.id.replace('A', ''), 10);
        return isNaN(num) ? 0 : num;
      }));
      app.nextTrackId = Math.max(app.nextTrackId || 2, maxId + 1);
      
      // Re-render non-original tracks
      const container = document.getElementById('audioTracksContainer');
      if (container) {
        // Remove existing rendered tracks (except the original audio track container)
        container.querySelectorAll('.audio-track[data-track-id]').forEach(el => {
          if (el.dataset.trackId !== 'A1') {
            el.remove();
          }
        });
        
        // Render each non-original track
        app.audioTracks.forEach(track => {
          if (track.id !== 'A1' && track.type !== 'original' && typeof app.renderAudioTrack === 'function') {
            app.renderAudioTrack(track);
          }
        });
      }
      
      console.log('[deserializeAudioTracks] Restored', app.audioTracks.length, 'tracks:', app.audioTracks.map(t => t.id));
    };

    // ============================================================
    // PROJECT STATE PERSISTENCE - Save and restore full editor state
    // (stored on the Space item metadata.json via clipboard:update-metadata)
    // ============================================================

    function safeJsonClone(value) {
      try {
        return JSON.parse(JSON.stringify(value));
      } catch {
        return null;
      }
    }

    /**
     * Serialize the full video editor state for persistence.
     * IMPORTANT: Only include JSON-serializable data (no DOM nodes, no functions).
     */
    app.serializeProjectState = function() {
      const state = {
        schema: 'video-editor-project-state',
        schemaVersion: 1,
        savedAt: new Date().toISOString(),

        // Track system
        audioTracks: app.serializeAudioTracks(),
        nextTrackId: app.nextTrackId || 2,

        // Timeline / edits
        trimStart: app.trimStart || 0,
        trimEnd: app.trimEnd || 0,
        fades: safeJsonClone(app.fades) || { fadeIn: null, fadeOut: null },
        sliceMarkers: safeJsonClone(app.sliceMarkers) || [],
        segments: safeJsonClone(app.segments) || [],

        // Markers
        markers: safeJsonClone(app.markers) || [],
        nextMarkerId: app.nextMarkerId || 1,

        // Transcript / teleprompter state that impacts editing UX
        transcriptSegments: safeJsonClone(app.transcriptSegments) || null,
        transcriptSource: app.transcriptSource || null,

        // Translation workflow
        translationSegments: safeJsonClone(app.translationSegments) || [],
        translationState: safeJsonClone(app.translationState) || null,

        // ADR workflow (non-destructive metadata)
        adr: {
          deadSpaceRegions: safeJsonClone(app.adrManager?.deadSpaceRegions) || [],
        }
      };

      return state;
    };

    /**
     * Restore a previously-saved project state onto the running app.
     * Best-effort: only touches fields that exist on the current runtime.
     */
    app.restoreProjectState = function(projectState) {
      if (!projectState || typeof projectState !== 'object') return false;
      if (projectState.schema !== 'video-editor-project-state') return false;

      try {
        // Restore track system first (so downstream renders can reference tracks)
        if (Array.isArray(projectState.audioTracks)) {
          app.restoreAudioTracks(projectState.audioTracks);
        }
        if (typeof projectState.nextTrackId === 'number') {
          app.nextTrackId = projectState.nextTrackId;
        }

        // Restore core edit state
        if (typeof projectState.trimStart === 'number') app.trimStart = projectState.trimStart;
        if (typeof projectState.trimEnd === 'number') app.trimEnd = projectState.trimEnd;
        if (projectState.fades && typeof projectState.fades === 'object') app.fades = projectState.fades;
        if (Array.isArray(projectState.sliceMarkers)) app.sliceMarkers = projectState.sliceMarkers;
        if (Array.isArray(projectState.segments)) app.segments = projectState.segments;

        // Restore markers
        if (Array.isArray(projectState.markers)) app.markers = projectState.markers;
        if (typeof projectState.nextMarkerId === 'number') app.nextMarkerId = projectState.nextMarkerId;

        // Transcript / teleprompter
        if (projectState.transcriptSegments !== undefined) app.transcriptSegments = projectState.transcriptSegments;
        if (projectState.transcriptSource !== undefined) app.transcriptSource = projectState.transcriptSource;

        // Translation
        if (Array.isArray(projectState.translationSegments)) app.translationSegments = projectState.translationSegments;
        if (projectState.translationState && typeof projectState.translationState === 'object') {
          app.translationState = projectState.translationState;
        }

        // ADR
        if (projectState.adr && typeof projectState.adr === 'object') {
          if (Array.isArray(projectState.adr.deadSpaceRegions) && app.adrManager) {
            app.adrManager.deadSpaceRegions = projectState.adr.deadSpaceRegions;
            // Re-render if available
            if (typeof app.adrManager.renderDeadSpaceRegions === 'function') {
              app.adrManager.renderDeadSpaceRegions();
            }
          }
        }

        // Best-effort UI refresh
        if (typeof app.updateTrimRegion === 'function') app.updateTrimRegion();
        if (typeof app.renderClipOverlays === 'function') app.renderClipOverlays();
        if (typeof app.renderSegments === 'function') app.renderSegments();
        if (typeof app.renderMarkers === 'function') app.renderMarkers();
        if (typeof app.renderTranslationSegments === 'function') app.renderTranslationSegments();

        console.log('[VideoEditorModulesBridge] Restored project state from metadata');
        return true;
      } catch (e) {
        console.warn('[VideoEditorModulesBridge] Failed to restore project state:', e);
        return false;
      }
    };

    /**
     * Persist the current project state to the Space item's metadata.json
     * so it can be restored after app restart.
     */
    app.persistProjectStateToSpaceMetadata = async function() {
      if (!app.spaceItemId) return { success: false, error: 'No spaceItemId' };
      if (!window.clipboard || typeof window.clipboard.updateMetadata !== 'function') {
        return { success: false, error: 'clipboard.updateMetadata not available' };
      }

      const projectState = app.serializeProjectState();

      return await window.clipboard.updateMetadata(app.spaceItemId, {
        videoEditorProjectState: projectState,
        videoEditorProjectStateUpdatedAt: new Date().toISOString()
      });
    };
    
    /**
     * Restore audio tracks from saved project data
     * Called after a project is loaded to re-render any additional tracks
     * @param {Array} savedTracks - Optional array of tracks from saved project
     */
    app.restoreAudioTracks = function(savedTracks) {
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'video-editor-modules-bridge.js:restoreAudioTracks:entry',message:'restoreAudioTracks called',data:{savedTracksCount:savedTracks?.length,savedTrackIds:savedTracks?.map(t=>t.id),currentAudioTracksCount:app.audioTracks?.length},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H4'})}).catch(()=>{});
      // #endregion
      const container = document.getElementById('audioTracksContainer');
      const defaultA1 = { id: 'A1', type: 'original', name: 'Original', muted: false, solo: false, volume: 1.0, clips: [] };
      
      if (!container) {
        console.warn('[RestoreAudioTracks] Container not found');
        return;
      }
      
      // If savedTracks provided, restore them to app.audioTracks first
      // BUT only if current audioTracks doesn't already have these tracks
      if (savedTracks && Array.isArray(savedTracks) && savedTracks.length > 0) {
        const currentTrackIds = new Set((app.audioTracks || []).map(t => t.id));
        
        // Check if savedTracks contain tracks not in current audioTracks
        const newTracks = savedTracks.filter(t => !currentTrackIds.has(t.id));
        
        if (newTracks.length === 0 && app.audioTracks && app.audioTracks.length >= savedTracks.length) {
          // All saved tracks already exist in audioTracks - skip to avoid duplicates
          console.log('[RestoreAudioTracks] All tracks already loaded, skipping restore:', 
            app.audioTracks.map(t => t.id));
        } else {
          // Keep A1 (original) track, replace the rest
          const originalTrack = (app.audioTracks || []).find(t => t.id === 'A1');
          
          // Merge: keep existing A1 if not in savedTracks, add saved tracks
          const hasA1InSaved = savedTracks.some(t => t.id === 'A1');
          
          if (hasA1InSaved) {
            app.audioTracks = savedTracks;
          } else {
            // Use existing A1, or create default if missing
            const a1Track = originalTrack || defaultA1;
            app.audioTracks = [a1Track, ...savedTracks.filter(t => t.id !== 'A1')];
          }
          
          // Restore nextTrackId
          const maxId = Math.max(...app.audioTracks.map(t => {
            const num = parseInt(t.id.replace('A', ''), 10);
            return isNaN(num) ? 0 : num;
          }));
          app.nextTrackId = Math.max(app.nextTrackId || 2, maxId + 1);
          
          console.log('[RestoreAudioTracks] Restored audioTracks array:', 
            app.audioTracks.map(t => t.id), 'nextTrackId:', app.nextTrackId);
        }
      }
      
      // ALWAYS ensure A1 track exists in audioTracks
      if (!app.audioTracks || app.audioTracks.length === 0) {
        app.audioTracks = [defaultA1];
        console.log('[RestoreAudioTracks] Created default A1 track (audioTracks was empty)');
      } else if (!app.audioTracks.some(t => t.id === 'A1')) {
        app.audioTracks = [defaultA1, ...app.audioTracks];
        console.log('[RestoreAudioTracks] Prepended default A1 track (was missing)');
      }
      
      const audioTracks = app.audioTracks;
      
      // Get currently rendered track IDs
      const renderedTrackIds = new Set();
      container.querySelectorAll('.audio-track[data-track-id]').forEach(el => {
        renderedTrackIds.add(el.dataset.trackId);
      });
      
      // Find tracks that need to be rendered
      const tracksToRender = audioTracks.filter(track => 
        track.id !== 'A1' && !renderedTrackIds.has(track.id)
      );
      
      if (tracksToRender.length === 0) {
        console.log('[RestoreAudioTracks] No additional tracks to render');
        return;
      }
      
      console.log('[RestoreAudioTracks] Rendering', tracksToRender.length, 'tracks:', 
        tracksToRender.map(t => t.id));
      
      // Render each track
      tracksToRender.forEach(track => {
        if (typeof app.renderAudioTrack === 'function') {
          app.renderAudioTrack(track);
        }
      });
      
      // Render clips for tracks that have them (after a delay to ensure DOM is ready)
      setTimeout(() => {
        tracksToRender.forEach(track => {
          if (track.clips && track.clips.length > 0) {
            // For speaker tracks, use the speaker clip renderer
            if (track.type === 'speaker' && app.adrManager && typeof app.adrManager._renderSpeakerClips === 'function') {
              app.adrManager._renderSpeakerClips(track.id, track.clips, track.color || '#4a9eff');
            } else {
              // Handle other clip types
              track.clips.forEach(clip => {
                if (clip.type === 'visual-reference' || clip.isVisualOnly) {
                  // Try to render visual clip using ADR manager
                  if (app.adrManager && typeof app.adrManager._renderVisualClip === 'function') {
                    app.adrManager._renderVisualClip(track.id, clip);
                  }
                } else if (clip.type === 'adr' || clip.type === 'elevenlabs') {
                  // ADR clips
                  if (app.adrManager && typeof app.adrManager._renderADRClip === 'function') {
                    app.adrManager._renderADRClip(track.id, clip);
                  }
                } else if (clip.type === 'room-tone') {
                  // Fill/room tone clips
                  if (app.adrManager && typeof app.adrManager._renderFillClip === 'function') {
                    app.adrManager._renderFillClip(track.id, clip);
                  }
                } else if (typeof app.renderTrackClips === 'function') {
                  // Fallback: use general track clip renderer
                  app.renderTrackClips(track.id);
                }
              });
            }
          }
        });
        console.log('[RestoreAudioTracks] Rendered clips for restored tracks');
      }, 100);
      
      // Re-attach context menu to new tracks
      if (app.trackContextMenu && typeof app.trackContextMenu.attachToExistingTracks === 'function') {
        app.trackContextMenu.attachToExistingTracks();
      }
      
      console.log('[RestoreAudioTracks] Rendered', tracksToRender.length, 'additional tracks');
    };
    
    /**
     * Hook into project loading to restore audio tracks
     * Wraps the original loadProjectData function if it exists
     */
    const originalLoadProjectData = app.loadProjectData;
    if (typeof originalLoadProjectData === 'function') {
      app.loadProjectData = function(projectData) {
        // #region agent log
        // #endregion
        // Call original
        const result = originalLoadProjectData.call(app, projectData);
        
        // Restore audio tracks after a short delay to ensure DOM is ready
        setTimeout(() => {
          // Pass saved tracks from project data - check both "tracks" and "audioTracks" keys
          const savedTracks = projectData?.audioTracks || projectData?.tracks || app.currentProject?.audioTracks || app.currentProject?.tracks;
          // #region agent log
          // #endregion
          app.restoreAudioTracks(savedTracks);
        }, 100);
        
        return result;
      };
      console.log('[VideoEditorModulesBridge] Hooked loadProjectData for track restoration');
    }
    
    // Also try to hook into restoreProject if it exists
    const originalRestoreProject = app.restoreProject;
    // #region agent log - DISABLED: referenced originalSaveProject before declaration
    //
    // #endregion
    if (typeof originalRestoreProject === 'function') {
      app.restoreProject = function(projectData, ...args) {
        // #region agent log
        // #endregion
        const result = originalRestoreProject.call(app, projectData, ...args);
        
        // Restore audio tracks after a short delay
        setTimeout(() => {
          // Pass saved tracks from project data - check both "tracks" and "audioTracks" keys
          const savedTracks = projectData?.audioTracks || projectData?.tracks || app.currentProject?.audioTracks || app.currentProject?.tracks;
          app.restoreAudioTracks(savedTracks);
        }, 100);
        
        return result;
      };
      console.log('[VideoEditorModulesBridge] Hooked restoreProject for track restoration');
    }
    
    // Watch for video load events to restore tracks
    // This catches the case where project data is loaded when a video is opened
    const videoPlayer = document.getElementById('videoPlayer');
    if (videoPlayer) {
      videoPlayer.addEventListener('loadedmetadata', () => {
        // Delay to allow project data to be loaded first
        setTimeout(() => {
          // GUARD: Skip if we're loading from a project (applyVersionState already handled tracks)
          if (app._loadingFromProject) {
            console.log('[VideoEditorModulesBridge] Skipping track restore - loading from project');
            return;
          }
          
          // Only restore tracks if audioTracks is empty (not loaded from project)
          // This prevents duplicate track issues when version data already loaded tracks
          if (!app.audioTracks || app.audioTracks.length <= 1) {
            const savedTracks = app.currentProject?.audioTracks || app.currentProject?.tracks;
            if (savedTracks && savedTracks.length > 1) {
              console.log('[VideoEditorModulesBridge] Restoring tracks from currentProject on video load');
              app.restoreAudioTracks(savedTracks);
            }
          } else {
            console.log('[VideoEditorModulesBridge] Tracks already loaded, count:', app.audioTracks.length);
          }
        }, 500);
      });
    }
    
    /**
     * Hook into the project save mechanism to ensure audioTracks are saved
     * Wraps saveProject if it exists
     */
    const originalSaveProject = app.saveProject;
    if (typeof originalSaveProject === 'function') {
      app.saveProject = function(...args) {
        // #region agent log
        // #endregion
        // Ensure audioTracks are serializable before save
        // Note: video-editor-app.js uses both "tracks" and looks for "audioTracks" in different places
        if (app.currentProject) {
          const serializedTracks = app.serializeAudioTracks();
          app.currentProject.audioTracks = serializedTracks;
          app.currentProject.tracks = serializedTracks; // Also set "tracks" for compatibility with loadProject
          app.currentProject.nextTrackId = app.nextTrackId || 2;
          // #region agent log
          // #endregion
        }
        
        return originalSaveProject.apply(app, args);
      };
      console.log('[VideoEditorModulesBridge] Hooked saveProject for track persistence');
    }
    
    /**
     * Also hook into auto-save mechanism if it uses a different method
     */
    const originalAutoSave = app.autoSaveProject;
    if (typeof originalAutoSave === 'function') {
      app.autoSaveProject = function(...args) {
        // Ensure audioTracks are serializable before auto-save
        if (app.currentProject) {
          const serializedTracks = app.serializeAudioTracks();
          app.currentProject.audioTracks = serializedTracks;
          app.currentProject.tracks = serializedTracks; // Also set "tracks" for compatibility
          app.currentProject.nextTrackId = app.nextTrackId || 2;
        }
        
        return originalAutoSave.apply(app, args);
      };
      console.log('[VideoEditorModulesBridge] Hooked autoSaveProject for track persistence');
    }

    // ============================================================
    // Hook Save-to-Space / Load-from-Space to persist & restore state
    // ============================================================

    const originalSaveToSpace = app.saveToSpace;
    if (typeof originalSaveToSpace === 'function') {
      app.saveToSpace = async function(...args) {
        const result = await originalSaveToSpace.apply(app, args);

        // Best-effort: also save full project state (tracks + ADR + markers + edits)
        try {
          // Only persist if we're editing a Space-backed item
          if (app.spaceItemId) {
            await app.persistProjectStateToSpaceMetadata();
          }
        } catch (e) {
          console.warn('[VideoEditorModulesBridge] Failed to persist project state after saveToSpace:', e);
        }

        return result;
      };
      console.log('[VideoEditorModulesBridge] Hooked saveToSpace for full project-state persistence');
    }

    const originalLoadVideoFromSpace = app.loadVideoFromSpace;
    if (typeof originalLoadVideoFromSpace === 'function') {
      app.loadVideoFromSpace = async function(itemId, ...args) {
        const result = await originalLoadVideoFromSpace.call(app, itemId, ...args);

        // Fetch metadata and restore persisted project state (if present)
        try {
          // #region agent log
          console.log('[DEBUG-H1] loadVideoFromSpace: About to call clipboard.getMetadata for itemId:', itemId);
          // #endregion
          if (window.clipboard && typeof window.clipboard.getMetadata === 'function') {
            const metaResult = await window.clipboard.getMetadata(itemId);
            // #region agent log
            console.log('[DEBUG-H4] loadVideoFromSpace: clipboard.getMetadata returned:', { success: metaResult?.success, hasMetadata: !!metaResult?.metadata });
            // #endregion
            const metadata = metaResult?.metadata;
            const savedState = metadata?.videoEditorProjectState;
            if (savedState) {
              // Delay slightly to allow DOM/UI init
              setTimeout(() => {
                app.restoreProjectState(savedState);
              }, 250);
            }
          }
        } catch (e) {
          console.warn('[VideoEditorModulesBridge] Failed to restore project state on loadVideoFromSpace:', e);
          // #region agent log
          console.error('[DEBUG-H1,H2,H3,H4] loadVideoFromSpace: clipboard.getMetadata FAILED:', e.message);
          // #endregion
        }

        return result;
      };
      console.log('[VideoEditorModulesBridge] Hooked loadVideoFromSpace for project-state restore');
    }

    // ============================================================
    // STATE MANAGER - Undo/Redo, Auto-Save, Snapshots
    // ============================================================
    
    /**
     * Get current editor state for undo/redo
     */
    app.getEditableState = function() {
      return {
        markers: JSON.parse(JSON.stringify(app.markers || [])),
        trimStart: app.trimStart,
        trimEnd: app.trimEnd,
        sliceMarkers: [...(app.sliceMarkers || [])],
        segments: JSON.parse(JSON.stringify(app.segments || [])),
        fades: { ...app.fades },
        audioTracks: app.serializeAudioTracks ? app.serializeAudioTracks() : []
      };
    };
    
    /**
     * Apply state from undo/redo
     */
    app.applyEditableState = function(state, action, description) {
      if (!state) return;
      
      console.log(`[StateManager] Applying state: ${action} - ${description}`);
      
      // Apply markers
      if (state.markers) {
        app.markers = JSON.parse(JSON.stringify(state.markers));
        app.nextMarkerId = Math.max(...app.markers.map(m => m.id || 0), 0) + 1;
        if (app.renderMarkers) app.renderMarkers();
        if (app.renderMarkerList) app.renderMarkerList();
      }
      
      // Apply trim points
      if (state.trimStart !== undefined) app.trimStart = state.trimStart;
      if (state.trimEnd !== undefined) app.trimEnd = state.trimEnd;
      if (app.updateTrimRegion) app.updateTrimRegion();
      
      // Apply slice markers
      if (state.sliceMarkers) {
        app.sliceMarkers = [...state.sliceMarkers];
        if (app.computeSegments) app.computeSegments();
        if (app.renderClipOverlays) app.renderClipOverlays();
      }
      
      // Apply segments
      if (state.segments) {
        app.segments = JSON.parse(JSON.stringify(state.segments));
        if (app.renderSegments) app.renderSegments();
      }
      
      // Apply fades
      if (state.fades) {
        app.fades = { ...state.fades };
      }
      
      // Apply audio tracks
      if (state.audioTracks && app.deserializeAudioTracks) {
        app.deserializeAudioTracks(state.audioTracks);
      }
      
      // Update UI
      app.updateUndoRedoUI();
    };
    
    /**
     * Update undo/redo button states
     */
    app.updateUndoRedoUI = function() {
      if (!app.stateManager) return;
      
      const status = app.stateManager.getUndoRedoStatus();
      
      // Find undo/redo buttons and update them
      const undoBtn = document.querySelector('button[title="Undo"]');
      const redoBtn = document.querySelector('button[title="Redo"]');
      
      if (undoBtn) {
        undoBtn.disabled = !status.canUndo;
        undoBtn.style.opacity = status.canUndo ? '1' : '0.4';
        undoBtn.title = status.canUndo 
          ? `Undo: ${status.undoDescription || 'Last action'}`
          : 'Nothing to undo';
      }
      
      if (redoBtn) {
        redoBtn.disabled = !status.canRedo;
        redoBtn.style.opacity = status.canRedo ? '1' : '0.4';
        redoBtn.title = status.canRedo 
          ? `Redo: ${status.redoDescription || 'Last undone action'}`
          : 'Nothing to redo';
      }
    };
    
    /**
     * Push current state to undo stack
     */
    app.pushUndoState = function(description) {
      if (!app.stateManager) return;
      const state = app.getEditableState();
      app.stateManager.pushState(state, description);
      app.updateUndoRedoUI();
    };
    
    /**
     * Undo last action
     */
    app.undo = function() {
      if (!app.stateManager) {
        app.showToast('info', 'Undo not available');
        return;
      }
      
      if (app.stateManager.undo()) {
        app.showToast('success', 'Undo successful');
      } else {
        app.showToast('info', 'Nothing to undo');
      }
    };
    
    /**
     * Redo last undone action
     */
    app.redo = function() {
      if (!app.stateManager) {
        app.showToast('info', 'Redo not available');
        return;
      }
      
      if (app.stateManager.redo()) {
        app.showToast('success', 'Redo successful');
      } else {
        app.showToast('info', 'Nothing to redo');
      }
    };
    
    /**
     * Create a named snapshot
     */
    app.createSnapshot = async function(name) {
      if (!app.stateManager) return null;
      
      try {
        const snapshot = await app.stateManager.createSnapshot(name || `Snapshot ${new Date().toLocaleString()}`);
        app.showToast('success', `Snapshot created: ${snapshot.name}`);
        return snapshot;
      } catch (error) {
        console.error('[StateManager] Error creating snapshot:', error);
        app.showToast('error', 'Failed to create snapshot');
        return null;
      }
    };
    
    /**
     * List all snapshots
     */
    app.listSnapshots = async function() {
      if (!app.stateManager) return [];
      return await app.stateManager.listSnapshots();
    };
    
    /**
     * Restore a snapshot
     */
    app.restoreSnapshot = async function(snapshotId) {
      if (!app.stateManager) return false;
      
      try {
        const result = await app.stateManager.restoreSnapshot(snapshotId);
        if (result) {
          app.showToast('success', 'Snapshot restored');
        }
        return result;
      } catch (error) {
        console.error('[StateManager] Error restoring snapshot:', error);
        app.showToast('error', 'Failed to restore snapshot');
        return false;
      }
    };
    
    // Initialize StateManager
    app.stateManager = new StateManager('video-editor', {
      maxUndoLevels: 50,
      autoSaveInterval: 5000,
      onStateChange: (state, action, description) => {
        app.applyEditableState(state, action, description);
      },
      onAutoSave: (state) => {
        console.log('[StateManager] Auto-saved');
      },
      getState: () => app.getEditableState()
    });
    
    // Start auto-save
    app.stateManager.startAutoSave();
    
    // Push initial state
    setTimeout(() => {
      if (app.videoPath) {
        app.pushUndoState('Initial state');
      }
      app.updateUndoRedoUI();
    }, 1000);
    
    console.log('[VideoEditorModulesBridge] StateManager initialized with undo/redo support');

    // ============================================================
    // HOOK STATE-CHANGING METHODS FOR UNDO/REDO
    // ============================================================
    
    // Hook saveMarker to push undo state
    const originalSaveMarker = app.saveMarker;
    if (typeof originalSaveMarker === 'function') {
      app.saveMarker = function(...args) {
        const isEdit = !!app.editingMarkerId;
        app.pushUndoState(isEdit ? 'Edit marker' : 'Add marker');
        return originalSaveMarker.apply(app, args);
      };
      console.log('[VideoEditorModulesBridge] Hooked saveMarker for undo');
    }
    
    // Hook deleteMarker to push undo state
    const originalDeleteMarker = app.deleteMarker;
    if (typeof originalDeleteMarker === 'function') {
      app.deleteMarker = function(id, ...args) {
        const marker = app.markers?.find(m => m.id === id);
        app.pushUndoState(`Delete marker: ${marker?.name || 'unnamed'}`);
        return originalDeleteMarker.call(app, id, ...args);
      };
      console.log('[VideoEditorModulesBridge] Hooked deleteMarker for undo');
    }
    
    // Hook sliceAtPlayhead to push undo state
    const originalSliceAtPlayhead = app.sliceAtPlayhead;
    if (typeof originalSliceAtPlayhead === 'function') {
      app.sliceAtPlayhead = function(...args) {
        app.pushUndoState('Add slice marker');
        return originalSliceAtPlayhead.apply(app, args);
      };
      console.log('[VideoEditorModulesBridge] Hooked sliceAtPlayhead for undo');
    }
    
    // Hook cutHead to push undo state
    const originalCutHead = app.cutHead;
    if (typeof originalCutHead === 'function') {
      app.cutHead = function(...args) {
        app.pushUndoState('Trim head');
        return originalCutHead.apply(app, args);
      };
      console.log('[VideoEditorModulesBridge] Hooked cutHead for undo');
    }
    
    // Hook cutTail to push undo state
    const originalCutTail = app.cutTail;
    if (typeof originalCutTail === 'function') {
      app.cutTail = function(...args) {
        app.pushUndoState('Trim tail');
        return originalCutTail.apply(app, args);
      };
      console.log('[VideoEditorModulesBridge] Hooked cutTail for undo');
    }
    
    // Hook clearAllMarkers to push undo state
    const originalClearAllMarkers = app.clearAllMarkers;
    if (typeof originalClearAllMarkers === 'function') {
      app.clearAllMarkers = function(...args) {
        if (app.markers?.length > 0) {
          app.pushUndoState('Clear all markers');
        }
        return originalClearAllMarkers.apply(app, args);
      };
      console.log('[VideoEditorModulesBridge] Hooked clearAllMarkers for undo');
    }

    // ============================================================
    // DEPLOYMENT VERSION MANAGER (Trailer/Short/Full)
    // ============================================================
    
    /**
     * Initialize deployment versions when video is loaded
     */
    app.initDeploymentVersions = function() {
      const video = document.getElementById('videoPlayer');
      if (!video || !video.duration || !app.videoPath) return;
      
      app.deploymentVersionManager = new DeploymentVersionManager(
        app.videoPath,
        video.duration,
        {
          onVersionChange: (action, data) => {
            console.log('[DeploymentVersionManager] Change:', action, data);
            // Could update UI here
          }
        }
      );
      
      console.log('[VideoEditorModulesBridge] DeploymentVersionManager initialized');
    };
    
    /**
     * Add current selection to a deployment version
     */
    app.addToVersion = function(versionId, start, end, label) {
      if (!app.deploymentVersionManager) {
        app.showToast('error', 'Load a video first');
        return;
      }
      
      try {
        const region = app.deploymentVersionManager.addRegion(versionId, start, end, { label });
        app.showToast('success', `Added to ${versionId}`);
        return region;
      } catch (error) {
        console.error('[DeploymentVersionManager] Error:', error);
        app.showToast('error', error.message);
        return null;
      }
    };
    
    /**
     * Create a new deployment version
     */
    app.createDeploymentVersion = function(id, template, options = {}) {
      if (!app.deploymentVersionManager) {
        app.showToast('error', 'Load a video first');
        return null;
      }
      
      try {
        const version = app.deploymentVersionManager.createVersion(id, template, options);
        app.showToast('success', `Created version: ${version.name}`);
        return version;
      } catch (error) {
        console.error('[DeploymentVersionManager] Error:', error);
        app.showToast('error', error.message);
        return null;
      }
    };
    
    /**
     * List all deployment versions
     */
    app.listDeploymentVersions = function() {
      if (!app.deploymentVersionManager) return [];
      return app.deploymentVersionManager.listVersions();
    };
    
    /**
     * Get export spec for a version (for FFmpeg)
     */
    app.getVersionExportSpec = function(versionId) {
      if (!app.deploymentVersionManager) return null;
      return app.deploymentVersionManager.getExportSpec(versionId);
    };
    
    // Initialize deployment versions when video is loaded
    const originalLoadVideo = app.loadVideo;
    if (typeof originalLoadVideo === 'function') {
      app.loadVideo = async function(...args) {
        const result = await originalLoadVideo.apply(app, args);
        
        // Initialize deployment versions after video loads
        setTimeout(() => {
          app.initDeploymentVersions();
        }, 500);
        
        return result;
      };
    }
    
    console.log('[VideoEditorModulesBridge] DeploymentVersionManager integration ready');
    
  } catch (err) {
    console.error('[VideoEditorModulesBridge] Failed to init modules:', err);
  }
}





