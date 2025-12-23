/**
 * DeploymentVersionManager - Manage different export versions of a video
 * 
 * Allows creating multiple "deployment versions" from the same source video:
 * - Trailer (30-60 seconds)
 * - Short (2-5 minutes)
 * - Full (complete video)
 * - Teaser (10-15 seconds for social)
 * - Localized versions (Spanish, French, etc.)
 * 
 * Each version defines which time regions to include from the source.
 * 
 * Usage:
 * ```javascript
 * const dvManager = new DeploymentVersionManager(videoPath, videoDuration);
 * 
 * // Create versions
 * dvManager.createVersion('trailer', 'trailer');
 * dvManager.createVersion('full-spanish', 'full', { language: 'es' });
 * 
 * // Add regions to trailer
 * dvManager.addRegion('trailer', 0, 10);      // Opening hook
 * dvManager.addRegion('trailer', 45, 55);     // Key demo
 * dvManager.addRegion('trailer', 180, 190);   // Call to action
 * 
 * // Export
 * const exportSpec = dvManager.getExportSpec('trailer');
 * // -> { regions: [...], totalDuration: 30, outputName: 'video-trailer.mp4' }
 * ```
 */

class DeploymentVersionManager {
  /**
   * Built-in version templates
   */
  static TEMPLATES = {
    trailer: {
      name: 'Trailer',
      maxDuration: 60,
      description: '30-60 second highlight reel',
      icon: '🎬',
      suggestedRegions: ['opening', 'highlight', 'cta']
    },
    short: {
      name: 'Short',
      maxDuration: 300,
      description: '2-5 minute condensed version',
      icon: '📱',
      suggestedRegions: ['opening', 'key-points', 'closing']
    },
    full: {
      name: 'Full',
      maxDuration: null,
      description: 'Complete video',
      icon: '🎥',
      suggestedRegions: ['all']
    },
    teaser: {
      name: 'Teaser',
      maxDuration: 15,
      description: '10-15 second social media clip',
      icon: '⚡',
      suggestedRegions: ['best-moment']
    },
    custom: {
      name: 'Custom',
      maxDuration: null,
      description: 'Custom version',
      icon: '✨',
      suggestedRegions: []
    }
  };

  /**
   * Supported languages for localization
   */
  static LANGUAGES = {
    en: { name: 'English', code: 'en' },
    es: { name: 'Spanish', code: 'es' },
    fr: { name: 'French', code: 'fr' },
    de: { name: 'German', code: 'de' },
    it: { name: 'Italian', code: 'it' },
    pt: { name: 'Portuguese', code: 'pt' },
    ja: { name: 'Japanese', code: 'ja' },
    ko: { name: 'Korean', code: 'ko' },
    zh: { name: 'Chinese', code: 'zh' },
    ar: { name: 'Arabic', code: 'ar' },
    hi: { name: 'Hindi', code: 'hi' },
    ru: { name: 'Russian', code: 'ru' }
  };

  /**
   * Create a new DeploymentVersionManager
   * @param {string} videoPath - Path to source video
   * @param {number} videoDuration - Total video duration in seconds
   * @param {object} options - Additional options
   */
  constructor(videoPath, videoDuration, options = {}) {
    this.videoPath = videoPath;
    this.videoDuration = videoDuration;
    this.videoName = this._extractVideoName(videoPath);
    this.versions = new Map();
    this.onVersionChange = options.onVersionChange || null;

    // Auto-create "Full" version with entire video
    this._createFullVersion();
  }

  /**
   * Extract video name from path
   * @private
   */
  _extractVideoName(videoPath) {
    if (!videoPath) return 'video';
    const basename = videoPath.split(/[/\\]/).pop();
    return basename.replace(/\.[^.]+$/, '');
  }

  /**
   * Create the default Full version
   * @private
   */
  _createFullVersion() {
    const fullVersion = {
      id: 'full',
      name: 'Full',
      template: 'full',
      language: null,
      regions: [{ start: 0, end: this.videoDuration, label: 'Full video' }],
      createdAt: Date.now(),
      modifiedAt: Date.now(),
      exportedAt: null,
      isDefault: true
    };
    this.versions.set('full', fullVersion);
  }

  // ═══════════════════════════════════════════════════════════
  // VERSION MANAGEMENT
  // ═══════════════════════════════════════════════════════════

  /**
   * Create a new deployment version
   * @param {string} id - Unique identifier for the version
   * @param {string} template - Template name ('trailer', 'short', 'full', 'teaser', 'custom')
   * @param {object} options - Additional options
   * @param {string} [options.name] - Custom name (defaults to template name)
   * @param {string} [options.language] - Language code for localized version
   * @returns {object} The created version
   */
  createVersion(id, template = 'custom', options = {}) {
    if (this.versions.has(id)) {
      throw new Error(`Version with id "${id}" already exists`);
    }

    const templateConfig = DeploymentVersionManager.TEMPLATES[template] || 
                           DeploymentVersionManager.TEMPLATES.custom;

    const version = {
      id,
      name: options.name || templateConfig.name,
      template,
      language: options.language || null,
      regions: [],
      maxDuration: options.maxDuration || templateConfig.maxDuration,
      createdAt: Date.now(),
      modifiedAt: Date.now(),
      exportedAt: null,
      isDefault: false,
      metadata: options.metadata || {}
    };

    this.versions.set(id, version);
    this._notifyChange('create', version);

    console.log(`[DeploymentVersionManager] Created version: ${version.name} (${id})`);
    return version;
  }

