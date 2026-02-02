/**
 * EditToolbar - Floating toolbar for text selection actions
 * 
 * Appears when text is selected in the StoryBeatsEditor and provides:
 * - Delete (mark for removal)
 * - Insert Gap (add placeholder for new content)
 * - Replace (mark for re-recording)
 * - Create Marker (turn selection into story beat)
 * - Split Marker (break existing marker at selection)
 */
export class EditToolbar {
  constructor(appContext) {
    this.app = appContext;
    
    // State
    this.visible = false;
    this.selection = null;
    
    // DOM reference
    this.element = null;
    
    // Create the toolbar element
    this.createToolbar();
  }

  /**
   * Create the toolbar DOM element
   */
  createToolbar() {
    // Check if already exists
    this.element = document.getElementById('storyBeatsEditToolbar');
    if (this.element) return;
    
    this.element = document.createElement('div');
    this.element.id = 'storyBeatsEditToolbar';
    this.element.className = 'storybeats-edit-toolbar hidden';
    
    this.element.innerHTML = `
      <div class="edit-toolbar-content">
        <button class="edit-toolbar-btn edit-toolbar-delete" data-action="delete" title="Delete Selection (Del)">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
          <span>Delete</span>
        </button>
        
        <button class="edit-toolbar-btn edit-toolbar-gap" data-action="insert-gap" title="Insert Gap for New Content">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          <span>Add Gap</span>
        </button>
        
        <button class="edit-toolbar-btn edit-toolbar-replace" data-action="replace" title="Replace with AI Voice">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/>
            <path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/>
          </svg>
          <span>Replace</span>
        </button>
        
        <div class="edit-toolbar-divider"></div>
        
        <button class="edit-toolbar-btn edit-toolbar-marker" data-action="create-marker" title="Create Story Beat from Selection">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>
          </svg>
          <span>Create Beat</span>
        </button>
        
        <button class="edit-toolbar-btn edit-toolbar-split" data-action="split-marker" title="Split Marker at Selection">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="2" x2="12" y2="22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
          </svg>
          <span>Split</span>
        </button>
      </div>
      
      <div class="edit-toolbar-info">
        <span class="edit-toolbar-selection-info" id="toolbarSelectionInfo"></span>
      </div>
    `;
    
    document.body.appendChild(this.element);
    
    // Attach event listeners
    this.attachListeners();
  }

