/**
 * Transcription Module
 *
 * Unified transcription service using ElevenLabs Scribe.
 * This is the ONLY transcription service that should be used in the app.
 *
 * Basic Usage:
 * ```javascript
 * import { getTranscriptionService } from './src/transcription';
 *
 * const transcription = getTranscriptionService();
 * const result = await transcription.transcribe('/path/to/audio.mp3', {
 *   diarize: true,  // Enable speaker identification
 *   language: 'en'  // Optional: auto-detects if not specified
 * });
 *
 * console.log(result.text);      // Full transcription
 * console.log(result.words);     // Word timestamps with speaker IDs
 * console.log(result.speakers);  // List of identified speakers (speaker_0, speaker_1, etc.)
 * ```
 *
 * Speaker Name Identification (uses LLM to identify who each speaker is):
 * ```javascript
 * // Option 1: Transcribe and identify in one call
 * const result = await transcription.transcribeWithSpeakerNames('/path/to/meeting.mp3', {
 *   context: 'Team standup meeting',
 *   expectedNames: ['Alice', 'Bob', 'Charlie']
 * });
 * console.log(result.speakerNames);      // { speaker_0: 'Alice', speaker_1: 'Bob' }
 * console.log(result.textWithSpeakers);  // "Alice: Good morning everyone..."
 *
 * // Option 2: Identify speakers from existing transcription
 * const identified = await transcription.identifySpeakers(result, {
 *   context: 'podcast interview'
 * });
 * console.log(identified.speakerMap);    // { speaker_0: 'Host', speaker_1: 'Guest' }
 * console.log(identified.roles);         // { speaker_0: 'interviewer', speaker_1: 'interviewee' }
 * ```
 *
 * @module src/transcription
 */

export { TranscriptionService, getTranscriptionService } from './TranscriptionService.js';

// Re-export as default for CommonJS compatibility
import { getTranscriptionService } from './TranscriptionService.js';
export default { getTranscriptionService };
