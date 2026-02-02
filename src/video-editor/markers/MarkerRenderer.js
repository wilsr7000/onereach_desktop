/**
 * MarkerRenderer - Timeline and sidebar rendering for markers
 * Handles marker display, drag handling, and list rendering
 */
export class MarkerRenderer {
  constructor(appContext) {
    this.app = appContext;
    
    // Drag state
    this.draggingMarker = null;
    this.wasDragging = false;
    
    // Details panel state
    this.selectedMarkerForDetails = null;
    
    // Bind event handlers
    this.handleDrag = this._handleDrag.bind(this);
    this.handleDragEnd = this._handleDragEnd.bind(this);
  }

  /**
   * Render markers on timeline track
   */
  renderTimeline() {
    const track = document.getElementById('markersTrack');
    const video = document.getElementById('videoPlayer');
    
    if (!track || !video || !video.duration) {
      if (track) track.innerHTML = '';
      return;
    }
    
    const markers = this.app.markerManager?.getAll() || this.app.markers || [];
    const zoom = this.app.timelineZoom || 1;
    track.style.width = `calc((100% - 108px) * ${zoom})`;
    
    track.innerHTML = markers.map(marker => {
      if (marker.type === 'range') {
        return this._renderRangeMarker(marker, video.duration);
      } else {
        return this._renderSpotMarker(marker, video.duration);
      }
    }).join('');
  }

  /**
   * Render range marker HTML
   */
  _renderRangeMarker(marker, videoDuration) {
    const startPercent = (marker.inTime / videoDuration) * 100;
    const endPercent = (marker.outTime / videoDuration) * 100;
    const width = endPercent - startPercent;
    const duration = marker.outTime - marker.inTime;
    
    return `
      <div class="marker-range" style="left: ${startPercent}%; width: ${width}%; background: ${marker.color};" 
           data-id="${marker.id}"
           onmousedown="app.markerRenderer?.startDragRangeMove(event, ${marker.id})"
           onclick="event.stopPropagation(); app.goToMarker(${marker.id})"
           oncontextmenu="event.preventDefault(); event.stopPropagation(); app.showMarkerContextMenu(event, ${marker.id})">
        <div class="marker-range-handle left" onmousedown="event.stopPropagation(); app.markerRenderer?.startDragRangeIn(event, ${marker.id})"></div>
        <div class="marker-range-label">${marker.name} (${this.app.formatTime(duration)})</div>
        <div class="marker-range-handle right" onmousedown="event.stopPropagation(); app.markerRenderer?.startDragRangeOut(event, ${marker.id})"></div>
      </div>
      <div class="marker" style="left: ${startPercent}%; background: ${marker.color}; cursor: ew-resize;" 
           data-id="${marker.id}-in"
           onmousedown="app.markerRenderer?.startDragRangeIn(event, ${marker.id})">
        <div class="marker-flag" style="background: ${marker.color};">▶</div>
        <div class="marker-label">IN: ${marker.name} (${this.app.formatTime(marker.inTime)})</div>
      </div>
      <div class="marker" style="left: ${endPercent}%; background: ${marker.color}; cursor: ew-resize;" 
           data-id="${marker.id}-out"
           onmousedown="app.markerRenderer?.startDragRangeOut(event, ${marker.id})">
        <div class="marker-flag" style="background: ${marker.color};">◀</div>
        <div class="marker-label">OUT: ${marker.name} (${this.app.formatTime(marker.outTime)})</div>
      </div>
    `;
  }

  /**
   * Render spot marker HTML
   */
  _renderSpotMarker(marker, videoDuration) {
    const percent = (marker.time / videoDuration) * 100;
    
    return `
      <div class="marker" style="left: ${percent}%; background: ${marker.color}; cursor: ew-resize;" 
           data-id="${marker.id}"
           onmousedown="app.markerRenderer?.startDragSpot(event, ${marker.id})"
           onclick="event.stopPropagation(); app.goToMarker(${marker.id})"
           oncontextmenu="event.preventDefault(); event.stopPropagation(); app.showMarkerContextMenu(event, ${marker.id})">
        <div class="marker-flag" style="background: ${marker.color};">●</div>
        <div class="marker-label">${marker.name} (${this.app.formatTime(marker.time)})</div>
      </div>
    `;
  }

  /**
   * Render markers list in sidebar
   */
  renderList() {
    const list = document.getElementById('markersList');
    const count = document.getElementById('markersCount');
    const markers = this.app.markerManager?.getAll() || this.app.markers || [];
    
    if (count) {
      count.textContent = markers.length;
    }
    
    if (!list) return;
    
    if (markers.length === 0) {
      list.innerHTML = '<div class="markers-empty">No markers yet.<br>Click "Add Marker" or press <kbd>N</kbd></div>';
      return;
    }
    
    list.innerHTML = markers.map((marker, index) => {
      const hasMetadata = marker.description || marker.transcription || (marker.tags && marker.tags.length > 0);
      const metaIcon = hasMetadata ? '📝' : '';
      
      if (marker.type === 'range') {
        return this._renderRangeListItem(marker, index, metaIcon);
      } else {
        return this._renderSpotListItem(marker, index, metaIcon);
      }
    }).join('');
    
    // Update details panel if visible
    if (this.selectedMarkerForDetails) {
      this.showDetails(this.selectedMarkerForDetails);
    }
  }

