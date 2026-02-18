/**
 * ProductionScriptUI.js
 *
 * UI components for adding and managing production script elements
 * (camera angles, shots, movements) in the Line Script panel.
 */

import {
  CAMERA_ANGLES,
  SHOT_TYPES,
  CAMERA_MOVEMENTS,
  TECHNICAL_DIRECTIONS,
  ProductionDirection,
} from './ProductionScript.js';

/**
 * Camera/Shot Selector UI
 */
export class ProductionScriptUI {
  constructor(appContext, productionScriptManager) {
    this.app = appContext;
    this.manager = productionScriptManager;
    this.currentTime = 0;
    this.visible = false;
    this.selectedCategory = 'shots'; // 'shots', 'angles', 'movements', 'technical'
  }

  /**
   * Render the production controls sidebar
   */
  renderSidebar() {
    return `
      <div class="production-sidebar">
        <div class="production-category-tabs">
          <button class="category-tab ${this.selectedCategory === 'shots' ? 'active' : ''}" 
                  data-category="shots">
            🎬 Shots
          </button>
          <button class="category-tab ${this.selectedCategory === 'angles' ? 'active' : ''}" 
                  data-category="angles">
            📷 Angles
          </button>
          <button class="category-tab ${this.selectedCategory === 'movements' ? 'active' : ''}" 
                  data-category="movements">
            🎥 Movement
          </button>
          <button class="category-tab ${this.selectedCategory === 'technical' ? 'active' : ''}" 
                  data-category="technical">
            ⚙️ Technical
          </button>
        </div>
        
        <div class="production-buttons">
          ${this.renderCategoryButtons()}
        </div>
        
        <div class="production-quick-add">
          <h4>Quick Add at Current Time</h4>
          <div class="current-timecode">${this.formatTimecode(this.currentTime)}</div>
          <input type="text" 
                 class="direction-description" 
                 placeholder="Optional description..."
                 id="productionDirectionDescription">
          <button class="btn-primary" id="addProductionDirection">
            ➕ Add Direction
          </button>
        </div>
        
        <div class="production-list">
          <h4>Directions (${this.manager.directions.length})</h4>
          <div class="direction-items">
            ${this.renderDirectionList()}
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Render buttons for current category
   */
  renderCategoryButtons() {
    let items = [];
    let title = '';

    switch (this.selectedCategory) {
      case 'shots':
        items = Object.values(SHOT_TYPES);
        title = 'Shot Types';
        break;
      case 'angles':
        items = Object.values(CAMERA_ANGLES);
        title = 'Camera Angles';
        break;
      case 'movements':
        items = Object.values(CAMERA_MOVEMENTS);
        title = 'Camera Movements';
        break;
      case 'technical':
        items = Object.values(TECHNICAL_DIRECTIONS);
        title = 'Technical Directions';
        break;
    }

    return `
      <h4>${title}</h4>
      <div class="production-button-grid">
        ${items
          .map(
            (item) => `
          <button class="production-btn" 
                  data-type="${this.selectedCategory}"
                  data-id="${item.id}"
                  title="${item.description}">
            <span class="btn-icon">${item.icon}</span>
            <span class="btn-abbr">${item.abbr}</span>
            <span class="btn-name">${item.name}</span>
          </button>
        `
          )
          .join('')}
      </div>
    `;
  }

  /**
   * Render list of existing directions
   */
  renderDirectionList() {
    if (this.manager.directions.length === 0) {
      return '<p class="empty-message">No directions yet. Click a button to add one.</p>';
    }

    return this.manager.directions
      .map(
        (direction) => `
        <div class="direction-item" data-direction-id="${direction.id}">
          <span class="direction-icon">${direction.getIcon()}</span>
          <span class="direction-time">${this.formatTimecode(direction.time)}</span>
          <span class="direction-text">${this.escapeHtml(direction.getDisplayText())}</span>
          <button class="direction-goto-btn" data-time="${direction.time}" title="Go to">▶</button>
          <button class="direction-delete-btn" data-id="${direction.id}" title="Delete">✕</button>
        </div>
      `
      )
      .join('');
  }

  /**
   * Handle adding a direction from button click
   */
  handleDirectionButtonClick(type, id, description = '') {
    const direction = new ProductionDirection({
      time: this.currentTime,
      type: type === 'shots' ? 'shot' : type === 'angles' ? 'angle' : type === 'movements' ? 'movement' : 'technical',
      shotType: type === 'shots' ? id : null,
      cameraAngle: type === 'angles' ? id : null,
      cameraMovement: type === 'movements' ? id : null,
      technicalDirection: type === 'technical' ? id : null,
      description,
    });

    this.manager.addDirection(direction);

    // Show feedback
    if (this.app.showToast) {
      this.app.showToast(
        `${direction.getIcon()} ${direction.getFullName()} added at ${this.formatTimecode(this.currentTime)}`,
        'success'
      );
    }

    return direction;
  }

  /**
   * Attach event listeners to UI elements
   */
  attachEventListeners(container) {
    // Category tabs
    container.querySelectorAll('.category-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        this.selectedCategory = tab.dataset.category;
        this.refresh(container);
      });
    });

    // Production buttons
    container.querySelectorAll('.production-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const type = btn.dataset.type;
        const id = btn.dataset.id;
        const descriptionInput = container.querySelector('#productionDirectionDescription');
        const description = descriptionInput ? descriptionInput.value : '';

        this.handleDirectionButtonClick(type, id, description);

        // Clear description
        if (descriptionInput) {
          descriptionInput.value = '';
        }

        this.refresh(container);
      });
    });

    // Add direction button
    const addBtn = container.querySelector('#addProductionDirection');
    if (addBtn) {
      addBtn.addEventListener('click', () => {
        // Get selected button
        const selectedBtn = container.querySelector('.production-btn.selected');
        if (!selectedBtn) {
          if (this.app.showToast) {
            this.app.showToast('Select a direction type first', 'warning');
          }
          return;
        }

        const type = selectedBtn.dataset.type;
        const id = selectedBtn.dataset.id;
        const descriptionInput = container.querySelector('#productionDirectionDescription');
        const description = descriptionInput ? descriptionInput.value : '';

        this.handleDirectionButtonClick(type, id, description);

        if (descriptionInput) {
          descriptionInput.value = '';
        }

        this.refresh(container);
      });
    }

    // Direction goto buttons
    container.querySelectorAll('.direction-goto-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const time = parseFloat(btn.dataset.time);
        if (this.app.seekTo) {
          this.app.seekTo(time);
        }
      });
    });

    // Direction delete buttons
    container.querySelectorAll('.direction-delete-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = parseFloat(btn.dataset.id);
        this.manager.deleteDirection(id);
        this.refresh(container);

        if (this.app.showToast) {
          this.app.showToast('Direction removed', 'info');
        }
      });
    });

    // Make production buttons selectable
    container.querySelectorAll('.production-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        // Toggle selection
        container.querySelectorAll('.production-btn').forEach((b) => b.classList.remove('selected'));
        btn.classList.add('selected');
      });
    });
  }

  /**
   * Update current time
   */
  setCurrentTime(time) {
    this.currentTime = time;
  }

  /**
   * Refresh the UI
   */
  refresh(container) {
    if (!container) return;

    // Re-render sidebar
    container.innerHTML = this.renderSidebar();

    // Re-attach listeners
    this.attachEventListeners(container);
  }

  /**
   * Format timecode
   */
  formatTimecode(seconds) {
    if (!seconds || isNaN(seconds)) return '00:00.0';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    const f = Math.floor((seconds % 1) * 10);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${f}`;
  }

