/**
 * VideoSyncEngine - Manages edit queue and video sync for transcript-based editing
 * 
 * Handles:
 * - Edit queue management (deletions, gaps, replacements)
 * - Diff calculation between original and edited timeline
 * - Preview generation for mini timeline
 * - Applying edits to video via FFmpeg
 */
export class VideoSyncEngine {
  constructor(appContext) {
    this.app = appContext;
    
    // State
    this.originalDuration = 0;
    this.edits = [];               // Synced with StoryBeatsEditor
    this.previewSegments = [];     // Calculated preview segments
    this.newDuration = 0;          // Calculated new duration after edits
  }

  /**
   * Initialize with video info
   */
  init(videoDuration) {
    this.originalDuration = videoDuration;
    this.edits = [];
    this.calculatePreview();
  }

  /**
   * Called when an edit is added
   */
  onEditAdded(edit) {
    this.edits = this.app.storyBeatsEditor?.getEdits() || [];
    this.calculatePreview();
  }

  /**
   * Called when an edit is removed
   */
  onEditRemoved(editId) {
    this.edits = this.app.storyBeatsEditor?.getEdits() || [];
    this.calculatePreview();
  }

  /**
   * Sync edits from the editor
   */
  syncEdits() {
    this.edits = this.app.storyBeatsEditor?.getEdits() || [];
    this.calculatePreview();
  }

  /**
   * Calculate the preview state (segments with cuts and gaps)
   * Returns an array of segments: { type: 'keep' | 'cut' | 'gap', startTime, endTime, duration }
   */
  calculatePreview() {
    const segments = [];
    let currentTime = 0;
    
    // Sort edits by start time
    const sortedEdits = [...this.edits].sort((a, b) => {
      const aTime = a.startTime || a.insertAfterTime || 0;
      const bTime = b.startTime || b.insertAfterTime || 0;
      return aTime - bTime;
    });
    
    // Build segment list
    sortedEdits.forEach(edit => {
      if (edit.type === 'delete' || edit.type === 'replace') {
        // Add keep segment before this edit
        if (edit.startTime > currentTime) {
          segments.push({
            type: 'keep',
            startTime: currentTime,
            endTime: edit.startTime,
            duration: edit.startTime - currentTime
          });
        }
        
        // Add cut segment
        segments.push({
          type: 'cut',
          startTime: edit.startTime,
          endTime: edit.endTime,
          duration: edit.endTime - edit.startTime,
          originalText: edit.originalText
        });
        
        // If replace, add the gap for new content
        if (edit.type === 'replace') {
          segments.push({
            type: 'gap',
            afterTime: edit.endTime,
            duration: edit.endTime - edit.startTime, // Same duration for replacement
            isReplacement: true
          });
        }
        
        currentTime = edit.endTime;
        
      } else if (edit.type === 'insert_gap') {
        // Add keep segment up to gap insertion point
        if (edit.insertAfterTime > currentTime) {
          segments.push({
            type: 'keep',
            startTime: currentTime,
            endTime: edit.insertAfterTime,
            duration: edit.insertAfterTime - currentTime
          });
          currentTime = edit.insertAfterTime;
        }
        
        // Add gap segment
        segments.push({
          type: 'gap',
          afterTime: edit.insertAfterTime,
          duration: edit.gapDuration || 3.0,
          isReplacement: false
        });
      }
    });
    
    // Add final keep segment if needed
    if (currentTime < this.originalDuration) {
      segments.push({
        type: 'keep',
        startTime: currentTime,
        endTime: this.originalDuration,
        duration: this.originalDuration - currentTime
      });
    }
    
    // If no edits, just one keep segment
    if (segments.length === 0) {
      segments.push({
        type: 'keep',
        startTime: 0,
        endTime: this.originalDuration,
        duration: this.originalDuration
      });
    }
    
    this.previewSegments = segments;
    
    // Calculate new duration
    this.newDuration = segments.reduce((total, seg) => {
      if (seg.type === 'keep') {
        return total + seg.duration;
      } else if (seg.type === 'gap') {
        return total + seg.duration;
      }
      // Cuts don't add to duration
      return total;
    }, 0);
    
    // Update mini timeline
    if (this.app.storyBeatsMiniTimeline) {
      this.app.storyBeatsMiniTimeline.updatePreview(this.previewSegments, this.newDuration);
    }
    
    return segments;
  }

  /**
   * Get the preview segments
   */
  getPreviewSegments() {
    return this.previewSegments;
  }

