/**
 * ExportPresets.js
 * 
 * Template-specific export formats for the Line Script system.
 * Each content type (Podcast, Product, Promo, Learning) has specialized
 * export formats optimized for that content type.
 */

/**
 * Export format definitions per template
 */
export const EXPORT_FORMATS = {
  // ==================== PODCAST EXPORTS ====================
  podcast: {
    'show-notes': {
      id: 'show-notes',
      name: 'Show Notes',
      icon: '📝',
      extension: 'md',
      mimeType: 'text/markdown',
      description: 'Formatted show notes with timestamps, topics, and highlights'
    },
    'audiogram-timestamps': {
      id: 'audiogram-timestamps',
      name: 'Audiogram Timestamps',
      icon: '🎧',
      extension: 'json',
      mimeType: 'application/json',
      description: 'Timestamps for creating audiograms and social clips'
    },
    'transcript-with-speakers': {
      id: 'transcript-with-speakers',
      name: 'Speaker Transcript',
      icon: '👥',
      extension: 'txt',
      mimeType: 'text/plain',
      description: 'Full transcript with speaker identification'
    },
    'quote-cards': {
      id: 'quote-cards',
      name: 'Quote Cards Data',
      icon: '💬',
      extension: 'json',
      mimeType: 'application/json',
      description: 'Quotable moments formatted for social media cards'
    },
    'youtube-chapters': {
      id: 'youtube-chapters',
      name: 'YouTube Chapters',
      icon: '📺',
      extension: 'txt',
      mimeType: 'text/plain',
      description: 'Chapter timestamps for YouTube description'
    }
  },

  // ==================== PRODUCT EXPORTS ====================
  product: {
    'shot-list': {
      id: 'shot-list',
      name: 'Shot List',
      icon: '🎬',
      extension: 'csv',
      mimeType: 'text/csv',
      description: 'Detailed shot list with timecodes and descriptions'
    },
    'feature-matrix': {
      id: 'feature-matrix',
      name: 'Feature Matrix',
      icon: '📊',
      extension: 'csv',
      mimeType: 'text/csv',
      description: 'Product features with timestamps and demo notes'
    },
    'storyboard': {
      id: 'storyboard',
      name: 'Storyboard Export',
      icon: '🎨',
      extension: 'html',
      mimeType: 'text/html',
      description: 'Visual storyboard with thumbnails and descriptions'
    },
    'social-cuts': {
      id: 'social-cuts',
      name: 'Social Cuts List',
      icon: '📱',
      extension: 'json',
      mimeType: 'application/json',
      description: 'Suggested cuts for social media platforms'
    },
    'youtube-chapters': {
      id: 'youtube-chapters',
      name: 'YouTube Chapters',
      icon: '📺',
      extension: 'txt',
      mimeType: 'text/plain',
      description: 'Chapter timestamps for YouTube description'
    }
  },

  // ==================== PROMO EXPORTS ====================
  promo: {
    'edl': {
      id: 'edl',
      name: 'EDL (Edit Decision List)',
      icon: '🎞️',
      extension: 'edl',
      mimeType: 'text/plain',
      description: 'CMX 3600 format EDL for NLE import'
    },
    'storyboard': {
      id: 'storyboard',
      name: 'Storyboard Export',
      icon: '🎨',
      extension: 'html',
      mimeType: 'text/html',
      description: 'Visual storyboard with timing and beat notes'
    },
    'timing-sheet': {
      id: 'timing-sheet',
      name: 'Timing Sheet',
      icon: '⏱️',
      extension: 'csv',
      mimeType: 'text/csv',
      description: 'Precise timing for beats, transitions, and CTAs'
    },
    'social-versions': {
      id: 'social-versions',
      name: 'Social Versions Plan',
      icon: '📱',
      extension: 'json',
      mimeType: 'application/json',
      description: 'Edit points for 15s, 30s, 60s versions'
    },
    'hook-analysis': {
      id: 'hook-analysis',
      name: 'Hook Analysis',
      icon: '🎣',
      extension: 'md',
      mimeType: 'text/markdown',
      description: 'Analysis of hooks and opening recommendations'
    }
  },

  // ==================== LEARNING EXPORTS ====================
  learning: {
    'youtube-chapters': {
      id: 'youtube-chapters',
      name: 'YouTube Chapters',
      icon: '📺',
      extension: 'txt',
      mimeType: 'text/plain',
      description: 'Chapter timestamps for YouTube description'
    },
    'course-outline': {
      id: 'course-outline',
      name: 'Course Outline',
      icon: '📚',
      extension: 'md',
      mimeType: 'text/markdown',
      description: 'Structured outline with learning objectives'
    },
    'study-guide': {
      id: 'study-guide',
      name: 'Study Guide',
      icon: '📖',
      extension: 'md',
      mimeType: 'text/markdown',
      description: 'Key points, definitions, and review questions'
    },
    'flashcards': {
      id: 'flashcards',
      name: 'Flashcards (Anki)',
      icon: '🗂️',
      extension: 'csv',
      mimeType: 'text/csv',
      description: 'Flashcard data for Anki or Quizlet import'
    },
    'quiz-questions': {
      id: 'quiz-questions',
      name: 'Quiz Questions',
      icon: '❓',
      extension: 'json',
      mimeType: 'application/json',
      description: 'Generated quiz questions from key points'
    }
  }
};

