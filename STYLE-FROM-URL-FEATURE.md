# Style from URL Feature

## Overview
The "Style from URL" feature allows users to extract and analyze design styles from one or more websites and apply them to their smart export documents. This helps create consistent branding and styling based on existing websites.

## How It Works

### User Interface
1. Click the "🌐 Style from URL" button in the smart export preview toolbar
2. Enter one or more website URLs to analyze
3. Select which style elements to extract:
   - Color palette
   - Typography (fonts, sizes, weights)
   - Spacing system
   - Component styles (buttons, cards, etc.)
4. Click "Analyze Styles" to process the websites

### Analysis Process
The system uses an Electron BrowserWindow to:
1. Load each website in a hidden window
2. Execute JavaScript to analyze computed styles
3. Extract and aggregate common design patterns
4. Generate CSS variables and styles based on the analysis

### Style Elements Extracted

#### Colors
- Background colors
- Text colors
- Border colors
- Excludes pure black (#000000) and white (#ffffff)
- Returns top 10 most frequently used colors

#### Typography
- Font families
- Font sizes
- Font weights
- Returns top 3 most used font families

#### Spacing
- Padding values
- Margin values
- Mapped to a standardized spacing scale (xs, sm, md, lg, xl, xxl)

#### Components
- Button styles (padding, border-radius, colors)
- Card styles (padding, border-radius, box-shadow)

### Generated CSS
The analyzer generates CSS with:
- CSS custom properties (variables) for colors, fonts, and spacing
- Component-specific styles
- Responsive design considerations

### Application
Once analyzed, users can:
- Preview the extracted styles
- Apply them to the current export
- The styles are injected as a `<style>` tag in the HTML document

## Technical Implementation

### Files Modified
1. `smart-export-preview.html` - Added UI for the feature
2. `preload.js` - Added `analyzeWebsiteStyles` API method
3. `main.js` - Added IPC handler for style analysis
4. `web-style-analyzer.js` - Core analysis module

### Security Considerations
- Uses a separate BrowserWindow with `webSecurity: false` to allow cross-origin analysis
- Runs in an isolated context
- No user data is exposed to analyzed websites

## Future Enhancements
1. Save analyzed styles as reusable templates
2. More sophisticated color palette extraction (dominant colors, color relationships)
3. Extract more component types (headers, forms, navigation)
4. AI-powered style recommendations
5. Export styles as a separate CSS file
6. Support for analyzing password-protected sites 