  /**
   * Get the calculated new duration
   */
  getNewDuration() {
    return this.newDuration;
  }

  /**
   * Get the duration change (positive = longer, negative = shorter)
   */
  getDurationChange() {
    return this.newDuration - this.originalDuration;
  }

  /**
   * Check if there are pending edits
   */
  hasEdits() {
    return this.edits.length > 0;
  }

  /**
   * Generate edit decision list for video processing
   * Returns array of { startTime, endTime, label? } for the processEditList API
   * This format specifies which segments to KEEP in the final video
   */
  generateEditDecisionList() {
    const edl = [];
    
    // Only include 'keep' segments - these are what gets included in the output
    this.previewSegments.forEach(segment => {
      if (segment.type === 'keep') {
        edl.push({
          startTime: segment.startTime,
          endTime: segment.endTime,
          label: `Keep ${segment.duration.toFixed(1)}s`
        });
      }
      // 'cut' segments are implicitly removed by not including them
      // 'gap' segments need special handling - insert silence
    });
    
    return edl;
  }
  
  /**
   * Generate extended edit list that includes gap insertions
   * This is for future use when the backend supports silence insertion
   */
  generateExtendedEditList() {
    const edl = [];
    
    this.previewSegments.forEach(segment => {
      if (segment.type === 'keep') {
        edl.push({
          action: 'keep',
          startTime: segment.startTime,
          endTime: segment.endTime,
          duration: segment.duration
        });
      } else if (segment.type === 'gap') {
        edl.push({
          action: 'insert_silence',
          duration: segment.duration,
          afterTime: segment.afterTime
        });
      }
      // 'cut' segments are implicitly handled by not including them
    });
    
    return edl;
  }

