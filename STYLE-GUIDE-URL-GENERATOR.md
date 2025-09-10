# Style Guide URL Generator - Complete Workflow

## Overview
The Style Guide URL Generator provides a complete workflow for creating, reviewing, saving, and managing CSS style guides from website URLs or manual CSS input.

## Complete Workflow

### 1. Creating a Style Guide

#### From URLs:
1. Click the style guide dropdown and select "➕ Add New Style..."
2. Enter a name for your style guide
3. Switch to the "🌐 Generate from URLs" tab
4. Enter one or more website URLs (e.g., apple.com, stripe.com)
5. Select which elements to extract:
   - Color palette
   - Typography
   - Spacing system
   - Component styles
6. Click "Analyze & Save"
7. Review the extracted styles (colors, fonts, etc.)
8. See the generated CSS in the preview box
9. Click "✏️ Edit" to modify the CSS if needed
10. Click "Save Style Guide" to save

#### From Manual CSS:
1. Click the style guide dropdown and select "➕ Add New Style..."
2. Enter a name for your style guide
3. Stay on the "📋 Paste CSS" tab
4. Paste your CSS code
5. Click "Save Style Guide"

### 2. Managing Saved Style Guides

When you click on a saved style guide in the dropdown, a context menu appears with options:

#### ✓ Apply to Export
- Immediately applies the style guide to your current export
- The styles are embedded in the document

#### 👁️ View/Edit CSS
- Opens a modal showing the complete CSS
- Displays metadata (creation date, source URLs if generated)
- Click "✏️ Edit" to modify the CSS
- Click "💾 Save Changes" to update the style guide
- Click "✓ Apply to Export" to use it immediately

#### 📄 View Style Guide
- Opens the style guide preview with your custom styles applied
- Shows how your CSS affects all components
- Dynamic color palette updates based on your CSS variables
- Same preview format as the default style guide
- Window title shows your style guide name

#### 🗑️ Delete
- Removes the style guide permanently
- Asks for confirmation before deletion

### 3. Viewing the Style Guide Documentation
- Select "👁️ View Style Guide" from the dropdown
- Opens the style guide documentation in a new window
- Shows all available styles with visual examples
- Includes live CSS editor for experimentation

## Features

### Smart Style Extraction
- Analyzes website styles intelligently
- Prioritizes visible elements
- Tracks color frequency to find dominant colors
- Extracts detailed component properties
- Cleans up font family names
- Generates comprehensive CSS with variables

### CSS Preview & Editing
- Syntax-highlighted CSS preview
- Inline editor for modifications
- Edit generated CSS before saving
- Edit saved style guides anytime
- Changes are saved persistently

### Style Guide Tab
- New "Style Guide" tab between "Source Code" and "AI Thinking"
- Shows the currently active style guide CSS
- Displays style guide name
- Copy button to quickly copy CSS to clipboard
- Updates automatically when styles change

### Organization
- Saved style guides show icons:
  - 🌐 = Generated from URLs
  - 📝 = Manually created
- Dropdown shows count of saved guides
- Metadata tracking (creation date, source URLs)

## Generated CSS Structure

```css
/* Custom Style Guide Generated from URLs */

:root {
  /* Colors */
  --color-primary: #3b82f6;
  --color-secondary: #10b981;
  --color-text: #2C2C2C;
  --color-background: #F5F2ED;
  
  /* Typography */
  --font-heading: Inter, sans-serif;
  --font-body: Roboto, sans-serif;
  
  /* Font Sizes */
  --font-size-xs: 0.75rem;
  --font-size-sm: 0.875rem;
  --font-size-base: 1rem;
  --font-size-lg: 1.125rem;
  --font-size-xl: 1.5rem;
  --font-size-2xl: 2rem;
  --font-size-3xl: 3rem;
  
  /* Spacing */
  --spacing-xs: 0.25rem;
  --spacing-sm: 0.5rem;
  --spacing-md: 1rem;
  --spacing-lg: 2rem;
  --spacing-xl: 3rem;
  --spacing-xxl: 4rem;
}

/* Document Styles */
.smart-export-document {
  font-family: var(--font-body);
  color: var(--color-text);
  line-height: 1.6;
}

/* Typography */
h1, h2, h3, h4, h5, h6 {
  font-family: var(--font-heading);
  font-weight: 600;
  line-height: 1.2;
  margin-bottom: var(--spacing-md);
}

/* Component Styles */
.content-card {
  background: var(--color-background);
  border: 1px solid var(--color-secondary);
  border-radius: 8px;
  padding: var(--spacing-lg);
  margin-bottom: var(--spacing-lg);
}

/* ... more styles ... */
```

## Tips for Best Results

### Choosing Reference Sites
- Select websites with clear, consistent design systems
- Popular sites like Apple, Stripe, Airbnb often have well-defined styles
- Avoid sites with inline styles or poor CSS organization

### Multiple URLs
- Analyze 2-3 similar sites to get a more comprehensive palette
- The analyzer will merge and deduplicate common styles
- More URLs = more complete style extraction

### Editing Strategy
- Review the generated CSS before saving
- Adjust color variable names to be semantic (e.g., `--color-primary` → `--color-brand`)
- Add custom styles specific to your needs
- Remove unnecessary styles to keep it clean

### Organization Tips
- Name style guides descriptively (e.g., "Corporate Blue Theme", "Minimalist Dark")
- Create multiple style guides for different purposes
- Update existing guides rather than creating duplicates

## Technical Details