  /**
   * Render range marker list item
   */
  _renderRangeListItem(marker, index, metaIcon) {
    const duration = marker.outTime - marker.inTime;
    return `
      <div class="marker-item" data-id="${marker.id}" onclick="app.markerRenderer?.showDetails(${marker.id})">
        <div class="marker-color-dot" style="background: ${marker.color}; border-radius: 2px; width: 16px;"></div>
        <div class="marker-item-info">
          <div class="marker-item-name">${index + 1}. ${marker.name} <span style="opacity: 0.5">↔️</span> ${metaIcon}</div>
          <div class="marker-item-time">${this.app.formatTime(marker.inTime)} → ${this.app.formatTime(marker.outTime)} (${this.app.formatTime(duration)})</div>
        </div>
        <div class="marker-item-actions">
          <button class="marker-action-btn" onclick="event.stopPropagation(); app.goToMarker(${marker.id})" title="Go to IN">▶</button>
          <button class="marker-action-btn" onclick="event.stopPropagation(); app.goToMarkerEnd(${marker.id})" title="Go to OUT">⏭</button>
          <button class="marker-action-btn" onclick="event.stopPropagation(); app.editMarker(${marker.id})" title="Edit">✏️</button>
          <button class="marker-action-btn delete" onclick="event.stopPropagation(); app.deleteMarker(${marker.id})" title="Delete">🗑️</button>
        </div>
      </div>
    `;
  }

  /**
   * Render spot marker list item
   */
  _renderSpotListItem(marker, index, metaIcon) {
    return `
      <div class="marker-item" data-id="${marker.id}" onclick="app.markerRenderer?.showDetails(${marker.id})">
        <div class="marker-color-dot" style="background: ${marker.color};"></div>
        <div class="marker-item-info">
          <div class="marker-item-name">${index + 1}. ${marker.name} <span style="opacity: 0.5">📍</span> ${metaIcon}</div>
          <div class="marker-item-time">${this.app.formatTime(marker.time)}</div>
        </div>
        <div class="marker-item-actions">
          <button class="marker-action-btn" onclick="event.stopPropagation(); app.goToMarker(${marker.id})" title="Go to marker">▶</button>
          <button class="marker-action-btn" onclick="event.stopPropagation(); app.editMarker(${marker.id})" title="Edit">✏️</button>
          <button class="marker-action-btn delete" onclick="event.stopPropagation(); app.deleteMarker(${marker.id})" title="Delete">🗑️</button>
        </div>
      </div>
    `;
  }

  /**
   * Render both timeline and list
   */
  render() {
    this.renderTimeline();
    this.renderList();
  }

  /**
   * Show marker details panel
   */
  showDetails(markerId) {
    const marker = this.app.markerManager?.getById(markerId) || 
                   this.app.markers?.find(m => m.id === markerId);
    if (!marker) return;
    
    this.selectedMarkerForDetails = markerId;
    
    // Highlight in list
    document.querySelectorAll('.marker-item').forEach(el => el.classList.remove('active'));
    const listItem = document.querySelector(`.marker-item[data-id="${markerId}"]`);
    if (listItem) listItem.classList.add('active');
    
    // Delegate to app's showMarkerDetails for full panel rendering
    this.app.showMarkerDetails?.(markerId);
  }

  /**
   * Close marker details panel
   */
  closeDetails() {
    this.selectedMarkerForDetails = null;
    // Delegate to app
    this.app.closeMarkerDetails?.();
  }

  // ─── Drag Handling ───

  /**
   * Start dragging a spot marker
   */
  startDragSpot(event, markerId) {
    event.preventDefault();
    event.stopPropagation();
    
    const markers = this.app.markerManager?.getAll() || this.app.markers || [];
    const marker = markers.find(m => m.id === markerId);
    if (!marker) return;
    
    this.draggingMarker = {
      id: markerId,
      type: 'spot',
      startX: event.clientX,
      startTime: marker.time
    };
    
    const el = document.querySelector(`.marker[data-id="${markerId}"]`);
    if (el) el.classList.add('dragging');
    
    document.addEventListener('mousemove', this.handleDrag);
    document.addEventListener('mouseup', this.handleDragEnd);
  }

  /**
   * Start dragging range IN point
   */
  startDragRangeIn(event, markerId) {
    event.preventDefault();
    event.stopPropagation();
    
    const markers = this.app.markerManager?.getAll() || this.app.markers || [];
    const marker = markers.find(m => m.id === markerId);
    if (!marker || marker.type !== 'range') return;
    
    this.draggingMarker = {
      id: markerId,
      type: 'range-in',
      startX: event.clientX,
      startTime: marker.inTime
    };
    
    const el = document.querySelector(`.marker[data-id="${markerId}-in"]`);
    if (el) el.classList.add('dragging');
    
    document.addEventListener('mousemove', this.handleDrag);
    document.addEventListener('mouseup', this.handleDragEnd);
  }

