/**
 * SpaceSaver - Save recordings to Space
 * @module src/recorder/services/SpaceSaver
 */

/**
 * Space saver class
 */
export class SpaceSaver {
  constructor() {
    this.currentSpaceId = null;
  }

  /**
   * Save recording to space
   * @param {Blob} blob - Video blob
   * @param {Object} options - Save options
   * @returns {Promise<Object>} Save result
   */
  async save(blob, options = {}) {
    const {
      filename = `recording_${Date.now()}.webm`,
      spaceId = this.currentSpaceId,
      metadata = {}
    } = options;

    if (!spaceId) {
      throw new Error('No space selected');
    }

    // Convert blob to array buffer
    const buffer = await blob.arrayBuffer();
    
    // Create file object
    const file = {
      name: filename,
      data: buffer,
      type: blob.type,
      size: blob.size
    };

    // Call Electron IPC to save
    if (window.spaces?.addFile) {
      const result = await window.spaces.addFile(spaceId, file, metadata);
      console.log('[SpaceSaver] Saved:', result);
      return result;
    }

    throw new Error('Space API not available');
  }

  /**
   * Save as local file
   * @param {Blob} blob - Video blob
   * @param {string} filename - Filename
   */
  async saveLocal(blob, filename = 'recording.webm') {
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    
    URL.revokeObjectURL(url);
    console.log('[SpaceSaver] Downloaded:', filename);
  }

  /**
   * Set current space
   * @param {string} spaceId - Space ID
   */
  setSpace(spaceId) {
    this.currentSpaceId = spaceId;
  }

  /**
   * Get available spaces
   * @returns {Promise<Array>} Spaces list
   */
  async getSpaces() {
    if (window.spaces?.list) {
      return await window.spaces.list();
    }
    return [];
  }
}
















