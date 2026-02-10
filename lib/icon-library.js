/**
 * Tufte-inspired SVG Icon Library
 * 
 * Simple, geometric, minimal icons following Tufte's data visualization principles:
 * - 1.5px stroke weight for consistency
 * - 24x24 viewport
 * - No fills, outline only
 * - Geometric primitives
 * 
 * Usage:
 *   import { ICONS, getIcon } from './icon-library.js';
 *   const html = `<div class="icon">${getIcon('file')}</div>`;
 */

export const ICONS = {
  // ============================================
  // CONTENT TYPE ICONS
  // ============================================
  
  file: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
    <polyline points="14 2 14 8 20 8"/>
  </svg>`,
  
  image: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2"/>
    <circle cx="8.5" cy="8.5" r="1.5"/>
    <polyline points="21 15 16 10 5 21"/>
  </svg>`,
  
  text: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M4 7h16M4 12h16M4 17h10"/>
  </svg>`,
  
  code: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="16 18 22 12 16 6"/>
    <polyline points="8 6 2 12 8 18"/>
  </svg>`,
  
  html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="16 18 22 12 16 6"/>
    <polyline points="8 6 2 12 8 18"/>
    <line x1="12" y1="2" x2="12" y2="22"/>
  </svg>`,
  
  video: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <rect x="2" y="5" width="20" height="14" rx="2"/>
    <polygon points="10 8 16 12 10 16"/>
  </svg>`,
  
  audio: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M9 18V5l12-2v13"/>
    <circle cx="6" cy="18" r="3"/>
    <circle cx="18" cy="16" r="3"/>
  </svg>`,
  
  pdf: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
    <polyline points="14 2 14 8 20 8"/>
    <path d="M7 11h10M7 15h10"/>
  </svg>`,
  
  url: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="10"/>
    <line x1="2" y1="12" x2="22" y2="12"/>
    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
  </svg>`,
  
  // ============================================
  // CONTAINER ICONS
  // ============================================
  
  space: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="8"/>
  </svg>`,
  
  folder: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
  </svg>`,
  
  box: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2"/>
  </svg>`,
  
  // ============================================
  // STATE ICONS
  // ============================================
  
  empty: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2"/>
    <line x1="9" y1="9" x2="15" y2="15"/>
    <line x1="15" y1="9" x2="9" y2="15"/>
  </svg>`,
  
  warning: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
    <line x1="12" y1="9" x2="12" y2="13"/>
    <line x1="12" y1="17" x2="12.01" y2="17"/>
  </svg>`,
  
  error: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="10"/>
    <line x1="15" y1="9" x2="9" y2="15"/>
    <line x1="9" y1="9" x2="15" y2="15"/>
  </svg>`,
  
  success: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="10"/>
    <polyline points="9 12 11 14 15 10"/>
  </svg>`,
  
  info: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="10"/>
    <line x1="12" y1="16" x2="12" y2="12"/>
    <line x1="12" y1="8" x2="12.01" y2="8"/>
  </svg>`,
  
  // ============================================
  // ACTION ICONS
  // ============================================
  
  search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="11" cy="11" r="8"/>
    <line x1="21" y1="21" x2="16.65" y2="16.65"/>
  </svg>`,
  
  plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <line x1="12" y1="5" x2="12" y2="19"/>
    <line x1="5" y1="12" x2="19" y2="12"/>
  </svg>`,
  
  minus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <line x1="5" y1="12" x2="19" y2="12"/>
  </svg>`,
  
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="20 6 9 17 4 12"/>
  </svg>`,
  
  x: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <line x1="18" y1="6" x2="6" y2="18"/>
    <line x1="6" y1="6" x2="18" y2="18"/>
  </svg>`,
  
  edit: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
  </svg>`,
  
  trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="3 6 5 6 21 6"/>
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
  </svg>`,
  
  download: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
    <polyline points="7 10 12 15 17 10"/>
    <line x1="12" y1="15" x2="12" y2="3"/>
  </svg>`,
  
  upload: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
    <polyline points="17 8 12 3 7 8"/>
    <line x1="12" y1="3" x2="12" y2="15"/>
  </svg>`,
  
  // ============================================
  // NAVIGATION ICONS
  // ============================================
  
  chevronLeft: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="15 18 9 12 15 6"/>
  </svg>`,
  
  chevronRight: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="9 18 15 12 9 6"/>
  </svg>`,
  
  chevronUp: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="18 15 12 9 6 15"/>
  </svg>`,
  
  chevronDown: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="6 9 12 15 18 9"/>
  </svg>`,
  
  // ============================================
  // UI ELEMENTS
  // ============================================
  
  settings: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="3"/>
    <path d="M12 1v6m0 6v6M5.64 5.64l4.24 4.24m4.24 4.24l4.24 4.24M1 12h6m6 0h6M5.64 18.36l4.24-4.24m4.24-4.24l4.24-4.24"/>
  </svg>`,
  
  more: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="1"/>
    <circle cx="19" cy="12" r="1"/>
    <circle cx="5" cy="12" r="1"/>
  </svg>`,
  
  moreVertical: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="1"/>
    <circle cx="12" cy="5" r="1"/>
    <circle cx="12" cy="19" r="1"/>
  </svg>`,
  
  filter: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
  </svg>`,
  
  // Media device icons
  microphone: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
    <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
    <line x1="12" y1="19" x2="12" y2="23"/>
    <line x1="8" y1="23" x2="16" y2="23"/>
  </svg>`,

  monitor: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <rect x="2" y="3" width="20" height="14" rx="2"/>
    <line x1="8" y1="21" x2="16" y2="21"/>
    <line x1="12" y1="17" x2="12" y2="21"/>
  </svg>`,

  camera: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
    <circle cx="12" cy="13" r="4"/>
  </svg>`,

  layers: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <polygon points="12 2 2 7 12 12 22 7 12 2"/>
    <polyline points="2 17 12 22 22 17"/>
    <polyline points="2 12 12 17 22 12"/>
  </svg>`,

  list: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <line x1="8" y1="6" x2="21" y2="6"/>
    <line x1="8" y1="12" x2="21" y2="12"/>
    <line x1="8" y1="18" x2="21" y2="18"/>
    <line x1="3" y1="6" x2="3.01" y2="6"/>
    <line x1="3" y1="12" x2="3.01" y2="12"/>
    <line x1="3" y1="18" x2="3.01" y2="18"/>
  </svg>`,

  // Fallback
  default: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <rect x="5" y="5" width="14" height="14" rx="2"/>
  </svg>`,
  
  // ============================================
  // GSX ECOSYSTEM ICONS (Galaxy/Solar System theme)
  // ============================================
  
  // Not pushed - gray, spiral arms curving inward with upload arrow
  gsxGalaxyNotPushed: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
    <path d="M12 3c0 1.5-1 2.5-2.5 3.5" stroke-linecap="round" opacity="0.4"/>
    <path d="M21 12c-1.5 0-2.5-1-3.5-2.5" stroke-linecap="round" opacity="0.4"/>
    <path d="M12 21c0-1.5 1-2.5 2.5-3.5" stroke-linecap="round" opacity="0.4"/>
    <path d="M3 12c1.5 0 2.5 1 3.5 2.5" stroke-linecap="round" opacity="0.4"/>
    <circle cx="4" cy="4" r="1.2" fill="currentColor" opacity="0.3"/>
    <circle cx="20" cy="4" r="1.2" fill="currentColor" opacity="0.3"/>
    <circle cx="20" cy="20" r="1.2" fill="currentColor" opacity="0.3"/>
    <circle cx="4" cy="20" r="1.2" fill="currentColor" opacity="0.3"/>
    <circle cx="12" cy="12" r="5" stroke-width="1.5"/>
    <text x="12" y="13" font-size="4.5" font-weight="700" fill="currentColor" text-anchor="middle" font-family="system-ui">GSX</text>
    <path d="M12 5V2M10 3.5l2-1.5 2 1.5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`,
  
  // Pushed - blue, spiral arms radiating outward with bright satellites
  gsxGalaxyPushed: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
    <path d="M12 3c0 2 1.5 3 4 4" stroke-linecap="round"/>
    <path d="M21 12c-2 0-3 1.5-4 4" stroke-linecap="round"/>
    <path d="M12 21c0-2-1.5-3-4-4" stroke-linecap="round"/>
    <path d="M3 12c2 0 3-1.5 4-4" stroke-linecap="round"/>
    <circle cx="4" cy="4" r="1.5" fill="currentColor"/>
    <circle cx="20" cy="4" r="1.5" fill="currentColor"/>
    <circle cx="20" cy="20" r="1.5" fill="currentColor"/>
    <circle cx="4" cy="20" r="1.5" fill="currentColor"/>
    <circle cx="12" cy="12" r="5" fill="currentColor" opacity="0.15" stroke-width="1.5"/>
    <text x="12" y="13" font-size="4.5" font-weight="700" fill="currentColor" text-anchor="middle" font-family="system-ui">GSX</text>
  </svg>`,
  
  // Changed locally - orange, dimmed arms with pulsing center dot
  gsxGalaxyChanged: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
    <path d="M12 3c0 2 1.5 3 4 4" stroke-linecap="round" opacity="0.35"/>
    <path d="M21 12c-2 0-3 1.5-4 4" stroke-linecap="round" opacity="0.35"/>
    <path d="M12 21c0-2-1.5-3-4-4" stroke-linecap="round" opacity="0.35"/>
    <path d="M3 12c2 0 3-1.5 4-4" stroke-linecap="round" opacity="0.35"/>
    <circle cx="4" cy="4" r="1.5" fill="currentColor" opacity="0.35"/>
    <circle cx="20" cy="4" r="1.5" fill="currentColor" opacity="0.35"/>
    <circle cx="20" cy="20" r="1.5" fill="currentColor" opacity="0.35"/>
    <circle cx="4" cy="20" r="1.5" fill="currentColor" opacity="0.35"/>
    <circle cx="12" cy="12" r="5" stroke-width="1.5"/>
    <text x="12" y="12" font-size="4.5" font-weight="700" fill="currentColor" text-anchor="middle" font-family="system-ui">GSX</text>
    <circle cx="12" cy="17" r="1.5" fill="currentColor" class="gsx-pulse"/>
  </svg>`,
  
  // Unpushed - gray dim, dashed arms with hollow satellites
  gsxGalaxyUnpushed: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
    <path d="M12 3c0 2 1.5 3 4 4" stroke-linecap="round" opacity="0.2" stroke-dasharray="2 2"/>
    <path d="M21 12c-2 0-3 1.5-4 4" stroke-linecap="round" opacity="0.2" stroke-dasharray="2 2"/>
    <path d="M12 21c0-2-1.5-3-4-4" stroke-linecap="round" opacity="0.2" stroke-dasharray="2 2"/>
    <path d="M3 12c2 0 3-1.5 4-4" stroke-linecap="round" opacity="0.2" stroke-dasharray="2 2"/>
    <circle cx="4" cy="4" r="1.5" fill="none" opacity="0.3"/>
    <circle cx="20" cy="4" r="1.5" fill="none" opacity="0.3"/>
    <circle cx="20" cy="20" r="1.5" fill="none" opacity="0.3"/>
    <circle cx="4" cy="20" r="1.5" fill="none" opacity="0.3"/>
    <circle cx="12" cy="12" r="5" stroke-width="1.5" stroke-dasharray="3 2"/>
    <text x="12" y="13" font-size="4.5" font-weight="700" fill="currentColor" text-anchor="middle" font-family="system-ui" opacity="0.5">GSX</text>
  </svg>`,
  
  // Copy/clipboard icon for link copying
  copy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <rect x="9" y="9" width="13" height="13" rx="2"/>
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
  </svg>`,
  
  // Link icon
  link: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
  </svg>`,
  
  // External link icon
  externalLink: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
    <polyline points="15 3 21 3 21 9"/>
    <line x1="10" y1="14" x2="21" y2="3"/>
  </svg>`,
  
  // Eye icon for visibility
  eye: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
    <circle cx="12" cy="12" r="3"/>
  </svg>`,
  
  // Eye off icon for private
  eyeOff: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
    <line x1="1" y1="1" x2="23" y2="23"/>
  </svg>`,

  // ============================================
  // DATA SOURCE ICONS
  // ============================================

  // Generic data source (database cylinder with connection line)
  dataSource: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <ellipse cx="12" cy="5" rx="8" ry="3"/>
    <path d="M20 5v6c0 1.66-3.58 3-8 3s-8-1.34-8-3V5"/>
    <path d="M20 11v6c0 1.66-3.58 3-8 3s-8-1.34-8-3v-6"/>
  </svg>`,

  // API endpoint (angle brackets with connection)
  api: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="16 18 22 12 16 6"/>
    <polyline points="8 6 2 12 8 18"/>
    <line x1="12" y1="2" x2="12" y2="22"/>
  </svg>`,

  // MCP server (plug connector)
  mcpServer: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 2v4"/>
    <path d="M8 4h8"/>
    <rect x="7" y="6" width="10" height="6" rx="1"/>
    <path d="M9 12v3"/>
    <path d="M15 12v3"/>
    <path d="M6 15h12"/>
    <path d="M12 15v5"/>
    <circle cx="12" cy="21" r="1"/>
  </svg>`,

  // Web scraper (globe with extraction arrow)
  webScraper: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="11" cy="11" r="8"/>
    <path d="M11 3a13 13 0 0 1 3 8 13 13 0 0 1-3 8"/>
    <path d="M11 3a13 13 0 0 0-3 8 13 13 0 0 0 3 8"/>
    <path d="M3 11h16"/>
    <path d="M18 18l4 4"/>
    <path d="M22 18v4h-4"/>
  </svg>`
};

