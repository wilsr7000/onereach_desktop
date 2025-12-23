/**
 * TeleprompterUI - Core teleprompter rendering and interaction
 * Handles word display, scrolling, cursor, and highlighting
 */
export class TeleprompterUI {
  constructor(appContext) {
    this.app = appContext;
    
    // State
    this.visible = true;  // Show by default when transcript available
    this.expanded = false;
    this.words = [];      // Cached expanded words with timing
    
    // Internal state
    this._mouseMove = null;  // Mouse move handler reference
  }

  /**
   * Toggle teleprompter visibility
   */
  toggle() {
    this.visible = !this.visible;
    const container = document.getElementById('teleprompterContainer');
    const toggleBtn = document.getElementById('teleprompterToggleBtn');
    
    if (this.visible) {
      container?.classList.remove('hidden');
      toggleBtn?.classList.add('active');
      this.init();
    } else {
      container?.classList.add('hidden');
      toggleBtn?.classList.remove('active');
    }
  }

  /**
   * Toggle expanded size
   */
  toggleSize() {
    this.expanded = !this.expanded;
    const container = document.getElementById('teleprompterContainer');
    container?.classList.toggle('expanded', this.expanded);
  }

  /**
   * Show the teleprompter (without toggling)
   */
  show() {
    this.visible = true;
    const container = document.getElementById('teleprompterContainer');
    const toggleBtn = document.getElementById('teleprompterToggleBtn');
    container?.classList.remove('hidden');
    toggleBtn?.classList.add('active');
    this.init();
  }

  /**
   * Hide the teleprompter
   */
  hide() {
    this.visible = false;
    const container = document.getElementById('teleprompterContainer');
    const toggleBtn = document.getElementById('teleprompterToggleBtn');
    container?.classList.add('hidden');
    toggleBtn?.classList.remove('active');
  }

  /**
   * Initialize teleprompter with transcript data
   */
  init() {
    const wordsContainer = document.getElementById('teleprompterWords');
    
    // Check if we have transcript segments
    if (!this.app.transcriptSegments || this.app.transcriptSegments.length === 0) {
      wordsContainer.innerHTML = `
        <div class="teleprompter-empty">
          <span>No transcript</span>
          <button onclick="app.transcribeFullVideoForTeleprompter()">🎤 Transcribe</button>
        </div>
      `;
      return;
    }
    
    // Expand segments to individual words
    this.words = this.expandTranscriptToWords(this.app.transcriptSegments);
    
    // Log timing info
    if (this.words.length > 0) {
      const first = this.words[0];
      const last = this.words[this.words.length - 1];
      console.log('[Teleprompter] Loaded', this.words.length, 'words (source:', this.app.transcriptSource + ')');
      console.log('[Teleprompter] Time range:', first.start?.toFixed(1) + 's -', last.end?.toFixed(1) + 's');
    }
    
    // Render words
    this.renderWords();
    
    // Show warning if not Whisper-generated
    this.updateSourceIndicator();
    
    // Update highlighting and scroll to current time
    const video = document.getElementById('videoPlayer');
    if (video) {
      const currentTime = video.currentTime;
      console.log('[Teleprompter] Scrolling to current time:', currentTime.toFixed(1) + 's');
      
      requestAnimationFrame(() => {
        this.updateHighlight(currentTime);
        this.scrollToTime(currentTime);
      });
    }
  }

  /**
   * Expand transcript segments into individual words with timing
   * Preserves speaker information from diarization
   */
  expandTranscriptToWords(segments) {
    const words = [];

    segments.forEach(segment => {
      const text = (segment.text || segment.word || '').trim();
      const startTime = segment.start || 0;
      const endTime = segment.end || (startTime + 1);
      // Preserve speaker ID from segment (supports multiple naming conventions)
      const speakerId = segment.speakerId || segment.speaker_id || segment.speaker || null;

      // If this is already a single word, use it directly
      if (!text.includes(' ')) {
        if (text.length > 0) {
          words.push({
            text: text,
            start: startTime,
            end: endTime,
            speaker: speakerId
          });
        }
        return;
      }

      // Split sentence into words and distribute timing
      const segmentWords = text.split(/\s+/).filter(w => w.length > 0);
      const segmentDuration = endTime - startTime;
      const wordDuration = segmentDuration / segmentWords.length;

      segmentWords.forEach((word, i) => {
        words.push({
          text: word,
          start: startTime + (i * wordDuration),
          end: startTime + ((i + 1) * wordDuration),
          speaker: speakerId  // All words from this segment have the same speaker
        });
      });
    });

    return words;
  }