  /**
   * Delete a version
   * @param {string} versionId 
   * @returns {boolean}
   */
  deleteVersion(versionId) {
    if (versionId === 'full') {
      console.warn('[DeploymentVersionManager] Cannot delete Full version');
      return false;
    }

    const deleted = this.versions.delete(versionId);
    if (deleted) {
      this._notifyChange('delete', { id: versionId });
    }
    return deleted;
  }

  /**
   * Rename a version
   * @param {string} versionId 
   * @param {string} newName 
   * @returns {boolean}
   */
  renameVersion(versionId, newName) {
    const version = this.versions.get(versionId);
    if (!version) return false;

    version.name = newName;
    version.modifiedAt = Date.now();
    this._notifyChange('rename', version);
    return true;
  }

  /**
   * Get a version by ID
   * @param {string} versionId 
   * @returns {object|null}
   */
  getVersion(versionId) {
    return this.versions.get(versionId) || null;
  }

  /**
   * List all versions
   * @returns {array}
   */
  listVersions() {
    return Array.from(this.versions.values()).map(v => ({
      ...v,
      totalDuration: this._calculateDuration(v),
      regionCount: v.regions.length
    }));
  }

  // ═══════════════════════════════════════════════════════════
  // REGION MANAGEMENT
  // ═══════════════════════════════════════════════════════════

