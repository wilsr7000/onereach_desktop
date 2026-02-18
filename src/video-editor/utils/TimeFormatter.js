/**
 * TimeFormatter - Time formatting and parsing utilities
 * Provides consistent timecode formatting across the video editor
 */

/**
 * Format seconds as HH:MM:SS
 * @param {number} seconds - Time in seconds
 * @returns {string} Formatted time string
 */
export function formatTime(seconds) {
  if (!seconds || isNaN(seconds)) return '00:00:00';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Format seconds as HH:MM:SS:FF (with frame number)
 * @param {number} seconds - Time in seconds
 * @param {number} fps - Frames per second (default 30)
 * @returns {string} Formatted timecode with frames
 */
export function formatTimecodeWithFrames(seconds, fps = 30) {
  if (!seconds || isNaN(seconds)) return '00:00:00:00';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const frames = Math.floor((seconds % 1) * fps);
  return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}:${frames.toString().padStart(2, '0')}`;
}

/**
 * Format seconds as compact time (MM:SS or HH:MM:SS if over 1 hour)
 * @param {number} seconds - Time in seconds
 * @returns {string} Formatted time string
 */
export function formatTimeCompact(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00';

  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Format seconds as duration text (e.g., "2m 30s" or "1h 15m")
 * @param {number} seconds - Duration in seconds
 * @returns {string} Human-readable duration
 */
export function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return '0s';

  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hrs > 0) {
    return mins > 0 ? `${hrs}h ${mins}m` : `${hrs}h`;
  }
  if (mins > 0) {
    return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  }
  return `${secs}s`;
}

/**
 * Parse time string to seconds
 * Supports formats: HH:MM:SS, MM:SS, SS, or plain number
 * @param {string|number} timeStr - Time string or number
 * @returns {number} Time in seconds
 */
export function parseTime(timeStr) {
  if (typeof timeStr === 'number') return timeStr;
  if (!timeStr) return 0;

  const str = String(timeStr).trim();
  const parts = str.split(':').map(Number);

  if (parts.length === 3) {
    // HH:MM:SS
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    // MM:SS
    return parts[0] * 60 + parts[1];
  }

  // Plain number (seconds)
  return parseFloat(str) || 0;
}

/**
 * Format bytes as human-readable size
 * @param {number} bytes - Size in bytes
 * @returns {string} Formatted size string
 */
export function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';

  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const size = bytes / Math.pow(1024, i);

  return `${size.toFixed(i > 0 ? 1 : 0)} ${sizes[i]}`;
}

/**
 * Format bitrate as human-readable
 * @param {number} bps - Bits per second
 * @returns {string} Formatted bitrate
 */
export function formatBitrate(bps) {
  if (!bps || bps === 0) return '0 bps';

  if (bps >= 1000000) {
    return `${(bps / 1000000).toFixed(1)} Mbps`;
  } else if (bps >= 1000) {
    return `${(bps / 1000).toFixed(0)} Kbps`;
  }
  return `${bps} bps`;
}

/**
 * TimeFormatter class - wraps all functions for class-based usage
 */
export class TimeFormatter {
  formatTime(seconds) {
    return formatTime(seconds);
  }

  formatTimecodeWithFrames(seconds, fps = 30) {
    return formatTimecodeWithFrames(seconds, fps);
  }

  formatTimeCompact(seconds) {
    return formatTimeCompact(seconds);
  }

  formatDuration(seconds) {
    return formatDuration(seconds);
  }

  parseTime(timeStr) {
    return parseTime(timeStr);
  }

  formatBytes(bytes) {
    return formatBytes(bytes);
  }

  formatBitrate(bps) {
    return formatBitrate(bps);
  }
}