  /**
   * Escape HTML
   */
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
  }
}

/**
 * Render production script format with camera directions inline
 */
export function renderProductionScriptFormat(words, dialogueBlocks, directions, markers, speakers, _template) {
  let html = '<div class="production-script-content">';
  let lineNumber = 1;
  let sceneNumber = 0;
  let lastMarkerId = null;

  // Sort directions by time
  const sortedDirections = [...directions].sort((a, b) => a.time - b.time);
  let directionIndex = 0;

  dialogueBlocks.forEach((block, _blockIdx) => {
    const blockTime = block.startTime;

    // Check for scene marker
    const sceneMarker = markers.find((m) => m.type === 'range' && Math.abs(m.inTime - blockTime) < 1);
    if (sceneMarker && sceneMarker.id !== lastMarkerId) {
      sceneNumber++;
      html += renderSceneHeader(sceneMarker, sceneNumber);
      lastMarkerId = sceneMarker.id;
    }

    // Add any directions that come before this block
    while (directionIndex < sortedDirections.length && sortedDirections[directionIndex].time <= blockTime) {
      html += renderCameraDirection(sortedDirections[directionIndex], lineNumber);
      lineNumber++;
      directionIndex++;
    }

    // Render speaker cue
    if (block.speaker) {
      html += renderSpeakerCue(block.speaker, lineNumber, speakers);
      lineNumber++;
    }

    // Render dialogue
    const dialogueLines = splitIntoLines(block.text, 50);
    dialogueLines.forEach((lineText, lineIdx) => {
      const lineTime = interpolateTime(block, lineIdx, dialogueLines.length);
      html += renderDialogueLine(lineNumber, lineTime, lineText, block.speaker, speakers);
      lineNumber++;
    });

    html += '<div class="block-spacer"></div>';
  });

  // Add any remaining directions
  while (directionIndex < sortedDirections.length) {
    html += renderCameraDirection(sortedDirections[directionIndex], lineNumber);
    lineNumber++;
    directionIndex++;
  }

  html += '</div>';
  return html;
}

