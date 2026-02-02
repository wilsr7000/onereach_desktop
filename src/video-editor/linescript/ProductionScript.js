/**
 * ProductionScript.js
 * 
 * Professional production script elements: camera angles, shot types,
 * camera movements, and technical directions for screenplay formatting.
 */

/**
 * Camera Angles
 */
export const CAMERA_ANGLES = {
  EYE_LEVEL: {
    id: 'eye-level',
    name: 'Eye Level',
    abbr: 'EL',
    description: 'Camera at subject\'s eye height (neutral, most common)',
    icon: '📷'
  },
  HIGH_ANGLE: {
    id: 'high-angle',
    name: 'High Angle',
    abbr: 'HA',
    description: 'Camera looks down at subject (makes subject appear vulnerable/weak)',
    icon: '📷⬇️'
  },
  LOW_ANGLE: {
    id: 'low-angle',
    name: 'Low Angle',
    abbr: 'LA',
    description: 'Camera looks up at subject (makes subject appear powerful/dominant)',
    icon: '📷⬆️'
  },
  BIRDS_EYE: {
    id: 'birds-eye',
    name: 'Bird\'s Eye View',
    abbr: 'BEV',
    description: 'Camera directly overhead looking down',
    icon: '🦅'
  },
  DUTCH_ANGLE: {
    id: 'dutch-angle',
    name: 'Dutch Angle',
    abbr: 'DUTCH',
    description: 'Camera tilted on axis (creates unease/disorientation)',
    icon: '📷↗️'
  },
  OVER_SHOULDER: {
    id: 'over-shoulder',
    name: 'Over the Shoulder',
    abbr: 'OTS',
    description: 'Camera behind one character looking at another',
    icon: '👤📷'
  },
  POV: {
    id: 'pov',
    name: 'Point of View',
    abbr: 'POV',
    description: 'Camera shows exactly what character sees',
    icon: '👁️'
  }
};

/**
 * Shot Types/Sizes
 */
export const SHOT_TYPES = {
  EXTREME_WIDE: {
    id: 'extreme-wide',
    name: 'Extreme Wide Shot',
    abbr: 'EWS',
    description: 'Establishes location, subject very small in frame',
    icon: '🏞️'
  },
  WIDE: {
    id: 'wide',
    name: 'Wide Shot',
    abbr: 'WS',
    description: 'Subject\'s full body visible, head to toe',
    icon: '🚶'
  },
  MEDIUM_WIDE: {
    id: 'medium-wide',
    name: 'Medium Wide Shot',
    abbr: 'MWS',
    description: 'Waist up, includes some environment',
    icon: '🧍'
  },
  MEDIUM: {
    id: 'medium',
    name: 'Medium Shot',
    abbr: 'MS',
    description: 'Waist to head, focuses on subject',
    icon: '👔'
  },
  MEDIUM_CLOSEUP: {
    id: 'medium-closeup',
    name: 'Medium Close-Up',
    abbr: 'MCU',
    description: 'Chest to head',
    icon: '👤'
  },
  CLOSEUP: {
    id: 'closeup',
    name: 'Close-Up',
    abbr: 'CU',
    description: 'Head and shoulders, emphasizes emotion',
    icon: '😊'
  },
  EXTREME_CLOSEUP: {
    id: 'extreme-closeup',
    name: 'Extreme Close-Up',
    abbr: 'ECU',
    description: 'Just eyes, mouth, or specific detail',
    icon: '👁️'
  },
  INSERT: {
    id: 'insert',
    name: 'Insert',
    abbr: 'INS',
    description: 'Extreme close-up of object (phone screen, written note, etc.)',
    icon: '📱'
  },
  TWO_SHOT: {
    id: 'two-shot',
    name: 'Two-Shot',
    abbr: '2S',
    description: 'Two people in frame',
    icon: '👥'
  },
  THREE_SHOT: {
    id: 'three-shot',
    name: 'Three-Shot',
    abbr: '3S',
    description: 'Three people in frame',
    icon: '👨‍👩‍👦'
  },
  COWBOY: {
    id: 'cowboy',
    name: 'Cowboy Shot',
    abbr: 'CS',
    description: 'Mid-thigh up (Western films)',
    icon: '🤠'
  }
};

/**
 * Camera Movements
 */
