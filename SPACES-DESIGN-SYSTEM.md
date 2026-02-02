# Spaces Design System

**Design Philosophy: Tufte Principles**

This design system follows Edward Tufte's data visualization principles:
1. **Maximize data-ink ratio** - Every visual element serves a purpose
2. **Data density** - More information in less space
3. **Small multiples** - Consistent, recognizable patterns
4. **No chartjunk** - Clean, functional design
5. **Clear hierarchy** - Visual structure follows information structure

## Visual Language

### Typography
- **Font Family**: Gill Sans (primary), Calibri (fallback) - humanist sans-serif with excellent legibility
- **Hierarchy**: 
  - Headers: 14px, weight 400, letter-spacing 0.02em
  - Body: 12px, weight 400
  - Captions: 11px, weight 400, uppercase
  - Labels: 10px, weight 400
- **Color**: 
  - Primary text: #111 (near black)
  - Secondary text: #555 (medium gray)
  - Tertiary text: #888 (light gray)

### Color Palette
- **Background**: #fafafa (off-white) - reduces eye strain
- **Surface**: #fff (white) - cards and panels
- **Lines**: #ddd (light gray) - borders and dividers
- **Emphasis**: #111 (black) - active states
- **Error**: #d32f2f (red) - warnings and errors

### Spacing
- Base unit: 4px
- Small: 8px (2 units)
- Medium: 12px (3 units)
- Large: 16px (4 units)
- XL: 20px (5 units)

### Borders
- Width: 1px (standard), 2px (emphasis)
- Radius: 2px (minimal, just enough to soften)
- Color: #ddd (light), #666 (hover), #111 (active)

## Icon System

### Design Principles
1. **Geometric primitives** - circles, squares, triangles, lines
2. **1.5px stroke weight** - consistent line weight
3. **24x24 viewport** - standard icon size
4. **No fills** - outline only for clarity
5. **Minimal details** - only essential features

### Content Type Icons

#### File
```svg
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
  <polyline points="14 2 14 8 20 8"/>
</svg>
```
**Use for**: Documents, PDFs, generic files

#### Image
```svg
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
  <rect x="3" y="3" width="18" height="18" rx="2"/>
  <circle cx="8.5" cy="8.5" r="1.5"/>
  <polyline points="21 15 16 10 5 21"/>
</svg>
```
**Use for**: Photos, graphics, PNG, JPG, SVG

#### Text
```svg
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
  <path d="M4 7h16M4 12h16M4 17h10"/>
</svg>
```
**Use for**: Plain text, markdown, notes

#### Code
```svg
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
  <polyline points="16 18 22 12 16 6"/>
  <polyline points="8 6 2 12 8 18"/>
</svg>
```
**Use for**: Source code, JSON, configuration files

#### HTML/Web
```svg
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
  <polyline points="16 18 22 12 16 6"/>
  <polyline points="8 6 2 12 8 18"/>
  <line x1="12" y1="2" x2="12" y2="22"/>
</svg>
```
**Use for**: HTML, CSS, web content

#### Video
```svg
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
  <rect x="2" y="5" width="20" height="14" rx="2"/>
  <polygon points="10 8 16 12 10 16"/>
</svg>
```
**Use for**: Video files, clips, recordings

#### Audio
```svg
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
  <path d="M9 18V5l12-2v13"/>
  <circle cx="6" cy="18" r="3"/>
  <circle cx="18" cy="16" r="3"/>
</svg>
```
**Use for**: Audio files, music, podcasts

### Space/Container Icons

#### Space (default)
```svg
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
  <circle cx="12" cy="12" r="8"/>
</svg>
```
**Use for**: Generic space/collection

#### Folder
```svg
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
</svg>
```
**Use for**: Smart folders, collections

### State Icons

#### Empty
```svg
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
  <rect x="3" y="3" width="18" height="18" rx="2"/>
  <line x1="9" y1="9" x2="15" y2="15"/>
  <line x1="15" y1="9" x2="9" y2="15"/>
</svg>
```
**Use for**: No items, empty state

#### Warning
```svg
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
  <line x1="12" y1="9" x2="12" y2="13"/>
  <line x1="12" y1="17" x2="12.01" y2="17"/>
</svg>
```
**Use for**: Errors, warnings, alerts

## Layout Patterns