  /**
   * Add a time region to a version
   * @param {string} versionId 
   * @param {number} start - Start time in seconds
   * @param {number} end - End time in seconds
   * @param {object} options - Additional options
   * @param {string} [options.label] - Label for this region
   * @param {string} [options.source] - Source of this region ('marker', 'ai', 'manual')
   * @returns {object} The added region
   */
  addRegion(versionId, start, end, options = {}) {
    const version = this.versions.get(versionId);
    if (!version) {
      throw new Error(`Version "${versionId}" not found`);
    }

    // Validate times
    start = Math.max(0, Math.min(start, this.videoDuration));
    end = Math.max(start, Math.min(end, this.videoDuration));

    const region = {
      id: `region_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      start,
      end,
      duration: end - start,
      label: options.label || `Region ${version.regions.length + 1}`,
      source: options.source || 'manual',
      createdAt: Date.now()
    };

    version.regions.push(region);
    version.modifiedAt = Date.now();

    // Sort regions by start time
    version.regions.sort((a, b) => a.start - b.start);

    this._notifyChange('addRegion', { versionId, region });

    console.log(`[DeploymentVersionManager] Added region to ${versionId}: ${start.toFixed(2)}-${end.toFixed(2)}`);
    return region;
  }

  /**
   * Remove a region from a version
   * @param {string} versionId 
   * @param {string} regionId 
   * @returns {boolean}
   */
  removeRegion(versionId, regionId) {
    const version = this.versions.get(versionId);
    if (!version) return false;

    const index = version.regions.findIndex(r => r.id === regionId);
    if (index === -1) return false;

    version.regions.splice(index, 1);
    version.modifiedAt = Date.now();
    this._notifyChange('removeRegion', { versionId, regionId });
    return true;
  }

  /**
   * Update a region's times
   * @param {string} versionId 
   * @param {string} regionId 
   * @param {number} start 
   * @param {number} end 
   * @returns {boolean}
   */
  updateRegion(versionId, regionId, start, end) {
    const version = this.versions.get(versionId);
    if (!version) return false;

    const region = version.regions.find(r => r.id === regionId);
    if (!region) return false;

    region.start = Math.max(0, Math.min(start, this.videoDuration));
    region.end = Math.max(region.start, Math.min(end, this.videoDuration));
    region.duration = region.end - region.start;
    version.modifiedAt = Date.now();

    // Re-sort regions
    version.regions.sort((a, b) => a.start - b.start);

    this._notifyChange('updateRegion', { versionId, region });
    return true;
  }

  /**
   * Reorder regions within a version
   * @param {string} versionId 
   * @param {array} regionIds - Array of region IDs in new order
   * @returns {boolean}
   */
  reorderRegions(versionId, regionIds) {
    const version = this.versions.get(versionId);
    if (!version) return false;

    const newOrder = [];
    for (const id of regionIds) {
      const region = version.regions.find(r => r.id === id);
      if (region) newOrder.push(region);
    }

    // Add any regions not in the list
    for (const region of version.regions) {
      if (!newOrder.includes(region)) {
        newOrder.push(region);
      }
    }

    version.regions = newOrder;
    version.modifiedAt = Date.now();
    this._notifyChange('reorderRegions', { versionId, regions: newOrder });
    return true;
  }

  /**
   * Add regions from markers
   * @param {string} versionId 
   * @param {array} markers - Array of marker objects with inTime/outTime or time
   * @returns {number} Number of regions added
   */
  addRegionsFromMarkers(versionId, markers) {
    let added = 0;

    for (const marker of markers) {
      const start = marker.inTime ?? marker.time ?? marker.start;
      const end = marker.outTime ?? marker.time ?? marker.end ?? start + 1;

      if (start !== undefined && end !== undefined) {
        this.addRegion(versionId, start, end, {
          label: marker.name || marker.description || `Marker ${added + 1}`,
          source: 'marker'
        });
        added++;
      }
    }

    return added;
  }

  // ═══════════════════════════════════════════════════════════
  // LOCALIZATION
  // ═══════════════════════════════════════════════════════════

  /**
   * Create a localized version from an existing version
   * @param {string} sourceVersionId 
   * @param {string} languageCode 
   * @returns {object} The new localized version
   */
  createLocalizedVersion(sourceVersionId, languageCode) {
    const source = this.versions.get(sourceVersionId);
    if (!source) {
      throw new Error(`Source version "${sourceVersionId}" not found`);
    }

    const language = DeploymentVersionManager.LANGUAGES[languageCode];
    if (!language) {
      throw new Error(`Unsupported language: ${languageCode}`);
    }

    const newId = `${sourceVersionId}-${languageCode}`;
    const newName = `${source.name} (${language.name})`;

    // Create new version with same regions
    const version = this.createVersion(newId, source.template, {
      name: newName,
      language: languageCode,
      maxDuration: source.maxDuration
    });

    // Copy regions
    for (const region of source.regions) {
      version.regions.push({ ...region, id: `region_${Date.now()}_${Math.random().toString(36).substr(2, 5)}` });
    }

    console.log(`[DeploymentVersionManager] Created localized version: ${newName}`);
    return version;
  }

  // ═══════════════════════════════════════════════════════════
  // EXPORT
  // ═══════════════════════════════════════════════════════════

  /**
   * Get export specification for a version
   * @param {string} versionId 
   * @returns {object} Export specification for FFmpeg
   */
  getExportSpec(versionId) {
    const version = this.versions.get(versionId);
    if (!version) {
      throw new Error(`Version "${versionId}" not found`);
    }

    const totalDuration = this._calculateDuration(version);
    const languageSuffix = version.language ? `-${version.language}` : '';
    const templateSuffix = version.template !== 'full' ? `-${version.template}` : '';

    return {
      versionId: version.id,
      versionName: version.name,
      template: version.template,
      language: version.language,
      regions: version.regions.map(r => ({
        start: r.start,
        end: r.end,
        duration: r.duration
      })),
      totalDuration,
      outputName: `${this.videoName}${templateSuffix}${languageSuffix}`,
      sourceVideo: this.videoPath,
      needsDubbing: version.language !== null
    };
  }

  /**
   * Get export specs for all versions (for batch export)
   * @returns {array}
   */
  getAllExportSpecs() {
    return this.listVersions()
      .filter(v => v.regions.length > 0)
      .map(v => this.getExportSpec(v.id));
  }

  /**
   * Mark version as exported
   * @param {string} versionId 
   */
  markExported(versionId) {
    const version = this.versions.get(versionId);
    if (version) {
      version.exportedAt = Date.now();
      this._notifyChange('exported', version);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // UTILITIES
  // ═══════════════════════════════════════════════════════════

  /**
   * Calculate total duration of a version's regions
   * @private
   */
  _calculateDuration(version) {
    return version.regions.reduce((sum, r) => sum + (r.end - r.start), 0);
  }

  /**
   * Notify change listener
   * @private
   */
  _notifyChange(action, data) {
    if (this.onVersionChange) {
      this.onVersionChange(action, data);
    }
  }

  /**
   * Serialize all versions for persistence
   * @returns {object}
   */
  serialize() {
    return {
      videoPath: this.videoPath,
      videoDuration: this.videoDuration,
      videoName: this.videoName,
      versions: Array.from(this.versions.entries())
    };
  }

  /**
   * Load versions from serialized data
   * @param {object} data 
   */
  deserialize(data) {
    if (data.versions) {
      this.versions = new Map(data.versions);
    }
  }

  /**
   * Check if version exceeds max duration
   * @param {string} versionId 
   * @returns {object} { exceeds, currentDuration, maxDuration }
   */
  checkDurationLimit(versionId) {
    const version = this.versions.get(versionId);
    if (!version) return { exceeds: false };

    const currentDuration = this._calculateDuration(version);
    const maxDuration = version.maxDuration;

    return {
      exceeds: maxDuration && currentDuration > maxDuration,
      currentDuration,
      maxDuration,
      overBy: maxDuration ? Math.max(0, currentDuration - maxDuration) : 0
    };
  }
}

// Export for both CommonJS and ES modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { DeploymentVersionManager };
}

export { DeploymentVersionManager };


