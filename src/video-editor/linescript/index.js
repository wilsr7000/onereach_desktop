/**
 * Line Script Module Index
 * 
 * Enhanced Line Script System with:
 * - Content-type templates (Podcast, Product, Promo, Learning)
 * - Progressive AI metadata generation
 * - Voice and keyboard spotting
 * - Hook detection, ZZZ detection, Energy analysis
 * - Custom beat prompts
 * - Project rating and progress tracking
 */

// Core components
export { LineScriptPanel, VIEW_MODES } from './LineScriptPanel.js';
export { AdaptiveModeManager, CONTEXT_SIGNALS } from './AdaptiveModeManager.js';
export { ContentTemplates, CONTENT_TEMPLATES, getTemplate, getAllTemplates, getMarkerTypes, getVoiceCommands, getKeyboardShortcuts, getAIPrompts, getExportFormats, getRatingCriteria, getUIConfig, suggestTemplate } from './ContentTemplates.js';

// AI components
export { LineScriptAI } from './LineScriptAI.js';
export { QuoteFinder } from './QuoteFinder.js';

// Detector components
export { HookDetector } from './HookDetector.js';
export { ZZZDetector } from './ZZZDetector.js';
export { EnergyAnalyzer } from './EnergyAnalyzer.js';
export { CustomBeatPrompts, BEAT_TEMPLATE_LIBRARY, BEAT_CATEGORIES } from './CustomBeatPrompts.js';

// Spotting components
export { SpottingController } from './SpottingController.js';
export { VoiceSpottingController } from './VoiceSpottingController.js';

// Rating components
export { ProjectRating } from './ProjectRating.js';
export { RatingStorage } from './RatingStorage.js';

// Export presets
export { ExportPresets, EXPORT_FORMATS } from './ExportPresets.js';

// Bridge for integration with video editor
export { initLineScriptBridge } from './LineScriptBridge.js';

/**
 * Initialize all Line Script modules for an app context
 * @param {object} appContext - The main app object
 * @returns {object} Object with all initialized modules
 */
export function initLineScriptModules(appContext) {
  // Create rating storage first (no dependencies)
  const ratingStorage = new (require('./RatingStorage.js').RatingStorage)();
  
  // Create content templates
  const contentTemplates = new (require('./ContentTemplates.js').ContentTemplates)();
  
  // Create panel (core UI)
  const LineScriptPanel = require('./LineScriptPanel.js').LineScriptPanel;
  const lineScriptPanel = new LineScriptPanel(appContext);
  
  // Create mode manager
  const AdaptiveModeManager = require('./AdaptiveModeManager.js').AdaptiveModeManager;
  const adaptiveModeManager = new AdaptiveModeManager(lineScriptPanel);
  
  // Create AI components
  const LineScriptAI = require('./LineScriptAI.js').LineScriptAI;
  const lineScriptAI = new LineScriptAI(appContext, lineScriptPanel);
  
  const QuoteFinder = require('./QuoteFinder.js').QuoteFinder;
  const quoteFinder = new QuoteFinder(appContext);
  
  // Create detectors
  const HookDetector = require('./HookDetector.js').HookDetector;
  const hookDetector = new HookDetector(appContext);
  
  const ZZZDetector = require('./ZZZDetector.js').ZZZDetector;
  const zzzDetector = new ZZZDetector(appContext);
  
  const EnergyAnalyzer = require('./EnergyAnalyzer.js').EnergyAnalyzer;
  const energyAnalyzer = new EnergyAnalyzer(appContext);
  
  const CustomBeatPrompts = require('./CustomBeatPrompts.js').CustomBeatPrompts;
  const customBeatPrompts = new CustomBeatPrompts(appContext);
  
  // Create spotting controllers
  const SpottingController = require('./SpottingController.js').SpottingController;
  const spottingController = new SpottingController(lineScriptPanel);
  
  const VoiceSpottingController = require('./VoiceSpottingController.js').VoiceSpottingController;
  const voiceSpottingController = new VoiceSpottingController(lineScriptPanel);
  
  // Create rating system
  const ProjectRating = require('./ProjectRating.js').ProjectRating;
  const projectRating = new ProjectRating(appContext, ratingStorage);
  
  // Attach to app context
  appContext.lineScriptPanel = lineScriptPanel;
  appContext.adaptiveModeManager = adaptiveModeManager;
  appContext.contentTemplates = contentTemplates;
  appContext.lineScriptAI = lineScriptAI;
  appContext.quoteFinder = quoteFinder;
  appContext.hookDetector = hookDetector;
  appContext.zzzDetector = zzzDetector;
  appContext.energyAnalyzer = energyAnalyzer;
  appContext.customBeatPrompts = customBeatPrompts;
  appContext.spottingController = spottingController;
  appContext.voiceSpottingController = voiceSpottingController;
  appContext.projectRating = projectRating;
  appContext.ratingStorage = ratingStorage;
  
  return {
    lineScriptPanel,
    adaptiveModeManager,
    contentTemplates,
    lineScriptAI,
    quoteFinder,
    hookDetector,
    zzzDetector,
    energyAnalyzer,
    customBeatPrompts,
    spottingController,
    voiceSpottingController,
    projectRating,
    ratingStorage
  };
}

/**
 * Module version
 */
export const VERSION = '1.0.0';

/**
 * Feature flags
 */
export const FEATURES = {
  TEMPLATES: true,
  PROGRESSIVE_AI: true,
  VOICE_SPOTTING: true,
  ADAPTIVE_MODES: true,
  HOOK_DETECTION: true,
  ZZZ_DETECTION: true,
  ENERGY_ANALYSIS: true,
  CUSTOM_BEATS: true,
  PROJECT_RATING: true,
  QUOTE_FINDER: true
};