export const CAMERA_MOVEMENTS = {
  PAN: {
    id: 'pan',
    name: 'Pan',
    abbr: 'PAN',
    description: 'Camera rotates horizontally on fixed axis',
    icon: '↔️'
  },
  TILT: {
    id: 'tilt',
    name: 'Tilt',
    abbr: 'TILT',
    description: 'Camera rotates vertically on fixed axis',
    icon: '↕️'
  },
  DOLLY: {
    id: 'dolly',
    name: 'Dolly',
    abbr: 'DOLLY',
    description: 'Camera moves forward/backward on tracks',
    icon: '🎬➡️'
  },
  TRACKING: {
    id: 'tracking',
    name: 'Tracking',
    abbr: 'TRACK',
    description: 'Camera follows subject on tracks',
    icon: '🎬➡️'
  },
  TRUCK: {
    id: 'truck',
    name: 'Truck',
    abbr: 'TRUCK',
    description: 'Camera moves left/right parallel to subject',
    icon: '⬅️➡️'
  },
  CRANE: {
    id: 'crane',
    name: 'Crane',
    abbr: 'CRANE',
    description: 'Camera moves up/down on crane',
    icon: '🏗️'
  },
  HANDHELD: {
    id: 'handheld',
    name: 'Handheld',
    abbr: 'HH',
    description: 'Shaky, documentary-style movement',
    icon: '🤳'
  },
  STEADICAM: {
    id: 'steadicam',
    name: 'Steadicam',
    abbr: 'STEDI',
    description: 'Smooth handheld-style movement',
    icon: '🎥'
  },
  ZOOM: {
    id: 'zoom',
    name: 'Zoom',
    abbr: 'ZOOM',
    description: 'Lens zooms in/out (camera doesn\'t move)',
    icon: '🔍'
  },
  WHIP_PAN: {
    id: 'whip-pan',
    name: 'Whip Pan',
    abbr: 'WHIP',
    description: 'Rapid pan creating motion blur',
    icon: '💨'
  },
  PUSH_IN: {
    id: 'push-in',
    name: 'Push In',
    abbr: 'PUSH',
    description: 'Slow dolly toward subject',
    icon: '➡️🎬'
  },
  PULL_OUT: {
    id: 'pull-out',
    name: 'Pull Out',
    abbr: 'PULL',
    description: 'Slow dolly away from subject',
    icon: '⬅️🎬'
  }
};

/**
 * Technical Directions
 */
export const TECHNICAL_DIRECTIONS = {
  ESTABLISHING: {
    id: 'establishing',
    name: 'Establishing Shot',
    abbr: 'EST',
    description: 'Sets location/context for scene',
    icon: '🏙️'
  },
  CUTAWAY: {
    id: 'cutaway',
    name: 'Cutaway',
    abbr: 'CUT',
    description: 'Brief shot of something other than main action',
    icon: '✂️'
  },
  ANGLE_ON: {
    id: 'angle-on',
    name: 'Angle On',
    abbr: 'ANGLE',
    description: 'Camera focuses on specific element',
    icon: '📐'
  },
  BACK_TO_SCENE: {
    id: 'back-to-scene',
    name: 'Back to Scene',
    abbr: 'BTS',
    description: 'Return to main action after cutaway',
    icon: '↩️'
  },
  INTERCUT: {
    id: 'intercut',
    name: 'Intercut',
    abbr: 'INT',
    description: 'Cutting between two simultaneous locations',
    icon: '🔀'
  },
  MONTAGE: {
    id: 'montage',
    name: 'Montage',
    abbr: 'MONT',
    description: 'Series of short shots showing passage of time',
    icon: '🎞️'
  },
  SPLIT_SCREEN: {
    id: 'split-screen',
    name: 'Split Screen',
    abbr: 'SPLIT',
    description: 'Multiple images on screen simultaneously',
    icon: '⬛⬜'
  },
  FREEZE_FRAME: {
    id: 'freeze-frame',
    name: 'Freeze Frame',
    abbr: 'FREEZE',
    description: 'Image stops/holds',
    icon: '⏸️'
  },
  SLOW_MOTION: {
    id: 'slow-motion',
    name: 'Slow Motion',
    abbr: 'SLO-MO',
    description: 'Action slowed down',
    icon: '🐌'
  },
  TIME_LAPSE: {
    id: 'time-lapse',
    name: 'Time Lapse',
    abbr: 'T-LAPSE',
    description: 'Compressed time passage',
    icon: '⏩'
  },
  RACK_FOCUS: {
    id: 'rack-focus',
    name: 'Rack Focus',
    abbr: 'RACK',
    description: 'Shift focus from foreground to background',
    icon: '🔍↔️'
  },
  DEEP_FOCUS: {
    id: 'deep-focus',
    name: 'Deep Focus',
    abbr: 'DEEP',
    description: 'Everything in frame sharp/in focus',
    icon: '🔍✨'
  },
  SHALLOW_FOCUS: {
    id: 'shallow-focus',
    name: 'Shallow Focus',
    abbr: 'SHALLOW',
    description: 'Only subject in focus, background blurred',
    icon: '🔍💫'
  },
  AERIAL: {
    id: 'aerial',
    name: 'Aerial Shot',
    abbr: 'AERIAL',
    description: 'Shot from aircraft/drone',
    icon: '🚁'
  }
};

/**
 * Lighting Notes
 */
