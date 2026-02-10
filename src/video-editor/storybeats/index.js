/**
 * Story Beats Module - Full-page transcript-based video editing
 * 
 * Components:
 * - StoryBeatsEditor: Full-page text editor with word rendering and selection
 * - EditToolbar: Floating toolbar for edit actions
 * - VideoSyncEngine: Edit queue and video sync management
 * - MiniTimeline: Compact preview timeline showing edits
 * - NotesPanel: Production notes management (director, supervisor, technical, takes)
 */

import { StoryBeatsEditor } from './StoryBeatsEditor.js';
import { EditToolbar } from './EditToolbar.js';
import { VideoSyncEngine } from './VideoSyncEngine.js';
import { MiniTimeline } from './MiniTimeline.js';
import { NotesPanel } from './NotesPanel.js';

export { StoryBeatsEditor, EditToolbar, VideoSyncEngine, MiniTimeline, NotesPanel };

/**
 * Initialize all story beats components
 */
export function initStoryBeats(appContext) {
  // Create instances
  appContext.storyBeatsEditor = new StoryBeatsEditor(appContext);
  appContext.storyBeatsToolbar = new EditToolbar(appContext);
  appContext.videoSyncEngine = new VideoSyncEngine(appContext);
  appContext.storyBeatsMiniTimeline = new MiniTimeline(appContext);
  
  window.logging.info('video', 'StoryBeats Module initialized');
  
  return {
    editor: appContext.storyBeatsEditor,
    toolbar: appContext.storyBeatsToolbar,
    syncEngine: appContext.videoSyncEngine,
    miniTimeline: appContext.storyBeatsMiniTimeline
  };
}