/**
 * ExportPresets class handles generating exports in various formats
 */
export class ExportPresets {
  constructor(appContext) {
    this.app = appContext;
  }

  /**
   * Get available export formats for a template
   */
  getFormatsForTemplate(templateId) {
    return EXPORT_FORMATS[templateId] || EXPORT_FORMATS.podcast;
  }

  /**
   * Generate export content for a specific format
   */
  async generateExport(formatId, templateId, data) {
    const generator = this.getGenerator(formatId);
    if (!generator) {
      throw new Error(`Unknown export format: ${formatId}`);
    }
    return generator.call(this, data, templateId);
  }

  /**
   * Get the generator function for a format
   */
  getGenerator(formatId) {
    const generators = {
      // Podcast formats
      'show-notes': this.generateShowNotes,
      'audiogram-timestamps': this.generateAudiogramTimestamps,
      'transcript-with-speakers': this.generateSpeakerTranscript,
      'quote-cards': this.generateQuoteCards,
      
      // Product formats
      'shot-list': this.generateShotList,
      'feature-matrix': this.generateFeatureMatrix,
      'storyboard': this.generateStoryboard,
      'social-cuts': this.generateSocialCuts,
      
      // Promo formats
      'edl': this.generateEDL,
      'timing-sheet': this.generateTimingSheet,
      'social-versions': this.generateSocialVersions,
      'hook-analysis': this.generateHookAnalysis,
      
      // Learning formats
      'youtube-chapters': this.generateYouTubeChapters,
      'course-outline': this.generateCourseOutline,
      'study-guide': this.generateStudyGuide,
      'flashcards': this.generateFlashcards,
      'quiz-questions': this.generateQuizQuestions
    };
    
    return generators[formatId];
  }

  // ==================== PODCAST GENERATORS ====================

  /**
   * Generate show notes in Markdown format
   */
  generateShowNotes(data) {
    const { title, markers, topics, quotes, duration } = data;
    
    let output = `# ${title || 'Episode Show Notes'}\n\n`;
    output += `Duration: ${this.formatDuration(duration)}\n\n`;
    
    // Topics/Chapters
    if (topics?.length) {
      output += `## Topics Discussed\n\n`;
      topics.forEach((topic, i) => {
        output += `### ${this.formatTimecode(topic.startTime)} - ${topic.title}\n`;
        if (topic.summary) {
          output += `${topic.summary}\n`;
        }
        output += '\n';
      });
    }
    
    // Key Quotes
    if (quotes?.length) {
      output += `## Notable Quotes\n\n`;
      quotes.slice(0, 5).forEach(quote => {
        output += `> "${quote.text}"\n`;
        output += `> — ${quote.speaker || 'Speaker'} (${this.formatTimecode(quote.startTime)})\n\n`;
      });
    }
    
    // Timestamps
    if (markers?.length) {
      output += `## Timestamps\n\n`;
      markers
        .filter(m => m.markerType === 'topic' || m.markerType === 'chapter')
        .forEach(marker => {
          output += `- ${this.formatTimecode(marker.time)} ${marker.name}\n`;
        });
    }
    
    return output;
  }