  /**
   * Render teleprompter words to the DOM
   * Includes speaker labels when speaker changes
   */
  renderWords() {
    const wordsContainer = document.getElementById('teleprompterWords');

    if (!this.words || this.words.length === 0) {
      wordsContainer.innerHTML = '<div class="teleprompter-empty">No words to display</div>';
      return;
    }

    // Build marker map for highlighting words in markers
    const markerMap = this.app.teleprompterMarkers?.buildMarkerTimeMap() || { ranges: [], spots: [] };
    
    // Track speaker changes for labels
    let lastSpeaker = null;
    const speakerColors = ['#4a9eff', '#22c55e', '#f59e0b', '#ec4899', '#8b5cf6', '#06b6d4'];
    
    // Build a map of unique speakers for consistent coloring
    const uniqueSpeakers = [...new Set(this.words.map(w => w.speaker).filter(Boolean))];
    const speakerColorMap = {};
    uniqueSpeakers.forEach((speaker, i) => {
      speakerColorMap[speaker] = i % speakerColors.length;
    });
    
    // Log speaker info
    if (uniqueSpeakers.length > 0) {
      console.log('[Teleprompter] Speakers detected:', uniqueSpeakers.join(', '));
    }

    wordsContainer.innerHTML = this.words.map((word, index) => {
      const startTime = this.app.formatTime(word.start);
      const endTime = this.app.formatTime(word.end);
      const duration = ((word.end - word.start) * 1000).toFixed(0);
      
      // Check if word falls within any marker
      const markerInfo = this.app.teleprompterMarkers?.getMarkerForTime(word.start, word.end, markerMap);
      let markerClass = '';
      let markerStyle = '';
      let markerTitle = '';
      let markerDataAttrs = '';
      
      if (markerInfo) {
        if (markerInfo.type === 'range') {
          markerClass = 'in-marker-range';
          markerStyle = `border-bottom: 2px solid ${markerInfo.color};`;
          markerTitle = ` | 📍 ${markerInfo.name}`;
          markerDataAttrs = `data-marker-id="${markerInfo.id}" data-marker-name="${markerInfo.name.replace(/"/g, '&quot;')}"`;
        } else if (markerInfo.type === 'spot') {
          markerClass = 'at-marker-point';
          markerStyle = `background: ${markerInfo.color}40;`;
          markerTitle = ` | 📌 ${markerInfo.name}`;
          markerDataAttrs = `data-marker-id="${markerInfo.id}" data-marker-name="${markerInfo.name.replace(/"/g, '&quot;')}"`;
        }
      }
      
      // Speaker identification
      let speakerLabel = '';
      let speakerClass = '';
      let speakerDataAttr = '';
      let speakerTitleInfo = '';
      
      if (word.speaker) {
        const speakerIndex = speakerColorMap[word.speaker] ?? 0;
        speakerClass = `speaker-${speakerIndex}`;
        speakerDataAttr = `data-speaker="${word.speaker}"`;
        speakerTitleInfo = ` | 🎙️ ${word.speaker}`;
        
        // Add speaker label when speaker changes
        if (word.speaker !== lastSpeaker) {
          const speakerColor = speakerColors[speakerIndex];
          const displayName = this.formatSpeakerName(word.speaker);
          speakerLabel = `<span class="teleprompter-speaker-label clickable" 
            style="background: ${speakerColor}20; color: ${speakerColor}; border-color: ${speakerColor};"
            onclick="event.stopPropagation(); app.showSpeakerEditDropdown(event, '${word.speaker}')"
            title="Click to edit speaker">${displayName}</span>`;
          lastSpeaker = word.speaker;
        }
      }
      
      return `${speakerLabel}<span class="teleprompter-word ${markerClass} ${speakerClass}"
              data-index="${index}"
              data-start="${word.start}"
              data-end="${word.end}"
              data-timecode="${startTime}"
              ${speakerDataAttr}
              ${markerDataAttrs}
              style="${markerStyle}"
              onclick="app.teleprompterMarkers?.handleWordClick(event, ${word.start}, ${word.end})"
              ondblclick="app.teleprompterMarkers?.editMarkerFromWord(${markerInfo?.id || 'null'})"
              title="${startTime} → ${endTime} (${duration}ms)${speakerTitleInfo}${markerTitle}">${word.text}</span>`;
    }).join('');
    
    // Add marker indicators at marker boundaries
    this.app.teleprompterMarkers?.addMarkerIndicators();
    
    // Add speaker legend if multiple speakers
    this.renderSpeakerLegend(uniqueSpeakers, speakerColorMap, speakerColors);

    // Setup insertion cursor
    this.setupInsertionCursor();
  }
  
