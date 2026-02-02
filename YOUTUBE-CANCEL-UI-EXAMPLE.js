// Example: Add Cancel Button to YouTube Downloads in Clipboard Viewer
// Add this to clipboard-viewer.js

// In the renderHistory() function, when rendering a downloading YouTube item:

function renderYouTubeDownloadItem(item) {
  const isDownloading = item.metadata?.downloadStatus === 'downloading';
  const progress = item.metadata?.downloadProgress || 0;
  
  return `
    <div class="history-item" data-id="${item.id}">
      <div class="item-content">
        <div class="item-icon">🎬</div>
        <div class="item-details">
          <div class="item-preview">${escapeHtml(item.preview)}</div>
          ${isDownloading ? `
            <div class="download-progress">
              <div class="progress-bar">
                <div class="progress-fill" style="width: ${progress}%"></div>
              </div>
              <div class="progress-text">${progress}%</div>
            </div>
          ` : ''}
        </div>
        ${isDownloading ? `
          <button class="cancel-btn" onclick="cancelYouTubeDownload('${item.id}')">
            Cancel
          </button>
        ` : ''}
      </div>
    </div>
  `;
}

// Add the cancel function
async function cancelYouTubeDownload(itemId) {
  try {
    console.log('[UI] Cancelling download:', itemId);
    
    const result = await window.youtube.cancelDownload(itemId);
    
    if (result.success) {
      console.log('[UI] Download cancelled successfully');
      showNotification('Download cancelled', 'info');
      // Refresh the UI
      renderHistory();
    } else {
      console.error('[UI] Failed to cancel:', result.error);
      showNotification('Failed to cancel download', 'error');
    }
  } catch (error) {
    console.error('[UI] Error cancelling download:', error);
    showNotification('Error cancelling download', 'error');
  }
}

// Add CSS for cancel button and progress bar
const styles = `
  .download-progress {
    margin-top: 8px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  
  .progress-bar {
    flex: 1;
    height: 4px;
    background: rgba(255,255,255,0.1);
    border-radius: 2px;
    overflow: hidden;
  }
  
  .progress-fill {
    height: 100%;
    background: linear-gradient(90deg, #6a1b9a, #9c27b0);
    transition: width 0.3s ease;
  }
  
  .progress-text {
    font-size: 11px;
    color: #aaa;
    min-width: 40px;
  }
  
  .cancel-btn {
    padding: 4px 12px;
    background: rgba(244, 67, 54, 0.1);
    border: 1px solid rgba(244, 67, 54, 0.3);
    border-radius: 4px;
    color: #f44336;
    font-size: 12px;
    cursor: pointer;
    transition: all 0.2s;
  }
  
  .cancel-btn:hover {
    background: rgba(244, 67, 54, 0.2);
    border-color: #f44336;
  }
`;

// ============================================
// Example: Show Active Downloads Widget
// ============================================

async function showActiveDownloads() {
  const result = await window.youtube.getActiveDownloads();
  
  if (!result.success || result.downloads.length === 0) {
    console.log('[UI] No active downloads');
    return;
  }
  
  console.log('[UI] Active downloads:', result.downloads);
  
  // Create a floating widget showing active downloads
  const widget = document.createElement('div');
  widget.className = 'active-downloads-widget';
  widget.innerHTML = `
    <div class="widget-header">
      <span>📥 Downloads (${result.downloads.length})</span>
      <button onclick="this.parentElement.parentElement.remove()">×</button>
    </div>
    <div class="widget-content">
      ${result.downloads.map(dl => `
        <div class="download-item">
          <div class="download-url">${new URL(dl.url).hostname}</div>
          <div class="download-progress">${dl.progress}%</div>
          <div class="download-time">${formatDuration(dl.duration)}</div>
          <button onclick="cancelYouTubeDownload('${dl.placeholderId}')">Cancel</button>
        </div>
      `).join('')}
    </div>
  `;
  
  document.body.appendChild(widget);
}

function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

// Add CSS for active downloads widget
const widgetStyles = `
  .active-downloads-widget {
    position: fixed;
    bottom: 20px;
    right: 20px;
    width: 300px;
    background: #2a2a2a;
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    z-index: 10000;
  }
  
  .widget-header {
    padding: 12px;
    background: linear-gradient(135deg, #6a1b9a, #4a148c);
    border-radius: 8px 8px 0 0;
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-weight: 600;
  }
  
  .widget-header button {
    background: none;
    border: none;
    color: white;
    font-size: 20px;
    cursor: pointer;
    padding: 0;
    width: 24px;
    height: 24px;
  }
  
  .widget-content {
    padding: 12px;
    max-height: 300px;
    overflow-y: auto;
  }
  
  .download-item {
    padding: 8px;
    background: rgba(255,255,255,0.05);
    border-radius: 4px;
    margin-bottom: 8px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  
  .download-url {
    font-size: 12px;
    color: #aaa;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  
  .download-progress {
    font-size: 14px;
    font-weight: 600;
    color: #9c27b0;
  }
  
  .download-time {
    font-size: 11px;
    color: #666;
  }
  
  .download-item button {
    margin-top: 4px;
    padding: 4px 8px;
    background: rgba(244, 67, 54, 0.1);
    border: 1px solid rgba(244, 67, 54, 0.3);
    border-radius: 4px;
    color: #f44336;
    font-size: 11px;
    cursor: pointer;
  }
`;
