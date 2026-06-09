/**
 * IPC channel names for the embedded WISER Playbooks `window.ai` bridge.
 *
 * Shared by the main-process handlers (`ai/main.ts`) and the dedicated
 * WISER preload (`preload-lite-wiser.ts`) so the two never drift. Kept in
 * its own electron-free file so both bundles (main + preload) can import it
 * without pulling in the rest of the ai module.
 *
 * All names follow the `lite:<module>:<verb>` convention (Rule 3).
 */
export const WISER_AI_CHANNELS = {
  /** invoke -> non-streaming chat completion. */
  CHAT: 'lite:ai:chat',
  /** invoke -> start a streaming completion; resolves with `{ requestId }`. */
  CHAT_STREAM: 'lite:ai:chat-stream',
  /**
   * main -> renderer push of stream chunks. Every payload carries the
   * `requestId` so the preload can route concurrent streams. Shape:
   * `{ requestId, delta?, done, finalResult?, error? }`.
   */
  CHAT_STREAM_CHUNK: 'lite:ai:chat-stream-chunk',
} as const;