export const LIGHTING_NOTES = {
  SILHOUETTE: {
    id: 'silhouette',
    name: 'Silhouette',
    description: 'Subject backlit, appears as dark shape',
    icon: '🌅'
  },
  HIGH_KEY: {
    id: 'high-key',
    name: 'High Key',
    description: 'Bright, even lighting (comedy, upbeat)',
    icon: '💡'
  },
  LOW_KEY: {
    id: 'low-key',
    name: 'Low Key',
    description: 'High contrast, dramatic shadows (thriller, noir)',
    icon: '🌑'
  },
  PRACTICAL: {
    id: 'practical',
    name: 'Practical',
    description: 'Light source visible in frame (lamp, candle)',
    icon: '🕯️'
  },
  MOTIVATED: {
    id: 'motivated',
    name: 'Motivated Lighting',
    description: 'Light justified by visible source',
    icon: '🪟'
  }
};

/**
 * Transitions
 */
export const TRANSITIONS = {
  CUT_TO: {
    id: 'cut-to',
    name: 'Cut To',
    abbr: 'CUT',
    description: 'Standard cut',
    icon: '✂️'
  },
  FADE_IN: {
    id: 'fade-in',
    name: 'Fade In',
    abbr: 'FADE IN',
    description: 'Fade from black',
    icon: '⬛➡️'
  },
  FADE_OUT: {
    id: 'fade-out',
    name: 'Fade Out',
    abbr: 'FADE OUT',
    description: 'Fade to black',
    icon: '➡️⬛'
  },
  DISSOLVE: {
    id: 'dissolve',
    name: 'Dissolve To',
    abbr: 'DISSOLVE',
    description: 'Gradual transition between shots',
    icon: '🌫️'
  },
  SMASH_CUT: {
    id: 'smash-cut',
    name: 'Smash Cut',
    abbr: 'SMASH',
    description: 'Jarring, abrupt cut',
    icon: '💥'
  },
  MATCH_CUT: {
    id: 'match-cut',
    name: 'Match Cut',
    abbr: 'MATCH',
    description: 'Cut matching similar elements',
    icon: '🔗'
  },
  JUMP_CUT: {
    id: 'jump-cut',
    name: 'Jump Cut',
    abbr: 'JUMP',
    description: 'Same subject, time jump',
    icon: '⏭️'
  },
  WIPE: {
    id: 'wipe',
    name: 'Wipe',
    abbr: 'WIPE',
    description: 'One shot replaces another across frame',
    icon: '↔️'
  }
};

/**
 * Production Direction - Main data structure
 */
export class ProductionDirection {
  constructor(data = {}) {
    this.id = data.id || Date.now() + Math.random();
    this.time = data.time || 0;
    this.type = data.type || 'shot'; // 'shot', 'angle', 'movement', 'technical', 'lighting', 'transition'
    
    // References to the specific direction
    this.shotType = data.shotType || null;
    this.cameraAngle = data.cameraAngle || null;
    this.cameraMovement = data.cameraMovement || null;
    this.technicalDirection = data.technicalDirection || null;
    this.lighting = data.lighting || null;
    this.transition = data.transition || null;
    
    // Additional details
    this.description = data.description || '';
    this.notes = data.notes || '';
    this.sceneId = data.sceneId || null;
    
    // Display preferences
    this.showInline = data.showInline !== false;
    this.emphasis = data.emphasis || false; // Bold/highlight important directions
  }
  
  /**
   * Get display text for this direction
   */
  getDisplayText() {
    let parts = [];
    
    if (this.shotType) {
      const shot = Object.values(SHOT_TYPES).find(s => s.id === this.shotType);
      if (shot) parts.push(shot.abbr);
    }
    
    if (this.cameraAngle) {
      const angle = Object.values(CAMERA_ANGLES).find(a => a.id === this.cameraAngle);
      if (angle) parts.push(angle.abbr);
    }
    
    if (this.cameraMovement) {
      const movement = Object.values(CAMERA_MOVEMENTS).find(m => m.id === this.cameraMovement);
      if (movement) parts.push(movement.abbr);
    }
    
    if (this.technicalDirection) {
      const tech = Object.values(TECHNICAL_DIRECTIONS).find(t => t.id === this.technicalDirection);
      if (tech) parts.push(tech.abbr);
    }
    
    if (this.description) {
      parts.push('-', this.description);
    }
    
    return parts.join(' ');
  }
  
