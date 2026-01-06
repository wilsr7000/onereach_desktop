/**
 * SnapManager - Snap-to-grid functionality for audio clip editing
 * 
 * Features:
 * - Snap to playhead, markers, and clip edges
 * - Configurable snap threshold
 * - Toggle enable/disable
 */

export class SnapManager {
  constructor(options = {}) {
    this.snapTargets = [];
    this.snapThreshold = options.snapThreshold || 10; // pixels
    this.enabled = options.enabled !== false;
    
    // Callbacks for converting between time and pixels
    this.timeToPixels = options.timeToPixels || ((time) => time * 100);
    this.pixelsToTime = options.pixelsToTime || ((pixels) => pixels / 100);
    
    console.log('[SnapManager] Initialized with threshold:', this.snapThreshold, 'px');
  }
  
  /**
   * Update snap targets based on current state
   * @param {object} params - { tracks, playheadTime, markers }
   */
  updateSnapTargets(params = {}) {
    const { tracks = [], playheadTime = 0, markers = [] } = params;
    
    this.snapTargets = [];
    
    // Add playhead as snap target
    this.snapTargets.push({
      time: playheadTime,
      type: 'playhead',
      priority: 1
    });
    
    // Add markers
    markers.forEach(marker => {
      if (marker.time !== undefined) {
        this.snapTargets.push({
          time: marker.time,
          type: 'marker',
          markerId: marker.id,
          priority: 2
        });
      }
      // For range markers, add in and out points
      if (marker.inTime !== undefined) {
        this.snapTargets.push({
          time: marker.inTime,
          type: 'marker-in',
          markerId: marker.id,
          priority: 2
        });
      }
      if (marker.outTime !== undefined) {
        this.snapTargets.push({
          time: marker.outTime,
          type: 'marker-out',
          markerId: marker.id,
          priority: 2
        });
      }
    });
    
    // Add clip edges from all tracks
    tracks.forEach(track => {
      if (!track.clips) return;
      
      track.clips.forEach(clip => {
        const clipStart = clip.timelineStart ?? 0;
        const clipDuration = (clip.sourceOut ?? 0) - (clip.sourceIn ?? 0);
        const clipEnd = clipStart + clipDuration;
        
        // Clip start
        this.snapTargets.push({
          time: clipStart,
          type: 'clip-start',
          clipId: clip.id,
          trackId: track.id,
          priority: 3
        });
        
        // Clip end
        this.snapTargets.push({
          time: clipEnd,
          type: 'clip-end',
          clipId: clip.id,
          trackId: track.id,
          priority: 3
        });
      });
    });
    
    // Sort by priority (higher priority = more important)
    this.snapTargets.sort((a, b) => a.priority - b.priority);
  }
  
  /**
   * Get the snap point for a given time
   * @param {number} time - Time to check
   * @param {string} excludeClipId - Clip ID to exclude from snap (the one being dragged)
   * @returns {object} { snapped: boolean, time: number, type?: string, target?: object }
   */
  getSnapPoint(time, excludeClipId = null) {
    if (!this.enabled) {
      return { snapped: false, time };
    }
    
    const timePixels = this.timeToPixels(time);
    
    for (const target of this.snapTargets) {
      // Skip the clip being dragged
      if (target.clipId === excludeClipId) continue;
      
      const targetPixels = this.timeToPixels(target.time);
      const distance = Math.abs(timePixels - targetPixels);
      
      if (distance < this.snapThreshold) {
        return {
          snapped: true,
          time: target.time,
          type: target.type,
          target
        };
      }
    }
    
    return { snapped: false, time };
  }
  
  /**
   * Get snap point for a clip being moved
   * Checks both start and end of the clip
   * @param {object} clip - { timelineStart, sourceIn, sourceOut }
   * @param {number} newStart - Proposed new start time
   * @returns {object} { snapped: boolean, adjustedStart: number, snapInfo?: object }
   */
  getClipSnapPoint(clip, newStart) {
    if (!this.enabled) {
      return { snapped: false, adjustedStart: newStart };
    }
    
    const clipDuration = (clip.sourceOut ?? 0) - (clip.sourceIn ?? 0);
    const newEnd = newStart + clipDuration;
    
    // Check snap for clip start
    const startSnap = this.getSnapPoint(newStart, clip.id);
    if (startSnap.snapped) {
      return {
        snapped: true,
        adjustedStart: startSnap.time,
        snapInfo: { edge: 'start', ...startSnap }
      };
    }
    
    // Check snap for clip end
    const endSnap = this.getSnapPoint(newEnd, clip.id);
    if (endSnap.snapped) {
      return {
        snapped: true,
        adjustedStart: endSnap.time - clipDuration,
        snapInfo: { edge: 'end', ...endSnap }
      };
    }
    
    return { snapped: false, adjustedStart: newStart };
  }
  
  /**
   * Enable/disable snapping
   */
  setEnabled(enabled) {
    this.enabled = enabled;
    console.log('[SnapManager] Enabled:', enabled);
  }
  
  /**
   * Toggle snapping on/off
   */
  toggle() {
    this.enabled = !this.enabled;
    console.log('[SnapManager] Toggled:', this.enabled);
    return this.enabled;
  }
  
  /**
   * Set snap threshold in pixels
   */
  setThreshold(pixels) {
    this.snapThreshold = Math.max(1, pixels);
    console.log('[SnapManager] Threshold set:', this.snapThreshold, 'px');
  }
  
  /**
   * Set time/pixel conversion functions
   */
  setConverters(timeToPixels, pixelsToTime) {
    this.timeToPixels = timeToPixels;
    this.pixelsToTime = pixelsToTime;
  }
  
  /**
   * Get all current snap targets (for visualization)
   */
  getSnapTargets() {
    return this.snapTargets;
  }
  
  /**
   * Clear snap targets
   */
  clear() {
    this.snapTargets = [];
  }
  
  /**
   * Dispose of resources
   */
  dispose() {
    this.snapTargets = [];
    this.timeToPixels = null;
    this.pixelsToTime = null;
    console.log('[SnapManager] Disposed');
  }
}