  /**
   * Attach event listeners to toolbar buttons
   */
  attachListeners() {
    this.element.querySelectorAll('.edit-toolbar-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = btn.dataset.action;
        this.handleAction(action);
      });
    });
  }

  /**
   * Handle toolbar action
   */
  handleAction(action) {
    const editor = this.app.storyBeatsEditor;
    if (!editor) return;
    
    switch (action) {
      case 'delete':
        editor.deleteSelection();
        break;
        
      case 'insert-gap':
        this.showGapDurationPrompt();
        break;
        
      case 'replace':
        this.showReplaceOptions();
        break;
        
      case 'create-marker':
        editor.createMarkerFromSelection();
        break;
        
      case 'split-marker':
        this.splitMarkerAtSelection();
        break;
    }
    
    this.hide();
  }

  /**
   * Show gap duration prompt
   */
  showGapDurationPrompt() {
    const duration = prompt('Gap duration (seconds):', '3.0');
    if (duration === null) return;
    
    const durationNum = parseFloat(duration);
    if (isNaN(durationNum) || durationNum <= 0) {
      this.app.showToast?.('error', 'Please enter a valid duration');
      return;
    }
    
    this.app.storyBeatsEditor?.insertGapAtSelection(durationNum);
  }

  /**
   * Show replace options
   */
  showReplaceOptions() {
    const editor = this.app.storyBeatsEditor;
    if (!editor?.selection) return;
    
    // For now, just mark for replacement
    // In future, could show a modal with AI voice options
    editor.replaceSelection();
  }

  /**
   * Split marker at selection point
   */
  splitMarkerAtSelection() {
    const editor = this.app.storyBeatsEditor;
    if (!editor?.selection) return;
    
    const splitTime = editor.selection.startTime;
    
    // Find marker at this time
    const marker = editor.getMarkerAtTime(splitTime);
    if (!marker) {
      this.app.showToast?.('info', 'No marker at selection to split');
      return;
    }
    
    // Create two markers from the one
    const markerManager = this.app.markerManager;
    if (!markerManager) return;
    
    const originalInTime = marker.inTime;
    const originalOutTime = marker.outTime;
    
    // Update original marker to end at split point
    marker.outTime = splitTime;
    marker.duration = splitTime - originalInTime;
    
    // Create new marker from split point to original end
    markerManager.addRangeMarker(
      splitTime,
      originalOutTime,
      `${marker.name} (cont.)`,
      marker.color,
      {
        description: marker.description,
        tags: marker.tags ? [...marker.tags] : []
      }
    );
    
    // Refresh
    editor.refresh();
    this.app.showToast?.('success', 'Marker split at selection');
  }

  /**
   * Show the toolbar near the selection
   */
  show(selection) {
    this.selection = selection;
    this.visible = true;
    
    // Update selection info
    const info = this.element.querySelector('#toolbarSelectionInfo');
    if (info) {
      const duration = (selection.endTime - selection.startTime).toFixed(1);
      const wordCount = selection.endIndex - selection.startIndex + 1;
      info.textContent = `${wordCount} word${wordCount !== 1 ? 's' : ''} (${duration}s)`;
    }
    
    // Position the toolbar
    this.position();
    
    // Show
    this.element.classList.remove('hidden');
  }

  /**
   * Hide the toolbar
   */
  hide() {
    this.visible = false;
    this.selection = null;
    this.element?.classList.add('hidden');
  }

  /**
   * Position the toolbar near the selection
   */
  position() {
    if (!this.selection) return;
    
    const editor = this.app.storyBeatsEditor;
    const editorContent = document.getElementById('storyBeatsEditorContent');
    if (!editorContent) return;
    
    // Find the first selected word element
    const startWordEl = editorContent.querySelector(`[data-index="${this.selection.startIndex}"]`);
    const endWordEl = editorContent.querySelector(`[data-index="${this.selection.endIndex}"]`);
    
    if (!startWordEl) {
      // Position at top center of editor
      const editorRect = editorContent.getBoundingClientRect();
      this.element.style.top = `${editorRect.top + 10}px`;
      this.element.style.left = `${editorRect.left + editorRect.width / 2}px`;
      this.element.style.transform = 'translateX(-50%)';
      return;
    }
    
    const startRect = startWordEl.getBoundingClientRect();
    const endRect = endWordEl ? endWordEl.getBoundingClientRect() : startRect;
    
    // Position above the selection, centered
    const centerX = (startRect.left + endRect.right) / 2;
    const topY = startRect.top - 10;
    
    this.element.style.top = `${topY}px`;
    this.element.style.left = `${centerX}px`;
    this.element.style.transform = 'translate(-50%, -100%)';
    
    // Make sure it doesn't go off screen
    const toolbarRect = this.element.getBoundingClientRect();
    
    if (toolbarRect.top < 0) {
      // Position below selection instead
      this.element.style.top = `${endRect.bottom + 10}px`;
      this.element.style.transform = 'translateX(-50%)';
    }
    
    if (toolbarRect.left < 0) {
      this.element.style.left = `${toolbarRect.width / 2 + 10}px`;
    }
    
    if (toolbarRect.right > window.innerWidth) {
      this.element.style.left = `${window.innerWidth - toolbarRect.width / 2 - 10}px`;
    }
  }

  /**
   * Destroy the toolbar
   */
  destroy() {
    this.element?.remove();
    this.element = null;
  }
}