  /**
   * Get full name for this direction
   */
  getFullName() {
    let names = [];
    
    if (this.shotType) {
      const shot = Object.values(SHOT_TYPES).find(s => s.id === this.shotType);
      if (shot) names.push(shot.name);
    }
    
    if (this.cameraAngle) {
      const angle = Object.values(CAMERA_ANGLES).find(a => a.id === this.cameraAngle);
      if (angle) names.push(angle.name);
    }
    
    if (this.cameraMovement) {
      const movement = Object.values(CAMERA_MOVEMENTS).find(m => m.id === this.cameraMovement);
      if (movement) names.push(movement.name);
    }
    
    if (this.technicalDirection) {
      const tech = Object.values(TECHNICAL_DIRECTIONS).find(t => t.id === this.technicalDirection);
      if (tech) names.push(tech.name);
    }
    
    return names.join(' + ');
  }
  
  /**
   * Get icon for this direction
   */
  getIcon() {
    if (this.shotType) {
      const shot = Object.values(SHOT_TYPES).find(s => s.id === this.shotType);
      if (shot) return shot.icon;
    }
    
    if (this.cameraAngle) {
      const angle = Object.values(CAMERA_ANGLES).find(a => a.id === this.cameraAngle);
      if (angle) return angle.icon;
    }
    
    if (this.cameraMovement) {
      const movement = Object.values(CAMERA_MOVEMENTS).find(m => m.id === this.cameraMovement);
      if (movement) return movement.icon;
    }
    
    if (this.technicalDirection) {
      const tech = Object.values(TECHNICAL_DIRECTIONS).find(t => t.id === this.technicalDirection);
      if (tech) return tech.icon;
    }
    
    return '🎬';
  }
  
  /**
   * Serialize to JSON
   */
  toJSON() {
    return {
      id: this.id,
      time: this.time,
      type: this.type,
      shotType: this.shotType,
      cameraAngle: this.cameraAngle,
      cameraMovement: this.cameraMovement,
      technicalDirection: this.technicalDirection,
      lighting: this.lighting,
      transition: this.transition,
      description: this.description,
      notes: this.notes,
      sceneId: this.sceneId,
      showInline: this.showInline,
      emphasis: this.emphasis
    };
  }
  
  /**
   * Create from JSON
   */
  static fromJSON(json) {
    return new ProductionDirection(json);
  }
}

/**
 * Production Script Manager - Handles collection of directions
 */
export class ProductionScriptManager {
  constructor() {
    this.directions = [];
    this.eventListeners = {};
  }
  
  /**
   * Add a direction
   */
  addDirection(direction) {
    if (!(direction instanceof ProductionDirection)) {
      direction = new ProductionDirection(direction);
    }
    
    this.directions.push(direction);
    this.directions.sort((a, b) => a.time - b.time);
    
    this.emit('directionAdded', { direction });
    return direction;
  }
  
  /**
   * Update a direction
   */
  updateDirection(id, updates) {
    const direction = this.directions.find(d => d.id === id);
    if (!direction) return null;
    
    Object.assign(direction, updates);
    this.emit('directionUpdated', { direction });
    return direction;
  }
  
  /**
   * Delete a direction
   */
  deleteDirection(id) {
    const index = this.directions.findIndex(d => d.id === id);
    if (index === -1) return false;
    
    const direction = this.directions[index];
    this.directions.splice(index, 1);
    
    this.emit('directionDeleted', { id, direction });
    return true;
  }
  
  /**
   * Get all directions
   */
  getAll() {
    return [...this.directions];
  }
  
  /**
   * Get directions in a time range
   */
  getInRange(startTime, endTime) {
    return this.directions.filter(d => d.time >= startTime && d.time <= endTime);
  }
  
  /**
   * Get direction at specific time (within threshold)
   */
  getAtTime(time, threshold = 0.5) {
    return this.directions.find(d => Math.abs(d.time - time) < threshold);
  }
  
  /**
   * Clear all directions
   */
  clear() {
    this.directions = [];
    this.emit('cleared');
  }
  
  /**
   * Export to JSON
   */
  toJSON() {
    return {
      directions: this.directions.map(d => d.toJSON())
    };
  }
  
  /**
   * Import from JSON
   */
  fromJSON(json) {
    this.clear();
    if (json.directions) {
      json.directions.forEach(d => {
        this.addDirection(ProductionDirection.fromJSON(d));
      });
    }
  }
  
  // Event emitter methods
  on(event, callback) {
    if (!this.eventListeners[event]) {
      this.eventListeners[event] = [];
    }
    this.eventListeners[event].push(callback);
  }
  
  emit(event, data = {}) {
    if (this.eventListeners[event]) {
      this.eventListeners[event].forEach(callback => callback(data));
    }
  }
  
  off(event, callback) {
    if (this.eventListeners[event]) {
      this.eventListeners[event] = this.eventListeners[event].filter(cb => cb !== callback);
    }
  }
}

export default {
  CAMERA_ANGLES,
  SHOT_TYPES,
  CAMERA_MOVEMENTS,
  TECHNICAL_DIRECTIONS,
  LIGHTING_NOTES,
  TRANSITIONS,
  ProductionDirection,
  ProductionScriptManager
};