### Grid System
- **Dense grid**: 100px minimum column width
- **Auto-fill**: Responsive columns that fill available space
- **Gap**: 12px between items
- **Padding**: 16px around grid

### List Items
- **Height**: 32px (4 units) per item
- **Padding**: 8px vertical, 12px horizontal
- **Grid**: icon (20px) | text (flex) | count (auto)
- **Gap**: 8px between elements

### Cards
- **Padding**: 10px horizontal, 8px vertical
- **Border**: 1px solid #e0e0e0
- **Min height**: 80px
- **Content**: icon (28px) + label (10px, 2 lines max)

## Interaction States

### Hover
- Border color: #666
- Background: #f5f5f5 (lists)
- No transitions - immediate feedback

### Active/Selected
- Border: 2px solid #111
- Background: #f5f5f5 (or #111 with white text for navigation)
- Text: #fff (for dark backgrounds)

### Disabled
- Opacity: 0.3
- Cursor: not-allowed
- Color: #999

### Focus
- Border: 1px solid #666
- Box shadow: inset 0 0 0 1px #666

## Components

### Search Input
```css
.search-box {
  padding: 6px 10px;
  background: #fff;
  border: 1px solid #ccc;
  border-radius: 2px;
  font-size: 12px;
  width: 180px;
}
```

### Button
```css
button {
  padding: 6px 12px;
  border: 1px solid #ccc;
  border-radius: 2px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
```

### Tab/Filter
```css
.filter-btn {
  padding: 4px 12px;
  border-bottom: 2px solid transparent;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.filter-btn.active {
  border-bottom-color: #111;
}
```

## Data Presentation

### Principles
1. **Tabular nums**: Use `font-variant-numeric: tabular-nums` for counts
2. **Tight leading**: Line height 1.3-1.4 for dense data
3. **Ellipsis**: Truncate long text with `text-overflow: ellipsis`
4. **Max lines**: Use `-webkit-line-clamp` for multi-line truncation

### Counts and Numbers
- Position: Right-aligned
- Color: #888 (secondary)
- Size: 10-11px
- Font variant: Tabular nums

## Accessibility

### Contrast
- All text meets WCAG AA standards (4.5:1 minimum)
- Primary text on white: #111 (14.4:1)
- Secondary text on white: #555 (7.8:1)
- Tertiary text on white: #888 (4.6:1)

### Focus States
- Visible border changes
- No reliance on color alone
- Keyboard navigation supported

### Screen Readers
- SVG icons include `aria-label` when used standalone
- Interactive elements have proper labels
- Empty states include descriptive text

## Best Practices

### Do
- Use consistent stroke weights (1.5px for icons)
- Keep borders minimal (1-2px)
- Use geometric primitives
- Maintain grid alignment
- Show data density over decoration
- Use tabular numerals for counts

### Don't
- Use gradients or shadows
- Add unnecessary animations
- Mix icon styles (emojis + SVG)
- Use bright colors for non-critical elements
- Hide information behind interactions
- Add decorative elements

## Implementation Notes

### Icon Usage
```javascript
// Good: SVG icons in renderer
const icon = SVG_ICONS[type] || SVG_ICONS.default;
grid.innerHTML = `<div class="item-icon">${icon}</div>`;

// Bad: Emoji icons (inconsistent across platforms)
const icon = TYPE_ICONS[type] || '📎';
```

### Color Usage
```css
/* Good: Minimal palette */
color: #111;
border: 1px solid #ddd;
background: #fafafa;

/* Bad: Many colors, gradients */
background: linear-gradient(135deg, #6a1b9a 0%, #4a148c 100%);
box-shadow: 0 4px 12px rgba(0,0,0,0.3);
```

### Spacing
```css
/* Good: Multiples of 4px */
padding: 8px 12px;
gap: 12px;

/* Bad: Arbitrary values */
padding: 7px 11px;
gap: 13px;
```

## File Structure

- **spaces-picker.html** - Main UI structure and Tufte-inspired CSS
- **spaces-picker-renderer.js** - SVG icon definitions and rendering logic
- **spaces-api.js** - Data layer (no visual elements)

## Rationale

This design system prioritizes:
1. **Clarity** over decoration
2. **Density** over whitespace
3. **Consistency** over variety
4. **Function** over form
5. **Speed** over animation

Following Tufte's principles, every pixel serves a purpose. The design gets out of the way and lets the data speak.
