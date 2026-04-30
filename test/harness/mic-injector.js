/**
 * Mic Injector - publishes scripted transcript events to naturalness
 * scenarios. Stands in for voice-listener.js without any WebSocket or
 * OpenAI Realtime dependency.
 *
 * The real voice-listener emits two kinds of payloads:
 *   - interim partials  { text, final: false, confidence }
 *   - finalized turns   { text, final: true,  confidence }
 *
 * Scenario tests subscribe via onTranscript(callback) and then drive
 * the pipeline by calling say() / sayPartial() / sayWithPartials().
 *
 * The injector owns a simulated clock (ms since last reset) so that
 * end-of-turn timing and barge-in windows are deterministic. Tests
 * interleave advance(ms) between utterances to model pauses.
 *
 * Example:
 *   const mic = new MicInjector();
 *   mic.onTranscript((ev) => { ... });
 *   mic.sayPartial('set a');
 *   mic.advance(200);
 *   mic.say('set a timer for five minutes');
 */

'use strict';

class MicInjector {
  constructor() {
    /** @type {Set<Function>} */
    this._subscribers = new Set();
    /** @type {Array<object>} */
    this.events = [];
    this._clockMs = 0;
  }

  /**
   * Subscribe to transcript events. Returns an unsubscribe function.
   * @param {(event: {text:string, final:boolean, confidence:number, timestamp:number}) => void} callback
   * @returns {() => void}
   */
  onTranscript(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('onTranscript callback must be a function');
    }
    this._subscribers.add(callback);
    return () => this._subscribers.delete(callback);
  }

  /**
   * Remove a specific subscriber, if it was registered.
   * @param {Function} callback
   */
  offTranscript(callback) {
    this._subscribers.delete(callback);
  }

  /**
   * Emit a finalized transcript (end-of-turn).
   * @param {string} text
   * @param {object} [options]
   * @param {number} [options.confidence=1.0]
   */
  say(text, options = {}) {
    this._emit({
      text: String(text ?? ''),
      final: true,
      confidence: options.confidence ?? 1.0,
      timestamp: this._clockMs,
    });
  }

  /**
   * Emit a single interim partial (mid-utterance).
   * @param {string} text
   * @param {object} [options]
   * @param {number} [options.confidence=0.7]
   */
  sayPartial(text, options = {}) {
    this._emit({
      text: String(text ?? ''),
      final: false,
      confidence: options.confidence ?? 0.7,
      timestamp: this._clockMs,
    });
  }

  /**
   * Emit a sequence of interim partials followed by a final.
   * Optional `partialIntervalMs` inserts a clock advance between each
   * partial to simulate streaming speech.
   *
   * @param {string[]} partials - last element is treated as the final text
   * @param {object} [options]
   * @param {number} [options.partialIntervalMs=0] - ms to advance between partials
   * @param {number} [options.confidence=1.0]
   */
  sayWithPartials(partials, options = {}) {
    if (!Array.isArray(partials) || partials.length === 0) return;
    const interval = options.partialIntervalMs || 0;
    for (let i = 0; i < partials.length - 1; i++) {
      this.sayPartial(partials[i]);
      if (interval > 0) this.advance(interval);
    }
    this.say(partials[partials.length - 1], {
      confidence: options.confidence ?? 1.0,
    });
  }

  /**
   * Advance the simulated clock. Timestamps on subsequent events
   * reflect the updated clock.
   * @param {number} ms
   */
  advance(ms) {
    if (!Number.isFinite(ms) || ms < 0) return;
    this._clockMs += ms;
  }

  /**
   * @returns {number} simulated ms since reset
   */
  now() {
    return this._clockMs;
  }

  /**
   * Clear history, clock, and subscribers.
   */
  reset() {
    this.events = [];
    this._subscribers.clear();
    this._clockMs = 0;
  }

  _emit(event) {
    this.events.push(event);
    for (const cb of this._subscribers) {
      try {
        cb(event);
      } catch (err) {
        // Subscriber errors must not break the injector's own state.
        // Swallow but surface the error on the event for debugging.
        event.subscriberError = err.message;
      }
    }
  }
}

module.exports = { MicInjector };