  /**
   * Start dragging range OUT point
   */
  startDragRangeOut(event, markerId) {
    event.preventDefault();
    event.stopPropagation();
    
    const markers = this.app.markerManager?.getAll() || this.app.markers || [];
    const marker = markers.find(m => m.id === markerId);
    if (!marker || marker.type !== 'range') return;
    
    this.draggingMarker = {
      id: markerId,
      type: 'range-out',
      startX: event.clientX,
      startTime: marker.outTime
    };
    
    const el = document.querySelector(`.marker[data-id="${markerId}-out"]`);
    if (el) el.classList.add('dragging');
    
    document.addEventListener('mousemove', this.handleDrag);
    document.addEventListener('mouseup', this.handleDragEnd);
  }

  /**
   * Start dragging entire range (move)
   */
  startDragRangeMove(event, markerId) {
    if (event.target.classList.contains('marker-range-handle')) return;
    
    event.preventDefault();
    event.stopPropagation();
    
    const markers = this.app.markerManager?.getAll() || this.app.markers || [];
    const marker = markers.find(m => m.id === markerId);
    if (!marker || marker.type !== 'range') return;
    
    this.draggingMarker = {
      id: markerId,
      type: 'range-move',
      startX: event.clientX,
      startInTime: marker.inTime,
      startOutTime: marker.outTime,
      duration: marker.outTime - marker.inTime
    };
    
    const el = document.querySelector(`.marker-range[data-id="${markerId}"]`);
    if (el) el.classList.add('dragging');
    
    document.addEventListener('mousemove', this.handleDrag);
    document.addEventListener('mouseup', this.handleDragEnd);
  }

  /**
   * Handle drag movement
   */
  _handleDrag(event) {
    if (!this.draggingMarker) return;
    
    const track = document.getElementById('markersTrack');
    const video = document.getElementById('videoPlayer');
    if (!track || !video || !video.duration) return;
    
    const markers = this.app.markerManager?.getAll() || this.app.markers || [];
    const marker = markers.find(m => m.id === this.draggingMarker.id);
    if (!marker) return;
    
    const rect = track.getBoundingClientRect();
    const trackWidth = rect.width;
    const deltaX = event.clientX - this.draggingMarker.startX;
    const deltaTime = (deltaX / trackWidth) * video.duration;
    
    switch (this.draggingMarker.type) {
      case 'spot':
        marker.time = Math.max(0, Math.min(video.duration, this.draggingMarker.startTime + deltaTime));
        break;
        
      case 'range-in':
        marker.inTime = Math.max(0, Math.min(marker.outTime - 0.1, this.draggingMarker.startTime + deltaTime));
        break;
        
      case 'range-out':
        marker.outTime = Math.max(marker.inTime + 0.1, Math.min(video.duration, this.draggingMarker.startTime + deltaTime));
        break;
        
      case 'range-move':
        let newIn = this.draggingMarker.startInTime + deltaTime;
        let newOut = this.draggingMarker.startOutTime + deltaTime;
        
        if (newIn < 0) {
          newIn = 0;
          newOut = this.draggingMarker.duration;
        }
        if (newOut > video.duration) {
          newOut = video.duration;
          newIn = video.duration - this.draggingMarker.duration;
        }
        
        marker.inTime = newIn;
        marker.outTime = newOut;
        break;
    }
    
    // Re-render and re-apply dragging class
    this.render();
    this._reapplyDraggingClass(marker.id);
  }

  /**
   * Handle drag end
   */
  _handleDragEnd(event) {
    if (!this.draggingMarker) return;
    
    const deltaX = Math.abs(event.clientX - this.draggingMarker.startX);
    if (deltaX > 5) {
      this.wasDragging = true;
    }
    
    // Remove dragging classes
    document.querySelectorAll('.marker.dragging, .marker-range.dragging').forEach(el => {
      el.classList.remove('dragging');
    });
    
    // Sort markers
    const markers = this.app.markerManager?.getAll() || this.app.markers || [];
    markers.sort((a, b) => {
      const timeA = a.type === 'range' ? a.inTime : a.time;
      const timeB = b.type === 'range' ? b.inTime : b.time;
      return timeA - timeB;
    });
    
    this.draggingMarker = null;
    
    document.removeEventListener('mousemove', this.handleDrag);
    document.removeEventListener('mouseup', this.handleDragEnd);
    
    this.render();
    this.app.showToast?.('success', 'Marker moved');
  }

  /**
   * Re-apply dragging class after re-render
   */
  _reapplyDraggingClass(markerId) {
    if (!this.draggingMarker) return;
    
    let el;
    switch (this.draggingMarker.type) {
      case 'spot':
        el = document.querySelector(`.marker[data-id="${markerId}"]`);
        break;
      case 'range-in':
        el = document.querySelector(`.marker[data-id="${markerId}-in"]`);
        break;
      case 'range-out':
        el = document.querySelector(`.marker[data-id="${markerId}-out"]`);
        break;
      case 'range-move':
        el = document.querySelector(`.marker-range[data-id="${markerId}"]`);
        break;
    }
    
    if (el) el.classList.add('dragging');
  }
}


















