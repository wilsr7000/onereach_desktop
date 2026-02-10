/**
 * WaveformTypes - Different waveform visualization modes
 * Provides drawing functions for bars, line, mirror, and spectrogram
 */
const { getLogQueue } = require('../../../lib/log-event-queue');
const log = getLogQueue();
export class WaveformTypes {
  constructor(appContext) {
    this.app = appContext;
  }

  /**
   * Draw bars waveform (default mode)
   */
  drawBars(ctx, width, height, peaks, duration, method, alignInfo = {}) {
    ctx.clearRect(0, 0, width, height);
    
    const { rulerWidth = width, offsetX = 0 } = alignInfo;

    // High resolution bars
    const barWidth = 2;
    const gap = 1;
    const totalBarWidth = barWidth + gap;
    const numBars = Math.min(peaks.length, Math.floor(rulerWidth / totalBarWidth));
    const peaksPerBar = peaks.length / numBars;

    // Purple gradient
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, 'rgba(139, 92, 246, 0.9)');
    gradient.addColorStop(0.5, 'rgba(99, 102, 241, 0.85)');
    gradient.addColorStop(1, 'rgba(139, 92, 246, 0.9)');
    ctx.fillStyle = gradient;

    // Draw mirrored waveform bars with max-pooling
    for (let i = 0; i < numBars; i++) {
      const startPeak = Math.floor(i * peaksPerBar);
      const endPeak = Math.floor((i + 1) * peaksPerBar);
      let maxPeak = 0;
      for (let j = startPeak; j < endPeak && j < peaks.length; j++) {
        if (peaks[j] > maxPeak) maxPeak = peaks[j];
      }
      const barHeight = Math.max(1, maxPeak * height * 0.9);
      const x = (i * totalBarWidth) + offsetX;
      const y = (height - barHeight) / 2;

      if (x < 0 || x > width) continue;

      ctx.beginPath();
      ctx.roundRect(x, y, barWidth, barHeight, 1);
      ctx.fill();
    }
    