  /**
   * Format speaker name for display (e.g., "speaker_0" -> "Speaker 1")
   */
  formatSpeakerName(speakerId) {
    if (!speakerId) return '';
    
    // Handle common formats: speaker_0, speaker_1, SPEAKER_0, etc.
    const match = speakerId.match(/speaker[_\s]?(\d+)/i);
    if (match) {
      const num = parseInt(match[1], 10) + 1; // Convert 0-indexed to 1-indexed
      return `Speaker ${num}`;
    }
    
    // Otherwise use as-is (might be a name)
    return speakerId;
  }
  
  /**
   * Render speaker legend showing all speakers and their colors
   */
  renderSpeakerLegend(speakers, colorMap, colors) {
    const container = document.getElementById('teleprompterContainer');
    if (!container) return;
    
    // Remove existing legend
    const existingLegend = container.querySelector('.teleprompter-speaker-legend');
    if (existingLegend) {
      existingLegend.remove();
    }
    
    // Only show legend if multiple speakers
    if (speakers.length < 2) return;
    
    const legend = document.createElement('div');
    legend.className = 'teleprompter-speaker-legend';
    legend.innerHTML = speakers.map(speaker => {
      const colorIndex = colorMap[speaker] ?? 0;
      const color = colors[colorIndex];
      const displayName = this.formatSpeakerName(speaker);
      return `<span class="speaker-legend-item clickable" 
        style="color: ${color};"
        onclick="event.stopPropagation(); app.showSpeakerEditDropdown(event, '${speaker}')"
        title="Click to edit speaker">
        <span class="speaker-legend-dot" style="background: ${color};"></span>
        ${displayName}
      </span>`;
    }).join('');
    
    container.appendChild(legend);
  }

  /**
   * Update word highlighting based on current video time
   */
  updateHighlight(currentTime) {
    if (!this.visible || !this.words || this.words.length === 0) return;

    // Apply sync adjustments
    const adjustedTime = this.app.transcriptSync 
      ? this.app.transcriptSync.adjustTime(currentTime)
      : currentTime;

    const wordElements = document.querySelectorAll('.teleprompter-word');
    let currentWordElement = null;

    wordElements.forEach((wordEl) => {
      const start = parseFloat(wordEl.dataset.start);
      const end = parseFloat(wordEl.dataset.end);

      // Remove all state classes
      wordEl.classList.remove('current', 'spoken', 'upcoming');

      if (adjustedTime >= start && adjustedTime < end) {
        wordEl.classList.add('current');
        currentWordElement = wordEl;
      } else if (adjustedTime >= end) {
        wordEl.classList.add('spoken');
      } else if (adjustedTime < start && adjustedTime >= start - 3) {
        wordEl.classList.add('upcoming');
      }
    });

    // Scroll to center current word
    if (currentWordElement) {
      this.scrollToWord(currentWordElement);
    }
  }