  /**
   * Generate timestamps for audiogram creation
   */
  generateAudiogramTimestamps(data) {
    const { markers, quotes } = data;
    
    const audiogramClips = [];
    
    // From quote markers
    if (quotes?.length) {
      quotes.forEach((quote, i) => {
        audiogramClips.push({
          id: `quote-${i}`,
          type: 'quote',
          text: quote.text,
          speaker: quote.speaker,
          startTime: quote.startTime,
          endTime: quote.endTime,
          duration: quote.endTime - quote.startTime,
          score: quote.score,
          suggestedCaption: quote.text.length <= 280 ? quote.text : quote.text.slice(0, 277) + '...'
        });
      });
    }
    
    // From clip markers
    if (markers?.length) {
      markers
        .filter(m => m.markerType === 'clip' || m.markerType === 'highlight')
        .forEach((marker, i) => {
          audiogramClips.push({
            id: `clip-${i}`,
            type: 'clip',
            name: marker.name,
            startTime: marker.time,
            endTime: marker.endTime || marker.time + 30,
            duration: (marker.endTime || marker.time + 30) - marker.time,
            notes: marker.description
          });
        });
    }
    
    return JSON.stringify({
      version: '1.0',
      clips: audiogramClips.sort((a, b) => (b.score || 0) - (a.score || 0))
    }, null, 2);
  }

  /**
   * Generate transcript with speaker identification
   */
  generateSpeakerTranscript(data) {
    const { segments, speakers } = data;
    
    if (!segments?.length) {
      return 'No transcript available.';
    }
    
    let output = '';
    let currentSpeaker = null;
    
    segments.forEach(segment => {
      const speaker = segment.speaker || 'Speaker';
      
      if (speaker !== currentSpeaker) {
        if (currentSpeaker !== null) output += '\n\n';
        output += `[${this.formatTimecode(segment.start)}] ${speaker}:\n`;
        currentSpeaker = speaker;
      }
      
      output += segment.text + ' ';
    });
    
    return output.trim();
  }

  /**
   * Generate quote card data for social media
   */
  generateQuoteCards(data) {
    const { quotes, title, speakers } = data;
    
    if (!quotes?.length) {
      return JSON.stringify({ cards: [] }, null, 2);
    }
    
    const cards = quotes.map((quote, i) => ({
      id: `card-${i}`,
      quote: quote.text,
      speaker: quote.speaker,
      timestamp: this.formatTimecode(quote.startTime),
      showTitle: title,
      
      // Social media optimized versions
      twitter: quote.text.length <= 280 ? quote.text : null,
      instagram: quote.text,
      linkedin: `"${quote.text}" — ${quote.speaker}`,
      
      // Suggested hashtags based on content
      suggestedHashtags: this.extractHashtags(quote.text),
      
      // Visual suggestions
      visualStyle: quote.score >= 8 ? 'bold' : 'standard',
      backgroundColor: this.suggestQuoteColor(quote)
    }));
    
    return JSON.stringify({
      version: '1.0',
      showTitle: title,
      totalCards: cards.length,
      cards
    }, null, 2);
  }

  // ==================== PRODUCT GENERATORS ====================

  /**
   * Generate shot list in CSV format
   */
  generateShotList(data) {
    const { markers, duration, title } = data;
    
    let csv = 'Shot #,Timecode In,Timecode Out,Duration,Type,Description,Notes\n';
    
    let shotNum = 1;
    markers
      .sort((a, b) => a.time - b.time)
      .forEach(marker => {
        const tcIn = this.formatTimecode(marker.time);
        const tcOut = this.formatTimecode(marker.endTime || marker.time + 5);
        const dur = this.formatDuration((marker.endTime || marker.time + 5) - marker.time);
        const type = marker.markerType || 'shot';
        const desc = (marker.name || '').replace(/,/g, ';');
        const notes = (marker.description || '').replace(/,/g, ';').replace(/\n/g, ' ');
        
        csv += `${shotNum},${tcIn},${tcOut},${dur},${type},${desc},${notes}\n`;
        shotNum++;
      });
    
    return csv;
  }

  /**
   * Generate feature matrix for product videos
   */
  generateFeatureMatrix(data) {
    const { markers, title } = data;
    
    let csv = 'Feature,Timestamp,Demo Duration,Demo Type,Key Benefit,CTA\n';
    
    markers
      .filter(m => m.markerType === 'feature' || m.markerType === 'demo')
      .forEach(marker => {
        const feature = (marker.name || '').replace(/,/g, ';');
        const timestamp = this.formatTimecode(marker.time);
        const duration = this.formatDuration((marker.endTime || marker.time + 10) - marker.time);
        const demoType = marker.markerType || 'feature';
        const benefit = (marker.lineScript?.visualDescription || '').replace(/,/g, ';');
        const cta = marker.tags?.includes('cta') ? 'Yes' : 'No';
        
        csv += `${feature},${timestamp},${duration},${demoType},${benefit},${cta}\n`;
      });
    
    return csv;
  }