  /**
   * Apply all edits to the video
   * This calls the backend to process the video
   */
  async applyAllEdits() {
    if (!this.hasEdits()) {
      this.app.showToast?.('info', 'No edits to apply');
      return { success: true, noChanges: true };
    }
    
    const videoPath = this.app.videoPath;
    if (!videoPath) {
      this.app.showToast?.('error', 'No video loaded');
      return { success: false, error: 'No video loaded' };
    }
    
    try {
      this.app.showToast?.('info', 'Applying edits to video...');
      
      // Generate edit decision list
      const editList = this.generateEditDecisionList();
      
      console.log('[VideoSyncEngine] Applying edits:', editList);
      
      // Call the video processor
      const result = await window.videoEditor.processEditList(videoPath, editList, {
        outputFormat: 'mp4',
        preserveQuality: true
      });
      
      if (!result.success) {
        throw new Error(result.error || 'Failed to process video');
      }
      
      // Clear edits after successful application
      this.app.storyBeatsEditor?.clearEdits();
      this.edits = [];
      this.calculatePreview();
      
      this.app.showToast?.('success', 'Edits applied successfully!');
      
      // Optionally load the new video
      if (result.outputPath) {
        const loadNew = confirm('Video edited successfully! Load the new version?');
        if (loadNew) {
          // Trigger video load
          this.app.loadVideo?.(result.outputPath);
        }
      }
      
      return result;
      
    } catch (error) {
      console.error('[VideoSyncEngine] Apply edits error:', error);
      this.app.showToast?.('error', 'Failed to apply edits: ' + error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Preview what the timeline will look like after edits
   * Returns visualization data for the mini timeline
   */
  getTimelineVisualization() {
    const vis = {
      originalDuration: this.originalDuration,
      newDuration: this.newDuration,
      segments: this.previewSegments.map(seg => ({
        ...seg,
        // Calculate visual position (percentage of original)
        visualStart: seg.type === 'gap' ? null : (seg.startTime / this.originalDuration) * 100,
        visualEnd: seg.type === 'gap' ? null : (seg.endTime / this.originalDuration) * 100,
        visualWidth: seg.type === 'gap' ? null : ((seg.endTime - seg.startTime) / this.originalDuration) * 100
      }))
    };
    
    return vis;
  }

  /**
   * Estimate the impact of current edits
   */
  getEditSummary() {
    const deletions = this.edits.filter(e => e.type === 'delete');
    const gaps = this.edits.filter(e => e.type === 'insert_gap');
    const replacements = this.edits.filter(e => e.type === 'replace');
    
    const totalCutTime = deletions.reduce((sum, e) => sum + (e.endTime - e.startTime), 0);
    const totalGapTime = gaps.reduce((sum, e) => sum + (e.gapDuration || 0), 0);
    const totalReplaceTime = replacements.reduce((sum, e) => sum + (e.endTime - e.startTime), 0);
    
    return {
      deletionCount: deletions.length,
      gapCount: gaps.length,
      replacementCount: replacements.length,
      totalCutTime,
      totalGapTime,
      totalReplaceTime,
      originalDuration: this.originalDuration,
      newDuration: this.newDuration,
      durationChange: this.newDuration - this.originalDuration
    };
  }

  /**
   * Undo the last edit
   */
  undoLastEdit() {
    if (this.edits.length === 0) return;
    
    const lastEdit = this.edits[this.edits.length - 1];
    this.app.storyBeatsEditor?.removeEdit(lastEdit.id);
  }

  /**
   * Clear all edits
   */
  clearAllEdits() {
    this.app.storyBeatsEditor?.clearEdits();
    this.edits = [];
    this.calculatePreview();
  }

  /**
   * Generate a virtual preview timeline
   * Creates a timeline structure that can be used for real-time preview without re-encoding
   * @param {Array} edits - Optional edits array (uses current edits if not provided)
   * @returns {Object} Preview timeline data
   */
  generatePreviewTimeline(edits = null) {
    const editList = edits || this.edits;
    const timeline = {
      originalDuration: this.originalDuration,
      segments: [],
      skipRegions: [],
      gapInsertions: [],
      totalDuration: 0
    };

    // Sort edits by time
    const sortedEdits = [...editList].sort((a, b) => {
      const aTime = a.startTime || a.insertAfterTime || 0;
      const bTime = b.startTime || b.insertAfterTime || 0;
      return aTime - bTime;
    });

    let currentOriginalTime = 0;
    let currentPreviewTime = 0;

    // Process each edit to build the timeline
    sortedEdits.forEach((edit, index) => {
      const editStart = edit.startTime || edit.insertAfterTime || 0;

      // Add segment before this edit (if any)
      if (editStart > currentOriginalTime) {
        const segmentDuration = editStart - currentOriginalTime;
        timeline.segments.push({
          type: 'keep',
          originalStart: currentOriginalTime,
          originalEnd: editStart,
          previewStart: currentPreviewTime,
          previewEnd: currentPreviewTime + segmentDuration,
          duration: segmentDuration
        });
        currentPreviewTime += segmentDuration;
      }

      if (edit.type === 'delete') {
        // Create skip region (content to skip during playback)
        const skipDuration = edit.endTime - edit.startTime;
        timeline.skipRegions.push({
          originalStart: edit.startTime,
          originalEnd: edit.endTime,
          duration: skipDuration,
          reason: 'delete',
          editId: edit.id
        });
        currentOriginalTime = edit.endTime;

      } else if (edit.type === 'replace') {
        // Skip original content
        const skipDuration = edit.endTime - edit.startTime;
        timeline.skipRegions.push({
          originalStart: edit.startTime,
          originalEnd: edit.endTime,
          duration: skipDuration,
          reason: 'replace',
          editId: edit.id
        });
        
        // Add gap for replacement content
        const gapDuration = edit.replacementDuration || skipDuration;
        timeline.gapInsertions.push({
          afterOriginalTime: edit.endTime,
          previewTime: currentPreviewTime,
          duration: gapDuration,
          isReplacement: true,
          editId: edit.id
        });
        currentPreviewTime += gapDuration;
        currentOriginalTime = edit.endTime;

      } else if (edit.type === 'insert_gap') {
        // Add gap insertion point
        const gapDuration = edit.gapDuration || 3.0;
        timeline.gapInsertions.push({
          afterOriginalTime: edit.insertAfterTime,
          previewTime: currentPreviewTime,
          duration: gapDuration,
          isReplacement: false,
          editId: edit.id
        });
        currentPreviewTime += gapDuration;
      }
    });

    // Add final segment (remaining content after last edit)
    if (currentOriginalTime < this.originalDuration) {
      const remainingDuration = this.originalDuration - currentOriginalTime;
      timeline.segments.push({
        type: 'keep',
        originalStart: currentOriginalTime,
        originalEnd: this.originalDuration,
        previewStart: currentPreviewTime,
        previewEnd: currentPreviewTime + remainingDuration,
        duration: remainingDuration
      });
      currentPreviewTime += remainingDuration;
    }

    timeline.totalDuration = currentPreviewTime;
    
    return timeline;
  }

  /**
   * Preview edits in player using time-skip approach
   * This allows real-time preview without re-encoding
   * @param {Array} edits - Optional edits to preview
   */
  previewInPlayer(edits = null) {
    const timeline = this.generatePreviewTimeline(edits);
    
    if (!this.app.video) {
      console.error('[VideoSyncEngine] No video element available for preview');
      return;
    }

    // Store original state
    this._previewState = {
      active: true,
      timeline,
      originalTime: this.app.video.currentTime,
      currentSegmentIndex: 0,
      isPlaying: !this.app.video.paused
    };

    // Setup time update handler for preview mode
    if (!this._previewTimeHandler) {
      this._previewTimeHandler = this._handlePreviewTimeUpdate.bind(this);
    }

    // Add preview time update listener
    this.app.video.addEventListener('timeupdate', this._previewTimeHandler);

    console.log('[VideoSyncEngine] Preview mode activated', timeline);
    this.app.showToast?.('info', 'Preview mode - showing edited timeline');
    
    return timeline;
  }

  /**
   * Handle time update during preview mode
   * Implements time-skip logic to simulate edits
   */
  _handlePreviewTimeUpdate(event) {
    if (!this._previewState?.active) return;

    const video = this.app.video;
    const currentTime = video.currentTime;
    const timeline = this._previewState.timeline;

    // Check if we're in a skip region
    for (const skip of timeline.skipRegions) {
      if (currentTime >= skip.originalStart && currentTime < skip.originalEnd) {
        // Skip to end of this region
        video.currentTime = skip.originalEnd;
        console.log(`[VideoSyncEngine] Skipping ${skip.reason}: ${skip.originalStart.toFixed(2)}s -> ${skip.originalEnd.toFixed(2)}s`);
        return;
      }
    }
  }

  /**
   * Stop preview mode and restore normal playback
   */
  stopPreview() {
    if (!this._previewState?.active) return;

    // Remove preview listener
    if (this.app.video && this._previewTimeHandler) {
      this.app.video.removeEventListener('timeupdate', this._previewTimeHandler);
    }

    // Restore original time if desired
    // this.app.video.currentTime = this._previewState.originalTime;

    this._previewState.active = false;
    this._previewState = null;

    console.log('[VideoSyncEngine] Preview mode deactivated');
    this.app.showToast?.('info', 'Preview mode ended');
  }

  /**
   * Check if preview mode is active
   */
  isPreviewActive() {
    return this._previewState?.active || false;
  }

  /**
   * Toggle preview mode
   */
  togglePreview() {
    if (this.isPreviewActive()) {
      this.stopPreview();
    } else {
      this.previewInPlayer();
    }
  }

  /**
   * Map original time to preview time
   * Useful for seeking in preview mode
   */
  originalTimeToPreviewTime(originalTime) {
    const timeline = this._previewState?.timeline || this.generatePreviewTimeline();
    let previewTime = 0;
    let remainingTime = originalTime;

    // Process segments and skip regions
    for (const segment of timeline.segments) {
      if (originalTime >= segment.originalStart && originalTime < segment.originalEnd) {
        // Time falls within this kept segment
        const offsetInSegment = originalTime - segment.originalStart;
        return segment.previewStart + offsetInSegment;
      }
    }

    // Check if time is in a skip region (deleted content)
    for (const skip of timeline.skipRegions) {
      if (originalTime >= skip.originalStart && originalTime < skip.originalEnd) {
        // Find the segment after this skip
        const nextSegment = timeline.segments.find(s => s.originalStart >= skip.originalEnd);
        return nextSegment ? nextSegment.previewStart : timeline.totalDuration;
      }
    }

    return Math.min(originalTime, timeline.totalDuration);
  }

  /**
   * Map preview time to original time
   * Useful for highlighting transcript during preview
   */
  previewTimeToOriginalTime(previewTime) {
    const timeline = this._previewState?.timeline || this.generatePreviewTimeline();

    for (const segment of timeline.segments) {
      if (previewTime >= segment.previewStart && previewTime < segment.previewEnd) {
        const offsetInSegment = previewTime - segment.previewStart;
        return segment.originalStart + offsetInSegment;
      }
    }

    return this.originalDuration; // Default to end
  }

  /**
   * Get preview state for UI
   */
  getPreviewState() {
    if (!this._previewState?.active) {
      return null;
    }

    const timeline = this._previewState.timeline;
    return {
      active: true,
      originalDuration: timeline.originalDuration,
      previewDuration: timeline.totalDuration,
      durationChange: timeline.totalDuration - timeline.originalDuration,
      segmentCount: timeline.segments.length,
      skipCount: timeline.skipRegions.length,
      gapCount: timeline.gapInsertions.length
    };
  }
}