### Style Extraction Process
1. Creates a hidden browser window for each URL
2. Waits for page to fully render
3. Analyzes computed styles of all visible elements
4. Weights elements by importance (body, headings get higher priority)
5. Tracks color frequency to identify primary palette
6. Extracts component-specific styles (buttons, cards, headers)
7. Generates organized CSS with CSS variables

### What Gets Extracted
- **Colors**: Background, text, borders (excluding pure black/white)
- **Fonts**: Font families, sizes, weights (prioritizes body and headings)
- **Spacing**: Padding and margin values (excludes negative values)
- **Components**: Buttons, cards, headers with their specific properties

### Storage
- Style guides are stored in the app's user data directory
- Persisted as JSON with CSS and metadata
- Survives app updates and restarts

## Troubleshooting

### "Failed to analyze website styles"
- Check the URL is accessible
- Some sites block automated access
- Try a different site or use manual CSS

### Missing Styles
- Site may use inline styles or CSS-in-JS
- Complex sites may require manual CSS additions
- Use the editor to add missing styles

### Poor Color Extraction
- Site may use CSS variables or gradients
- Manually adjust colors in the editor
- Use browser dev tools to find specific colors

### Style Guide Not Applying
- Check for CSS syntax errors
- Ensure CSS selectors match your document structure
- Try applying to a fresh export

## Keyboard Shortcuts
- `Escape` - Close any open modal
- `Ctrl/Cmd + S` - Save changes (when editing)

## Best Practices
1. Start with URL generation for a base style
2. Edit to refine and customize
3. Save with descriptive names
4. Test on actual exports
5. Update rather than recreate when possible
6. Keep style guides focused and purposeful

# Style Guide URL Generator

This feature allows users to generate custom CSS style guides by analyzing the design of existing websites.

## How It Works

The system provides two types of style extraction from URLs:

### 1. CSS Style Extraction (Visual Styles)
Extracts visual design elements like colors, fonts, spacing, and component styles from any website.

### 2. Content Guidelines Extraction (Writing Styles)
**NEW!** Extracts content writing guidelines including tone, formatting rules, terminology, and document structure from style guide URLs.

## Content Guidelines Extraction

### Two-Step Process

1. **Extract Guidelines**: Fetch and analyze key style guidelines from a style guide URL
2. **Apply Guidelines**: Use the extracted guidelines when generating content

### What Gets Extracted

When you provide a style guide URL, the system analyzes:

- **Tone & Voice**: Formal/casual, first/third person, active/passive voice
- **Formatting Rules**: Heading case, punctuation, Oxford comma usage
- **Terminology**: Frequently used terms and their proper usage
- **Document Structure**: Section patterns, hierarchy preferences  
- **Citation Styles**: APA, Chicago, numbered references

### How to Use

1. Click the **📋 Content Guidelines** button in the export preview
2. Enter the URL of a publicly accessible style guide
3. Click **Extract Guidelines** to analyze the page
4. Review the extracted guidelines
5. Check **Apply these guidelines** to use them in content generation
6. Click **Regenerate** to create content following these guidelines

### Requirements

- The URL must be publicly accessible (no login required)
- Works best with actual style guide pages, not general content pages
- Large style guides may be processed in sections

### Example URLs

Good sources for content guidelines:
- Organization style guides
- Editorial guidelines
- Brand voice documents
- Writing standards pages
- Documentation style guides

## CSS Style Extraction (Original Feature)

### User Workflow

1. From the Export Preview window, users can:
   - Select "Add New Style..." from the style guide dropdown
   - Choose "From Website URLs" tab
   - Enter one or more website URLs
   - Click "Analyze Styles" to extract design patterns

2. The system analyzes:
   - Color palettes (primary, secondary, text, background colors)
   - Typography (font families, sizes, weights)
   - Spacing patterns
   - Component styles (buttons, cards, headers)

3. Generated CSS includes:
   - CSS custom properties (variables) for consistent theming
   - Typography styles with proper hierarchy
   - Component classes matching the analyzed design
   - Utility classes for common patterns

4. Users can:
   - Preview the generated CSS
   - Edit the CSS before saving
   - Save as a reusable style guide
   - Apply immediately to their export

## Technical Implementation

### CSS Style Analyzer (`web-style-analyzer.js`)
- Creates a hidden browser window to load target websites
- Injects JavaScript to analyze computed styles
- Extracts design tokens and patterns
- Generates organized CSS output

### Content Style Analyzer (`content-style-analyzer.js`)
- Loads style guide pages in a hidden browser window
- Extracts text content and structure
- Analyzes patterns for:
  - Tone indicators and voice preferences
  - Formatting rules and conventions
  - Frequently used terminology
  - Document structure patterns
  - Citation formats
- Returns structured guidelines for content generation

### Integration (`smart-export.js`)
Both analyzers integrate with the smart export system:
- CSS styles are applied to the visual presentation
- Content guidelines inform the AI content generation
- Users can combine both for comprehensive style matching

## Benefits

1. **Brand Consistency**: Match existing brand guidelines automatically
2. **Time Saving**: No manual CSS writing required
3. **Learning Tool**: See how professional sites structure their styles
4. **Flexibility**: Edit generated styles before applying
5. **Reusability**: Save style guides for future exports
6. **Comprehensive Styling**: Both visual design and content writing covered

## Security & Privacy

- All analysis happens locally in isolated browser contexts
- No data is sent to external servers
- Only publicly accessible content is analyzed
- Temporary browser windows are closed after analysis

## Future Enhancements

- Support for authenticated/private style guides
- Batch processing of multiple style guide URLs
- AI-powered style guide merging
- Export/import of guideline sets
- Integration with popular style guide formats (APA, MLA, Chicago) 