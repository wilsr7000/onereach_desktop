/**
 * EDLManager - Edit Decision List handling
 * Saves and loads edit state, converts between formats
 * @module src/video/versioning/EDLManager
 */

import fs from 'fs';
import path from 'path';

/**
 * EDL segment types
 */
export const SEGMENT_TYPES = {
  INCLUDE: 'include',
  EXCLUDE: 'exclude',
  SILENCE: 'silence'
};

/**
 * Service for managing Edit Decision Lists
 */
export class EDLManager {
  constructor() {
    this.formatVersion = '1.0';
  }

  /**
   * Create an EDL from the current editor state
   * @param {Object} editorState - Current state from video editor
   * @returns {Object} EDL data
   */
  createEDLFromState(editorState) {
    const {
      sourceVideo,
      duration,
      trimStart = 0,
      trimEnd = null,
      markers = [],
      playlist = [],
      audioTracks = [],
      deadSpaceRegions = [],
      effects = {}
    } = editorState;

    // Build segments from playlist or full video
    let segments = [];
    
    if (playlist && playlist.length > 0) {
      // Use playlist items as segments
      segments = playlist.map((item, index) => ({
        id: `seg_${String(index + 1).padStart(3, '0')}`,
        startTime: item.inTime || item.startTime,
        endTime: item.outTime || item.endTime,
        type: SEGMENT_TYPES.INCLUDE,
        name: item.name || `Segment ${index + 1}`,
        markerId: item.markerId
      }));
    } else if (trimStart > 0 || trimEnd !== null) {
      // Use trim points
      segments = [{
        id: 'seg_001',
        startTime: trimStart,
        endTime: trimEnd,
        type: SEGMENT_TYPES.INCLUDE
      }];
    } else {
      // Full video
      segments = [{
        id: 'seg_001',
        startTime: 0,
        endTime: duration || null,
        type: SEGMENT_TYPES.INCLUDE
      }];
    }

    // Add dead space regions as silence segments
    if (deadSpaceRegions && deadSpaceRegions.length > 0) {
      for (const region of deadSpaceRegions) {
        segments.push({
          id: `silence_${region.id || Date.now()}`,
          startTime: region.startTime,
          endTime: region.endTime,
          type: SEGMENT_TYPES.SILENCE,
          trackId: region.trackId
        });
      }
    }

    // Build markers list
    const edlMarkers = markers.map(marker => ({
      id: marker.id,
      name: marker.name,
      type: marker.type, // 'spot' or 'range'
      time: marker.time,
      timeIn: marker.timeIn || marker.inTime,
      timeOut: marker.timeOut || marker.outTime,
      color: marker.color,
      description: marker.description,
      transcription: marker.transcription,
      tags: marker.tags || [],
      notes: marker.notes,
      createdAt: marker.createdAt,
      modifiedAt: marker.modifiedAt
    }));

    // Build audio tracks
    const edlAudioTracks = audioTracks.map(track => ({
      id: track.id,
      name: track.name,
      type: track.type, // 'original', 'voice', 'music', 'sfx', 'ambience'
      muted: track.muted,
      volume: track.volume,
      clips: (track.clips || []).map(clip => ({
        id: clip.id,
        name: clip.name,
        sourcePath: clip.sourcePath,
        startTime: clip.startTime,
        endTime: clip.endTime,
        duration: clip.duration,
        type: clip.type
      }))
    }));

    // Build effects object
    const edlEffects = {
      fadeIn: effects.fadeIn || null,
      fadeOut: effects.fadeOut || null,
      speed: effects.speed || 1.0,
      reversed: effects.reversed || false
    };

    return {
      formatVersion: this.formatVersion,
      sourceVideo: sourceVideo,
      sourceDuration: duration,
      createdAt: new Date().toISOString(),
      segments: segments,
      markers: edlMarkers,
      audioTracks: edlAudioTracks,
      effects: edlEffects
    };
  }

