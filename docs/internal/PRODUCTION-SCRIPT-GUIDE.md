# Production Script System - Quick Start Guide

The Production Script system adds professional camera angles, shot types, and technical directions to your Line Script transcripts with timecode integration.

## Features

### Camera Elements

All professional production elements are integrated with **timecodes** so every camera direction is precisely tied to video time:

#### Camera Angles
- **Eye Level** - Neutral camera height
- **High Angle** - Camera looks down (subject appears vulnerable)
- **Low Angle** - Camera looks up (subject appears powerful)
- **Bird's Eye View** - Overhead shot
- **Dutch Angle** - Tilted camera for unease
- **Over the Shoulder (OTS)** - Behind one person looking at another
- **POV** - Point of view shot

#### Shot Types
- **Extreme Wide Shot (EWS)** - Establishing location
- **Wide Shot (WS)** - Full body
- **Medium Wide (MWS)** - Waist up
- **Medium Shot (MS)** - Waist to head
- **Medium Close-Up (MCU)** - Chest to head
- **Close-Up (CU)** - Head and shoulders
- **Extreme Close-Up (ECU)** - Eyes, mouth, detail
- **Insert** - Object close-up (phone, note, etc.)
- **Two-Shot / Three-Shot** - Multiple people
- **Cowboy Shot** - Mid-thigh up

#### Camera Movements
- **Pan** - Horizontal rotation
- **Tilt** - Vertical rotation
- **Dolly/Tracking** - Move forward/back on tracks
- **Truck** - Move left/right
- **Crane** - Up/down movement
- **Handheld** - Documentary style
- **Steadicam** - Smooth handheld
- **Zoom** - Lens zoom
- **Whip Pan** - Fast pan with blur
- **Push In / Pull Out** - Slow dolly

#### Technical Directions
- **Establishing Shot** - Set location
- **Cutaway** - Brief alternate shot
- **Angle On** - Focus on specific element
- **Intercut** - Cutting between locations
- **Montage** - Time passage series
- **Split Screen** - Multiple images
- **Freeze Frame** - Hold image
- **Slow Motion** - Slowed action
- **Time Lapse** - Compressed time
- **Rack Focus** - Shift focus
- **Aerial** - Drone/aircraft shot

## How to Use

### 1. Access Production Mode

In the Video Editor's Line Script panel:
1. Click the **🎬 PRODUCTION** mode button in the view mode selector
2. You'll see a sidebar with camera/shot options and the main script display

### 2. Add Camera Directions

**Using the Sidebar:**
1. Choose a category tab (Shots, Angles, Movement, Technical)
2. Click any button to add that direction at the current video time
3. Optionally add a description in the text field
4. Click "Add Direction" to save

**While Watching:**
- Play your video
- When you reach a point that needs a camera direction, pause
- Select the direction type from the sidebar
- It's automatically added at the current timecode

### 3. Production Script Display

Your transcript is shown in professional screenplay format:

```
SCENE 1 - INT. OFFICE - DAY [00:15.3 → 02:45.8]

1   [00:15.3]  📷 EWS  ESTABLISHING SHOT - Wide Angle
2   [00:18.5]  😊 CU   CLOSE-UP
    Rain streams down the window.

DETECTIVE MARTINEZ
3   [00:22.1] Three bodies. No witnesses.

4   [00:28.3]  🎬 TRACK  TRACKING SHOT - Following subject

MARTINEZ (cont'd)
5   [00:35.7] I know who it is.

6   [00:42.1]  📱 INS  INSERT - Phone screen
```

**Every line shows:**
- Line number
- **Timecode** (MM:SS.f format)
- Content (camera direction or dialogue)
- Icon and abbreviation for directions

### 4. Export Options

Click the toolbar buttons to export:

- **📤 Export Production Script** - Full formatted script with all directions
- **📋 Export Shot List** - CSV with shot #, timecode, type, description
- **📊 Export Camera Report** - Statistics and breakdown by shot type

### 5. Storage

Production directions are automatically saved to your project and reload when you reopen the video.

## Production Templates

Choose a template optimized for your content type:

### 🎬 Narrative / Fiction
- Full camera coverage
- Emphasis on dramatic angles
- Scene-based organization
- Lighting and emotion notes

### 🎥 Documentary
- Observational shots
- Interview coverage
- B-roll markers
- Natural/handheld style

### 📺 Commercial / Promo
- Product beauty shots
- Brand moments
- CTA markers
- Lifestyle context

## Keyboard Shortcuts

While in Production mode:

- **Space** - Play/Pause
- **C** - Add camera direction (selected type)
- **I** - Set IN point
- **O** - Set OUT point
- **Click any direction** - Jump to that timecode
- **Click any dialogue line** - Seek to that time

## Tips

1. **Watch First, Mark Second** - Play through your video once to understand the flow, then go back and add camera directions

2. **Start with Scenes** - Use range markers to define scenes, then add camera directions within each scene

3. **Essential Directions Only** - Only mark directions that matter for production - don't over-specify

4. **Use Descriptions** - Add brief descriptions to camera directions for context ("Product reveal", "Hero enters", etc.)

5. **Export Early** - Export your shot list and production script to share with your team

## Integration with Line Script

Production directions work alongside your existing Line Script features:
- **Markers** - Scene boundaries appear as headers
- **Transcript** - Dialogue appears in screenplay format
- **Speakers** - Speaker cues are formatted correctly
- **Timecodes** - Everything is precisely timed

## File Format

Production directions are stored as JSON and can be:
- Exported to share with other team members
- Imported to restore directions
- Version controlled with your project

## Next Steps

1. Switch to PRODUCTION mode in your Line Script panel
2. Load a video with transcript
3. Start adding camera directions
4. Export your production script

---

**Need Help?**
- Check `src/video-editor/linescript/ProductionScript.js` for data structures
- See `src/video-editor/linescript/ProductionScriptUI.js` for UI components
- Review `src/video-editor/linescript/LineScriptPanel.js` for integration

The production script system is fully integrated with your existing Video Editor workflow!