    // Center line
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();
  }

  /**
   * Draw line waveform - continuous line showing audio shape
   */
  drawLine(ctx, width, height, peaks, duration, method, alignInfo = {}) {
    ctx.clearRect(0, 0, width, height);
    
    const { rulerWidth = width, offsetX = 0 } = alignInfo;
    
    const centerY = height / 2;
    const amplitude = height * 0.4;
    
    // Background gradient
    const bgGrad = ctx.createLinearGradient(0, 0, 0, height);
    bgGrad.addColorStop(0, 'rgba(99, 102, 241, 0.1)');
    bgGrad.addColorStop(0.5, 'rgba(99, 102, 241, 0.05)');
    bgGrad.addColorStop(1, 'rgba(99, 102, 241, 0.1)');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, width, height);
    
    // Draw filled area
    ctx.beginPath();
    ctx.moveTo(offsetX, centerY);
    
    // Top line
    for (let i = 0; i < peaks.length; i++) {
      const x = (i / peaks.length) * rulerWidth + offsetX;
      const y = centerY - (peaks[i] * amplitude);
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    
    // Bottom line (mirror)
    for (let i = peaks.length - 1; i >= 0; i--) {
      const x = (i / peaks.length) * rulerWidth + offsetX;
      const y = centerY + (peaks[i] * amplitude);
      ctx.lineTo(x, y);
    }
    
    ctx.closePath();
    
    // Fill gradient
    const fillGrad = ctx.createLinearGradient(0, 0, 0, height);
    fillGrad.addColorStop(0, 'rgba(139, 92, 246, 0.6)');
    fillGrad.addColorStop(0.5, 'rgba(99, 102, 241, 0.8)');
    fillGrad.addColorStop(1, 'rgba(139, 92, 246, 0.6)');
    ctx.fillStyle = fillGrad;
    ctx.fill();
    
    // Center line detail
    ctx.strokeStyle = 'rgba(139, 92, 246, 0.9)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < peaks.length; i++) {
      const x = (i / peaks.length) * rulerWidth + offsetX;
      const y = centerY - (peaks[i] * amplitude * 0.5);
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
    
    // Center line
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, centerY);
    ctx.lineTo(width, centerY);
    ctx.stroke();
  }

  /**
   * Draw mirror waveform - Pro Tools style
   */
  drawMirror(ctx, width, height, peaks, duration, method, alignInfo = {}) {
    ctx.clearRect(0, 0, width, height);

    const { rulerWidth = width, offsetX = 0 } = alignInfo;

    const centerY = height / 2;
    const amplitude = height * 0.45;
    
    // Downsample peaks for display
    const displayPeaks = [];
    const displayWidth = Math.ceil(rulerWidth);
    const peaksPerPixel = peaks.length / displayWidth;
    for (let x = 0; x < displayWidth; x++) {
      const startPeak = Math.floor(x * peaksPerPixel);
      const endPeak = Math.floor((x + 1) * peaksPerPixel);
      let maxPeak = 0;
      for (let j = startPeak; j < endPeak && j < peaks.length; j++) {
        if (peaks[j] > maxPeak) maxPeak = peaks[j];
      }
      displayPeaks.push(maxPeak);
    }

    // Draw envelope
    ctx.beginPath();

    // Top envelope
    for (let i = 0; i < displayPeaks.length; i++) {
      const x = i + offsetX;
      const y = centerY - (displayPeaks[i] * amplitude);
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }

    ctx.lineTo(rulerWidth + offsetX, centerY);

    // Bottom envelope
    for (let i = displayPeaks.length - 1; i >= 0; i--) {
      const x = i + offsetX;
      const y = centerY + (displayPeaks[i] * amplitude);
      ctx.lineTo(x, y);
    }

    ctx.closePath();
    
    // Gradient fill
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, 'rgba(16, 185, 129, 0.7)');
    gradient.addColorStop(0.3, 'rgba(99, 102, 241, 0.8)');
    gradient.addColorStop(0.5, 'rgba(139, 92, 246, 0.9)');
    gradient.addColorStop(0.7, 'rgba(99, 102, 241, 0.8)');
    gradient.addColorStop(1, 'rgba(16, 185, 129, 0.7)');
    ctx.fillStyle = gradient;
    ctx.fill();
    
    // Glow effect
    ctx.shadowColor = 'rgba(139, 92, 246, 0.5)';
    ctx.shadowBlur = 10;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.shadowBlur = 0;
    
    // Center line
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, centerY);
    ctx.lineTo(width, centerY);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /**
   * Draw spectrogram - amplitude-based heat map
   */
  async drawSpectrogram(ctx, width, height, duration, audioBuffer, alignInfo = {}) {
    log.info('video', '[Spectrogram] Starting draw', { arg0: { width, arg1: height, arg2: duration, arg3: hasAudioBuffer: !!audioBuffer } });

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    
    const canvas = ctx.canvas;
    const actualWidth = canvas.width;
    const actualHeight = canvas.height;
    
    ctx.clearRect(0, 0, actualWidth, actualHeight);

    if (!audioBuffer) {
      ctx.restore();
      ctx.fillStyle = 'rgba(139, 92, 246, 0.2)';
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Loading audio...', width / 2, height / 2);
      return;
    }

    log.info('video', '[Spectrogram] Drawing at', { arg0: actualWidth, arg1: 'x', arg2: actualHeight });

    const channelData = audioBuffer.getChannelData(0);
    const totalSamples = channelData.length;

    // Color lookup table
    const colors = this._generateSpectrogramColors();

    // Create image data
    const imageData = ctx.createImageData(actualWidth, actualHeight);
    const data = imageData.data;

    // Dark background
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 15; data[i + 1] = 15; data[i + 2] = 35; data[i + 3] = 255;
    }

    // Sample stride for speed
    const stride = Math.max(1, Math.floor(totalSamples / (actualWidth * 64)));

    // Find max amplitude
    let globalMax = 0;
    for (let i = 0; i < totalSamples; i += stride * 10) {
      const amp = Math.abs(channelData[i]);
      if (amp > globalMax) globalMax = amp;
    }
    if (globalMax < 0.001) globalMax = 1;

    // Draw columns
    for (let x = 0; x < actualWidth; x++) {
      const sampleStart = Math.floor((x / actualWidth) * totalSamples);
      const sampleEnd = Math.floor(((x + 1) / actualWidth) * totalSamples);
      
      let peak = 0;
      let sum = 0;
      let count = 0;
      for (let i = sampleStart; i < sampleEnd; i += stride) {
        const amp = Math.abs(channelData[i] || 0);
        if (amp > peak) peak = amp;
        sum += amp;
        count++;
      }
      const avg = count > 0 ? sum / count : 0;
      
      const normPeak = peak / globalMax;
      const normAvg = avg / globalMax;
      
      const barHeight = Math.floor(normPeak * actualHeight * 0.9);
      
      for (let y = 0; y < barHeight; y++) {
        const screenY = actualHeight - 1 - y;
        const yRatio = y / barHeight;
        const intensity = (normAvg * 0.5 + yRatio * 0.5) * normPeak;
        const colorIdx = Math.min(255, Math.floor(intensity * 255));
        const color = colors[colorIdx];
        
        const idx = (screenY * actualWidth + x) * 4;
        data[idx] = color.r;
        data[idx + 1] = color.g;
        data[idx + 2] = color.b;
        data[idx + 3] = 255;
      }
    }

    ctx.putImageData(imageData, 0, 0);
    ctx.restore();
    
    log.info('video', '[Spectrogram] Done');
  }

  /**
   * Generate color palette for spectrogram
   */
  _generateSpectrogramColors() {
    const colors = new Array(256);
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      let r, g, b;
      if (t < 0.2) {
        r = 15; g = 15; b = Math.floor(40 + t * 5 * 120);
      } else if (t < 0.4) {
        r = Math.floor((t - 0.2) * 5 * 80); g = Math.floor((t - 0.2) * 5 * 150); b = 160;
      } else if (t < 0.6) {
        r = 80; g = 150 + Math.floor((t - 0.4) * 5 * 105); b = Math.floor(160 - (t - 0.4) * 5 * 160);
      } else if (t < 0.8) {
        r = 80 + Math.floor((t - 0.6) * 5 * 175); g = 255; b = 0;
      } else {
        r = 255; g = Math.floor(255 - (t - 0.8) * 5 * 100); b = Math.floor((t - 0.8) * 5 * 80);
      }
      colors[i] = { r, g, b };
    }
    return colors;
  }

  /**
   * Draw loading state with ghost waveform
   */
  drawLoading(ctx, width, height, message, pulsePhase = 0) {
    ctx.clearRect(0, 0, width, height);
    
    const barWidth = 2;
    const gap = 1;
    const totalBarWidth = barWidth + gap;
    const barCount = Math.floor(width / totalBarWidth);
    
    const pulseOpacity = 0.3 + 0.2 * Math.sin(pulsePhase);
    ctx.fillStyle = `rgba(139, 92, 246, ${pulseOpacity})`;
    
    for (let i = 0; i < barCount; i++) {
      const ghostHeight = Math.sin(i * 0.1 + pulsePhase) * 0.3 + 0.4;
      const barHeight = ghostHeight * height * 0.6;
      const x = i * totalBarWidth;
      const y = (height - barHeight) / 2;
      
      ctx.beginPath();
      ctx.roundRect(x, y, barWidth, barHeight, 1);
      ctx.fill();
    }
    
    // Loading text
    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(message, width / 2, height / 2);
  }

  /**
   * Draw error state
   */
  drawError(ctx, width, height, message) {
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = 'rgba(239, 68, 68, 0.3)';
    ctx.fillRect(0, height * 0.35, width, height * 0.3);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(message, width / 2, height / 2 + 4);
  }

  /**
   * Draw status indicator
   */
  drawStatus(ctx, width, height, method, wordCount) {
    let statusText = '';
    if (wordCount > 0) {
      statusText = `✓ ${wordCount} words`;
    } else {
      const methodLabels = {
        'webaudio': '✓ HD Audio',
        'video-element': '✓ Live',
        'cached': '✓ Cached',
        'ffmpeg': '✓ FFmpeg',
        'spectrogram': '✓ Spectrum'
      };
      statusText = methodLabels[method] || '';
    }
    
    if (statusText) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
      const textWidth = ctx.measureText(statusText).width;
      ctx.fillRect(width - textWidth - 16, 2, textWidth + 12, 16);
      
      ctx.fillStyle = 'rgba(16, 185, 129, 0.9)';
      ctx.font = 'bold 9px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(statusText, width - 8, 13);
    }
  }
}


