  /**
   * Apply EDL to editor state
   * @param {Object} edl - EDL data
   * @returns {Object} Editor state
   */
  applyEDLToState(edl) {
    const state = {
      sourceVideo: edl.sourceVideo,
      duration: edl.sourceDuration,
      markers: [],
      playlist: [],
      audioTracks: [],
      deadSpaceRegions: [],
      effects: edl.effects || {}
    };

    // Convert segments to playlist
    const includeSegments = (edl.segments || []).filter(
      seg => seg.type === SEGMENT_TYPES.INCLUDE
    );
    
    state.playlist = includeSegments.map(seg => ({
      id: seg.id,
      name: seg.name || 'Segment',
      inTime: seg.startTime,
      outTime: seg.endTime,
      duration: seg.endTime ? seg.endTime - seg.startTime : null,
      markerId: seg.markerId
    }));

    // Extract dead space regions
    state.deadSpaceRegions = (edl.segments || [])
      .filter(seg => seg.type === SEGMENT_TYPES.SILENCE)
      .map(seg => ({
        id: seg.id,
        startTime: seg.startTime,
        endTime: seg.endTime,
        trackId: seg.trackId
      }));

    // Convert markers
    state.markers = (edl.markers || []).map(marker => ({
      id: marker.id,
      name: marker.name,
      type: marker.type,
      time: marker.time,
      timeIn: marker.timeIn,
      timeOut: marker.timeOut,
      inTime: marker.timeIn,
      outTime: marker.timeOut,
      color: marker.color,
      description: marker.description,
      transcription: marker.transcription,
      tags: marker.tags || [],
      notes: marker.notes,
      createdAt: marker.createdAt,
      modifiedAt: marker.modifiedAt
    }));

    // Convert audio tracks
    state.audioTracks = (edl.audioTracks || []).map(track => ({
      id: track.id,
      name: track.name,
      type: track.type,
      muted: track.muted,
      volume: track.volume,
      clips: (track.clips || []).map(clip => ({
        id: clip.id,
        name: clip.name,
        sourcePath: clip.sourcePath,
        startTime: clip.startTime,
        endTime: clip.endTime,
        duration: clip.duration,
        type: clip.type
      }))
    }));

    // Set trim points if only one include segment
    if (includeSegments.length === 1) {
      state.trimStart = includeSegments[0].startTime;
      state.trimEnd = includeSegments[0].endTime;
    }

    return state;
  }

