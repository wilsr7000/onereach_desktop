/**
 * QueueRenderer - Renders queue list UI
 * @module src/agentic-player/ui/QueueRenderer
 */

/**
 * Queue renderer class
 */
export class QueueRenderer {
  constructor(listElement, countElement) {
    this.listElement = listElement;
    this.countElement = countElement;
  }

  /**
   * Render queue and history
   * @param {Array} history - Played clips
   * @param {Array} queue - Upcoming clips
   * @param {Object} currentClip - Currently playing clip
   */
  render(history, queue, currentClip) {
    const total = history.length + queue.length;
    this.countElement.textContent = total;

    if (history.length === 0 && queue.length === 0) {
      this.listElement.innerHTML = '<div class="queue-empty">Waiting for clips...</div>';
      return;
    }

    let html = '';

    // History (played clips)
    history.forEach((clip, i) => {
      const isCurrent = i === history.length - 1 && currentClip;
      html += this.renderItem(clip, i + 1, isCurrent ? 'current' : 'played');
    });

    // Queue (upcoming clips)
    queue.forEach((clip, i) => {
      const num = history.length + i + 1;
      html += this.renderItem(clip, num, 'pending');
    });

    this.listElement.innerHTML = html;
  }

  /**
   * Render single queue item
   * @param {Object} clip - Clip data
   * @param {number} num - Item number
   * @param {string} state - Item state
   * @returns {string} HTML string
   */
  renderItem(clip, num, state) {
    const duration = (clip.outTime || 0) - (clip.inTime || 0);
    return `
      <div class="queue-item ${state}">
        <span class="queue-number">${num}</span>
        <div class="queue-item-info">
          <div class="queue-item-name">${clip.name || 'Clip'}</div>
          <div class="queue-item-duration">${this.formatTime(duration)}</div>
        </div>
      </div>
    `;
  }

  /**
   * Format time helper
   * @param {number} seconds - Seconds
   * @returns {string} Formatted time
   */
  formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }
}