  /**
   * Scroll to show words at a specific time
   */
  scrollToTime(targetTime) {
    if (!this.words || this.words.length === 0) return;

    // Find the word closest to targetTime
    let closestIndex = 0;
    let closestDiff = Infinity;

    this.words.forEach((word, index) => {
      const diff = Math.abs(word.start - targetTime);
      if (diff < closestDiff) {
        closestDiff = diff;
        closestIndex = index;
      }
    });

    const wordEl = document.querySelector(`.teleprompter-word[data-index="${closestIndex}"]`);
    if (wordEl) {
      this.scrollToWord(wordEl);
      console.log('[Teleprompter] Scrolled to word', closestIndex, ':', this.words[closestIndex].text);
    }
  }

  /**
   * Smooth horizontal scroll to center a word element
   */
  scrollToWord(wordElement) {
    const container = document.getElementById('teleprompterContent');
    if (!container || !wordElement) return;

    const containerRect = container.getBoundingClientRect();
    const wordRect = wordElement.getBoundingClientRect();
    
    // Calculate where the word currently is relative to the container's visible area
    const wordCenterRelativeToContainer = (wordRect.left + wordRect.width / 2) - containerRect.left;
    const containerCenter = containerRect.width / 2;
    
    // Calculate scroll adjustment needed to center the word
    const scrollAdjustment = wordCenterRelativeToContainer - containerCenter;
    const targetScroll = container.scrollLeft + scrollAdjustment;

    container.scrollTo({
      left: targetScroll,
      behavior: 'smooth'
    });
  }

  /**
   * Seek video to a specific time
   */
  seekToTime(time) {
    const video = document.getElementById('videoPlayer');
    if (video) {
      video.currentTime = time;
      this.updateHighlight(time);
    }
  }

  /**
   * Update the transcript source indicator (warning for non-Whisper)
   */
  updateSourceIndicator() {
    const container = document.getElementById('teleprompterContainer');
    if (!container) return;

    // Remove existing indicator
    let indicator = container.querySelector('.transcript-source-indicator');
    if (indicator) {
      indicator.remove();
    }

    // Only show indicator if not Whisper
    if (this.app.transcriptSource === 'whisper') {
      return;
    }

    // Create warning indicator
    indicator = document.createElement('div');
    indicator.className = 'transcript-source-indicator';

    if (this.app.transcriptSource === 'evenly-distributed' || this.app.transcriptSource === 'pending-evenly-distributed') {
      indicator.innerHTML = `
        <span class="indicator-warning">⚠️ Timing not synced</span>
        <button class="indicator-action" onclick="app.transcribeForWaveform()" title="Re-transcribe with Whisper for accurate timing">
          🎤 Fix with Whisper
        </button>
      `;
      indicator.title = 'Transcript timing is evenly distributed and may not match the audio.';
    } else if (this.app.transcriptSource === 'youtube') {
      indicator.innerHTML = `
        <span class="indicator-info">📺 YouTube captions</span>
        <button class="indicator-action" onclick="app.transcribeForWaveform()" title="Re-transcribe with Whisper for more accurate timing">
          🎤 Improve
        </button>
      `;
      indicator.title = 'Using YouTube auto-captions. Timing may be slightly off.';
    } else {
      indicator.innerHTML = `
        <span class="indicator-unknown">❓ Unknown source</span>
        <button class="indicator-action" onclick="app.transcribeForWaveform()" title="Re-transcribe with Whisper for accurate timing">
          🎤 Transcribe
        </button>
      `;
      indicator.title = 'Transcript source unknown.';
    }

    container.appendChild(indicator);
  }

