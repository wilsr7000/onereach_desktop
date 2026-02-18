/**
 * PlaylistExporter - Export playlists and AI-assisted scene selection
 * @module src/video/export/PlaylistExporter
 */

import { ffmpeg } from '../core/VideoProcessor.js';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { app } = require('electron');
const ai = require('../../../lib/ai-service');
const { getLogQueue } = require('../../../lib/log-event-queue');
const log = getLogQueue();

/**
 * Service for exporting video playlists
 */
export class PlaylistExporter {
  constructor() {
    this.outputDir = path.join(app.getPath('userData'), 'video-exports');
  }

  /**
   * Export playlist - concatenate multiple segments into one video
   * @param {string} inputPath - Source video path
   * @param {Object} options - Export options with segments
   * @returns {Promise<Object>} Export result
   */
  async exportPlaylist(inputPath, options = {}) {
    const { segments, outputPath = null } = options;

    if (!segments || segments.length === 0) {
      throw new Error('No segments provided');
    }

    const baseName = path.basename(inputPath, path.extname(inputPath));
    const output = outputPath || path.join(this.outputDir, `${baseName}_playlist_${Date.now()}.mp4`);
    const jobId = `playlist_${Date.now()}`;

    // Create temp directory for segment files
    const tempDir = path.join(this.outputDir, `temp_playlist_${jobId}`);
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    try {
      log.info('video', '[PlaylistExporter] Exporting playlist with segments', { v0: segments.length });

      // Extract each segment
      const segmentFiles = [];
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const segmentPath = path.join(tempDir, `segment_${String(i).padStart(3, '0')}.mp4`);

        await new Promise((resolve, reject) => {
          ffmpeg(inputPath)
            .setStartTime(seg.startTime)
            .setDuration(seg.endTime - seg.startTime)
            .outputOptions(['-c:v', 'libx264', '-c:a', 'aac', '-avoid_negative_ts', 'make_zero', '-preset', 'fast'])
            .output(segmentPath)
            .on('end', () => {
              log.info('video', '[PlaylistExporter] Segment / extracted', { v0: i + 1, v1: segments.length });
              resolve();
            })
            .on('error', reject)
            .run();
        });

        segmentFiles.push(segmentPath);
      }

      // Create concat list file
      const listPath = path.join(tempDir, 'concat_list.txt');
      const listContent = segmentFiles.map((f) => `file '${f}'`).join('\n');
      fs.writeFileSync(listPath, listContent);

      // Concatenate all segments
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(listPath)
          .inputOptions(['-f', 'concat', '-safe', '0'])
          .outputOptions(['-c', 'copy'])
          .output(output)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });

      // Cleanup temp files
      this.cleanupTempDir(tempDir, segmentFiles, listPath);

      log.info('video', '[PlaylistExporter] Playlist exported to:', { v0: output });

      return {
        success: true,
        outputPath: output,
        segmentCount: segments.length,
      };
    } catch (error) {
      this.cleanupTempDir(tempDir, [], null);
      throw error;
    }
  }

  /**
   * Build playlist with AI - uses OpenAI to select and order scenes
   * @param {Object} options - Options with prompt and scenes
   * @returns {Promise<Object>} AI selection result
   */
  async buildPlaylistWithAI(options = {}) {
    const { prompt, scenes, keepOrder, includeAll } = options;

    if (!scenes || scenes.length === 0) {
      return { success: false, error: 'No scenes provided' };
    }

    // Get OpenAI API key from settings
    const settingsPath = path.join(app.getPath('userData'), 'settings.json');
    let openaiKey = null;

    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      openaiKey = settings.openaiApiKey;
    }

    if (!openaiKey) {
      return { success: false, error: 'OpenAI API key not configured. Please set it in Settings.' };
    }

    // Build the prompt for OpenAI
    const systemPrompt = `You are a video editor assistant that helps create playlists from video scenes.
You will receive a list of scenes with their metadata (name, description, transcription, tags, duration).
Based on the user's request, select which scenes to include and in what order.

Respond with a JSON object containing:
- "selectedSceneIds": array of scene IDs to include, in the order they should play
- "reasoning": brief explanation of your choices (1 sentence)

Rules:
${keepOrder ? '- Maintain chronological order of scenes' : '- You can reorder scenes for better flow'}
${includeAll ? '- Include ALL scenes in the playlist' : '- Only include scenes relevant to the request'}
- Be concise and relevant to the user's request`;

    const userPrompt = `User request: "${prompt}"

Available scenes:
${scenes
  .map(
    (s) => `
Scene ${s.index} (ID: ${s.id}):
- Name: ${s.name}
- Type: ${s.type}
- Duration: ${s.durationFormatted}
- Time: ${s.timeIn}${s.timeOut ? ` → ${s.timeOut}` : ''}
${s.description ? `- Description: ${s.description}` : ''}
${s.transcription ? `- Transcription: "${s.transcription.substring(0, 200)}${s.transcription.length > 200 ? '...' : ''}"` : ''}
${s.tags.length > 0 ? `- Tags: ${s.tags.join(', ')}` : ''}
${s.notes ? `- Notes: ${s.notes}` : ''}
`
  )
  .join('\n')}

Select the appropriate scenes and return JSON.`;

    try {
      const response = await ai.chat({
        profile: 'fast',
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        temperature: 0.7,
        jsonMode: true,
        feature: 'playlist-exporter',
      });

      // Parse the AI response
      const content = response.content;
      const result = JSON.parse(content);

      log.info('video', '[PlaylistExporter] AI playlist result', { data: result });

      // Validate the selected IDs
      const validIds = scenes.map((s) => s.id);
      const selectedIds = (result.selectedSceneIds || []).filter((id) => validIds.includes(id));

      if (selectedIds.length === 0) {
        return { success: false, error: 'AI did not select any valid scenes' };
      }

      return {
        success: true,
        selectedSceneIds: selectedIds,
        reasoning: result.reasoning || '',
      };
    } catch (error) {
      log.error('video', '[PlaylistExporter] AI playlist error', { error: error });
      return { success: false, error: error.message };
    }
  }

  // callOpenAI removed — now uses ai-service directly in buildAIPlaylist()

  /**
   * Clean up temporary directory
   * @private
   */
  cleanupTempDir(tempDir, segmentFiles, listPath) {
    try {
      segmentFiles.forEach((f) => {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      });
      if (listPath && fs.existsSync(listPath)) fs.unlinkSync(listPath);
      if (fs.existsSync(tempDir)) fs.rmdirSync(tempDir);
    } catch (e) {
      log.warn('video', '[PlaylistExporter] Cleanup error', { data: e });
    }
  }
}
