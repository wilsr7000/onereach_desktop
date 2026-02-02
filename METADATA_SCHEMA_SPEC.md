# Metadata Schema Specification by Asset Type

## Core Fields (All Types)

**Every asset type shares these:**
```javascript
{
  title: string,           // Clear title
  description: string,     // 2-3 sentence description
  tags: string[],          // Searchable tags
  notes: string,           // Additional context
  ai_metadata_generated: boolean,
  ai_metadata_timestamp: string,
  space_context_used: boolean
}
```

---

## Type-Specific Schemas

### 📸 IMAGE
```javascript
{
  // Core fields
  title: "Screenshot of VS Code",
  description: "Code editor showing React component...",
  tags: ["code", "react", "vscode"],
  notes: "Component for authentication",
  
  // IMAGE-SPECIFIC
  category: "screenshot|photo|diagram|design|chart|document|ui-mockup|other",
  extracted_text: "import React, { useState }...",
  visible_urls: ["github.com/repo"],
  app_detected: "VS Code",
  ai_detected: false,
  instructions: "Reference for React component structure"
}
```

### 🎬 VIDEO
```javascript
{
  // Core fields
  title: "Ilya Sutskever Interview",
  description: "Discussion about AI research...",
  tags: ["ai", "interview", "research"],
  notes: "Important insights on scaling",
  
  // VIDEO-SPECIFIC
  shortDescription: "One sentence summary",
  longDescription: "Detailed 3 sentence description",
  category: "tutorial|interview|presentation|screen-recording|educational|documentary",
  topics: ["AI", "scaling", "research"],
  speakers: ["Ilya Sutskever", "Dwarkesh Patel"],
  keyPoints: ["Scaling limits", "Age of research"],
  targetAudience: "AI researchers and developers"
}
```

### 🎵 AUDIO
```javascript
{
  // Core fields
  title: "Project Discussion",
  description: "Team meeting about timeline...",
  tags: ["meeting", "project", "planning"],
  notes: "Key decisions made",
  
  // AUDIO-SPECIFIC
  audioType: "podcast|music|voice-memo|audiobook|interview|lecture|recording",
  topics: ["timeline", "budget", "team"],
  speakers: ["John", "Sarah"],
  keyPoints: ["Launch date confirmed", "Budget approved"],
  genre: "Professional recording"
}
```

### 💻 CODE
```javascript
{
  // Core fields
  title: "React useAuth Hook",
  description: "Custom hook for authentication...",
  tags: ["react", "hooks", "auth"],
  notes: "Reusable authentication logic",
  
  // CODE-SPECIFIC
  language: "JavaScript/React",
  purpose: "Authentication state management",
  functions: ["useAuth", "login", "logout", "checkAuth"],
  dependencies: ["react", "axios", "jwt-decode"],
  complexity: "simple|moderate|complex"
}
```

### 📄 PDF
```javascript
{
  // Core fields
  title: "Q4 Financial Report",
  description: "Quarterly financial analysis...",
  tags: ["finance", "report", "q4"],
  notes: "For board meeting",
  
  // PDF-SPECIFIC
  documentType: "report|manual|invoice|presentation|form|contract|resume",
  subject: "Financial reporting",
  category: "Business",
  purpose: "Quarterly analysis and projections"
}
```

### 📊 DATA FILE
```javascript
{
  // Core fields
  title: "User Database Export",
  description: "JSON export of user records...",
  tags: ["users", "data", "export"],
  notes: "Backup from production",
  
  // DATA-SPECIFIC
  dataType: "config|dataset|api-response|export|schema|log",
  format: "JSON|CSV|YAML|XML",
  entities: ["users", "profiles", "settings"],
  keyFields: ["id", "email", "name", "created_at"],
  purpose: "User data backup and migration"
}
```

### 📝 TEXT
```javascript
{
  // Core fields
  title: "Meeting Notes - Kickoff",
  description: "Notes from project kickoff meeting...",
  tags: ["meeting", "notes", "project"],
  notes: "Action items assigned",
  
  // TEXT-SPECIFIC
  contentType: "notes|article|documentation|message|list|meeting-notes",
  topics: ["project", "timeline", "team"],
  keyPoints: ["Launch Q2", "Team of 5", "Budget approved"],
  actionItems: ["Review designs", "Schedule sprint planning"]
}
```

### 🌐 URL
```javascript
{
  // Core fields
  title: "React Hooks Documentation",
  description: "Official React docs on Hooks API...",
  tags: ["react", "documentation", "hooks"],
  notes: "Reference for useEffect patterns",
  
  // URL-SPECIFIC
  urlType: "article|documentation|tool|repository|video|social-media|resource",
  platform: "React Official Docs",
  topics: ["React", "Hooks", "useEffect"],
  category: "Documentation",
  purpose: "Technical reference for development"
}
```

### 🗂️ HTML
```javascript
{
  // Core fields
  title: "Product Requirements Doc",
  description: "PRD for user authentication feature...",
  tags: ["prd", "requirements", "auth"],
  notes: "Version 1.0",
  
  // HTML-SPECIFIC
  documentType: "article|report|documentation|presentation|email",
  topics: ["authentication", "user-management", "security"],
  keyPoints: ["OAuth support", "2FA required", "Session management"],
  author: "Product Team",
  source: "smart-export|generated-document|website"
}
```

---

## Modal Should Show Type-Specific Fields

**Current Problem:** Modal shows same fields for all types

**Should Be:** Modal dynamically shows fields based on asset type

---

This is what needs to be built next!