  /**
   * Generate visual storyboard in HTML format
   */
  generateStoryboard(data) {
    const { markers, title, duration } = data;
    
    let html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Storyboard - ${title || 'Video'}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #1a1a1a; color: #d4d4d4; padding: 20px; }
    h1 { color: #fff; border-bottom: 2px solid #e84c3d; padding-bottom: 10px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 20px; }
    .card { background: #2a2a2a; border-radius: 8px; overflow: hidden; border-left: 4px solid var(--accent, #4a9eff); }
    .card-header { padding: 12px; background: #333; display: flex; justify-content: space-between; }
    .card-time { font-family: monospace; color: #4a9eff; }
    .card-type { font-size: 11px; background: #444; padding: 2px 8px; border-radius: 4px; }
    .card-thumbnail { width: 100%; height: 160px; background: #1a1a1a; display: flex; align-items: center; justify-content: center; color: #666; }
    .card-thumbnail img { width: 100%; height: 100%; object-fit: cover; }
    .card-content { padding: 12px; }
    .card-title { font-weight: 600; margin-bottom: 8px; }
    .card-desc { font-size: 12px; color: #909090; line-height: 1.5; }
    .card-notes { font-size: 11px; color: #666; margin-top: 8px; font-style: italic; }
  </style>
</head>
<body>
  <h1>📽️ ${title || 'Video'} - Storyboard</h1>
  <p>Duration: ${this.formatDuration(duration)} | Scenes: ${markers.length}</p>
  <div class="grid">
`;
    
    markers.forEach((marker, i) => {
      const color = marker.color || '#4a9eff';
      const thumbnail = marker.lineScript?.snapshotBase64 
        ? `<img src="data:image/jpeg;base64,${marker.lineScript.snapshotBase64}" alt="Frame">`
        : `🎬 Scene ${i + 1}`;
      
      html += `
    <div class="card" style="--accent: ${color}">
      <div class="card-header">
        <span class="card-time">${this.formatTimecode(marker.time)}</span>
        <span class="card-type">${marker.markerType || 'scene'}</span>
      </div>
      <div class="card-thumbnail">${thumbnail}</div>
      <div class="card-content">
        <div class="card-title">${marker.name || `Scene ${i + 1}`}</div>
        <div class="card-desc">${marker.lineScript?.visualDescription || marker.description || ''}</div>
        ${marker.lineScript?.actionNotes ? `<div class="card-notes">📝 ${marker.lineScript.actionNotes}</div>` : ''}
      </div>
    </div>
`;
    });
    
    html += `
  </div>
</body>
</html>`;
    
    return html;
  }

  /**
   * Generate social media cut suggestions
   */
  generateSocialCuts(data) {
    const { markers, hooks, duration } = data;
    
    const platforms = {
      tiktok: { maxDuration: 60, idealDuration: 30, aspectRatio: '9:16' },
      instagram_reels: { maxDuration: 90, idealDuration: 30, aspectRatio: '9:16' },
      youtube_shorts: { maxDuration: 60, idealDuration: 45, aspectRatio: '9:16' },
      twitter: { maxDuration: 140, idealDuration: 45, aspectRatio: '16:9' },
      linkedin: { maxDuration: 600, idealDuration: 90, aspectRatio: '16:9' }
    };
    
    const cuts = [];
    
    // Generate cuts from hooks and highlight markers
    const highlights = markers.filter(m => 
      m.markerType === 'hook' || m.markerType === 'highlight' || m.markerType === 'cta'
    );
    
    highlights.forEach((marker, i) => {
      const duration = (marker.endTime || marker.time + 30) - marker.time;
      
      Object.entries(platforms).forEach(([platform, specs]) => {
        if (duration <= specs.maxDuration) {
          cuts.push({
            id: `${platform}-${i}`,
            platform,
            startTime: marker.time,
            endTime: marker.endTime || marker.time + Math.min(duration, specs.idealDuration),
            duration: Math.min(duration, specs.idealDuration),
            sourceMarker: marker.name,
            aspectRatio: specs.aspectRatio,
            suggestedCaption: marker.description || marker.name
          });
        }
      });
    });
    
    return JSON.stringify({
      version: '1.0',
      sourceDuration: duration,
      platforms,
      suggestedCuts: cuts
    }, null, 2);
  }

  // ==================== PROMO GENERATORS ====================

  /**
   * Generate EDL (Edit Decision List) in CMX 3600 format
   */
  generateEDL(data) {
    const { title, markers, duration } = data;
    
    let edl = `TITLE: ${title || 'Video'}\n`;
    edl += `FCM: NON-DROP FRAME\n\n`;
    
    let editNum = 1;
    markers
      .sort((a, b) => a.time - b.time)
      .forEach(marker => {
        const srcIn = this.formatTimecodeEDL(marker.time);
        const srcOut = this.formatTimecodeEDL(marker.endTime || marker.time + 5);
        const recIn = this.formatTimecodeEDL(marker.time);
        const recOut = this.formatTimecodeEDL(marker.endTime || marker.time + 5);
        
        // EDL format: edit# reel channel transition srcIn srcOut recIn recOut
        edl += `${String(editNum).padStart(3, '0')}  AX       V     C        ${srcIn} ${srcOut} ${recIn} ${recOut}\n`;
        
        if (marker.name) {
          edl += `* FROM CLIP NAME: ${marker.name}\n`;
        }
        if (marker.description) {
          edl += `* COMMENT: ${marker.description}\n`;
        }
        edl += '\n';
        editNum++;
      });
    
    return edl;
  }

  /**
   * Generate timing sheet for commercial production
   */
  generateTimingSheet(data) {
    const { markers, duration, title } = data;
    
    let csv = 'Beat #,Timecode,Duration,Beat Type,Element,Audio Cue,Visual Cue,Notes\n';
    
    let beatNum = 1;
    markers
      .sort((a, b) => a.time - b.time)
      .forEach(marker => {
        const tc = this.formatTimecode(marker.time);
        const dur = ((marker.endTime || marker.time + 2) - marker.time).toFixed(2) + 's';
        const type = marker.markerType || 'beat';
        const element = (marker.name || '').replace(/,/g, ';');
        const audio = (marker.lineScript?.mood || '').replace(/,/g, ';');
        const visual = (marker.lineScript?.visualDescription || '').replace(/,/g, ';');
        const notes = (marker.description || '').replace(/,/g, ';').replace(/\n/g, ' ');
        
        csv += `${beatNum},${tc},${dur},${type},${element},${audio},${visual},${notes}\n`;
        beatNum++;
      });
    
    return csv;
  }

  /**
   * Generate social media version plans
   */
  generateSocialVersions(data) {
    const { markers, hooks, duration } = data;
    
    // Define version lengths
    const versions = [
      { id: '6s', duration: 6, name: '6-Second Bumper', platforms: ['instagram-story', 'youtube-bumper'] },
      { id: '15s', duration: 15, name: '15-Second Spot', platforms: ['tiktok', 'instagram-reels'] },
      { id: '30s', duration: 30, name: '30-Second Spot', platforms: ['tv', 'youtube', 'facebook'] },
      { id: '60s', duration: 60, name: '60-Second Long Form', platforms: ['youtube', 'linkedin'] }
    ];
    
    // Find best segments for each version
    const versionPlans = versions.map(version => {
      const segments = this.findBestSegmentsForDuration(markers, hooks, version.duration);
      
      return {
        ...version,
        segments,
        editPoints: segments.map(s => ({
          inPoint: this.formatTimecode(s.startTime),
          outPoint: this.formatTimecode(s.endTime),
          type: s.type,
          reason: s.reason
        })),
        estimatedDuration: segments.reduce((sum, s) => sum + (s.endTime - s.startTime), 0)
      };
    });
    
    return JSON.stringify({
      version: '1.0',
      sourceDuration: duration,
      versions: versionPlans
    }, null, 2);
  }

  /**
   * Generate hook analysis report
   */
  generateHookAnalysis(data) {
    const { hooks, title, duration } = data;
    
    let md = `# Hook Analysis: ${title || 'Video'}\n\n`;
    md += `Source Duration: ${this.formatDuration(duration)}\n\n`;
    
    if (!hooks?.length) {
      md += `*No hooks analyzed. Run hook detection first.*\n`;
      return md;
    }
    
    // Current opening analysis
    md += `## Current Opening\n\n`;
    const currentOpening = hooks.find(h => h.startTime < 10);
    if (currentOpening) {
      md += `- **Score**: ${currentOpening.score}/10\n`;
      md += `- **Text**: "${currentOpening.transcript}"\n`;
      md += `- **Classification**: ${currentOpening.classification || 'standard'}\n\n`;
    } else {
      md += `*Opening not analyzed*\n\n`;
    }
    
    // Best hooks found
    md += `## Top Hooks Found\n\n`;
    hooks
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .forEach((hook, i) => {
        md += `### ${i + 1}. Score: ${hook.score}/10 (${this.formatTimecode(hook.startTime)})\n\n`;
        md += `> "${hook.transcript}"\n\n`;
        if (hook.breakdown) {
          md += `**Factors:**\n`;
          Object.entries(hook.breakdown).forEach(([key, value]) => {
            md += `- ${key}: ${value}/10\n`;
          });
        }
        md += `**Suggested Use**: ${hook.suggestedUse || 'general'}\n\n`;
      });
    
    // Recommendations
    md += `## Recommendations\n\n`;
    const bestHook = hooks.sort((a, b) => b.score - a.score)[0];
    if (bestHook && (!currentOpening || bestHook.score > currentOpening.score + 1)) {
      md += `⭐ **Consider using the hook at ${this.formatTimecode(bestHook.startTime)} as your opening.**\n`;
      md += `This would improve your opening score from ${currentOpening?.score || 'N/A'} to ${bestHook.score}.\n\n`;
    }
    
    return md;
  }

  // ==================== LEARNING GENERATORS ====================

  /**
   * Generate YouTube chapter timestamps
   */
  generateYouTubeChapters(data) {
    const { markers, topics } = data;
    
    let output = '';
    
    // Use topics if available, otherwise use chapter markers
    const chapters = topics?.length 
      ? topics
      : markers.filter(m => m.markerType === 'chapter' || m.markerType === 'topic');
    
    if (!chapters.length) {
      // Auto-generate from any available markers
      markers
        .filter(m => m.name)
        .sort((a, b) => a.time - b.time)
        .forEach(marker => {
          const tc = this.formatYouTubeTimestamp(marker.time);
          output += `${tc} ${marker.name}\n`;
        });
    } else {
      chapters.forEach(chapter => {
        const tc = this.formatYouTubeTimestamp(chapter.startTime || chapter.time);
        const title = chapter.title || chapter.name;
        output += `${tc} ${title}\n`;
      });
    }
    
    return output || '0:00 Introduction\n';
  }

  /**
   * Generate course outline in Markdown
   */
  generateCourseOutline(data) {
    const { markers, topics, title, duration } = data;
    
    let md = `# Course Outline: ${title || 'Course'}\n\n`;
    md += `Total Duration: ${this.formatDuration(duration)}\n\n`;
    
    // Learning Objectives
    const keyPoints = markers.filter(m => m.markerType === 'keypoint');
    if (keyPoints.length) {
      md += `## Learning Objectives\n\n`;
      md += `By the end of this course, you will be able to:\n\n`;
      keyPoints.slice(0, 5).forEach((kp, i) => {
        md += `${i + 1}. ${kp.name}\n`;
      });
      md += '\n';
    }
    
    // Course Structure
    md += `## Course Structure\n\n`;
    
    const chapters = topics?.length 
      ? topics 
      : markers.filter(m => m.markerType === 'chapter');
    
    chapters.forEach((chapter, i) => {
      const startTime = chapter.startTime || chapter.time;
      const endTime = chapter.endTime || chapters[i + 1]?.startTime || duration;
      const dur = this.formatDuration(endTime - startTime);
      
      md += `### Module ${i + 1}: ${chapter.title || chapter.name}\n`;
      md += `Duration: ${dur} | Start: ${this.formatTimecode(startTime)}\n\n`;
      
      if (chapter.summary) {
        md += `${chapter.summary}\n\n`;
      }
      
      // Key points within this chapter
      const chapterKeyPoints = keyPoints.filter(kp => 
        kp.time >= startTime && kp.time < endTime
      );
      if (chapterKeyPoints.length) {
        md += `**Key Points:**\n`;
        chapterKeyPoints.forEach(kp => {
          md += `- ${kp.name}\n`;
        });
        md += '\n';
      }
    });
    
    return md;
  }

  /**
   * Generate study guide with key points and questions
   */
  generateStudyGuide(data) {
    const { markers, topics, title } = data;
    
    let md = `# Study Guide: ${title || 'Course'}\n\n`;
    
    // Key Concepts
    const concepts = markers.filter(m => m.markerType === 'concept' || m.markerType === 'keypoint');
    if (concepts.length) {
      md += `## Key Concepts\n\n`;
      concepts.forEach(concept => {
        md += `### ${concept.name}\n`;
        md += `*Timestamp: ${this.formatTimecode(concept.time)}*\n\n`;
        if (concept.description) {
          md += `${concept.description}\n\n`;
        }
      });
    }
    
    // Examples
    const examples = markers.filter(m => m.markerType === 'example');
    if (examples.length) {
      md += `## Examples & Demonstrations\n\n`;
      examples.forEach(example => {
        md += `- **${example.name}** (${this.formatTimecode(example.time)})\n`;
        if (example.description) {
          md += `  ${example.description}\n`;
        }
      });
      md += '\n';
    }
    
    // Review Questions
    const quizPoints = markers.filter(m => m.markerType === 'quiz');
    if (quizPoints.length) {
      md += `## Review Questions\n\n`;
      quizPoints.forEach((quiz, i) => {
        md += `${i + 1}. ${quiz.name || `Question about content at ${this.formatTimecode(quiz.time)}`}\n`;
      });
      md += '\n';
    }
    
    // Summary
    md += `## Summary\n\n`;
    md += `This ${topics?.length ? `${topics.length}-topic` : ''} course covers:\n\n`;
    
    (topics || markers.filter(m => m.markerType === 'chapter')).forEach(topic => {
      md += `- ${topic.title || topic.name}\n`;
    });
    
    return md;
  }

  /**
   * Generate flashcards in CSV format (Anki compatible)
   */
  generateFlashcards(data) {
    const { markers, title } = data;
    
    let csv = 'Front,Back,Tags\n';
    
    // From key points
    markers
      .filter(m => m.markerType === 'keypoint' || m.markerType === 'concept')
      .forEach(marker => {
        const front = `What is ${marker.name.toLowerCase()}?`.replace(/,/g, ';');
        const back = (marker.description || marker.lineScript?.visualDescription || marker.name).replace(/,/g, ';').replace(/\n/g, ' ');
        const tags = [title || 'course', marker.markerType].join(' ');
        
        csv += `"${front}","${back}","${tags}"\n`;
      });
    
    // From quiz points
    markers
      .filter(m => m.markerType === 'quiz')
      .forEach(marker => {
        const front = (marker.name || 'Review this concept').replace(/,/g, ';');
        const back = (marker.description || `See video at ${this.formatTimecode(marker.time)}`).replace(/,/g, ';');
        const tags = [title || 'course', 'quiz'].join(' ');
        
        csv += `"${front}","${back}","${tags}"\n`;
      });
    
    return csv;
  }

  /**
   * Generate quiz questions in JSON format
   */
  generateQuizQuestions(data) {
    const { markers, topics, title } = data;
    
    const questions = [];
    
    // From quiz markers
    markers
      .filter(m => m.markerType === 'quiz')
      .forEach((marker, i) => {
        questions.push({
          id: `q-${i}`,
          type: 'open',
          question: marker.name || `Explain the concept discussed at ${this.formatTimecode(marker.time)}`,
          timestamp: marker.time,
          topic: this.findTopicForTime(marker.time, topics),
          hints: marker.description ? [marker.description] : []
        });
      });
    
    // From key points (multiple choice style)
    markers
      .filter(m => m.markerType === 'keypoint')
      .slice(0, 10)
      .forEach((marker, i) => {
        questions.push({
          id: `kp-${i}`,
          type: 'review',
          question: `What is the key takeaway about "${marker.name}"?`,
          timestamp: marker.time,
          topic: this.findTopicForTime(marker.time, topics),
          expectedAnswer: marker.description || marker.lineScript?.visualDescription
        });
      });
    
    return JSON.stringify({
      version: '1.0',
      courseTitle: title,
      totalQuestions: questions.length,
      questions
    }, null, 2);
  }

  // ==================== HELPER METHODS ====================

  /**
   * Format seconds to HH:MM:SS
   */
  formatTimecode(seconds) {
    if (!seconds || isNaN(seconds)) return '00:00:00';
    
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    
    return [
      h.toString().padStart(2, '0'),
      m.toString().padStart(2, '0'),
      s.toString().padStart(2, '0')
    ].join(':');
  }

  /**
   * Format seconds to EDL timecode (HH:MM:SS:FF)
   */
  formatTimecodeEDL(seconds, fps = 30) {
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
   * Format for YouTube timestamp (M:SS or H:MM:SS)
   */
  formatYouTubeTimestamp(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    
    if (h > 0) {
      return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  /**
   * Format duration to human-readable
   */
  formatDuration(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    
    if (m >= 60) {
      const h = Math.floor(m / 60);
      const mins = m % 60;
      return `${h}h ${mins}m`;
    }
    
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  /**
   * Extract hashtags from text content
   */
  extractHashtags(text) {
    // Simple keyword extraction for hashtags
    const commonWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below', 'between', 'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just', 'and', 'but', 'or', 'if', 'because', 'until', 'while', 'about', 'that', 'this', 'these', 'those', 'what', 'which', 'who', 'whom', 'it', 'its', 'they', 'them', 'their', 'we', 'us', 'our', 'you', 'your', 'i', 'me', 'my', 'he', 'him', 'his', 'she', 'her']);
    
    const words = text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 3 && !commonWords.has(w));
    
    // Get unique words and format as hashtags
    const unique = [...new Set(words)].slice(0, 5);
    return unique.map(w => `#${w}`);
  }

  /**
   * Suggest a color for quote card based on content
   */
  suggestQuoteColor(quote) {
    const text = quote.text.toLowerCase();
    
    if (text.includes('love') || text.includes('heart') || text.includes('passion')) {
      return '#e84c3d';
    }
    if (text.includes('success') || text.includes('win') || text.includes('achieve')) {
      return '#22c55e';
    }
    if (text.includes('learn') || text.includes('know') || text.includes('understand')) {
      return '#3b82f6';
    }
    if (text.includes('money') || text.includes('business') || text.includes('work')) {
      return '#f59e0b';
    }
    
    return '#8b5cf6'; // Default purple
  }

  /**
   * Find best segments for a target duration
   */
  findBestSegmentsForDuration(markers, hooks, targetDuration) {
    const segments = [];
    let totalDuration = 0;
    
    // Prioritize hooks
    const sortedHooks = (hooks || []).sort((a, b) => (b.score || 0) - (a.score || 0));
    
    for (const hook of sortedHooks) {
      const segDuration = (hook.endTime || hook.startTime + 5) - hook.startTime;
      if (totalDuration + segDuration <= targetDuration) {
        segments.push({
          startTime: hook.startTime,
          endTime: hook.endTime || hook.startTime + 5,
          type: 'hook',
          reason: `Hook score: ${hook.score}`
        });
        totalDuration += segDuration;
      }
      if (totalDuration >= targetDuration * 0.9) break;
    }
    
    // Fill with important markers
    const importantMarkers = markers
      .filter(m => m.markerType === 'cta' || m.markerType === 'highlight')
      .sort((a, b) => a.time - b.time);
    
    for (const marker of importantMarkers) {
      const segDuration = (marker.endTime || marker.time + 3) - marker.time;
      if (totalDuration + segDuration <= targetDuration) {
        segments.push({
          startTime: marker.time,
          endTime: marker.endTime || marker.time + 3,
          type: marker.markerType,
          reason: marker.name
        });
        totalDuration += segDuration;
      }
      if (totalDuration >= targetDuration) break;
    }
    
    return segments.sort((a, b) => a.startTime - b.startTime);
  }

  /**
   * Find which topic a timestamp belongs to
   */
  findTopicForTime(time, topics) {
    if (!topics?.length) return null;
    
    for (const topic of topics) {
      if (time >= topic.startTime && time < (topic.endTime || Infinity)) {
        return topic.title || topic.name;
      }
    }
    return null;
  }

  /**
   * Download export file
   */
  downloadExport(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /**
   * Copy export content to clipboard
   */
  async copyToClipboard(content) {
    try {
      await navigator.clipboard.writeText(content);
      return true;
    } catch (error) {
      console.error('[ExportPresets] Copy failed:', error);
      return false;
    }
  }
}

export default ExportPresets;










