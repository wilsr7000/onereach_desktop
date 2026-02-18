/**
 * ADR Track Manager - Multi-track audio workflow for ADR (Automated Dialogue Replacement)
 *
 * Provides:
 * - Track duplication
 * - Working track with dead space regions
 * - ADR clip management
 * - Fill track for room tone
 * - Right-click context menu for tracks
 *
 * Usage:
 *   app.adrManager = new ADRTrackManager(app);
 *   app.trackContextMenu = new TrackContextMenu(app, app.adrManager);
 */

(function (global) {
  'use strict';

  // ============================================================================
  // ADRTrackManager Class
  // ============================================================================

  class ADRTrackManager {
    constructor(appContext) {
      this.app = appContext;

      // Track type constants
      this.TRACK_TYPES = {
        ORIGINAL: 'original',
        GUIDE: 'guide',
        WORKING: 'working',
        ADR: 'adr',
        FILL: 'fill',
        VOICE: 'voice',
        DUB: 'dub',
        SFX: 'sfx',
        SPEAKER: 'speaker', // Speaker-specific tracks from split
      };

      // Dead space regions (visual-only markers for silence)
      this.deadSpaceRegions = [];

      console.log('[ADRTrackManager] Initialized');
    }

    /**
     * Get all audio tracks from app
     */
    get tracks() {
      const tracks = this.app.audioTracks || [];
      // Debug: log if audioTracks seems missing
      if (!this.app.audioTracks) {
        console.warn('[ADRTrackManager] app.audioTracks is undefined/null');
      }
      return tracks;
    }

    /**
     * Find a track by ID
     */
    findTrack(trackId) {
      const tracks = this.tracks;
      const found = tracks.find((t) => t.id === trackId);
      if (!found && tracks.length > 0) {
        console.warn(
          '[ADRTrackManager] Track not found:',
          trackId,
          'Available:',
          tracks.map((t) => t.id)
        );
      }
      return found;
    }

    /**
     * Find a track by type
     */
    findTrackByType(type) {
      return this.tracks.find((t) => t.type === type);
    }

    /**
     * Get the guide track (original or first non-working track)
     */
    getGuideTrack() {
      return this.findTrackByType(this.TRACK_TYPES.ORIGINAL) || this.findTrackByType(this.TRACK_TYPES.GUIDE);
    }

    /**
     * Check if a working track exists
     */
    hasWorkingTrack() {
      return !!this.findTrackByType(this.TRACK_TYPES.WORKING);
    }

    /**
     * Check if an ADR track exists
     */
    hasADRTrack() {
      return !!this.findTrackByType(this.TRACK_TYPES.ADR);
    }

    /**
     * Duplicate a track
     * @param {string} trackId - ID of the track to duplicate
     * @param {object} options - Optional configuration
     * @returns {object|null} The new duplicated track or null if failed
     */
    duplicateTrack(trackId, options = {}) {
      const sourceTrack = this.findTrack(trackId);
      if (!sourceTrack) {
        console.error('[ADRTrackManager] Cannot duplicate: track not found', trackId);
        this.app.showToast && this.app.showToast('error', 'Track not found');
        return null;
      }

      const {
        name = `${sourceTrack.name} (Copy)`,
        type = sourceTrack.type === this.TRACK_TYPES.ORIGINAL ? this.TRACK_TYPES.WORKING : sourceTrack.type,
        copyClips = true,
        createVisualClip = true, // Create visual representation for original track
      } = options;

      // Generate new track ID
      const newTrackId = `A${this.app.nextTrackId++}`;

      // Determine clips for new track
      let clips = [];

      if (copyClips && sourceTrack.clips && sourceTrack.clips.length > 0) {
        // Copy existing clips
        clips = this._cloneClips(sourceTrack.clips);
      } else if (createVisualClip && sourceTrack.type === this.TRACK_TYPES.ORIGINAL) {
        // For original track, create a visual clip representing the full audio
        const video = document.getElementById('videoPlayer');
        const duration = video?.duration || this.app.videoInfo?.duration || 0;

        if (duration > 0) {
          clips = [
            {
              id: `clip-${Date.now()}`,
              type: 'visual-reference',
              name: 'Original Audio',
              startTime: 0,
              endTime: duration,
              duration: duration,
              sourceTrackId: trackId,
              isVisualOnly: true, // Flag to indicate this is visual representation only
            },
          ];
        }
      }

      // Create the new track
      const newTrack = {
        id: newTrackId,
        type: type,
        name: name,
        muted: false,
        solo: false,
        volume: sourceTrack.volume || 1.0,
        clips: clips,
        sourceTrackId: trackId, // Reference to original for ADR workflow
      };

      // Add to tracks array
      this.app.audioTracks.push(newTrack);

      // Render the new track in UI
      if (this.app.renderAudioTrack) {
        this.app.renderAudioTrack(newTrack);
      }

      // Render the visual clip on the new track
      if (clips.length > 0) {
        this._renderVisualClip(newTrackId, clips[0]);
      }

      console.log('[ADRTrackManager] Duplicated track', {
        sourceId: trackId,
        newId: newTrackId,
        type: type,
        name: name,
        clipsCount: clips.length,
      });

      this.app.showToast && this.app.showToast('success', `Created ${name}`);

      // Load audio for the new track (async, shares buffer with original)
      if (this.app.multiTrackAudio) {
        this.app.multiTrackAudio
          .loadTrackAudio(newTrackId, null, {
            volume: newTrack.volume || 1.0,
            muted: newTrack.muted || false,
            solo: newTrack.solo || false,
          })
          .then(() => {
            console.log('[ADRTrackManager] Audio loaded for new track:', newTrackId);
          })
          .catch((err) => {
            console.warn('[ADRTrackManager] Could not load audio for track:', newTrackId, err.message);
          });
      }

      return newTrack;
    }

    /**
     * Render a visual clip on a track (shows waveform representation)
     */
    _renderVisualClip(trackId, clip) {
      const trackContent = document.getElementById(`trackContent-${trackId}`);
      if (!trackContent) {
        console.warn('[ADRTrackManager] Track content container not found:', trackId);
        return;
      }

      // Hide empty state
      const emptyState = document.getElementById(`trackEmpty-${trackId}`);
      if (emptyState) {
        emptyState.style.display = 'none';
      }

      // Get video duration for positioning
      const video = document.getElementById('videoPlayer');
      const totalDuration = video?.duration || this.app.videoInfo?.duration || clip.duration;

      // Calculate clip position and width as percentage
      const leftPercent = (clip.startTime / totalDuration) * 100;
      const widthPercent = ((clip.endTime - clip.startTime) / totalDuration) * 100;

      // Create clip element
      const clipEl = document.createElement('div');
      clipEl.className = 'track-clip visual-reference-clip';
      clipEl.id = `clip-${clip.id}`;
      clipEl.dataset.clipId = clip.id;
      clipEl.style.cssText = `
        position: absolute;
        left: ${leftPercent}%;
        width: ${widthPercent}%;
        height: 100%;
        background: linear-gradient(180deg, rgba(59, 130, 246, 0.3) 0%, rgba(59, 130, 246, 0.1) 100%);
        border: 1px solid rgba(59, 130, 246, 0.5);
        border-radius: 4px;
        overflow: hidden;
      `;

      // Add waveform visualization
      const waveformContainer = document.createElement('div');
      waveformContainer.className = 'clip-waveform';
      waveformContainer.style.cssText = `
        width: 100%;
        height: 100%;
        opacity: 0.7;
        position: relative;
      `;

      // Copy waveform from original track - but REGENERATE to avoid transcript text overlay
      // The transcript words are drawn directly on the canvas, so we can't just copy it
      const originalWaveform = document.querySelector(
        '#audioTrackContainer .waveform-canvas, #audioTrackContainer .audio-waveform, #audioWaveform'
      );

      if (originalWaveform && originalWaveform.tagName === 'CANVAS' && this.app.waveformMasterPeaks) {
        // Create a new canvas and draw a CLEAN waveform (without transcript text)
        const waveformClone = document.createElement('canvas');
        const sourceWidth = originalWaveform.width;
        const sourceHeight = originalWaveform.height;
        waveformClone.width = sourceWidth;
        waveformClone.height = sourceHeight;
        waveformClone.style.width = '100%';
        waveformClone.style.height = '100%';

        // Draw a simplified waveform from the master peaks (no transcript text)
        const ctx = waveformClone.getContext('2d');
        const peaks = this.app.waveformMasterPeaks;
        const width = sourceWidth / 2; // Account for retina scaling
        const height = sourceHeight / 2;

        ctx.scale(2, 2); // Retina scaling

        // Draw simple bars waveform
        ctx.fillStyle = 'rgba(59, 130, 246, 0.6)';
        const barWidth = Math.max(1, width / peaks.length);
        const centerY = height / 2;

        peaks.forEach((peak, i) => {
          const x = (i / peaks.length) * width;
          const barHeight = peak * height * 0.8;
          ctx.fillRect(x, centerY - barHeight / 2, barWidth - 0.5, barHeight);
        });

        waveformContainer.appendChild(waveformClone);
      } else if (originalWaveform && originalWaveform.tagName === 'CANVAS') {
        // Fallback: Copy canvas but note it may have transcript text
        // This happens when waveformMasterPeaks isn't available yet
        const waveformClone = document.createElement('canvas');
        waveformClone.width = originalWaveform.width;
        waveformClone.height = originalWaveform.height;
        waveformClone.style.width = '100%';
        waveformClone.style.height = '100%';

        const ctx = waveformClone.getContext('2d');
        ctx.drawImage(originalWaveform, 0, 0);

        waveformContainer.appendChild(waveformClone);
      } else {
        // No waveform available - show gradient placeholder
        waveformContainer.style.background = `linear-gradient(
          180deg, 
          transparent 0%, 
          transparent 35%,
          rgba(59, 130, 246, 0.2) 40%,
          rgba(59, 130, 246, 0.4) 50%,
          rgba(59, 130, 246, 0.2) 60%,
          transparent 65%,
          transparent 100%
        )`;
      }

      clipEl.appendChild(waveformContainer);

      trackContent.appendChild(clipEl);

      console.log('[ADRTrackManager] Rendered visual clip on track', trackId);
    }

    /**
     * Create a working track from the guide/original track
     * Used when inserting silence or creating ADR
     */
    ensureWorkingTrack() {
      let workingTrack = this.findTrackByType(this.TRACK_TYPES.WORKING);

      if (!workingTrack) {
        const guideTrack = this.getGuideTrack();
        if (!guideTrack) {
          console.error('[ADRTrackManager] No guide track found');
          return null;
        }

        workingTrack = this.duplicateTrack(guideTrack.id, {
          name: 'Working',
          type: this.TRACK_TYPES.WORKING,
          copyClips: false, // Working track starts empty, dead space is visual-only
        });
      }

      return workingTrack;
    }

    /**
     * Create an ADR track if it doesn't exist
     */
    ensureADRTrack() {
      let adrTrack = this.findTrackByType(this.TRACK_TYPES.ADR);

      if (!adrTrack) {
        const newTrackId = `A${this.app.nextTrackId++}`;

        adrTrack = {
          id: newTrackId,
          type: this.TRACK_TYPES.ADR,
          name: 'ADR',
          muted: false,
          solo: false,
          volume: 1.0,
          clips: [],
        };

        this.app.audioTracks.push(adrTrack);
        if (this.app.renderAudioTrack) {
          this.app.renderAudioTrack(adrTrack);
        }

        console.log('[ADRTrackManager] Created ADR track', newTrackId);
      }

      return adrTrack;
    }

    /**
     * Clone clips array (deep copy)
     */
    _cloneClips(clips) {
      if (!clips || !Array.isArray(clips)) return [];
      return clips.map((clip) => ({ ...clip }));
    }

    /**
     * Get track display info for UI
     */
    getTrackDisplayInfo(track) {
      const typeLabels = {
        [this.TRACK_TYPES.ORIGINAL]: { label: 'Original', color: '#3b82f6' },
        [this.TRACK_TYPES.GUIDE]: { label: 'Guide', color: '#22c55e' },
        [this.TRACK_TYPES.WORKING]: { label: 'Working', color: '#f97316' },
        [this.TRACK_TYPES.ADR]: { label: 'ADR', color: '#8b5cf6' },
        [this.TRACK_TYPES.FILL]: { label: 'Fill', color: '#06b6d4' },
        [this.TRACK_TYPES.VOICE]: { label: 'Voice', color: '#ec4899' },
        [this.TRACK_TYPES.SFX]: { label: 'SFX', color: '#eab308' },
        [this.TRACK_TYPES.SPEAKER]: { label: 'Speaker', color: '#14b8a6' },
      };

      return typeLabels[track.type] || { label: track.type, color: '#6b7280' };
    }

    /**
     * Check if track can be duplicated
     */
    canDuplicate(trackId) {
      const track = this.findTrack(trackId);
      return !!track;
    }

    /**
     * Check if track can be deleted
     */
    canDelete(trackId) {
      const track = this.findTrack(trackId);
      // Can't delete original track
      return track && track.type !== this.TRACK_TYPES.ORIGINAL;
    }

    /**
     * Insert silence (mark dead space region) on the Working track
     * @param {number} startTime - Start time in seconds
     * @param {number} endTime - End time in seconds
     * @param {string} name - Name/label for this silence region
     */
    insertSilence(startTime, endTime, name = 'Silence') {
      // 1. Ensure Working track exists (duplicate Guide if needed)
      let workingTrack = this.ensureWorkingTrack();

      if (!workingTrack) {
        console.error('[ADRTrackManager] Failed to create working track');
        this.app.showToast && this.app.showToast('error', 'Could not create working track');
        return null;
      }

      // 2. Add dead space region (metadata)
      if (!workingTrack.deadSpaceRegions) {
        workingTrack.deadSpaceRegions = [];
      }

      const region = {
        id: `dead-${Date.now()}`,
        start: startTime,
        end: endTime,
        name: name,
        createdAt: new Date().toISOString(),
      };

      workingTrack.deadSpaceRegions.push(region);

      // Also add to global deadSpaceRegions for easier access
      this.deadSpaceRegions.push(region);

      // 3. Render on timeline
      this.renderDeadSpaceRegions();

      const duration = endTime - startTime;
      const formattedDuration = this._formatTime(duration);
      const formattedStart = this._formatTime(startTime);

      console.log('[ADRTrackManager] Inserted silence:', {
        name,
        start: formattedStart,
        duration: formattedDuration,
      });

      this.app.showToast && this.app.showToast('success', `Inserted silence: ${formattedStart} (${formattedDuration})`);

      return region;
    }

    /**
     * Render all dead space regions on the Working track timeline
     */
    renderDeadSpaceRegions() {
      const workingTrack = this.findTrackByType(this.TRACK_TYPES.WORKING);
      if (!workingTrack) {
        return;
      }

      const trackContent = document.getElementById(`trackContent-${workingTrack.id}`);
      if (!trackContent) {
        console.warn('[ADRTrackManager] Working track content not found');
        return;
      }

      // Remove existing dead space regions
      trackContent.querySelectorAll('.dead-space-region').forEach((el) => el.remove());

      // Get video duration for positioning
      const video = document.getElementById('videoPlayer');
      const totalDuration = video?.duration || this.app.videoInfo?.duration || 1;

      // Render each dead space region
      const regions = workingTrack.deadSpaceRegions || [];
      regions.forEach((region) => {
        const leftPercent = (region.start / totalDuration) * 100;
        const widthPercent = ((region.end - region.start) / totalDuration) * 100;

        const regionEl = document.createElement('div');
        regionEl.className = 'dead-space-region';
        regionEl.dataset.regionId = region.id;
        regionEl.style.cssText = `
          position: absolute;
          left: ${leftPercent}%;
          width: ${widthPercent}%;
          height: 100%;
          pointer-events: none;
          z-index: 10;
        `;

        // Add label
        const labelEl = document.createElement('div');
        labelEl.className = 'dead-space-label';
        labelEl.textContent = `🔇 ${region.name}`;
        regionEl.appendChild(labelEl);

        trackContent.appendChild(regionEl);
      });

      console.log('[ADRTrackManager] Rendered', regions.length, 'dead space regions');
    }

    /**
     * Remove a dead space region
     */
    removeDeadSpaceRegion(regionId) {
      const workingTrack = this.findTrackByType(this.TRACK_TYPES.WORKING);
      if (!workingTrack || !workingTrack.deadSpaceRegions) {
        return false;
      }

      const index = workingTrack.deadSpaceRegions.findIndex((r) => r.id === regionId);
      if (index !== -1) {
        workingTrack.deadSpaceRegions.splice(index, 1);

        // Also remove from global array
        const globalIndex = this.deadSpaceRegions.findIndex((r) => r.id === regionId);
        if (globalIndex !== -1) {
          this.deadSpaceRegions.splice(globalIndex, 1);
        }

        this.renderDeadSpaceRegions();
        return true;
      }

      return false;
    }

    /**
     * Re-record with AI - Full ADR workflow
     * Inserts silence + generates ElevenLabs audio + adds to ADR track
     * @param {number} startTime - Start time in seconds
     * @param {number} endTime - End time in seconds
     * @param {string} text - Transcription text to convert to speech
     * @param {string} name - Name/label for this clip
     * @param {string} voice - ElevenLabs voice ID (optional)
     */
    async rerecordWithAI(startTime, endTime, text, name = 'ADR Clip', voice = 'Rachel') {
      if (!text || text.trim().length === 0) {
        console.error('[ADRTrackManager] No transcription provided');
        this.app.showToast && this.app.showToast('error', 'Please enter transcription text');
        return null;
      }

      try {
        // 1. Insert silence on Working track (creates it if needed)
        console.log('[ADRTrackManager] Step 1/3: Inserting silence...');
        this.insertSilence(startTime, endTime, name);

        // 2. Ensure ADR track exists
        console.log('[ADRTrackManager] Step 2/3: Ensuring ADR track...');
        let adrTrack = this.ensureADRTrack();

        if (!adrTrack) {
          throw new Error('Failed to create ADR track');
        }

        // 3. Generate ElevenLabs audio
        console.log('[ADRTrackManager] Step 3/3: Generating AI voice...');
        this.app.showProgress && this.app.showProgress('Generating AI Voice', 'Calling ElevenLabs API...');

        const result = await window.videoEditor.generateElevenLabsAudio({
          text: text.trim(),
          voice: voice,
        });

        this.app.hideProgress && this.app.hideProgress();

        if (result.error) {
          throw new Error(result.error);
        }

        if (!result.audioPath) {
          throw new Error('No audio file generated');
        }

        // 4. Add clip to ADR track
        const clip = {
          id: `adr-${Date.now()}`,
          name: name,
          path: result.audioPath,
          startTime: startTime,
          endTime: endTime,
          duration: endTime - startTime,
          text: text,
          voice: voice,
          type: 'elevenlabs',
          createdAt: new Date().toISOString(),
        };

        adrTrack.clips.push(clip);

        // 5. Render the clip on timeline
        if (this.app.renderTrackClips) {
          this.app.renderTrackClips(adrTrack.id);
        } else {
          // Fallback: manually render the clip
          this._renderADRClip(adrTrack.id, clip);
        }

        console.log('[ADRTrackManager] ADR workflow complete:', {
          clip: name,
          duration: this._formatTime(clip.duration),
          audioPath: result.audioPath,
        });

        this.app.showToast && this.app.showToast('success', `ADR clip added: ${name}`);

        return clip;
      } catch (error) {
        console.error('[ADRTrackManager] Re-record failed:', error);
        this.app.hideProgress && this.app.hideProgress();
        this.app.showToast && this.app.showToast('error', 'Re-record failed: ' + error.message);
        return null;
      }
    }

    /**
     * Render an ADR clip on the timeline
     */
    _renderADRClip(trackId, clip) {
      const trackContent = document.getElementById(`trackContent-${trackId}`);
      if (!trackContent) {
        console.warn('[ADRTrackManager] ADR track content not found');
        return;
      }

      // Hide empty state
      const emptyState = document.getElementById(`trackEmpty-${trackId}`);
      if (emptyState) {
        emptyState.style.display = 'none';
      }

      // Get video duration for positioning
      const video = document.getElementById('videoPlayer');
      const totalDuration = video?.duration || this.app.videoInfo?.duration || clip.duration;

      // Calculate clip position and width as percentage
      const leftPercent = (clip.startTime / totalDuration) * 100;
      const widthPercent = ((clip.endTime - clip.startTime) / totalDuration) * 100;

      // Create clip element
      const clipEl = document.createElement('div');
      clipEl.className = 'track-clip adr-clip';
      clipEl.id = `clip-${clip.id}`;
      clipEl.dataset.clipId = clip.id;
      clipEl.style.cssText = `
        position: absolute;
        left: ${leftPercent}%;
        width: ${widthPercent}%;
        height: 100%;
        background: linear-gradient(180deg, rgba(139, 92, 246, 0.4) 0%, rgba(139, 92, 246, 0.2) 100%);
        border: 1px solid rgba(139, 92, 246, 0.7);
        border-radius: 4px;
        overflow: hidden;
        cursor: pointer;
      `;

      // Empty content - waveform only, no text labels

      trackContent.appendChild(clipEl);

      console.log('[ADRTrackManager] Rendered ADR clip on track', trackId);
    }

    /**
     * Create a custom voice using ElevenLabs voice cloning
     * Uses smart audio selection based on transcript when available
     * @param {string} trackId - ID of the track to clone voice from
     * @param {string} voiceName - Name for the custom voice
     */
    async createCustomVoice(trackId, voiceName) {
      const track = this.findTrack(trackId);
      if (!track) {
        throw new Error('Track not found');
      }

      console.log('[ADRTrackManager] Creating custom voice from track:', track.name);

      // Get transcript and duration info
      const transcript = this.app.transcriptSegments || [];
      const video = document.getElementById('videoPlayer');
      const totalDuration = video?.duration || this.app.videoInfo?.duration || 60;

      // Calculate available audio duration
      let availableDuration = totalDuration;
      if (track.type !== this.TRACK_TYPES.ORIGINAL && track.clips?.length > 0) {
        availableDuration = track.clips.reduce((sum, clip) => {
          return sum + ((clip.endTime || clip.duration || 0) - (clip.startTime || 0));
        }, 0);
      }

      // Validate minimum audio (1 minute recommended for ElevenLabs)
      if (availableDuration < 60) {
        const proceed = confirm(
          `Warning: Only ${Math.round(availableDuration)} seconds of audio available.\n\n` +
            `ElevenLabs recommends at least 1 minute for best voice cloning results.\n\n` +
            `Continue anyway?`
        );
        if (!proceed) return null;
      }

      try {
        this.app.showProgress &&
          this.app.showProgress('Creating Custom Voice', 'Analyzing audio for optimal segments...');

        // Select optimal audio segments using transcript
        const segments = this._selectOptimalVoiceSegments(transcript, track, {
          targetDuration: 180, // 3 minutes optimal
          maxDuration: 300, // 5 minutes max
          preferSpeaker: track.speakerId || null,
        });

        console.log(
          '[ADRTrackManager] Selected',
          segments.length,
          'segments for voice cloning, total duration:',
          segments.reduce((sum, s) => sum + (s.end - s.start), 0).toFixed(1),
          'seconds'
        );

        // Extract audio for selected segments
        let audioPath = null;

        if (track.type === this.TRACK_TYPES.ORIGINAL) {
          if (!this.app.videoPath) {
            throw new Error('No video loaded');
          }

          this.app.showProgress && this.app.showProgress('Creating Custom Voice', 'Extracting audio sample...');

          // If we have multiple segments, extract each and concatenate
          if (segments.length === 1) {
            // Single segment - extract directly
            audioPath = await window.videoEditor.extractAudio(this.app.videoPath, {
              startTime: segments[0].start,
              duration: segments[0].end - segments[0].start,
            });
          } else {
            // Multiple segments - extract the full range (simplification)
            // In production, you'd concatenate segments, but for now use contiguous range
            const minStart = Math.min(...segments.map((s) => s.start));
            const maxEnd = Math.max(...segments.map((s) => s.end));
            const duration = Math.min(maxEnd - minStart, 300); // Cap at 5 minutes

            audioPath = await window.videoEditor.extractAudio(this.app.videoPath, {
              startTime: minStart,
              duration: duration,
            });
          }
        } else if (track.clips && track.clips.length > 0) {
          // For other tracks, use the first clip's audio path
          const firstClip = track.clips[0];
          if (firstClip.path) {
            audioPath = firstClip.path;
          } else {
            throw new Error('No audio file found in track');
          }
        } else {
          throw new Error('Track has no audio to clone from');
        }

        if (!audioPath || audioPath.error) {
          throw new Error('Failed to extract audio sample');
        }

        // Update progress
        this.app.showProgress &&
          this.app.showProgress('Creating Custom Voice', 'Uploading to ElevenLabs (this may take a minute)...');

        // Call ElevenLabs voice cloning API
        const result = await window.videoEditor.createCustomVoice({
          name: voiceName,
          audioPath: audioPath.outputPath || audioPath,
        });

        this.app.hideProgress && this.app.hideProgress();

        if (result.error) {
          throw new Error(result.error);
        }

        if (!result.voiceId) {
          throw new Error('No voice ID returned from ElevenLabs');
        }

        // Store the custom voice
        if (!this.app.customVoices) {
          this.app.customVoices = [];
        }

        this.app.customVoices.push({
          id: result.voiceId,
          name: voiceName,
          createdFrom: track.name,
          createdAt: new Date().toISOString(),
        });

        // Update voice selector dropdown
        this._updateVoiceSelector();

        console.log('[ADRTrackManager] Custom voice created:', {
          name: voiceName,
          voiceId: result.voiceId,
          source: track.name,
        });

        this.app.showToast && this.app.showToast('success', `Custom voice "${voiceName}" created!`);

        return result;
      } catch (error) {
        console.error('[ADRTrackManager] Create custom voice failed:', error);
        this.app.hideProgress && this.app.hideProgress();
        throw error;
      }
    }

    /**
     * Select optimal audio segments for voice cloning using transcript data
     * @param {Array} transcript - Array of transcript segments with {text, start, end, speakerId}
     * @param {Object} track - The track object
     * @param {Object} options - Selection options {targetDuration, maxDuration, preferSpeaker}
     * @returns {Array} Array of selected segments {start, end}
     */
    _selectOptimalVoiceSegments(transcript, track, options = {}) {
      const { targetDuration = 180, maxDuration = 300, preferSpeaker = null } = options;
      const totalDuration = this.app.videoInfo?.duration || 60;

      // No transcript - return single segment capped at maxDuration
      if (!transcript || transcript.length === 0) {
        console.log(
          '[ADRTrackManager] No transcript available, using first',
          Math.min(maxDuration, totalDuration),
          'seconds'
        );
        return [{ start: 0, end: Math.min(maxDuration, totalDuration) }];
      }

      // Group consecutive transcript segments by speaker
      const speakerGroups = this._groupTranscriptBySpeaker(transcript);

      console.log('[ADRTrackManager] Found', speakerGroups.length, 'speaker groups in transcript');

      // Filter for preferred speaker if specified
      let candidateGroups = speakerGroups;
      if (preferSpeaker) {
        const filtered = speakerGroups.filter((g) => g.speakerId === preferSpeaker);
        if (filtered.length > 0) {
          candidateGroups = filtered;
          console.log('[ADRTrackManager] Filtered to', candidateGroups.length, 'groups for speaker:', preferSpeaker);
        }
      }

      // Sort by duration (longer continuous speech = better for cloning)
      candidateGroups.sort((a, b) => b.end - b.start - (a.end - a.start));

      // Accumulate segments until target duration reached
      const selected = [];
      let totalSelectedDuration = 0;

      for (const group of candidateGroups) {
        if (totalSelectedDuration >= targetDuration) break;

        const groupDuration = group.end - group.start;

        // Skip very short segments (less than 5 seconds)
        if (groupDuration < 5) continue;

        selected.push({ start: group.start, end: group.end, speakerId: group.speakerId });
        totalSelectedDuration += groupDuration;
      }

      // If we couldn't get enough from speaker groups, fall back to simple extraction
      if (totalSelectedDuration < 60 && totalDuration >= 60) {
        console.log(
          '[ADRTrackManager] Not enough speech segments, falling back to first',
          Math.min(targetDuration, totalDuration),
          'seconds'
        );
        return [{ start: 0, end: Math.min(targetDuration, totalDuration) }];
      }

      return selected;
    }

    /**
     * Group transcript segments by speaker into continuous blocks
     * @param {Array} transcript - Array of word/segment objects with speakerId
     * @returns {Array} Array of speaker groups {speakerId, start, end, wordCount}
     */
    _groupTranscriptBySpeaker(transcript) {
      if (!transcript || transcript.length === 0) return [];

      const groups = [];
      let currentGroup = null;

      for (const segment of transcript) {
        const speakerId = segment.speakerId || segment.speaker_id || segment.speaker || 'unknown';
        const start = segment.start || 0;
        const end = segment.end || start + 0.5;

        if (!currentGroup || currentGroup.speakerId !== speakerId || start - currentGroup.end > 2) {
          // Start new group if speaker changed or there's a gap > 2 seconds
          if (currentGroup) {
            groups.push(currentGroup);
          }
          currentGroup = {
            speakerId,
            start,
            end,
            wordCount: 1,
          };
        } else {
          // Extend current group
          currentGroup.end = end;
          currentGroup.wordCount++;
        }
      }

      // Don't forget the last group
      if (currentGroup) {
        groups.push(currentGroup);
      }

      return groups;
    }

    /**
     * Update the voice selector dropdown with custom voices
     */
    _updateVoiceSelector() {
      const voiceSelect = document.getElementById('elevenLabsVoiceSelect');
      if (!voiceSelect) {
        console.warn('[ADRTrackManager] Voice selector not found');
        return;
      }

      // Get current selection
      const currentValue = voiceSelect.value;

      // Remove old custom voices options (if any)
      const customOptions = voiceSelect.querySelectorAll('.custom-voice-option');
      customOptions.forEach((opt) => opt.remove());

      // Add custom voices
      const customVoices = this.app.customVoices || [];
      if (customVoices.length > 0) {
        // Add separator if needed
        if (voiceSelect.children.length > 0 && !voiceSelect.querySelector('.voice-divider')) {
          const divider = document.createElement('option');
          divider.disabled = true;
          divider.className = 'voice-divider';
          divider.textContent = '─────── Custom Voices ───────';
          voiceSelect.appendChild(divider);
        }

        // Add each custom voice
        customVoices.forEach((voice) => {
          const option = document.createElement('option');
          option.value = voice.id;
          option.textContent = `${voice.name} (Custom)`;
          option.className = 'custom-voice-option';
          voiceSelect.appendChild(option);
        });
      }

      // Restore selection if still valid
      if (currentValue) {
        const optionExists = Array.from(voiceSelect.options).some((opt) => opt.value === currentValue);
        if (optionExists) {
          voiceSelect.value = currentValue;
        }
      }

      console.log('[ADRTrackManager] Voice selector updated with', customVoices.length, 'custom voices');
    }

    /**
     * Create Fill Track with auto-extracted room tone
     */
    async createFillTrack() {
      if (!this.app.videoPath) {
        throw new Error('No video loaded');
      }

      console.log('[ADRTrackManager] Creating fill track with room tone...');

      try {
        this.app.showProgress && this.app.showProgress('Creating Fill Track', 'Analyzing audio for quiet sections...');

        // 1. Find quiet sections in the video
        const quietSections = await window.videoEditor.findQuietSections(this.app.videoPath);

        if (!quietSections || quietSections.length === 0) {
          this.app.hideProgress && this.app.hideProgress();
          this.app.showToast && this.app.showToast('warning', 'No quiet sections found - fill track will use silence');

          // Create fill track with silence
          this._createEmptyFillTrack();
          return;
        }

        console.log('[ADRTrackManager] Found', quietSections.length, 'quiet sections');

        // 2. Extract room tone from the best (longest/quietest) section
        const bestSection = quietSections[0];
        const extractDuration = Math.min(10, bestSection.end - bestSection.start); // Max 10 seconds

        this.app.showProgress && this.app.showProgress('Creating Fill Track', 'Extracting room tone sample...');

        const result = await window.videoEditor.extractAudio(this.app.videoPath, {
          startTime: bestSection.start,
          duration: extractDuration,
        });

        this.app.hideProgress && this.app.hideProgress();

        if (result.error || !result.outputPath) {
          throw new Error('Failed to extract room tone: ' + (result.error || 'No output path'));
        }

        // 3. Create or update Fill track
        let fillTrack = this.findTrackByType(this.TRACK_TYPES.FILL);

        if (!fillTrack) {
          const newTrackId = `A${this.app.nextTrackId++}`;

          fillTrack = {
            id: newTrackId,
            type: this.TRACK_TYPES.FILL,
            name: 'Fill (Room Tone)',
            muted: false,
            solo: false,
            volume: 0.6, // Lower volume for subtle background
            clips: [],
            roomTonePath: result.outputPath,
            roomToneDuration: extractDuration,
            roomToneSource: {
              start: bestSection.start,
              end: bestSection.start + extractDuration,
              volume: bestSection.volume || 'unknown',
            },
          };

          this.app.audioTracks.push(fillTrack);

          if (this.app.renderAudioTrack) {
            this.app.renderAudioTrack(fillTrack);
          }

          console.log('[ADRTrackManager] Created fill track:', newTrackId);
        } else {
          // Update existing fill track
          fillTrack.roomTonePath = result.outputPath;
          fillTrack.roomToneDuration = extractDuration;
          this.app.showToast && this.app.showToast('info', 'Fill track updated with new room tone');
        }

        // 4. Add a visual clip representing the room tone
        const video = document.getElementById('videoPlayer');
        const totalDuration = video?.duration || this.app.videoInfo?.duration || extractDuration;

        fillTrack.clips = [
          {
            id: `fill-${Date.now()}`,
            type: 'room-tone',
            name: 'Room Tone (Loops)',
            startTime: 0,
            endTime: totalDuration,
            duration: totalDuration,
            sourcePath: result.outputPath,
            sourceDuration: extractDuration,
            isLooping: true,
          },
        ];

        // Render the clip
        this._renderFillClip(fillTrack.id, fillTrack.clips[0]);

        this.app.showToast &&
          this.app.showToast('success', `Fill track created with ${this._formatTime(extractDuration)} of room tone`);

        return fillTrack;
      } catch (error) {
        console.error('[ADRTrackManager] Create fill track failed:', error);
        this.app.hideProgress && this.app.hideProgress();
        throw error;
      }
    }

    /**
     * Create empty fill track (fallback when no room tone found)
     */
    _createEmptyFillTrack() {
      let fillTrack = this.findTrackByType(this.TRACK_TYPES.FILL);

      if (!fillTrack) {
        const newTrackId = `A${this.app.nextTrackId++}`;

        fillTrack = {
          id: newTrackId,
          type: this.TRACK_TYPES.FILL,
          name: 'Fill (Silence)',
          muted: false,
          solo: false,
          volume: 0.6,
          clips: [],
          roomTonePath: null,
        };

        this.app.audioTracks.push(fillTrack);

        if (this.app.renderAudioTrack) {
          this.app.renderAudioTrack(fillTrack);
        }

        console.log('[ADRTrackManager] Created empty fill track');
      }

      return fillTrack;
    }

    /**
     * Render fill track clip (room tone visual)
     */
    _renderFillClip(trackId, clip) {
      const trackContent = document.getElementById(`trackContent-${trackId}`);
      if (!trackContent) {
        console.warn('[ADRTrackManager] Fill track content not found');
        return;
      }

      // Hide empty state
      const emptyState = document.getElementById(`trackEmpty-${trackId}`);
      if (emptyState) {
        emptyState.style.display = 'none';
      }

      // Get video duration for positioning
      const video = document.getElementById('videoPlayer');
      const _totalDuration = video?.duration || this.app.videoInfo?.duration || clip.duration;

      // Fill track spans the entire duration
      const clipEl = document.createElement('div');
      clipEl.className = 'track-clip fill-clip';
      clipEl.id = `clip-${clip.id}`;
      clipEl.dataset.clipId = clip.id;
      clipEl.style.cssText = `
        position: absolute;
        left: 0%;
        width: 100%;
        height: 100%;
        background: repeating-linear-gradient(
          90deg,
          rgba(6, 182, 212, 0.15),
          rgba(6, 182, 212, 0.15) 20px,
          rgba(6, 182, 212, 0.25) 20px,
          rgba(6, 182, 212, 0.25) 40px
        );
        border: 1px solid rgba(6, 182, 212, 0.5);
        border-radius: 4px;
        overflow: hidden;
      `;

      // Add label
      clipEl.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: center; height: 100%; padding: 4px;">
          <span style="font-size: 14px; margin-right: 4px;">🎵</span>
          <span style="font-size: 10px; color: rgba(255,255,255,0.9); text-shadow: 0 1px 2px rgba(0,0,0,0.6);">
            Room Tone (${this._formatTime(clip.sourceDuration)} loops)
          </span>
        </div>
      `;

      trackContent.appendChild(clipEl);

      console.log('[ADRTrackManager] Rendered fill clip on track', trackId);
    }

    /**
     * Export video with ADR tracks merged
     * Triggers the final export process that merges all audio layers
     */
    async exportWithADRTracks() {
      if (!this.app.videoPath) {
        this.app.showToast && this.app.showToast('error', 'No video loaded');
        return null;
      }

      // Get all tracks
      const workingTrack = this.findTrackByType(this.TRACK_TYPES.WORKING);
      const adrTrack = this.findTrackByType(this.TRACK_TYPES.ADR);
      const fillTrack = this.findTrackByType(this.TRACK_TYPES.FILL);

      // Check if there's anything to export
      if (!workingTrack && !adrTrack) {
        this.app.showToast && this.app.showToast('info', 'No ADR changes to export - exporting original video');
        // Could fallback to regular export
        return null;
      }

      console.log('[ADRTrackManager] Exporting with ADR tracks:', {
        hasWorking: !!workingTrack,
        hasADR: !!adrTrack,
        hasFill: !!fillTrack,
        deadSpaceRegions: workingTrack?.deadSpaceRegions?.length || 0,
        adrClips: adrTrack?.clips?.length || 0,
      });

      try {
        // Prepare export data
        const exportData = {
          deadSpaceRegions: workingTrack?.deadSpaceRegions || [],
          adrClips: adrTrack?.clips || [],
          fillTrack: fillTrack
            ? {
                roomTonePath: fillTrack.roomTonePath,
                roomToneDuration: fillTrack.roomToneDuration,
                volume: fillTrack.volume || 0.6,
              }
            : null,
        };

        this.app.showProgress && this.app.showProgress('Exporting ADR Video', 'Preparing audio layers...');

        // Call backend export method
        const result = await window.videoEditor.exportWithADRTracks(this.app.videoPath, exportData);

        this.app.hideProgress && this.app.hideProgress();

        if (result.error) {
          throw new Error(result.error);
        }

        console.log('[ADRTrackManager] Export complete:', result.outputPath);
        this.app.showToast && this.app.showToast('success', 'ADR video exported successfully!');

        return result;
      } catch (error) {
        console.error('[ADRTrackManager] Export failed:', error);
        this.app.hideProgress && this.app.hideProgress();
        this.app.showToast && this.app.showToast('error', 'Export failed: ' + error.message);
        throw error;
      }
    }

    /**
     * Format time helper (mm:ss)
     */
    _formatTime(seconds) {
      if (typeof seconds !== 'number' || isNaN(seconds)) return '0:00';
      const m = Math.floor(seconds / 60);
      const s = Math.floor(seconds % 60);
      return `${m}:${String(s).padStart(2, '0')}`;
    }

    // ============================================================================
    // Speaker Split Methods
    // ============================================================================

    /**
     * Group words into sentences using punctuation and pause detection
     * This helps with majority voting to reduce fragmentation from single-word misidentifications
     * @param {Array} words - Array of word objects sorted by start time
     * @param {Object} config - Configuration with SENTENCE_GAP_THRESHOLD and MIN_SENTENCE_WORDS
     * @returns {Array} Array of sentence arrays, each containing words
     */
    _groupWordsIntoSentences(words, config) {
      if (!words || words.length === 0) return [];

      const sentences = [];
      let currentSentence = [];

      for (let i = 0; i < words.length; i++) {
        const word = words[i];
        const nextWord = words[i + 1];

        currentSentence.push(word);

        // Check if this is a sentence boundary
        const isSentenceEnd =
          // End punctuation in word text
          /[.!?]$/.test(word.text || '') ||
          // Large gap to next word (pause)
          (nextWord && nextWord.start - word.end > config.SENTENCE_GAP_THRESHOLD) ||
          // No next word (last word)
          !nextWord;

        if (isSentenceEnd) {
          // Only split if we have enough words for a meaningful sentence
          if (currentSentence.length >= config.MIN_SENTENCE_WORDS || !nextWord) {
            sentences.push(currentSentence);
            currentSentence = [];
          }
          // If sentence is too short, keep accumulating
        }
      }

      // Handle any remaining words
      if (currentSentence.length > 0) {
        // Merge with last sentence if it exists and combined isn't too large
        if (sentences.length > 0 && currentSentence.length < config.MIN_SENTENCE_WORDS) {
          sentences[sentences.length - 1].push(...currentSentence);
        } else {
          sentences.push(currentSentence);
        }
      }

      return sentences;
    }

    /**
     * Determine the dominant speaker for a sentence using majority voting
     * Returns the speaker ID if they have clear majority, null otherwise
     * @param {Array} sentenceWords - Array of words in a sentence
     * @param {Object} config - Configuration with SPEAKER_MAJORITY_THRESHOLD
     * @returns {string|null} Dominant speaker ID or null if no clear majority
     */
    _determineSentenceSpeaker(sentenceWords, config) {
      if (!sentenceWords || sentenceWords.length === 0) return null;

      // Count words per speaker
      const speakerCounts = {};
      let totalWithSpeaker = 0;

      for (const word of sentenceWords) {
        const speakerId = word.speakerId || word.speaker || word.speaker_id;
        if (speakerId) {
          speakerCounts[speakerId] = (speakerCounts[speakerId] || 0) + 1;
          totalWithSpeaker++;
        }
      }

      if (totalWithSpeaker === 0) return null;

      // Find speaker with most words
      let dominantSpeaker = null;
      let maxCount = 0;

      for (const [speakerId, count] of Object.entries(speakerCounts)) {
        if (count > maxCount) {
          maxCount = count;
          dominantSpeaker = speakerId;
        }
      }

      // Check if dominant speaker has clear majority
      const majorityRatio = maxCount / totalWithSpeaker;

      if (majorityRatio >= config.SPEAKER_MAJORITY_THRESHOLD) {
        return dominantSpeaker;
      }

      // If no clear majority but one speaker has significantly more, use them
      // This handles cases like 60% speaker A, 40% speaker B
      if (majorityRatio >= 0.5 && Object.keys(speakerCounts).length === 2) {
        console.log(
          `[ADRTrackManager] Weak majority (${(majorityRatio * 100).toFixed(0)}%) for ${dominantSpeaker} in sentence of ${totalWithSpeaker} words`
        );
        return dominantSpeaker;
      }

      // No clear winner - return null to keep original assignments
      console.log(`[ADRTrackManager] No clear majority in sentence of ${totalWithSpeaker} words:`, speakerCounts);
      return null;
    }

    /**
     * Group words by speaker into contiguous time segments
     * Merges adjacent words from the same speaker into continuous segments
     * @param {Array} words - Array of word objects with speaker, start, end properties
     * @returns {Object} Map of speakerId to array of {start, end} segments
     */
    _groupWordsBySpeaker(words) {
      if (!words || words.length === 0) {
        console.warn('[ADRTrackManager] No words provided to _groupWordsBySpeaker');
        return {};
      }

      // Configuration for smarter segment building
      const CONFIG = {
        SEGMENT_PADDING: 0.15, // Padding before/after segments (seconds)
        MIN_SEGMENT_DURATION: 0.5, // Minimum segment duration to create (seconds)
        SAME_SPEAKER_MERGE_GAP: 2.0, // Merge same-speaker segments within this gap (seconds)
        MIN_WORDS_FOR_SPLIT: 3, // Minimum words needed before creating a separate segment
        // NEW: Sentence-aware majority voting settings
        SENTENCE_GAP_THRESHOLD: 1.5, // Gap indicating sentence break (seconds)
        SPEAKER_MAJORITY_THRESHOLD: 0.7, // 70% of words = dominant speaker
        MIN_SENTENCE_WORDS: 5, // Group at least 5 words per sentence
      };

      // Debug: Log sample of word data to understand structure
      console.log('[ADRTrackManager] Total words:', words.length);
      console.log('[ADRTrackManager] Smart segmentation config:', CONFIG);
      console.log(
        '[ADRTrackManager] First 5 words sample:',
        words.slice(0, 5).map((w) => ({
          text: w.text,
          start: w.start?.toFixed(2),
          end: w.end?.toFixed(2),
          speaker: w.speaker,
          speakerId: w.speakerId,
          speaker_id: w.speaker_id,
        }))
      );

      // IMPORTANT: Sort words by start time to ensure correct segment building
      const sortedWords = [...words].sort((a, b) => (a.start || 0) - (b.start || 0));

      // ========== NEW: Sentence-Aware Majority Voting Algorithm ==========
      // Step 1: Group words into sentences using punctuation and pauses
      const sentences = this._groupWordsIntoSentences(sortedWords, CONFIG);
      console.log('[ADRTrackManager] Grouped into', sentences.length, 'sentences');

      // Step 2: For each sentence, determine dominant speaker via majority vote
      const normalizedWords = [];
      sentences.forEach((sentence, idx) => {
        const dominantSpeaker = this._determineSentenceSpeaker(sentence, CONFIG);

        if (dominantSpeaker) {
          // Assign all words in this sentence to the dominant speaker
          sentence.forEach((word) => {
            const originalSpeaker = word.speakerId || word.speaker || word.speaker_id;
            if (originalSpeaker !== dominantSpeaker) {
              console.log(
                `[ADRTrackManager] Sentence ${idx}: Reassigning "${word.text}" from ${originalSpeaker} to ${dominantSpeaker}`
              );
            }
            normalizedWords.push({
              ...word,
              speaker: dominantSpeaker,
              speakerId: dominantSpeaker,
              speaker_id: dominantSpeaker,
              _originalSpeaker: word.speakerId || word.speaker || word.speaker_id,
            });
          });
        } else {
          // Keep original assignments if no clear majority
          sentence.forEach((word) => {
            normalizedWords.push(word);
          });
        }
      });

      console.log('[ADRTrackManager] After sentence normalization:', normalizedWords.length, 'words');

      // Step 3: Build raw segments from normalized words (now with cleaner speaker assignments)
      const rawSegments = {};
      let currentSpeaker = null;
      let currentSegment = null;
      let skippedCount = 0;
      let processedCount = 0;

      for (const word of normalizedWords) {
        const speakerId = word.speakerId || word.speaker || word.speaker_id;
        if (!speakerId) {
          skippedCount++;
          continue;
        }

        const start = word.start;
        const end = word.end;

        if (typeof start !== 'number' || typeof end !== 'number' || isNaN(start) || isNaN(end)) {
          console.warn('[ADRTrackManager] Invalid timing for word:', word.text, 'start:', start, 'end:', end);
          skippedCount++;
          continue;
        }

        processedCount++;

        if (!rawSegments[speakerId]) {
          rawSegments[speakerId] = [];
        }

        // If same speaker, always extend the current segment (keep contiguous)
        if (currentSpeaker === speakerId && currentSegment) {
          currentSegment.end = end;
          currentSegment.wordCount++;
        } else {
          // Different speaker
          if (currentSpeaker && currentSegment) {
            rawSegments[currentSpeaker].push(currentSegment);
          }
          currentSpeaker = speakerId;
          currentSegment = { start, end, wordCount: 1 };
        }
      }

      // Don't forget the last segment
      if (currentSpeaker && currentSegment) {
        rawSegments[currentSpeaker].push(currentSegment);
      }

      console.log(
        '[ADRTrackManager] Raw segments (before merging):',
        Object.keys(rawSegments)
          .map((s) => `${s}: ${rawSegments[s].length} segments`)
          .join(', ')
      );
      console.log(`[ADRTrackManager] Processed ${processedCount} words, skipped ${skippedCount} words`);

      // Second pass: Merge nearby segments for the same speaker
      const speakerSegments = {};
      Object.keys(rawSegments).forEach((speakerId) => {
        const segments = rawSegments[speakerId];
        if (!segments.length) return;

        segments.sort((a, b) => a.start - b.start);

        // Merge segments that are close together
        const mergedSegments = [{ ...segments[0] }];

        for (let i = 1; i < segments.length; i++) {
          const current = segments[i];
          const last = mergedSegments[mergedSegments.length - 1];

          const gap = current.start - last.end;
          if (gap <= CONFIG.SAME_SPEAKER_MERGE_GAP) {
            // Merge: extend the last segment to include this one
            last.end = current.end;
            last.wordCount += current.wordCount;
          } else {
            mergedSegments.push({ ...current });
          }
        }

        speakerSegments[speakerId] = mergedSegments;
      });

      console.log(
        '[ADRTrackManager] After merging nearby segments:',
        Object.keys(speakerSegments)
          .map((s) => `${s}: ${speakerSegments[s].length} segments`)
          .join(', ')
      );

      // Third pass: Remove very short segments (noise/interjections)
      Object.keys(speakerSegments).forEach((speakerId) => {
        speakerSegments[speakerId] = speakerSegments[speakerId].filter((seg) => {
          const duration = seg.end - seg.start;
          if (duration < CONFIG.MIN_SEGMENT_DURATION && seg.wordCount < CONFIG.MIN_WORDS_FOR_SPLIT) {
            console.log(
              `[ADRTrackManager] Filtering short segment for ${speakerId}: ${duration.toFixed(2)}s (${seg.wordCount} words)`
            );
            return false;
          }
          return true;
        });
      });

      // Fourth pass: Add padding and extend to fill gaps between speakers
      const allSegments = [];
      Object.keys(speakerSegments).forEach((speakerId) => {
        speakerSegments[speakerId].forEach((seg) => {
          allSegments.push({ ...seg, speakerId });
        });
      });
      allSegments.sort((a, b) => a.start - b.start);

      // Apply padding
      Object.keys(speakerSegments).forEach((speakerId) => {
        const segments = speakerSegments[speakerId];

        segments.forEach((seg) => {
          const segIndex = allSegments.findIndex(
            (s) => s.speakerId === speakerId && Math.abs(s.start - seg.start) < 0.01
          );

          const prevSeg = segIndex > 0 ? allSegments[segIndex - 1] : null;
          const nextSeg = segIndex < allSegments.length - 1 ? allSegments[segIndex + 1] : null;

          // Extend start backwards
          if (prevSeg) {
            const gap = seg.start - prevSeg.end;
            if (gap > 0) {
              const extension = Math.min(gap / 2, CONFIG.SEGMENT_PADDING);
              seg.start = Math.max(seg.start - extension, prevSeg.end);
            }
          } else {
            seg.start = Math.max(0, seg.start - CONFIG.SEGMENT_PADDING);
          }

          // Extend end forwards
          if (nextSeg) {
            const gap = nextSeg.start - seg.end;
            if (gap > 0) {
              const extension = Math.min(gap / 2, CONFIG.SEGMENT_PADDING);
              seg.end = Math.min(seg.end + extension, nextSeg.start);
            }
          } else {
            seg.end = seg.end + CONFIG.SEGMENT_PADDING;
          }
        });

        // Ensure no overlapping after padding
        for (let i = segments.length - 1; i > 0; i--) {
          const current = segments[i];
          const previous = segments[i - 1];

          if (current.start < previous.end) {
            const midpoint = (previous.end + current.start) / 2;
            previous.end = midpoint;
            current.start = midpoint;
          }
        }
      });

      // Final validation
      let fixedCount = 0;
      Object.keys(speakerSegments).forEach((speakerId) => {
        const segments = speakerSegments[speakerId];

        segments.forEach((seg) => {
          if (seg.end <= seg.start) {
            console.warn(`[ADRTrackManager] Fixing invalid segment for ${speakerId}: ${seg.start}-${seg.end}`);
            seg.end = seg.start + CONFIG.MIN_SEGMENT_DURATION;
            fixedCount++;
          }
          delete seg.wordCount;
        });

        segments.sort((a, b) => a.start - b.start);
      });

      if (fixedCount > 0) {
        console.log(`[ADRTrackManager] Fixed ${fixedCount} segment issues`);
      }

      // Debug: Log final segments
      Object.keys(speakerSegments).forEach((s) => {
        const segs = speakerSegments[s];
        if (!segs.length) return;
        const firstSeg = segs[0];
        const lastSeg = segs[segs.length - 1];
        const totalDuration = segs.reduce((sum, seg) => sum + (seg.end - seg.start), 0);
        const avgDuration = totalDuration / segs.length;
        console.log(
          `[ADRTrackManager] ${s}: ${segs.length} final segments, ` +
            `first: ${firstSeg?.start?.toFixed(2)}s-${firstSeg?.end?.toFixed(2)}s, ` +
            `last: ${lastSeg?.start?.toFixed(2)}s-${lastSeg?.end?.toFixed(2)}s, ` +
            `total: ${totalDuration.toFixed(2)}s, avg: ${avgDuration.toFixed(2)}s`
        );
      });

      return speakerSegments;
    }

    /**
     * Create a speaker track with audio clips for their segments
     * @param {string} speakerId - The speaker ID (e.g., "speaker_0")
     * @param {string} speakerName - Display name for the speaker
     * @param {Array} segments - Array of {start, end} time segments
     * @param {string} color - Track color (optional)
     */
    async _createSpeakerTrack(speakerId, speakerName, segments, color = null) {
      if (!segments || segments.length === 0) {
        console.warn('[ADRTrackManager] No segments for speaker:', speakerId);
        return null;
      }

      // Generate track ID
      const newTrackId = `A${this.app.nextTrackId++}`;

      // Pick a color based on speaker index if not provided
      const speakerColors = ['#4a9eff', '#22c55e', '#f59e0b', '#ec4899', '#8b5cf6', '#06b6d4', '#14b8a6', '#ef4444'];
      const speakerIndex = parseInt(speakerId.replace(/\D/g, '')) || 0;
      const trackColor = color || speakerColors[speakerIndex % speakerColors.length];

      // Create clips for each segment
      const clips = segments.map((seg, idx) => ({
        id: `clip-${speakerId}-${idx}-${Date.now()}`,
        type: 'speaker-segment',
        name: `${speakerName} - Segment ${idx + 1}`,
        startTime: seg.start,
        endTime: seg.end,
        duration: seg.end - seg.start,
        speakerId: speakerId,
        isVisualOnly: false,
      }));

      // Create the track
      const newTrack = {
        id: newTrackId,
        type: this.TRACK_TYPES.SPEAKER,
        name: speakerName,
        speakerId: speakerId,
        muted: false,
        solo: false,
        volume: 1.0,
        clips: clips,
        color: trackColor,
      };

      // Add to tracks array
      this.app.audioTracks.push(newTrack);

      // Render the track in UI
      if (this.app.renderAudioTrack) {
        this.app.renderAudioTrack(newTrack);
      }

      // Wait for DOM to update before rendering clips
      await new Promise((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(resolve);
        });
      });

      // Render clips on the track
      this._renderSpeakerClips(newTrackId, clips, trackColor);

      console.log('[ADRTrackManager] Created speaker track:', {
        trackId: newTrackId,
        speaker: speakerName,
        segments: segments.length,
        totalDuration: segments.reduce((sum, s) => sum + (s.end - s.start), 0).toFixed(2) + 's',
      });

      return newTrack;
    }

    /**
     * Render speaker clips on a track with waveform visualization
     */
    _renderSpeakerClips(trackId, clips, color) {
      const trackContent = document.getElementById(`trackContent-${trackId}`);
      if (!trackContent) {
        console.warn('[ADRTrackManager] Track content container not found:', trackId);
        return;
      }

      // Hide empty state
      const emptyState = document.getElementById(`trackEmpty-${trackId}`);
      if (emptyState) {
        emptyState.style.display = 'none';
      }

      // Get video duration for positioning
      const video = document.getElementById('videoPlayer');
      const totalDuration = video?.duration || this.app.videoInfo?.duration || 1;

      console.log(
        `[ADRTrackManager] Rendering ${clips.length} clips on track ${trackId}, video duration: ${totalDuration.toFixed(2)}s`
      );

      // Find the original waveform canvas to copy from
      const originalWaveform = document.querySelector(
        '#audioTrackContainer .waveform-canvas, #audioTrackContainer .audio-waveform, #audioWaveform, canvas[class*="waveform"]'
      );
      const hasWaveform = originalWaveform && originalWaveform.tagName === 'CANVAS';

      if (hasWaveform) {
        console.log(
          '[ADRTrackManager] Found waveform canvas to copy from:',
          originalWaveform.width,
          'x',
          originalWaveform.height
        );
      }

      // Render each clip
      clips.forEach((clip, idx) => {
        const leftPercent = (clip.startTime / totalDuration) * 100;
        const widthPercent = ((clip.endTime - clip.startTime) / totalDuration) * 100;

        // Debug first few clips
        if (idx < 3) {
          console.log(
            `[ADRTrackManager] Clip ${idx}: ${clip.startTime.toFixed(2)}s-${clip.endTime.toFixed(2)}s = left:${leftPercent.toFixed(1)}%, width:${widthPercent.toFixed(1)}%`
          );
        }

        const clipEl = document.createElement('div');
        clipEl.className = 'track-clip speaker-clip';
        clipEl.id = `clip-${clip.id}`;
        clipEl.dataset.clipId = clip.id;
        clipEl.dataset.speakerId = clip.speakerId;
        clipEl.style.cssText = `
          position: absolute;
          left: ${leftPercent}%;
          width: ${widthPercent}%;
          height: 100%;
          background: linear-gradient(180deg, ${color}40 0%, ${color}20 100%);
          border: 1px solid ${color}80;
          border-radius: 4px;
          overflow: hidden;
          cursor: pointer;
        `;

        // Add waveform visualization
        if (hasWaveform) {
          // Create a canvas for this clip's waveform portion
          const waveformCanvas = document.createElement('canvas');
          const clipWidthRatio = (clip.endTime - clip.startTime) / totalDuration;
          const clipStartRatio = clip.startTime / totalDuration;

          // Calculate source region from original waveform
          const srcX = Math.floor(clipStartRatio * originalWaveform.width);
          const srcWidth = Math.floor(clipWidthRatio * originalWaveform.width);

          // Set canvas size to match the clip portion
          waveformCanvas.width = Math.max(srcWidth, 1);
          waveformCanvas.height = originalWaveform.height;
          waveformCanvas.style.cssText = `
            width: 100%;
            height: 100%;
            opacity: 0.8;
          `;

          // Copy the relevant portion of the waveform
          const ctx = waveformCanvas.getContext('2d');
          try {
            ctx.drawImage(
              originalWaveform,
              srcX,
              0,
              srcWidth,
              originalWaveform.height, // Source rect
              0,
              0,
              waveformCanvas.width,
              waveformCanvas.height // Dest rect
            );

            // Apply color tint overlay
            ctx.globalCompositeOperation = 'source-atop';
            ctx.fillStyle = color + '40';
            ctx.fillRect(0, 0, waveformCanvas.width, waveformCanvas.height);
            ctx.globalCompositeOperation = 'source-over';
          } catch (e) {
            console.warn('[ADRTrackManager] Could not copy waveform portion:', e.message);
          }

          clipEl.appendChild(waveformCanvas);
        } else {
          // Fallback: simple striped pattern if no waveform available
          const waveEl = document.createElement('div');
          waveEl.style.cssText = `
            width: 100%;
            height: 100%;
            background: repeating-linear-gradient(
              90deg,
              transparent,
              transparent 2px,
              ${color}30 2px,
              ${color}30 4px
            );
            opacity: 0.5;
          `;
          clipEl.appendChild(waveEl);
        }

        trackContent.appendChild(clipEl);
      });

      console.log('[ADRTrackManager] Rendered', clips.length, 'clips on speaker track', trackId);
    }

    /**
     * Split audio by speaker - main entry point
     * Creates a separate track for each speaker with their audio segments
     * @param {string} sourceTrackId - ID of the source track (usually original/guide)
     */
    async splitBySpeaker(sourceTrackId) {
      console.log('[ADRTrackManager] Starting speaker split from track:', sourceTrackId);

      // 1. Get transcription words with speaker data
      const words = this.app.teleprompterWords || this.app.transcriptSegments || [];

      if (words.length === 0) {
        throw new Error('No transcription data available. Please transcribe the video first.');
      }

      // Check if we have speaker data
      const hasSpeakers = words.some((w) => w.speaker || w.speakerId || w.speaker_id);
      if (!hasSpeakers) {
        throw new Error('No speaker data found. Please transcribe with speaker diarization enabled.');
      }

      // 2. Group words by speaker ID to get time segments
      const speakerSegments = this._groupWordsBySpeaker(words);
      const speakerIds = Object.keys(speakerSegments);

      if (speakerIds.length === 0) {
        throw new Error('No speaker segments found in transcription.');
      }

      console.log('[ADRTrackManager] Found', speakerIds.length, 'speakers to split');

      // 3. For each speaker, create a track
      const createdTracks = [];
      for (const speakerId of speakerIds) {
        const segments = speakerSegments[speakerId];

        // Get speaker name from app's speakerNames map, or format the ID
        let speakerName = this.app.speakerNames?.[speakerId];
        if (!speakerName) {
          // Format speaker_0 as "Speaker 1", speaker_1 as "Speaker 2", etc.
          const speakerNum = parseInt(speakerId.replace(/\D/g, '')) + 1;
          speakerName = `Speaker ${speakerNum}`;
        }

        const track = await this._createSpeakerTrack(speakerId, speakerName, segments);
        if (track) {
          createdTracks.push(track);
        }
      }

      console.log('[ADRTrackManager] Speaker split complete:', createdTracks.length, 'tracks created');

      return createdTracks;
    }

    /**
     * Update speaker tracks in-place after speaker corrections
     * Called when user changes speaker assignments for words
     * This avoids having to delete and recreate all tracks
     */
    async updateSpeakerClipsAfterCorrection() {
      console.log('[ADRTrackManager] Updating speaker clips after correction...');

      // Get current words with speaker data
      const words = this.app.teleprompterWords || this.app.transcriptSegments || [];

      if (words.length === 0) {
        console.warn('[ADRTrackManager] No words available for clip update');
        return;
      }

      // Find all speaker tracks
      const speakerTracks = this.app.audioTracks?.filter((t) => t.type === this.TRACK_TYPES.SPEAKER) || [];

      if (speakerTracks.length === 0) {
        console.log('[ADRTrackManager] No speaker tracks to update');
        return;
      }

      // Recalculate segments from updated words
      const newSegments = this._groupWordsBySpeaker(words);

      console.log(
        '[ADRTrackManager] Recalculated segments:',
        Object.keys(newSegments)
          .map((s) => `${s}: ${newSegments[s].length}`)
          .join(', ')
      );

      // Get video duration for positioning
      const video = document.getElementById('videoPlayer');
      const totalDuration = video?.duration || this.app.videoInfo?.duration || 1;

      // Update each speaker track
      for (const track of speakerTracks) {
        const speakerId = track.speakerId;
        const newSegs = newSegments[speakerId] || [];

        console.log(
          `[ADRTrackManager] Updating track ${track.id} (${speakerId}): ${track.clips?.length || 0} clips -> ${newSegs.length} segments`
        );

        // Update track clips
        track.clips = newSegs.map((seg, idx) => ({
          id: `clip-${speakerId}-${idx}-${Date.now()}`,
          type: 'speaker-segment',
          name: `${track.name} - Segment ${idx + 1}`,
          startTime: seg.start,
          endTime: seg.end,
          duration: seg.end - seg.start,
          speakerId: speakerId,
          isVisualOnly: false,
        }));

        // Re-render clips on this track
        this._rerenderTrackClips(track, totalDuration);
      }

      // Check if any new speakers need tracks created
      const existingSpeakerIds = speakerTracks.map((t) => t.speakerId);
      const newSpeakerIds = Object.keys(newSegments).filter((s) => !existingSpeakerIds.includes(s));

      if (newSpeakerIds.length > 0) {
        console.log('[ADRTrackManager] Creating tracks for new speakers:', newSpeakerIds);

        for (const speakerId of newSpeakerIds) {
          const segments = newSegments[speakerId];
          if (segments && segments.length > 0) {
            let speakerName = this.app.speakerNames?.[speakerId];
            if (!speakerName) {
              const speakerNum = parseInt(speakerId.replace(/\D/g, '')) + 1;
              speakerName = `Speaker ${speakerNum}`;
            }
            await this._createSpeakerTrack(speakerId, speakerName, segments);
          }
        }
      }

      // Remove tracks for speakers that no longer have any words
      const emptySpeakers = existingSpeakerIds.filter((s) => !newSegments[s] || newSegments[s].length === 0);
      for (const speakerId of emptySpeakers) {
        const trackToRemove = speakerTracks.find((t) => t.speakerId === speakerId);
        if (trackToRemove) {
          console.log(`[ADRTrackManager] Removing empty track for ${speakerId}`);
          this.app.audioTracks = this.app.audioTracks.filter((t) => t.id !== trackToRemove.id);

          // Remove from DOM
          const trackEl = document.getElementById(`track-${trackToRemove.id}`);
          if (trackEl) trackEl.remove();
        }
      }

      console.log('[ADRTrackManager] Speaker clips update complete');
    }

    /**
     * Re-render clips on a track (used after updating clip data)
     */
    _rerenderTrackClips(track, totalDuration) {
      const trackContent = document.getElementById(`trackContent-${track.id}`);
      if (!trackContent) {
        console.warn('[ADRTrackManager] Track content container not found:', track.id);
        return;
      }

      // Clear existing clips
      trackContent.innerHTML = '';

      // Show empty state if no clips
      if (!track.clips || track.clips.length === 0) {
        trackContent.innerHTML = `<div id="trackEmpty-${track.id}" class="track-empty-state">No clips</div>`;
        return;
      }

      // Get track color
      const color = track.color || '#4a9eff';

      // Find original waveform to copy from
      const originalWaveform = document.querySelector(
        '#audioTrackContainer .waveform-canvas, #audioTrackContainer .audio-waveform, #audioWaveform, canvas[class*="waveform"]'
      );
      const hasWaveform = originalWaveform && originalWaveform.tagName === 'CANVAS';

      // Render each clip
      track.clips.forEach((clip, _idx) => {
        const leftPercent = (clip.startTime / totalDuration) * 100;
        const widthPercent = ((clip.endTime - clip.startTime) / totalDuration) * 100;

        const clipEl = document.createElement('div');
        clipEl.className = 'track-clip speaker-clip';
        clipEl.id = `clip-${clip.id}`;
        clipEl.dataset.clipId = clip.id;
        clipEl.dataset.speakerId = clip.speakerId;
        clipEl.style.cssText = `
          position: absolute;
          left: ${leftPercent}%;
          width: ${widthPercent}%;
          height: 100%;
          background: linear-gradient(180deg, ${color}40 0%, ${color}20 100%);
          border: 1px solid ${color}80;
          border-radius: 4px;
          overflow: hidden;
          cursor: pointer;
        `;

        // Add waveform or fallback pattern
        if (hasWaveform) {
          const waveformCanvas = document.createElement('canvas');
          const clipWidthRatio = (clip.endTime - clip.startTime) / totalDuration;
          const clipStartRatio = clip.startTime / totalDuration;

          const srcX = Math.floor(clipStartRatio * originalWaveform.width);
          const srcWidth = Math.floor(clipWidthRatio * originalWaveform.width);

          waveformCanvas.width = Math.max(srcWidth, 1);
          waveformCanvas.height = originalWaveform.height;
          waveformCanvas.style.cssText = `width: 100%; height: 100%; opacity: 0.8;`;

          const ctx = waveformCanvas.getContext('2d');
          try {
            ctx.drawImage(
              originalWaveform,
              srcX,
              0,
              srcWidth,
              originalWaveform.height,
              0,
              0,
              waveformCanvas.width,
              waveformCanvas.height
            );
            ctx.globalCompositeOperation = 'source-atop';
            ctx.fillStyle = color + '40';
            ctx.fillRect(0, 0, waveformCanvas.width, waveformCanvas.height);
          } catch (e) {
            console.warn('[ADRTrackManager] Could not copy waveform:', e.message);
          }

          clipEl.appendChild(waveformCanvas);
        } else {
          const waveEl = document.createElement('div');
          waveEl.style.cssText = `
            width: 100%; height: 100%;
            background: repeating-linear-gradient(90deg, transparent, transparent 2px, ${color}30 2px, ${color}30 4px);
            opacity: 0.5;
          `;
          clipEl.appendChild(waveEl);
        }

        trackContent.appendChild(clipEl);
      });
    }

    /**
     * Check if speaker data exists in the transcription
     * @returns {boolean} True if speaker data is available
     */
    hasSpeakerData() {
      const words = this.app.teleprompterWords || this.app.transcriptSegments || [];
      return words.some((w) => w.speaker || w.speakerId || w.speaker_id);
    }
  }

  // ============================================================================
  // TrackContextMenu Class
  // ============================================================================

  class TrackContextMenu {
    constructor(appContext, adrManager) {
      this.app = appContext;
      this.adrManager = adrManager;
      this.menuElement = null;
      this.currentTrackId = null;

      this._createMenuElement();
      this._setupEventListeners();
      this._attachToExistingTracks();

      console.log('[TrackContextMenu] Initialized');
    }

    /**
     * Create the context menu DOM element
     */
    _createMenuElement() {
      // Check if menu already exists
      this.menuElement = document.getElementById('trackContextMenu');

      if (!this.menuElement) {
        this.menuElement = document.createElement('div');
        this.menuElement.id = 'trackContextMenu';
        this.menuElement.className = 'context-menu track-context-menu';
        this.menuElement.innerHTML = '<div class="context-menu-items" id="trackContextMenuItems"></div>';
        document.body.appendChild(this.menuElement);
      }

      this.itemsContainer =
        this.menuElement.querySelector('#trackContextMenuItems') ||
        this.menuElement.querySelector('.context-menu-items');
    }

    /**
     * Setup event listeners
     */
    _setupEventListeners() {
      // Close menu on click outside
      document.addEventListener('click', (e) => {
        if (this.menuElement && !this.menuElement.contains(e.target)) {
          this.hide();
        }
      });

      // Close on escape
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          this.hide();
        }
      });

      // Handle menu item clicks
      if (this.itemsContainer) {
        this.itemsContainer.addEventListener('click', (e) => {
          const item = e.target.closest('.context-menu-item');
          if (item && !item.classList.contains('disabled')) {
            const action = item.dataset.action;
            this._handleAction(action);
          }
        });
      }
    }

    /**
     * Attach context menu to all existing track labels
     */
    _attachToExistingTracks() {
      // Wait for DOM to be ready
      setTimeout(() => {
        const tracks = this.app.audioTracks || [];

        tracks.forEach((track) => {
          const trackEl =
            document.getElementById(`track-${track.id}`) || document.querySelector(`[data-track-id="${track.id}"]`);

          if (trackEl) {
            const label = trackEl.querySelector('.track-label');
            if (label) {
              this.attachToLabel(label, track.id);
            }
          }
        });

        // Also attach to the original audio track (which has id="audioTrackContainer")
        const originalTrack = document.getElementById('audioTrackContainer');
        if (originalTrack) {
          const label = originalTrack.querySelector('.track-label');
          if (label && !label.dataset.contextMenuAttached) {
            this.attachToLabel(label, 'A1');
          }
        }

        console.log('[TrackContextMenu] Attached to existing tracks');
      }, 500);
    }

    /**
     * Show context menu for a track
     * @param {string} trackId - The track ID
     * @param {number} x - X position
     * @param {number} y - Y position
     * @returns {boolean} True if menu was shown successfully
     */
    show(trackId, x, y) {
      this.currentTrackId = trackId;
      const track = this.adrManager.findTrack(trackId);

      if (!track) {
        // Track not found - this can happen during initialization or if track hasn't been loaded yet
        // Log at debug level instead of error since it's often a timing issue
        console.log('[TrackContextMenu] Track not found:', trackId, '- audioTracks may not be initialized yet');
        return false;
      }

      const items = this._buildMenuItems(track);

      if (this.itemsContainer) {
        this.itemsContainer.innerHTML = this._buildMenuHTML(items);
      }

      this._positionMenu(x, y);
      return true;
    }

    /**
     * Hide the context menu
     */
    hide() {
      if (this.menuElement) {
        this.menuElement.classList.remove('visible');
      }
      this.currentTrackId = null;
    }

    /**
     * Position menu with viewport clamping
     */
    _positionMenu(x, y) {
      const menu = this.menuElement;
      const minMargin = 12;
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      // Show off-screen to measure
      menu.style.left = '-9999px';
      menu.style.top = '-9999px';
      menu.classList.add('visible');

      const rect = menu.getBoundingClientRect();
      let mw = Math.max(rect.width, 180);
      let mh = rect.height;

      // Calculate final position
      let finalX = x;
      let finalY = y;

      if (x + mw > vw - minMargin) {
        finalX = Math.max(minMargin, x - mw);
      }
      if (y + mh > vh - minMargin) {
        finalY = Math.max(minMargin, y - mh);
      }

      menu.style.left = `${finalX}px`;
      menu.style.top = `${finalY}px`;
    }

    /**
     * Build menu items based on track type
     */
    _buildMenuItems(track) {
      const items = [];
      const isOriginal = track.type === 'original';
      const displayInfo = this.adrManager.getTrackDisplayInfo(track);

      // Header
      items.push({
        type: 'header',
        label: `${track.name} (${displayInfo.label})`,
      });

      items.push({ type: 'divider' });

      // Duplicate - always available
      items.push({
        icon: '📋',
        label: 'Duplicate Track',
        action: 'duplicate',
        shortcut: '⌘D',
      });

      // Rename - available for non-original tracks
      items.push({
        icon: '✏️',
        label: 'Rename Track',
        action: 'rename',
        disabled: isOriginal,
      });

      items.push({ type: 'divider' });

      // Solo/Mute options
      items.push({
        icon: track.solo ? '🔊' : '🎯',
        label: track.solo ? 'Unsolo Track' : 'Solo Track',
        action: 'toggle-solo',
      });

      items.push({
        icon: track.muted ? '🔊' : '🔇',
        label: track.muted ? 'Unmute Track' : 'Mute Track',
        action: 'toggle-mute',
      });

      items.push({ type: 'divider' });

      // Extract Audio - available for all tracks
      items.push({
        icon: '↓',
        label: 'Extract Audio to MP3',
        action: 'extract-audio',
        shortcut: '⌥E',
      });

      items.push({ type: 'divider' });

      // Track-specific actions
      if (isOriginal) {
        items.push({
          icon: '📝',
          label: 'Create Working Track',
          action: 'create-working',
        });

        items.push({
          icon: '🎵',
          label: 'Create Fill Track (Room Tone)',
          action: 'create-fill',
        });

        // Split by speaker - only show if speaker data exists
        if (this.adrManager.hasSpeakerData()) {
          items.push({
            icon: '👥',
            label: 'Split All Speakers',
            action: 'split-speakers',
          });
        }
      }

      // Voice cloning - available for all tracks with audio
      items.push({ type: 'divider' });
      items.push({
        icon: '🎤',
        label: 'Create Custom Voice from Track',
        action: 'create-voice',
      });

      // Language/Voice transformation section
      items.push({ type: 'divider' });
      items.push({
        icon: '🌍',
        label: 'Change Language...',
        action: 'change-language',
      });
      items.push({
        icon: '🎭',
        label: 'Change Voice...',
        action: 'change-voice',
      });

      // Delete - not for original track
      if (!isOriginal) {
        items.push({ type: 'divider' });
        items.push({
          icon: '🗑️',
          label: 'Delete Track',
          action: 'delete',
          danger: true,
        });
      }

      return items;
    }

    /**
     * Build HTML from menu items
     */
    _buildMenuHTML(items) {
      let html = '';

      for (const item of items) {
        if (item.type === 'header') {
          html += `<div class="context-menu-header">${item.label}</div>`;
        } else if (item.type === 'divider') {
          html += `<div class="context-menu-divider"></div>`;
        } else {
          const disabledClass = item.disabled ? 'disabled' : '';
          const dangerClass = item.danger ? 'danger' : '';
          const dataAction = item.action ? `data-action="${item.action}"` : '';

          html += `
            <div class="context-menu-item ${disabledClass} ${dangerClass}" ${dataAction}>
              ${item.icon ? `<span class="context-menu-item-icon">${item.icon}</span>` : ''}
              <span class="context-menu-item-label">${item.label}</span>
              ${item.shortcut ? `<span class="context-menu-item-shortcut">${item.shortcut}</span>` : ''}
            </div>
          `;
        }
      }

      return html;
    }

    /**
     * Handle menu action
     */
    _handleAction(action) {
      const trackId = this.currentTrackId;

      if (!trackId) {
        console.error('[TrackContextMenu] No track selected');
        this.hide();
        return;
      }

      console.log('[TrackContextMenu] Action:', action, 'Track:', trackId);

      switch (action) {
        case 'duplicate':
          // Push undo state BEFORE making changes
          this.app.pushUndoState && this.app.pushUndoState('Duplicate track');
          this.adrManager.duplicateTrack(trackId);
          // Save immediately so duplicated track persists
          if (this.app.saveCurrentVersion) {
            this.app.saveCurrentVersion().then(() => {
              console.log('[TrackContextMenu] Duplicated track saved to project');
            });
          }
          break;

        case 'rename':
          this._promptRename(trackId);
          break;

        case 'toggle-solo':
          this.app.toggleTrackSolo && this.app.toggleTrackSolo(trackId);
          break;

        case 'toggle-mute':
          this.app.toggleTrackMute && this.app.toggleTrackMute(trackId);
          break;

        case 'extract-audio':
          // Call the app's extractAudio method
          if (this.app.extractAudio) {
            this.app.extractAudio();
          } else {
            console.warn('[TrackContextMenu] extractAudio method not available');
            this.app.showToast && this.app.showToast('error', 'Extract audio not available');
          }
          break;

        case 'create-working':
          // Push undo state BEFORE making changes
          this.app.pushUndoState && this.app.pushUndoState('Create working track');
          this.adrManager.ensureWorkingTrack();
          // Save immediately so working track persists
          if (this.app.saveCurrentVersion) {
            this.app.saveCurrentVersion().then(() => {
              console.log('[TrackContextMenu] Working track saved to project');
            });
          }
          break;

        case 'create-fill':
          this._createFillTrack();
          break;

        case 'create-voice':
          this._createCustomVoice(trackId);
          break;

        case 'split-speakers':
          this._splitAllSpeakers(trackId);
          break;

        case 'delete':
          this._confirmDelete(trackId);
          break;

        case 'change-language':
          this._showChangeLanguageDialog(trackId);
          break;

        case 'change-voice':
          this._showChangeVoiceDialog(trackId);
          break;

        default:
          console.warn('[TrackContextMenu] Unknown action:', action);
      }

      this.hide();
    }

    /**
     * Split audio by speaker into separate tracks
     */
    async _splitAllSpeakers(trackId) {
      try {
        // Push undo state BEFORE making changes
        this.app.pushUndoState && this.app.pushUndoState('Split by speaker');

        this.app.showProgress && this.app.showProgress('Splitting Speakers', 'Analyzing speaker segments...');
        const tracks = await this.adrManager.splitBySpeaker(trackId);
        this.app.hideProgress && this.app.hideProgress();

        // Save immediately so speaker tracks persist to the project
        if (this.app.saveCurrentVersion) {
          await this.app.saveCurrentVersion();
          console.log('[TrackContextMenu] Speaker tracks saved to project');
        }

        this.app.showToast && this.app.showToast('success', `Created ${tracks.length} speaker tracks`);
      } catch (error) {
        console.error('[TrackContextMenu] Split speakers error:', error);
        this.app.hideProgress && this.app.hideProgress();
        this.app.showToast && this.app.showToast('error', 'Failed to split speakers: ' + error.message);
      }
    }

    /**
     * Create fill track with room tone
     */
    async _createFillTrack() {
      try {
        // Push undo state BEFORE making changes
        this.app.pushUndoState && this.app.pushUndoState('Create fill track');

        await this.adrManager.createFillTrack();

        // Save immediately so fill track persists to the project
        if (this.app.saveCurrentVersion) {
          await this.app.saveCurrentVersion();
          console.log('[TrackContextMenu] Fill track saved to project');
        }
      } catch (error) {
        console.error('[TrackContextMenu] Create fill track error:', error);
        this.app.showToast && this.app.showToast('error', 'Fill track creation failed: ' + error.message);
      }
    }

    /**
     * Create custom voice from track audio
     */
    async _createCustomVoice(trackId) {
      const track = this.adrManager.findTrack(trackId);
      if (!track) return;

      // Use track name as default suggestion for voice name
      const defaultName = track.name || 'Custom Voice';
      const voiceName = prompt(
        'Enter name for your custom voice:\n\n' + "(This will clone the voice from this track's audio)",
        defaultName
      );
      if (!voiceName || !voiceName.trim()) return;

      try {
        // Call the ADR manager method
        await this.adrManager.createCustomVoice(trackId, voiceName.trim());
      } catch (error) {
        console.error('[TrackContextMenu] Create voice error:', error);
        this.app.showToast && this.app.showToast('error', 'Voice creation failed: ' + error.message);
      }
    }

    /**
     * Prompt for track rename
     */
    _promptRename(trackId) {
      const track = this.adrManager.findTrack(trackId);
      if (!track) return;

      const newName = prompt('Enter new track name:', track.name);
      if (newName && newName.trim()) {
        // Push undo state BEFORE making changes
        this.app.pushUndoState && this.app.pushUndoState(`Rename track to "${newName.trim()}"`);

        track.name = newName.trim();

        // Update UI
        const nameEl = document.querySelector(`#track-${trackId} .track-name`);
        if (nameEl) {
          nameEl.textContent = track.name;
        }

        // Save immediately so rename persists
        if (this.app.saveCurrentVersion) {
          this.app.saveCurrentVersion().then(() => {
            console.log('[TrackContextMenu] Track rename saved to project');
          });
        }

        this.app.showToast && this.app.showToast('success', `Renamed to "${track.name}"`);
      }
    }

    /**
     * Confirm track deletion
     */
    _confirmDelete(trackId) {
      const track = this.adrManager.findTrack(trackId);
      if (!track) return;

      if (confirm(`Delete "${track.name}" track?`)) {
        // Push undo state BEFORE making changes (so user can undo delete)
        this.app.pushUndoState && this.app.pushUndoState(`Delete track "${track.name}"`);

        this.app.removeTrack && this.app.removeTrack(trackId);

        // Save immediately so deletion persists
        if (this.app.saveCurrentVersion) {
          this.app.saveCurrentVersion().then(() => {
            console.log('[TrackContextMenu] Track deletion saved to project');
          });
        }
      }
    }

    /**
     * Show Change Language dialog for dubbing track to another language
     */
    _showChangeLanguageDialog(trackId) {
      const track = this.adrManager.findTrack(trackId);
      if (!track) return;

      // Check if transcription exists
      if (!this.app.transcriptSegments || this.app.transcriptSegments.length === 0) {
        this.app.showToast &&
          this.app.showToast('warning', 'Please transcribe the audio first before changing language');
        return;
      }

      // Language options (matching video-editor-app.js dubbingLanguages)
      const languages = [
        { code: 'es', name: 'Spanish' },
        { code: 'fr', name: 'French' },
        { code: 'de', name: 'German' },
        { code: 'it', name: 'Italian' },
        { code: 'pt', name: 'Portuguese' },
        { code: 'pl', name: 'Polish' },
        { code: 'ja', name: 'Japanese' },
        { code: 'zh', name: 'Chinese' },
        { code: 'ko', name: 'Korean' },
        { code: 'hi', name: 'Hindi' },
        { code: 'ar', name: 'Arabic' },
        { code: 'ru', name: 'Russian' },
        { code: 'nl', name: 'Dutch' },
        { code: 'tr', name: 'Turkish' },
        { code: 'sv', name: 'Swedish' },
      ];

      const dialog = document.createElement('div');
      dialog.className = 'modal-backdrop';
      dialog.id = 'changeLanguageDialog';
      dialog.innerHTML = `
        <div class="modal" style="max-width: 400px;">
          <div class="modal-header">
            <h3>🌍 Change Language</h3>
            <button class="modal-close" onclick="document.getElementById('changeLanguageDialog').remove()">×</button>
          </div>
          <div class="modal-body">
            <p style="margin-bottom: 12px; font-size: 12px; color: var(--text-secondary);">
              Track: <strong>${track.name}</strong><br>
              Segments: <strong>${this.app.transcriptSegments.length}</strong>
            </p>

            <label style="display: block; margin-bottom: 8px; font-weight: 500;">Target Language:</label>
            <select id="targetLanguageSelect" class="input" style="width: 100%; padding: 8px; background: var(--bg-surface); border: 1px solid var(--border-color); border-radius: 6px; color: var(--text-primary);">
              ${languages.map((lang) => `<option value="${lang.code}">${lang.name}</option>`).join('')}
            </select>

            <div style="margin-top: 16px; padding: 12px; background: rgba(59, 130, 246, 0.1); border-radius: 8px; border: 1px solid rgba(59, 130, 246, 0.3);">
              <p style="margin: 0; font-size: 12px; color: #60a5fa;">
                ℹ️ Each segment will be dubbed to the target language while matching the original timing.
              </p>
            </div>
          </div>
          <div class="modal-footer" style="display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px;">
            <button class="btn btn-secondary" onclick="document.getElementById('changeLanguageDialog').remove()">Cancel</button>
            <button class="btn btn-primary" id="startChangeLanguageBtn">
              <span>🎙️ Start Dubbing</span>
            </button>
          </div>
        </div>
      `;

      document.body.appendChild(dialog);

      // Handle start button
      document.getElementById('startChangeLanguageBtn').onclick = async () => {
        const languageCode = document.getElementById('targetLanguageSelect').value;
        const languageName = languages.find((l) => l.code === languageCode)?.name || languageCode;

        dialog.remove();

        // Execute the dubbing workflow
        await this._executeTrackDubbing(trackId, languageCode, languageName);
      };
    }

    /**
     * Show Change Voice dialog for replacing voice while keeping same language
     */
    _showChangeVoiceDialog(trackId) {
      const track = this.adrManager.findTrack(trackId);
      if (!track) return;

      // Check if transcription exists
      if (!this.app.transcriptSegments || this.app.transcriptSegments.length === 0) {
        this.app.showToast && this.app.showToast('warning', 'Please transcribe the audio first before changing voice');
        return;
      }

      // ElevenLabs voices (common preset voices)
      const voices = [
        { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah' },
        { id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel' },
        { id: 'AZnzlk1XvdvUeBnXmlld', name: 'Domi' },
        { id: 'CYw3kZ02Hs0563khs1Fj', name: 'Dave' },
        { id: 'D38z5RcWu1voky8WS1ja', name: 'Fin' },
        { id: 'ErXwobaYiN019PkySvjV', name: 'Antoni' },
        { id: 'IKne3meq5aSn9XLyUdCD', name: 'Charlie' },
        { id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George' },
        { id: 'MF3mGyEYCl7XYWbV9V6O', name: 'Elli' },
        { id: 'N2lVS1w4EtoT3dr4eOWO', name: 'Callum' },
        { id: 'TX3LPaxmHKxFdv7VOQHJ', name: 'Liam' },
        { id: 'XB0fDUnXU5powFXDhCwa', name: 'Charlotte' },
        { id: 'Xb7hH8MSUJpSbSDYk0k2', name: 'Alice' },
        { id: 'pFZP5JQG7iQjIQuC4Bku', name: 'Lily' },
        { id: 'pNInz6obpgDQGcFmaJgB', name: 'Adam' },
      ];

      const dialog = document.createElement('div');
      dialog.className = 'modal-backdrop';
      dialog.id = 'changeVoiceDialog';
      dialog.innerHTML = `
        <div class="modal" style="max-width: 400px;">
          <div class="modal-header">
            <h3>🎭 Change Voice</h3>
            <button class="modal-close" onclick="document.getElementById('changeVoiceDialog').remove()">×</button>
          </div>
          <div class="modal-body">
            <p style="margin-bottom: 12px; font-size: 12px; color: var(--text-secondary);">
              Track: <strong>${track.name}</strong><br>
              Segments: <strong>${this.app.transcriptSegments.length}</strong>
            </p>

            <label style="display: block; margin-bottom: 8px; font-weight: 500;">Select Voice:</label>
            <select id="targetVoiceSelect" class="input" style="width: 100%; padding: 8px; background: var(--bg-surface); border: 1px solid var(--border-color); border-radius: 6px; color: var(--text-primary);">
              ${voices.map((voice) => `<option value="${voice.id}">${voice.name}</option>`).join('')}
            </select>

            <div style="margin-top: 16px; padding: 12px; background: rgba(139, 92, 246, 0.1); border-radius: 8px; border: 1px solid rgba(139, 92, 246, 0.3);">
              <p style="margin: 0; font-size: 12px; color: #a78bfa;">
                ℹ️ Each segment will be regenerated with the selected voice while matching the original timing.
              </p>
            </div>
          </div>
          <div class="modal-footer" style="display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px;">
            <button class="btn btn-secondary" onclick="document.getElementById('changeVoiceDialog').remove()">Cancel</button>
            <button class="btn btn-primary" id="startChangeVoiceBtn">
              <span>🎤 Generate Voice</span>
            </button>
          </div>
        </div>
      `;

      document.body.appendChild(dialog);

      // Handle start button
      document.getElementById('startChangeVoiceBtn').onclick = async () => {
        const voiceId = document.getElementById('targetVoiceSelect').value;
        const voiceName = voices.find((v) => v.id === voiceId)?.name || 'Custom';

        dialog.remove();

        // Execute the voice change workflow
        await this._executeTrackVoiceChange(trackId, voiceId, voiceName);
      };
    }

    /**
     * Execute track dubbing workflow - dub all segments to target language
     */
    async _executeTrackDubbing(trackId, languageCode, languageName) {
      const segments = this.app.transcriptSegments;
      if (!segments || segments.length === 0) {
        this.app.showToast && this.app.showToast('error', 'No transcript segments found');
        return;
      }

      console.log('[TrackContextMenu] Starting track dubbing to', languageName, 'with', segments.length, 'segments');

      // Push undo state
      this.app.pushUndoState && this.app.pushUndoState(`Dub track to ${languageName}`);

      // Find or create the target track
      const targetTrackName = `Dub: ${languageName}`;
      const targetTrack = this.app.findOrCreateTrack
        ? this.app.findOrCreateTrack(targetTrackName, 'dub')
        : this._findOrCreateTrack(targetTrackName, 'dub');

      // Show progress
      this.app.showProgress &&
        this.app.showProgress(`Dubbing to ${languageName}`, `Processing ${segments.length} segments...`);

      let successCount = 0;
      let errorCount = 0;

      try {
        for (let i = 0; i < segments.length; i++) {
          const segment = segments[i];
          const segmentDuration = segment.end - segment.start;

          this.app.showProgress &&
            this.app.showProgress(
              `Dubbing to ${languageName}`,
              `Segment ${i + 1}/${segments.length}: "${segment.text?.substring(0, 30)}..."`,
              Math.round(((i + 1) / segments.length) * 100)
            );

          try {
            // Extract audio segment
            const segmentPath = await this._extractAudioSegment(segment.start, segment.end);

            // Create dubbing project for this segment
            const createResult = await window.videoEditor.createDubbing({
              videoPath: segmentPath,
              targetLanguages: [languageCode],
              sourceLanguage: 'en',
              numSpeakers: 1,
            });

            if (!createResult.success) {
              throw new Error(createResult.error || 'Failed to create dubbing project');
            }

            // Poll for completion
            const dubbingId = createResult.dubbing_id;
            const dubbedAudioPath = await this._pollDubbingStatus(dubbingId, languageCode);

            // Add clip to target track
            const clip = {
              id: `dub-${languageCode}-${Date.now()}-${i}`,
              name: `${languageName} ${i + 1}`,
              path: dubbedAudioPath,
              startTime: segment.start,
              endTime: segment.end,
              duration: segmentDuration,
              type: 'dub',
              language: languageName,
              sourceSegmentIndex: i,
            };

            this.app.addClipToTrack && this.app.addClipToTrack(targetTrack.id, clip);
            successCount++;
          } catch (segmentError) {
            console.error('[TrackContextMenu] Segment dubbing error:', i, segmentError);
            errorCount++;
          }
        }

        this.app.hideProgress && this.app.hideProgress();

        // Save project
        if (this.app.saveCurrentVersion) {
          await this.app.saveCurrentVersion();
        }

        if (errorCount === 0) {
          this.app.showToast && this.app.showToast('success', `✅ Dubbed ${successCount} segments to ${languageName}`);
        } else {
          this.app.showToast &&
            this.app.showToast('warning', `Dubbed ${successCount}/${segments.length} segments (${errorCount} failed)`);
        }
      } catch (error) {
        console.error('[TrackContextMenu] Track dubbing error:', error);
        this.app.hideProgress && this.app.hideProgress();
        this.app.showToast && this.app.showToast('error', 'Dubbing failed: ' + error.message);
      }
    }

    /**
     * Execute track voice change workflow - regenerate all segments with new voice
     */
    async _executeTrackVoiceChange(trackId, voiceId, voiceName) {
      const segments = this.app.transcriptSegments;
      if (!segments || segments.length === 0) {
        this.app.showToast && this.app.showToast('error', 'No transcript segments found');
        return;
      }

      console.log('[TrackContextMenu] Starting voice change to', voiceName, 'with', segments.length, 'segments');

      // Push undo state
      this.app.pushUndoState && this.app.pushUndoState(`Change voice to ${voiceName}`);

      // Find or create the target track
      const targetTrackName = `Voice: ${voiceName}`;
      const targetTrack = this.app.findOrCreateTrack
        ? this.app.findOrCreateTrack(targetTrackName, 'voice')
        : this._findOrCreateTrack(targetTrackName, 'voice');

      // Show progress
      this.app.showProgress &&
        this.app.showProgress(`Generating ${voiceName} voice`, `Processing ${segments.length} segments...`);

      let successCount = 0;
      let errorCount = 0;

      try {
        for (let i = 0; i < segments.length; i++) {
          const segment = segments[i];
          const segmentDuration = segment.end - segment.start;

          this.app.showProgress &&
            this.app.showProgress(
              `Generating ${voiceName} voice`,
              `Segment ${i + 1}/${segments.length}: "${segment.text?.substring(0, 30)}..."`,
              Math.round(((i + 1) / segments.length) * 100)
            );

          try {
            // Generate TTS with duration constraint
            const result = await window.videoEditor.generateTimedTTS({
              text: segment.text,
              voiceId: voiceId,
              targetDuration: segmentDuration,
            });

            if (!result.success) {
              throw new Error(result.error || 'Failed to generate TTS');
            }

            // Add clip to target track
            const clip = {
              id: `voice-${voiceName}-${Date.now()}-${i}`,
              name: `${voiceName} ${i + 1}`,
              path: result.audioPath,
              startTime: segment.start,
              endTime: segment.end,
              duration: segmentDuration,
              type: 'voice',
              voiceId: voiceId,
              voiceName: voiceName,
              sourceSegmentIndex: i,
            };

            this.app.addClipToTrack && this.app.addClipToTrack(targetTrack.id, clip);
            successCount++;
          } catch (segmentError) {
            console.error('[TrackContextMenu] Segment voice change error:', i, segmentError);
            errorCount++;
          }
        }

        this.app.hideProgress && this.app.hideProgress();

        // Save project
        if (this.app.saveCurrentVersion) {
          await this.app.saveCurrentVersion();
        }

        if (errorCount === 0) {
          this.app.showToast &&
            this.app.showToast('success', `✅ Generated ${successCount} segments with ${voiceName} voice`);
        } else {
          this.app.showToast &&
            this.app.showToast(
              'warning',
              `Generated ${successCount}/${segments.length} segments (${errorCount} failed)`
            );
        }
      } catch (error) {
        console.error('[TrackContextMenu] Voice change error:', error);
        this.app.hideProgress && this.app.hideProgress();
        this.app.showToast && this.app.showToast('error', 'Voice change failed: ' + error.message);
      }
    }

    /**
     * Find existing track by name or create a new one
     */
    _findOrCreateTrack(trackName, trackType) {
      // Search existing tracks by name
      let track = this.app.audioTracks?.find((t) => t.name === trackName);

      if (!track) {
        // Create ONE new track
        const trackId = `A${this.app.nextTrackId++}`;
        track = {
          id: trackId,
          type: trackType,
          name: trackName,
          muted: false,
          solo: false,
          volume: 1.0,
          clips: [],
        };
        this.app.audioTracks.push(track);
        this.app.renderAudioTrack && this.app.renderAudioTrack(track);
        console.log('[TrackContextMenu] Created new track:', trackName, trackId);
      } else {
        console.log('[TrackContextMenu] Found existing track:', trackName, track.id);
      }

      return track;
    }

    /**
     * Extract audio segment from the video
     */
    async _extractAudioSegment(startTime, endTime) {
      // Use existing video editor functionality to extract segment
      if (window.videoEditor && window.videoEditor.extractAudioSegment) {
        const result = await window.videoEditor.extractAudioSegment(this.app.videoPath, startTime, endTime);
        if (result.success) {
          return result.outputPath;
        }
        throw new Error(result.error || 'Failed to extract audio segment');
      }

      // Fallback: extract video segment (dubbing API accepts video too)
      if (this.app.extractVideoSegment) {
        return await this.app.extractVideoSegment(startTime, endTime);
      }

      throw new Error('No segment extraction method available');
    }

    /**
     * Poll dubbing status until complete
     */
    async _pollDubbingStatus(dubbingId, languageCode) {
      const maxAttempts = 120; // 10 minutes at 5s intervals
      let attempts = 0;

      while (attempts < maxAttempts) {
        const status = await window.videoEditor.getDubbingStatus(dubbingId);

        if (status.status === 'dubbed') {
          // Download the dubbed audio
          const downloadResult = await window.videoEditor.downloadDubbedAudio(dubbingId, languageCode);
          if (downloadResult.success) {
            return downloadResult.audioPath;
          }
          throw new Error(downloadResult.error || 'Failed to download dubbed audio');
        } else if (status.status === 'failed') {
          throw new Error('Dubbing failed on the server');
        }

        // Wait 5 seconds before checking again
        await new Promise((resolve) => {
          setTimeout(resolve, 5000);
        });
        attempts++;
      }

      throw new Error('Dubbing timed out');
    }

    /**
     * Attach context menu handler to a track label element
     * @param {HTMLElement} labelElement - The track label element
     * @param {string} trackId - The track ID
     */
    attachToLabel(labelElement, trackId) {
      if (!labelElement || labelElement.dataset.contextMenuAttached) return;

      labelElement.addEventListener('contextmenu', (e) => {
        // Try to show the track context menu
        const success = this.show(trackId, e.clientX, e.clientY);

        // Only prevent default if we successfully showed the menu
        if (success) {
          e.preventDefault();
          e.stopPropagation();
        }
        // If show() failed, let the event bubble up so the global handler can show audioTrack menu
      });

      labelElement.dataset.contextMenuAttached = 'true';
      labelElement.style.cursor = 'context-menu';
    }
  }

  // ============================================================================
  // Export to global scope
  // ============================================================================

  global.ADRTrackManager = ADRTrackManager;
  global.TrackContextMenu = TrackContextMenu;
})(typeof window !== 'undefined' ? window : this);