/**
 * Get an icon by name with fallback
 * @param {string} name - Icon name
 * @returns {string} SVG markup
 */
export function getIcon(name) {
  return ICONS[name] || ICONS.default;
}

/**
 * Get icon for content type (maps legacy type names to icons)
 * @param {string} type - Content type
 * @returns {string} SVG markup
 */
export function getTypeIcon(type, subtype) {
  const typeMap = {
    file: 'file',
    image: 'image',
    text: 'text',
    code: 'code',
    html: 'html',
    video: 'video',
    audio: 'audio',
    pdf: 'pdf',
    url: 'url',
    web: 'url',
    'data-source': 'dataSource'
  };

  // Data source subtypes get specific icons
  if (type === 'data-source' && subtype) {
    const dsSubtypeMap = {
      mcp: 'mcpServer',
      api: 'api',
      'web-scraping': 'webScraper'
    };
    const subIcon = dsSubtypeMap[subtype];
    if (subIcon && ICONS[subIcon]) return ICONS[subIcon];
  }
  
  const iconName = typeMap[type] || 'default';
  return ICONS[iconName];
}

/**
 * Create an icon element with optional class
 * @param {string} name - Icon name
 * @param {string} className - Optional CSS class
 * @returns {string} HTML markup
 */
export function createIconElement(name, className = '') {
  const classAttr = className ? ` class="${className}"` : '';
  return `<span${classAttr}>${getIcon(name)}</span>`;
}

// For CommonJS compatibility (Node.js)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ICONS,
    getIcon,
    getTypeIcon,
    createIconElement
  };
}