  /**
   * Setup the insertion cursor between words
   */
  setupInsertionCursor() {
    const container = document.getElementById('teleprompterContainer');
    const content = document.getElementById('teleprompterContent');
    const wordsContainer = document.getElementById('teleprompterWords');
    if (!container || !wordsContainer) return;

    // Create or get cursor element
    let cursor = container.querySelector('.teleprompter-cursor');
    if (!cursor) {
      cursor = document.createElement('div');
      cursor.className = 'teleprompter-cursor';
      cursor.innerHTML = `
        <div class="cursor-line"></div>
        <div class="cursor-timecode"></div>
        <div class="cursor-hint">Click to mark</div>
      `;
      container.appendChild(cursor);
    }

    // Create range indicator
    let rangeIndicator = container.querySelector('.teleprompter-range-indicator');
    if (!rangeIndicator) {
      rangeIndicator = document.createElement('div');
      rangeIndicator.className = 'teleprompter-range-indicator';
      rangeIndicator.innerHTML = `
        <div class="range-start-line"></div>
        <div class="range-start-label">IN</div>
      `;
      container.appendChild(rangeIndicator);
    }

    // Remove existing listener
    if (this._mouseMove) {
      (content || wordsContainer).removeEventListener('mousemove', this._mouseMove);
    }

    // Track mouse position for cursor
    this._mouseMove = (e) => {
      const words = wordsContainer.querySelectorAll('.teleprompter-word');
      if (words.length === 0) {
        cursor.style.display = 'none';
        return;
      }

      const mouseX = e.clientX;
      const containerRect = container.getBoundingClientRect();

      // Check if over a word
      const isOverWord = e.target?.classList?.contains('teleprompter-word');
      if (isOverWord) {
        cursor.style.display = 'none';
        return;
      }

      // Find gap position
      let cursorTime = null;
      let cursorX = null;

      for (let i = 0; i < words.length; i++) {
        const wordRect = words[i].getBoundingClientRect();
        const wordStart = parseFloat(words[i].dataset.start);
        const wordEnd = parseFloat(words[i].dataset.end);

        // Before first word
        if (i === 0 && mouseX < wordRect.left) {
          cursorTime = wordStart;
          cursorX = wordRect.left - containerRect.left;
          break;
        }

        // In gap between words
        if (i < words.length - 1) {
          const nextRect = words[i + 1].getBoundingClientRect();
          const nextStart = parseFloat(words[i + 1].dataset.start);

          if (mouseX >= wordRect.right && mouseX <= nextRect.left) {
            const gapWidth = nextRect.left - wordRect.right;
            const gapProgress = gapWidth > 0 ? (mouseX - wordRect.right) / gapWidth : 0.5;
            cursorTime = wordEnd + (nextStart - wordEnd) * gapProgress;
            cursorX = mouseX - containerRect.left;
            break;
          }
        }

        // After last word
        if (i === words.length - 1 && mouseX > wordRect.right) {
          cursorTime = wordEnd;
          cursorX = wordRect.right - containerRect.left;
          break;
        }
      }

      if (cursorTime !== null && cursorX !== null) {
        cursor.style.display = 'flex';
        cursor.style.left = `${cursorX}px`;
        cursor.querySelector('.cursor-timecode').textContent = this.app.formatTime(cursorTime);
        cursor.dataset.time = cursorTime;

        // Update hint based on range marking state
        const hint = cursor.querySelector('.cursor-hint');
        const rangeStart = this.app.teleprompterMarkers?.rangeStart;
        if (rangeStart) {
          hint.textContent = 'Click for OUT';
          cursor.classList.add('range-end-mode');
        } else {
          hint.textContent = 'Click to mark';
          cursor.classList.remove('range-end-mode');
        }
      } else {
        cursor.style.display = 'none';
      }
    };

    // Cursor click handler
    cursor.onclick = (e) => {
      const time = parseFloat(cursor.dataset.time);
      if (isNaN(time)) return;
      
      e.stopPropagation();
      this.app.teleprompterMarkers?.handleCursorClick(e, time);
    };

    (content || wordsContainer).addEventListener('mousemove', this._mouseMove);

    container.addEventListener('mouseleave', () => {
      cursor.style.display = 'none';
    });
  }

  /**
   * Get words around a specific time
   */
  getWordsAroundTime(time, count = 3) {
    if (!this.words) return [];

    let closestIndex = 0;
    let closestDiff = Infinity;

    this.words.forEach((word, i) => {
      const diff = Math.abs(word.start - time);
      if (diff < closestDiff) {
        closestDiff = diff;
        closestIndex = i;
      }
    });

    const startIndex = Math.max(0, closestIndex - count);
    const endIndex = Math.min(this.words.length, closestIndex + count + 1);

    return this.words.slice(startIndex, endIndex);
  }

  /**
   * Get words in a time range
   */
  getWordsInRange(startTime, endTime) {
    if (!this.words) return [];
    return this.words.filter(word => word.start >= startTime && word.end <= endTime);
  }
}


















