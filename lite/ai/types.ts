/**
 * Lite AI service types.
 *
 * v1 surface: TTS (text-to-speech) + a single chat completion. Both
 * via OpenAI -- the only provider supported in v1. The shape is
 * deliberately profile-shaped so a future provider (Anthropic,
 * gemini, local) can plug in behind `provider`.
 *
 * Public types are re-exported from `api.ts`.
 */

/** Provider name. v1: openai only. */
export type AiProvider = 'openai';

/** OpenAI TTS voices. Surfaced in Settings -> AI Run Times. */
export const OPENAI_TTS_VOICES = [
  'alloy',
  'echo',
  'fable',
  'onyx',
  'nova',
  'shimmer',
] as const;
export type OpenAiTtsVoice = (typeof OPENAI_TTS_VOICES)[number];

/** TTS quality / speed tier. */
export type OpenAiTtsModel = 'tts-1' | 'tts-1-hd';

/** Audio format returned by the TTS endpoint. */
export type OpenAiTtsFormat = 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';

/** TTS request input. */
export interface TtsRequest {
  /** The text to speak. Capped at ~4096 chars per OpenAI; caller is responsible for chunking. */
  text: string;
  /** Voice. Default: `nova`. */
  voice?: OpenAiTtsVoice;
  /** Model. Default: `tts-1`. `tts-1-hd` is higher quality / slower. */
  model?: OpenAiTtsModel;
  /** Response audio format. Default: `mp3`. */
  format?: OpenAiTtsFormat;
  /** Speed multiplier 0.25..4.0. Default: 1.0. */
  speed?: number;
  /** Optional feature label for cost tracking + logs. */
  feature?: string;
}

/** TTS response. */
export interface TtsResponse {
  /** Raw audio bytes. */
  audio: Uint8Array;
  /** Audio MIME type, e.g. `audio/mpeg`. */
  mimeType: string;
  /** Echo of the requested format. */
  format: OpenAiTtsFormat;
  /** Echo of the voice used. */
  voice: OpenAiTtsVoice;
  /** Echo of the model used. */
  model: OpenAiTtsModel;
}

/** Chat message. */
export interface AiChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Chat completion request. */
export interface ChatRequest {
  messages: AiChatMessage[];
  /** Model. Default: `gpt-4o-mini`. */
  model?: string;
  /** Sampling temperature. Default: 0.7. */
  temperature?: number;
  /** Max output tokens. Default: 500. */
  maxTokens?: number;
  /** Optional feature label for cost tracking + logs. */
  feature?: string;
}

/** Chat completion response. */
export interface ChatResponse {
  /** The model's text reply. */
  content: string;
  /** Model echoed back. */
  model: string;
  /** Token usage from OpenAI. */
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/** Public status snapshot of the AI service. NEVER carries the API key. */
export interface AiStatus {
  provider: AiProvider;
  hasApiKey: boolean;
  defaultTtsVoice: OpenAiTtsVoice;
  defaultTtsModel: OpenAiTtsModel;
  defaultChatModel: string;
}

/** Configuration payload accepted by `configure()`. */
export interface AiConfig {
  apiKey?: string;
  defaultTtsVoice?: OpenAiTtsVoice;
  defaultTtsModel?: OpenAiTtsModel;
  defaultChatModel?: string;
}

/** Sentinel constant -- ensures the file has a value-level export. */
export const AI_MODULE_VERSION = 1 as const;
