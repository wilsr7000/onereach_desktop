# Smart Export Style Guide

## Overview
The Smart Export Style Guide provides a sophisticated design system based on the journey map aesthetic. It creates elegant, professional documents with warm colors, serif typography, and thoughtful spacing.

## Quick Start
1. View the interactive style guide: `open smart-export-style-guide.html`
2. Reference the CSS file: `smart-export-styles.css`
3. Use in templates and exports

## Editing the Style Guide
1. Click the "🎨 Style Guide" button in Smart Export Preview
2. Click "✏️ Edit CSS" in the style guide
3. Make your changes with live preview
4. Click "🔄 Restore Default" to return to original styles
5. Save your changes (applies to current session)

## Design Principles

### 1. **Warm & Sophisticated**
- Uses a warm beige (#F5F2ED) background
- Creates an approachable yet professional feeling
- Inspired by high-end journey mapping documents

### 2. **Typography First**
- Primary font: Crimson Text (elegant serif)
- Clear hierarchy with consistent sizing
- Generous line height (1.8) for readability

### 3. **Subtle Details**
- Thin borders and underline accents
- Custom bullet points
- Minimal but effective use of color

## Core Components

### Headers
```html
<header class="document-header">
    <h1 class="document-title">Title</h1>
    <div class="document-meta">
        <span class="document-date">Date</span>
        <span class="document-context">Context</span>
    </div>
</header>
```

### Journey Map Headers
```html
<div class="journey-header">
    <div class="journey-header-left">
        <h1 class="document-title">Journey Map</h1>
        <div class="journey-subtitle">Subtitle text</div>
    </div>
    <div class="journey-header-right">
        <div>April 24, 2024</div>
        <div style="font-style: italic;">User Persona</div>
    </div>
</div>
```

### Content Cards
```html
<div class="content-card">
    <h3 class="card-title">Card Title</h3>
    <p class="body-text">Content here...</p>
</div>
```

### Lists
```html
<ul class="styled-list">
    <li>Item with custom bullet</li>
    <li>Another item</li>
</ul>
```

### Timeline
```html
<div class="timeline-container">
    <div class="timeline-line"></div>
    <div class="timeline-stages">
        <div class="timeline-stage">
            <div class="timeline-marker"></div>
            Stage Name
        </div>
    </div>
</div>
```

## Color Palette
- **Background**: `#F5F2ED` - Warm beige
- **Primary Text**: `#2C2C2C` - Dark charcoal
- **Secondary Text**: `#5A5A5A` - Medium gray
- **Lines/Borders**: `#D4D4D4` - Light gray
- **Accent Dots**: `#8B8B8B` - Medium gray

## Spacing System
- `xs`: 0.25rem (4px)
- `sm`: 0.5rem (8px)
- `md`: 1rem (16px)
- `lg`: 2rem (32px)
- `xl`: 3rem (48px)
- `xxl`: 4rem (64px)

## Utility Classes
- `.text-center` - Center align text
- `.text-right` - Right align text
- `.text-muted` - Secondary text color
- `.mb-sm`, `.mb-md`, `.mb-lg`, `.mb-xl` - Bottom margins
- `.mt-sm`, `.mt-md`, `.mt-lg`, `.mt-xl` - Top margins

## Journey Map Components

### Emotion Curves
```html
<div class="emotion-curve">
    <svg viewBox="0 0 800 150">
        <path d="M 0 75 Q 100 50, 200 75 T 400 75 Q 500 30, 600 75 T 800 75" />
    </svg>
</div>
```

### Journey Stages
```html
<div class="journey-stages">
    <div class="journey-stages-line"></div>
    <div class="timeline-stages">
        <div class="journey-stage-item">
            <div class="journey-stage-marker active"></div>
            <div>Stage Name</div>
        </div>
    </div>
</div>
```

### Thought Annotations
```html
<div class="thought-annotation">
    User thought or insight in italics
</div>
```

### Experience Sweeteners
```html
<div class="sweeteners-section">
    <div class="sweeteners-title">Experience sweeteners</div>
    <ul class="styled-list">
        <li>Clear explanations</li>
        <li>Interactive tools</li>
    </ul>
</div>
```

### Opportunity Patterns
```html
<div class="opportunity-pattern">
    <div class="opportunity-pattern-dot active"></div>
    <div class="opportunity-pattern-dot"></div>
</div>
```

## Best Practices

### 1. **Maintain Visual Hierarchy**
- Use `.document-title` for main titles
- Use `.section-header` for major sections
- Use `.card-title` for component headings

### 2. **Consistent Spacing**
- Use the spacing variables rather than custom values
- Apply utility classes for quick spacing adjustments

### 3. **Content Organization**
- Group related content in `.content-card`
- Use `.insight-card` for key findings
- Apply `.quote-block` for testimonials or excerpts

### 4. **Responsive Design**
- The system includes mobile breakpoints
- Components adapt gracefully to smaller screens

## Integration with AI Templates
When creating templates, instruct the AI to:
1. Use the provided CSS classes
2. Follow the component patterns
3. Maintain the warm, professional aesthetic
4. Embed styles for portability

## File Structure
```
smart-export-styles.css          # Core CSS file
smart-export-style-guide.html    # Visual reference
smart-export-preview.html        # Uses the styles
smart-export.js                  # Instructs AI to use styles
pdf-generator.js                 # Embeds styles for PDFs
```

## Examples in Production
The style guide is automatically applied to:
- AI-generated smart exports
- Basic PDF exports
- Preview displays
- Saved documents

This creates a consistent, professional appearance across all exported documents.

## Complete Journey Map Structure
A full journey map typically includes:
1. **Header** - Title, date, and context/persona
2. **Emotion Curve** - Visual representation of user feelings
3. **Journey Stages** - Key phases with markers
4. **Thoughts Layer** - User thoughts at each stage
5. **Opportunities** - Dots indicating improvement areas
6. **Experience Sweeteners** - Positive elements to enhance
7. **Sources** - Citation for research/data

The style guide includes complete examples demonstrating how these elements work together to create sophisticated journey maps. 