/**
 * Render a camera direction line
 */
function renderCameraDirection(direction, lineNumber) {
  return `
    <div class="camera-direction ${direction.emphasis ? 'emphasis' : ''}" 
         data-line="${lineNumber}" 
         data-time="${direction.time}"
         data-direction-id="${direction.id}">
      <span class="line-number">${lineNumber}</span>
      <span class="line-timecode">${formatTimecode(direction.time)}</span>
      <span class="camera-icon">${direction.getIcon()}</span>
      <span class="camera-text">${escapeHtml(direction.getDisplayText())}</span>
    </div>
  `;
}

/**
 * Render scene header
 */
function renderSceneHeader(marker, sceneNumber) {
  const duration = (marker.outTime - marker.inTime).toFixed(1);
  return `
    <div class="scene-header" data-marker-id="${marker.id}" style="--scene-color: ${marker.color}">
      <div class="scene-slugline">
        <span class="scene-number">${sceneNumber}</span>
        <span class="scene-name">${escapeHtml(marker.name || 'Scene')}</span>
        <span class="scene-duration">${duration}s</span>
      </div>
      <div class="scene-timecode">
        ${formatTimecode(marker.inTime)} → ${formatTimecode(marker.outTime)}
      </div>
      ${marker.description ? `<div class="scene-description">${escapeHtml(marker.description)}</div>` : ''}
    </div>
  `;
}

/**
 * Render speaker cue
 */
function renderSpeakerCue(speaker, lineNumber, speakers) {
  const speakerIdx = speakers.indexOf(speaker);
  const speakerClass = speakerIdx >= 0 ? `speaker-${speakerIdx % 6}` : '';

  return `
    <div class="speaker-cue ${speakerClass}" data-line="${lineNumber}">
      <span class="speaker-avatar">${speaker.charAt(0).toUpperCase()}</span>
      <span class="speaker-name">${escapeHtml(speaker)}</span>
    </div>
  `;
}

/**
 * Render dialogue line
 */
function renderDialogueLine(lineNumber, time, text, speaker, speakers) {
  const speakerIdx = speaker ? speakers.indexOf(speaker) : -1;
  const speakerClass = speakerIdx >= 0 ? `speaker-${speakerIdx % 6}` : '';

  return `
    <div class="dialogue-line ${speakerClass}" data-line="${lineNumber}" data-time="${time}">
      <span class="line-number">${lineNumber}</span>
      <span class="line-timecode">${formatTimecode(time)}</span>
      <span class="line-text">${escapeHtml(text)}</span>
    </div>
  `;
}

// Utility functions
function formatTimecode(seconds) {
  if (!seconds || isNaN(seconds)) return '00:00.0';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const f = Math.floor((seconds % 1) * 10);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${f}`;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text || '';
  return div.innerHTML;
}

function splitIntoLines(text, maxChars) {
  const words = text.split(/\s+/);
  const lines = [];
  let currentLine = [];
  let currentLength = 0;

  words.forEach((word) => {
    if (currentLength + word.length + 1 > maxChars && currentLine.length > 0) {
      lines.push(currentLine.join(' '));
      currentLine = [word];
      currentLength = word.length;
    } else {
      currentLine.push(word);
      currentLength += word.length + 1;
    }
  });

  if (currentLine.length > 0) {
    lines.push(currentLine.join(' '));
  }

  return lines;
}

function interpolateTime(block, lineIdx, totalLines) {
  const duration = block.endTime - block.startTime;
  return block.startTime + (duration * lineIdx) / totalLines;
}

export default {
  ProductionScriptUI,
  renderProductionScriptFormat,
};