  /**
   * Save EDL to file
   * @param {string} filePath - Path to save EDL
   * @param {Object} edl - EDL data
   */
  saveEDL(filePath, edl) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(edl, null, 2));
    console.log(`[EDLManager] Saved EDL to: ${filePath}`);
  }

  /**
   * Load EDL from file
   * @param {string} filePath - Path to EDL file
   * @returns {Object} EDL data
   */
  loadEDL(filePath) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`EDL file not found: ${filePath}`);
    }
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
  }

  /**
   * Export EDL to CMX 3600 format (standard broadcast format)
   * @param {Object} edl - EDL data
   * @param {number} fps - Frames per second
   * @returns {string} CMX 3600 formatted string
   */
  exportToCMX3600(edl, fps = 30) {
    let output = `TITLE: ${edl.sourceVideo || 'Untitled'}\n`;
    output += `FCM: NON-DROP FRAME\n\n`;

    const includeSegments = (edl.segments || []).filter(
      seg => seg.type === SEGMENT_TYPES.INCLUDE
    );

    let eventNumber = 1;
    let recordIn = 0;

    for (const segment of includeSegments) {
      const sourceIn = this._secondsToTimecode(segment.startTime, fps);
      const sourceOut = this._secondsToTimecode(segment.endTime || segment.startTime + 1, fps);
      const recIn = this._secondsToTimecode(recordIn, fps);
      const duration = (segment.endTime || segment.startTime + 1) - segment.startTime;
      const recOut = this._secondsToTimecode(recordIn + duration, fps);

      output += `${String(eventNumber).padStart(3, '0')}  AX       V     C        `;
      output += `${sourceIn} ${sourceOut} ${recIn} ${recOut}\n`;
      output += `* FROM CLIP NAME: ${segment.name || 'Segment'}\n\n`;

      eventNumber++;
      recordIn += duration;
    }

    return output;
  }

  /**
   * Export EDL to Final Cut Pro XML format
   * @param {Object} edl - EDL data
   * @param {number} fps - Frames per second
   * @returns {string} FCP XML formatted string
   */
  exportToFCPXML(edl, fps = 30) {
    const includeSegments = (edl.segments || []).filter(
      seg => seg.type === SEGMENT_TYPES.INCLUDE
    );

    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    xml += `<!DOCTYPE xmeml>\n`;
    xml += `<xmeml version="4">\n`;
    xml += `  <sequence>\n`;
    xml += `    <name>${edl.sourceVideo || 'Sequence'}</name>\n`;
    xml += `    <rate><timebase>${fps}</timebase></rate>\n`;
    xml += `    <media>\n`;
    xml += `      <video>\n`;
    xml += `        <track>\n`;

    let startFrame = 0;
    for (const segment of includeSegments) {
      const inFrame = Math.floor(segment.startTime * fps);
      const outFrame = Math.floor((segment.endTime || segment.startTime + 1) * fps);
      const duration = outFrame - inFrame;

      xml += `          <clipitem>\n`;
      xml += `            <name>${segment.name || 'Clip'}</name>\n`;
      xml += `            <start>${startFrame}</start>\n`;
      xml += `            <end>${startFrame + duration}</end>\n`;
      xml += `            <in>${inFrame}</in>\n`;
      xml += `            <out>${outFrame}</out>\n`;
      xml += `            <file>\n`;
      xml += `              <pathurl>file://${edl.sourceVideo}</pathurl>\n`;
      xml += `            </file>\n`;
      xml += `          </clipitem>\n`;

      startFrame += duration;
    }

    xml += `        </track>\n`;
    xml += `      </video>\n`;
    xml += `    </media>\n`;
    xml += `  </sequence>\n`;
    xml += `</xmeml>`;

    return xml;
  }

  /**
   * Import from CMX 3600 format
   * @param {string} cmxContent - CMX 3600 formatted string
   * @param {string} sourceVideo - Path to source video
   * @param {number} fps - Frames per second
   * @returns {Object} EDL data
   */
  importFromCMX3600(cmxContent, sourceVideo, fps = 30) {
    const lines = cmxContent.split('\n');
    const segments = [];
    
    let i = 0;
    while (i < lines.length) {
      const line = lines[i].trim();
      
      // Match event line pattern: NNN  REEL  TYPE  TRANS  SRC_IN  SRC_OUT  REC_IN  REC_OUT
      const eventMatch = line.match(/^(\d{3})\s+\S+\s+\S+\s+\S+\s+(\d{2}:\d{2}:\d{2}:\d{2})\s+(\d{2}:\d{2}:\d{2}:\d{2})/);
      
      if (eventMatch) {
        const srcIn = this._timecodeToSeconds(eventMatch[2], fps);
        const srcOut = this._timecodeToSeconds(eventMatch[3], fps);
        
        let name = `Segment ${segments.length + 1}`;
        
        // Check for clip name comment
        if (i + 1 < lines.length) {
          const nextLine = lines[i + 1].trim();
          const nameMatch = nextLine.match(/^\*\s*FROM CLIP NAME:\s*(.+)/);
          if (nameMatch) {
            name = nameMatch[1];
          }
        }
        
        segments.push({
          id: `seg_${String(segments.length + 1).padStart(3, '0')}`,
          startTime: srcIn,
          endTime: srcOut,
          type: SEGMENT_TYPES.INCLUDE,
          name: name
        });
      }
      
      i++;
    }

    return {
      formatVersion: this.formatVersion,
      sourceVideo: sourceVideo,
      createdAt: new Date().toISOString(),
      importedFrom: 'CMX3600',
      segments: segments,
      markers: [],
      audioTracks: [],
      effects: {}
    };
  }

  /**
   * Convert seconds to SMPTE timecode
   * @private
   */
  _secondsToTimecode(seconds, fps) {
    const totalFrames = Math.floor(seconds * fps);
    const hours = Math.floor(totalFrames / (fps * 60 * 60));
    const minutes = Math.floor((totalFrames % (fps * 60 * 60)) / (fps * 60));
    const secs = Math.floor((totalFrames % (fps * 60)) / fps);
    const frames = totalFrames % fps;
    
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}:${String(frames).padStart(2, '0')}`;
  }

  /**
   * Convert SMPTE timecode to seconds
   * @private
   */
  _timecodeToSeconds(timecode, fps) {
    const parts = timecode.split(':').map(Number);
    if (parts.length !== 4) return 0;
    
    const [hours, minutes, seconds, frames] = parts;
    return hours * 3600 + minutes * 60 + seconds + frames / fps;
  }

  /**
   * Validate EDL structure
   * @param {Object} edl - EDL to validate
   * @returns {Object} Validation result
   */
  validateEDL(edl) {
    const errors = [];
    const warnings = [];

    if (!edl.sourceVideo) {
      errors.push('Missing sourceVideo');
    }

    if (!edl.segments || edl.segments.length === 0) {
      errors.push('No segments defined');
    } else {
      // Check for overlapping segments
      const includes = edl.segments
        .filter(s => s.type === SEGMENT_TYPES.INCLUDE)
        .sort((a, b) => a.startTime - b.startTime);
      
      for (let i = 1; i < includes.length; i++) {
        if (includes[i].startTime < includes[i - 1].endTime) {
          warnings.push(`Overlapping segments: ${includes[i - 1].id} and ${includes[i].id}`);
        }
      }

      // Check for negative times
      for (const seg of edl.segments) {
        if (seg.startTime < 0) {
          errors.push(`Segment ${seg.id} has negative start time`);
        }
        if (seg.endTime !== null && seg.endTime <= seg.startTime) {
          errors.push(`Segment ${seg.id} has invalid duration (end <= start)`);
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Calculate total duration from EDL segments
   * @param {Object} edl - EDL data
   * @returns {number} Total duration in seconds
   */
  calculateDuration(edl) {
    const includeSegments = (edl.segments || []).filter(
      seg => seg.type === SEGMENT_TYPES.INCLUDE
    );
    
    return includeSegments.reduce((total, seg) => {
      const duration = (seg.endTime || 0) - (seg.startTime || 0);
      return total + Math.max(0, duration);
    }, 0);
  }
}







