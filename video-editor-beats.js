/**
 * Video Editor - Story Beats Module
 * 
 * Extracted from video-editor-app.js to improve IDE performance.
 * This module provides the story beats system for marking, organizing,
 * and exporting narrative beats from video content.
 * 
 * Usage: Include this script before video-editor-app.js, then the app
 * will automatically integrate these methods via Object.assign().
 */

(function() {
  'use strict';

  /**
   * Story Beats Mixin - methods to be merged into the main app object
   */
  const StoryBeatsMixin = {
    // ==================== STORY BEATS STATE ====================
    beats: [],
    nextBeatId: 1,
    selectedBeatId: null,
    beatsCurrentTab: 'list',

    // ==================== STORY BEATS METHODS ====================

    switchBeatsTab(tab) {
      this.beatsCurrentTab = tab;
      
      // Update tab buttons
      document.querySelectorAll('.beats-sidebar-tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tab);
      });
      
      // Show/hide content
      document.getElementById('beatsListTab').style.display = tab === 'list' ? 'block' : 'none';
      document.getElementById('beatsGraphTab').style.display = tab === 'graph' ? 'block' : 'none';
      document.getElementById('beatsDeployTab').style.display = tab === 'deploy' ? 'block' : 'none';
      
      if (tab === 'graph') {
        this.renderBeatGraph();
      }
    },

    addNewBeat() {
      // Get current selection from timeline if any
      const inTime = this.trimStart || 0;
      const outTime = this.trimEnd || (this.videoInfo?.duration || 0);
      
      const beat = {
        id: `beat-${this.nextBeatId++}`,
        name: `Beat ${this.beats.length + 1}`,
        inTime: inTime,
        outTime: outTime,
        description: '',
        transcription: '',
        tags: [],
        links: []
      };
      
      this.beats.push(beat);
      this.renderBeatList();
      this.selectBeat(beat.id);
      
      this.showToast('success', 'Beat added! Fill in the details.');
    },

    renderBeatList() {
      const container = document.getElementById('beatList');
      
      // Guard against null container (e.g., when loading version before UI is ready)
      if (!container) {
        console.log('[VideoEditorBeats] Beat list container not available yet');
        return;
      }

      if (this.beats.length === 0) {
        container.innerHTML = `
          <div class="beat-inspector-empty">
            <p>No beats marked yet.</p>
            <p style="font-size: 11px; margin-top: 8px;">Select a region on the timeline and click "Add Beat"</p>
          </div>
        `;
        return;
      }
      
      container.innerHTML = this.beats.map(beat => `
        <div class="beat-item ${beat.id === this.selectedBeatId ? 'selected' : ''}" 
             onclick="app.selectBeat('${beat.id}')">
          <div class="beat-item-header">
            <span class="beat-item-name">${beat.name}</span>
            <span class="beat-item-time">${this.formatTime(beat.inTime)} - ${this.formatTime(beat.outTime)}</span>
          </div>
          ${beat.description ? `<div class="beat-item-description">${beat.description}</div>` : ''}
          ${beat.links.length > 0 ? `
            <div class="beat-item-links">
              ${beat.links.map(link => `<span class="beat-link-badge">${link.relationship}</span>`).join('')}
            </div>
          ` : ''}
        </div>
      `).join('');
    },

    selectBeat(beatId) {
      this.selectedBeatId = beatId;
      const beat = this.beats.find(b => b.id === beatId);
      
      if (!beat) return;
      
      // Update list selection
      this.renderBeatList();
      
      // Show inspector
      document.getElementById('beatInspectorPanel').style.display = 'block';
      
      // Populate fields
      document.getElementById('beatName').value = beat.name;
      document.getElementById('beatInTime').value = this.formatTime(beat.inTime);
      document.getElementById('beatOutTime').value = this.formatTime(beat.outTime);
      document.getElementById('beatDescription').value = beat.description || '';
      document.getElementById('beatTranscription').value = beat.transcription || '';
      
      // Render tags
      this.renderBeatTags(beat.tags);
      
      // Render links
      this.renderBeatLinks(beat.links);
      
      // Seek video to beat start
      const video = document.getElementById('videoPlayer');
      if (video) {
        video.currentTime = beat.inTime;
      }
    },

    renderBeatTags(tags) {
      const container = document.getElementById('beatTagsContainer');
      const input = document.getElementById('beatTagInput');
      
      // Clear existing tags (keep input)
      container.querySelectorAll('.beat-tag').forEach(el => el.remove());
      
      // Add tags
      tags.forEach(tag => {
        const tagEl = document.createElement('span');
        tagEl.className = 'beat-tag';
        tagEl.innerHTML = `${tag} <button class="beat-tag-remove" onclick="app.removeBeatTag('${tag}')">×</button>`;
        container.insertBefore(tagEl, input);
      });
    },

    handleBeatTagKeydown(event) {
      if (event.key === 'Enter' || event.key === ',') {
        event.preventDefault();
        const input = event.target;
        const tag = input.value.trim().replace(',', '');
        
        if (tag && this.selectedBeatId) {
          const beat = this.beats.find(b => b.id === this.selectedBeatId);
          if (beat && !beat.tags.includes(tag)) {
            beat.tags.push(tag);
            this.renderBeatTags(beat.tags);
          }
          input.value = '';
        }
      }
    },

    removeBeatTag(tag) {
      if (!this.selectedBeatId) return;
      const beat = this.beats.find(b => b.id === this.selectedBeatId);
      if (beat) {
        beat.tags = beat.tags.filter(t => t !== tag);
        this.renderBeatTags(beat.tags);
      }
    },

    renderBeatLinks(links) {
      const container = document.getElementById('beatLinksList');
      
      if (links.length === 0) {
        container.innerHTML = '<div style="font-size: 11px; color: var(--text-muted);">No links yet</div>';
        return;
      }
      
      container.innerHTML = links.map((link, i) => {
        const targetBeat = this.beats.find(b => b.id === link.targetBeatId);
        return `
          <div class="beat-link-item">
            <div class="beat-link-info">
              <span class="beat-link-type">${link.relationship}</span>
              <span>${targetBeat?.name || link.targetVideoId || 'Unknown'}</span>
            </div>
            <button class="btn btn-ghost" onclick="app.removeBeatLink(${i})" style="padding: 4px; color: var(--error);">×</button>
          </div>
        `;
      }).join('');
    },

    addBeatLink() {
      if (!this.selectedBeatId) return;
      
      // Show a simple dialog to select target and relationship
      const beat = this.beats.find(b => b.id === this.selectedBeatId);
      if (!beat) return;
      
      // For now, just add a placeholder link
      const otherBeats = this.beats.filter(b => b.id !== this.selectedBeatId);
      if (otherBeats.length === 0) {
        this.showToast('info', 'Add more beats to create links');
        return;
      }
      
      beat.links.push({
        targetBeatId: otherBeats[0].id,
        relationship: 'leads_to',
        targetVideoId: null
      });
      
      this.renderBeatLinks(beat.links);
      this.showToast('info', 'Link added - edit to customize');
    },

    removeBeatLink(index) {
      if (!this.selectedBeatId) return;
      const beat = this.beats.find(b => b.id === this.selectedBeatId);
      if (beat) {
        beat.links.splice(index, 1);
        this.renderBeatLinks(beat.links);
      }
    },

    saveBeat() {
      if (!this.selectedBeatId) return;
      const beat = this.beats.find(b => b.id === this.selectedBeatId);
      if (!beat) return;
      
      beat.name = document.getElementById('beatName').value;
      beat.inTime = this.parseTime(document.getElementById('beatInTime').value);
      beat.outTime = this.parseTime(document.getElementById('beatOutTime').value);
      beat.description = document.getElementById('beatDescription').value;
      beat.transcription = document.getElementById('beatTranscription').value;
      
      this.renderBeatList();
      this.showToast('success', 'Beat saved');
    },

    deleteBeat() {
      if (!this.selectedBeatId) return;
      
      this.beats = this.beats.filter(b => b.id !== this.selectedBeatId);
      this.selectedBeatId = null;
      
      document.getElementById('beatInspectorPanel').style.display = 'none';
      this.renderBeatList();
      this.showToast('success', 'Beat deleted');
    },

    async transcribeBeat() {
      if (!this.selectedBeatId || !this.videoPath) return;
      const beat = this.beats.find(b => b.id === this.selectedBeatId);
      if (!beat) return;
      
      this.showToast('info', 'Transcribing...');
      
      try {
        const result = await window.videoEditor.transcribeRange(this.videoPath, {
          startTime: beat.inTime,
          endTime: beat.outTime
        });
        
        if (result.transcription) {
          beat.transcription = result.transcription;
          document.getElementById('beatTranscription').value = result.transcription;
          this.showToast('success', 'Transcription complete');
        } else {
          throw new Error(result.error || 'Transcription failed');
        }
      } catch (error) {
        this.showToast('error', 'Transcription failed: ' + error.message);
      }
    },

    // Beat Graph Rendering
    renderBeatGraph() {
      const canvas = document.getElementById('beatGraphCanvas');
      if (!canvas) return;
      
      // Clear existing
      canvas.innerHTML = '';
      
      if (this.beats.length === 0) {
        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('x', '50%');
        text.setAttribute('y', '50%');
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('fill', '#5c5c5c');
        text.setAttribute('font-size', '12');
        text.textContent = 'Add beats to see graph';
        canvas.appendChild(text);
        return;
      }
      
      // Position beats in a layout
      const containerWidth = canvas.clientWidth || 400;
      const containerHeight = canvas.clientHeight || 300;
      const nodeWidth = 100;
      const nodeHeight = 40;
      
      // Simple horizontal layout
      const spacing = containerWidth / (this.beats.length + 1);
      
      this.beats.forEach((beat, i) => {
        beat._x = spacing * (i + 1) - nodeWidth / 2;
        beat._y = containerHeight / 2 - nodeHeight / 2;
      });
      
      // Draw links first (so they appear behind nodes)
      this.beats.forEach(beat => {
        beat.links.forEach(link => {
          const targetBeat = this.beats.find(b => b.id === link.targetBeatId);
          if (targetBeat) {
            const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            const startX = beat._x + nodeWidth;
            const startY = beat._y + nodeHeight / 2;
            const endX = targetBeat._x;
            const endY = targetBeat._y + nodeHeight / 2;
            
            // Curved line
            const midX = (startX + endX) / 2;
            line.setAttribute('d', `M ${startX} ${startY} Q ${midX} ${startY - 30} ${endX} ${endY}`);
            line.setAttribute('stroke', '#4a9eff');
            line.setAttribute('stroke-width', '2');
            line.setAttribute('fill', 'none');
            line.setAttribute('marker-end', 'url(#arrowhead)');
            canvas.appendChild(line);
            
            // Link label
            const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            label.setAttribute('x', midX);
            label.setAttribute('y', startY - 35);
            label.setAttribute('text-anchor', 'middle');
            label.setAttribute('fill', '#909090');
            label.setAttribute('font-size', '10');
            label.textContent = link.relationship;
            canvas.appendChild(label);
          }
        });
      });
      
      // Draw nodes
      this.beats.forEach(beat => {
        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.setAttribute('class', 'beat-graph-node');
        g.setAttribute('data-beat-id', beat.id);
        g.style.cursor = 'pointer';
        g.onclick = () => this.selectBeat(beat.id);
        
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', beat._x);
        rect.setAttribute('y', beat._y);
        rect.setAttribute('width', nodeWidth);
        rect.setAttribute('height', nodeHeight);
        rect.setAttribute('rx', '6');
        rect.setAttribute('fill', beat.id === this.selectedBeatId ? '#232323' : '#1e1e1e');
        rect.setAttribute('stroke', beat.id === this.selectedBeatId ? '#e84c3d' : '#4a9eff');
        rect.setAttribute('stroke-width', '2');
        g.appendChild(rect);
        
        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('x', beat._x + nodeWidth / 2);
        text.setAttribute('y', beat._y + nodeHeight / 2 + 4);
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('fill', '#d4d4d4');
        text.setAttribute('font-size', '12');
        text.textContent = beat.name.length > 12 ? beat.name.substring(0, 12) + '...' : beat.name;
        g.appendChild(text);
        
        canvas.appendChild(g);
      });
      
      // Add arrowhead marker
      const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
      defs.innerHTML = `
        <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
          <polygon points="0 0, 10 3.5, 0 7" fill="#4a9eff" />
        </marker>
      `;
      canvas.insertBefore(defs, canvas.firstChild);
    },

    zoomBeatGraph(factor) {
      // TODO: Implement graph zoom
      this.showToast('info', 'Zoom coming soon');
    },

    resetBeatGraphView() {
      this.renderBeatGraph();
    },

    // Deploy Functions
    async testInPlayer() {
      if (this.beats.length === 0) {
        this.showToast('error', 'Add some beats first');
        return;
      }
      
      if (!this.videoPath) {
        this.showToast('error', 'No video loaded');
        return;
      }
      
      try {
        // Save beats first
        await this.exportProjectToSpace();
        
        // Create player config with beats
        const playerConfig = {
          videoPath: this.videoPath,
          beats: this.beats.map(beat => ({
            id: beat.id,
            name: beat.name,
            timeIn: this.formatTime(beat.inTime),
            timeOut: this.formatTime(beat.outTime),
            description: beat.description,
            transcription: beat.transcription,
            tags: beat.tags,
            links: beat.links
          })),
          mode: 'test'
        };
        
        // Open player window
        const playerWindow = window.open(
          'agentic-player/index.html',
          'AgenticPlayer',
          'width=1200,height=800'
        );
        
        // Send config when loaded
        if (playerWindow) {
          playerWindow.addEventListener('load', () => {
            playerWindow.postMessage({
              type: 'load-beats',
              config: playerConfig
            }, '*');
          });
          
          this.showToast('success', 'Player opened!');
        }
      } catch (error) {
        console.error('[Deploy] Test player error:', error);
        this.showToast('error', 'Failed to open player');
      }
    },

    generateEmbedCode() {
      if (this.beats.length === 0) {
        this.showToast('error', 'Add some beats first');
        return;
      }
      
      const embedCode = `<iframe src="https://player.onereach.ai/embed/${Date.now()}" 
  width="800" height="450" frameborder="0" 
  allow="autoplay; fullscreen" allowfullscreen>
</iframe>`;
      
      navigator.clipboard.writeText(embedCode).then(() => {
        this.showToast('success', 'Embed code copied!');
      });
      
      document.getElementById('embedCodeBox').textContent = embedCode;
      document.getElementById('embedCodeSection').style.display = 'block';
    },

    async exportPlayerPackage() {
      if (this.beats.length === 0) {
        this.showToast('error', 'Add some beats first');
        return;
      }
      
      if (!this.videoPath) {
        this.showToast('error', 'No video loaded');
        return;
      }
      
      try {
        this.showToast('info', 'Creating player package...');
        
        // Create package structure
        const packageData = {
          beats: this.exportBeatsJSON(),
          config: {
            videoPath: this.videoPath.split('/').pop(),
            title: this.currentProject?.name || 'Video Player',
            autoplay: false,
            controls: true
          },
          readme: this.generatePlayerReadme()
        };
        
        // Download beats.json
        this.downloadJSON(JSON.stringify(packageData.beats, null, 2), 'beats.json');
        
        // Download config.json
        this.downloadJSON(JSON.stringify(packageData.config, null, 2), 'config.json');
        
        // Download README
        const readmeBlob = new Blob([packageData.readme], { type: 'text/markdown' });
        const readmeUrl = URL.createObjectURL(readmeBlob);
        const readmeLink = document.createElement('a');
        readmeLink.href = readmeUrl;
        readmeLink.download = 'README.md';
        readmeLink.click();
        URL.revokeObjectURL(readmeUrl);
        
        this.showToast('success', 'Player package exported! Copy agentic-player folder and add your video file.');
        
        // Show instructions
        setTimeout(() => {
          alert(`Player Package Created!\n\n` +
                `Files downloaded:\n` +
                `- beats.json (story beats metadata)\n` +
                `- config.json (player configuration)\n` +
                `- README.md (setup instructions)\n\n` +
                `Next steps:\n` +
                `1. Copy the agentic-player/ folder from your app\n` +
                `2. Add these files to that folder\n` +
                `3. Add your video file (${this.videoPath.split('/').pop()})\n` +
                `4. Host on any web server or open index.html locally\n\n` +
                `See README.md for detailed instructions.`);
        }, 1000);
      } catch (error) {
        console.error('[Deploy] Export package error:', error);
        this.showToast('error', 'Export failed');
      }
    },

    generatePlayerReadme() {
      return `# Agentic Video Player - Self-Hosted Package

This package contains everything needed to host your interactive video player.

## Package Contents

- \`index.html\` - Player HTML
- \`player.js\` - Player JavaScript
- \`styles.css\` - Player styles
- \`beats.json\` - Story beats metadata
- \`config.json\` - Player configuration
- \`${this.videoPath.split('/').pop()}\` - Your video file (add this)

## Setup Instructions

### Option 1: Local Testing

1. Place all files in a folder
2. Add your video file: \`${this.videoPath.split('/').pop()}\`
3. Open \`index.html\` in a modern browser

### Option 2: Web Hosting

1. Upload all files to your web server
2. Ensure video file is accessible
3. Navigate to \`https://yourdomain.com/player/\`

### Option 3: CDN + Hosting

1. Upload video to CDN (e.g., Cloudflare, AWS S3)
2. Update \`config.json\` with CDN URL
3. Host player files on any static host

## Configuration

Edit \`config.json\` to customize:

\`\`\`json
{
  "videoPath": "your-video.mp4",  // Local or CDN URL
  "title": "Your Video Title",
  "autoplay": false,
  "controls": true
}
\`\`\`

## Story Beats

The \`beats.json\` file contains all your marked story beats with:
- Time codes (in/out points)
- Transcriptions
- Descriptions
- Tags
- Links to other beats

The player uses this to enable:
- Smart navigation
- Beat-to-beat jumping
- Graph-based playback
- Interactive storytelling

## Requirements

- Modern browser (Chrome, Firefox, Safari, Edge)
- Video codec support (H.264/VP9)
- HTTPS recommended for production

## Troubleshooting

**Video won't play:**
- Check video path in config.json
- Ensure video format is web-compatible (MP4/WebM)
- Check browser console for errors

**Beats not loading:**
- Verify beats.json is valid JSON
- Check file path and permissions
- Ensure all beat time codes are valid

## Support

For issues or questions, refer to the main Onereach.ai documentation.

---

Generated by Onereach Video Editor
${new Date().toLocaleDateString()}
`;
    },

    // Generate scene description from transcript using LLM
    async generateMarkerDescriptionFromTranscript() {
      const transcriptField = document.getElementById('markerTranscription');
      const descriptionField = document.getElementById('markerDescription');
      const btn = document.getElementById('generateDescriptionBtn');
      const status = document.getElementById('descriptionStatus');
      
      const transcript = transcriptField?.value?.trim();
      
      if (!transcript) {
        this.showToast('error', 'No transcription available. Use "Auto-Transcribe" first.');
        return;
      }
      
      // Get time range info for context
      let timeContext = '';
      if (this.selectedMarkerType === 'range') {
        const inTime = this.formatTime(this.rangeInTime);
        const outTime = this.formatTime(this.rangeOutTime);
        const duration = this.rangeOutTime - this.rangeInTime;
        timeContext = `Time range: ${inTime} - ${outTime} (${this.formatTime(duration)} duration)`;
      } else {
        const spotTime = parseFloat(document.getElementById('markerModal')?.dataset?.time || 0);
        timeContext = `Time point: ${this.formatTime(spotTime)}`;
      }
      
      // Get video context
      const videoName = this.videoPath ? this.videoPath.split('/').pop() : 'Unknown video';
      
      // Show loading state
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = '⏳ Generating...';
      }
      if (status) {
        status.classList.remove('hidden');
        status.innerHTML = 'Generating description with AI...';
      }
      
      try {
        // Call the LLM via IPC
        const result = await window.videoEditor.generateSceneDescription({
          transcript,
          timeContext,
          videoName,
          existingDescription: descriptionField?.value?.trim() || ''
        });
        
        if (!result.success) {
          throw new Error(result.error || 'Failed to generate description');
        }
        
        // Fill in the description field
        if (descriptionField) {
          descriptionField.value = result.description;
        }
        
        if (status) {
          status.innerHTML = '✅ Description generated from transcript';
        }
        
        this.showToast('success', 'Description generated!');
        
      } catch (error) {
        console.error('[GenerateDescription] Error:', error);
        if (status) {
          status.innerHTML = `❌ ${error.message}`;
        }
        this.showToast('error', 'Failed to generate description: ' + error.message);
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = '✨ Generate from Transcript';
        }
      }
    },

    // Export beats to JSON with full metadata and transcript
    exportBeatsJSON() {
      const video = document.getElementById('videoPlayer');
      const fps = 30; // Assume 30fps for timecode
      
      return {
        version: '2.0',
        exportedAt: new Date().toISOString(),
        videoId: this.spaceItemId || 'local',
        videoPath: this.videoPath,
        videoName: this.videoPath ? this.videoPath.split('/').pop() : 'Untitled',
        duration: this.videoInfo?.duration || video?.duration || 0,
        durationFormatted: this.formatTime(this.videoInfo?.duration || video?.duration || 0),
        transcriptSource: this.transcriptSource || 'unknown',
        
        // Full markers/scenes list with all metadata
        markers: this.markers.map(marker => {
          const isRange = marker.type === 'range';
          const startTime = isRange ? marker.inTime : marker.time;
          const endTime = isRange ? marker.outTime : marker.time;
          
          // Get transcript for this marker's time range
          let transcript = marker.transcription || '';
          if (!transcript && isRange && this.teleprompterWords && this.teleprompterWords.length > 0) {
            // Auto-extract transcript if not set
            const rangeWords = this.getWordsInRange(marker.inTime, marker.outTime);
            transcript = rangeWords.map(w => w.text).join(' ');
          }
          
          return {
            id: marker.id,
            name: marker.name,
            type: marker.type,
            color: marker.color,
            
            // Timing with multiple formats
            timing: {
              inTime: startTime,
              outTime: endTime,
              duration: isRange ? marker.duration : 0,
              inTimecode: this.formatTimecodeWithFrames(startTime, fps),
              outTimecode: this.formatTimecodeWithFrames(endTime, fps),
              inFormatted: this.formatTime(startTime),
              outFormatted: this.formatTime(endTime),
              durationFormatted: isRange ? this.formatTime(marker.duration) : '00:00'
            },
            
            // Content
            transcript: transcript,
            description: marker.description || '',
            notes: marker.notes || '',
            tags: marker.tags || [],
            
            // Metadata
            createdAt: marker.createdAt,
            modifiedAt: marker.modifiedAt
          };
        }),
        
        // Beats (for story beat system)
        beats: this.beats.map(beat => ({
          id: beat.id,
          name: beat.name,
          timing: {
            inTime: beat.inTime,
            outTime: beat.outTime,
            inTimecode: this.formatTimecodeWithFrames(beat.inTime, fps),
            outTimecode: this.formatTimecodeWithFrames(beat.outTime, fps),
            inFormatted: this.formatTime(beat.inTime),
            outFormatted: this.formatTime(beat.outTime)
          },
          transcription: beat.transcription,
          description: beat.description,
          tags: beat.tags,
          links: beat.links
        })),
        
        // Full transcript with timecodes
        fullTranscript: this.exportFullTranscript(),
        
        crossVideoIndex: {}
      };
    },
    
    // Format time as SMPTE timecode (HH:MM:SS:FF)
    formatTimecodeWithFrames(seconds, fps = 30) {
      if (!seconds || isNaN(seconds)) return '00:00:00:00';
      
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = Math.floor(seconds % 60);
      const frames = Math.floor((seconds % 1) * fps);
      
      return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}:${frames.toString().padStart(2, '0')}`;
    },
    
    // Export full transcript with word-level timecodes
    exportFullTranscript() {
      if (!this.teleprompterWords || this.teleprompterWords.length === 0) {
        return { text: '', words: [], segments: [] };
      }
      
      // Full text
      const fullText = this.teleprompterWords.map(w => w.text).join(' ');
      
      // Word-level data
      const words = this.teleprompterWords.map(w => ({
        text: w.text,
        start: w.start,
        end: w.end,
        startTimecode: this.formatTimecodeWithFrames(w.start, 30),
        endTimecode: this.formatTimecodeWithFrames(w.end, 30)
      }));
      
      // Group into segments (by sentence or ~10 words)
      const segments = [];
      let currentSegment = { words: [], start: 0, text: '' };
      
      for (const word of this.teleprompterWords) {
        if (currentSegment.words.length === 0) {
          currentSegment.start = word.start;
        }
        
        currentSegment.words.push(word);
        currentSegment.text += (currentSegment.text ? ' ' : '') + word.text;
        
        // Break on sentence end or ~10 words
        const isSentenceEnd = /[.!?]$/.test(word.text);
        if (isSentenceEnd || currentSegment.words.length >= 10) {
          currentSegment.end = word.end;
          currentSegment.startTimecode = this.formatTimecodeWithFrames(currentSegment.start, 30);
          currentSegment.endTimecode = this.formatTimecodeWithFrames(currentSegment.end, 30);
          segments.push({ ...currentSegment, words: undefined }); // Don't duplicate words in segments
          currentSegment = { words: [], start: 0, text: '' };
        }
      }
      
      // Don't forget last segment
      if (currentSegment.words.length > 0) {
        currentSegment.end = currentSegment.words[currentSegment.words.length - 1].end;
        currentSegment.startTimecode = this.formatTimecodeWithFrames(currentSegment.start, 30);
        currentSegment.endTimecode = this.formatTimecodeWithFrames(currentSegment.end, 30);
        segments.push({ ...currentSegment, words: undefined });
      }
      
      return { text: fullText, words, segments };
    }
  };

  // Export to window for integration with main app
  window.VideoEditorBeats = {
    mixin: StoryBeatsMixin
  };

  console.log('[VideoEditorBeats] Module loaded');
})();
