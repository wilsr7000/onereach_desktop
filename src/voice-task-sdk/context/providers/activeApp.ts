/**
 * Active App Context Provider
 * 
 * Provides information about the currently focused application and document.
 * Uses Electron's focused window info and platform-specific APIs.
 */

import type { ContextProvider, ContextData, ProviderSettings, SettingsSchema } from '../types'

export interface ActiveAppProviderSettings extends ProviderSettings {
  includeWindowTitle?: boolean
  includeDocumentPath?: boolean
}

export function createActiveAppProvider(initialSettings?: ActiveAppProviderSettings): ContextProvider {
  let enabled = true
  let settings: ActiveAppProviderSettings = {
    includeWindowTitle: true,
    includeDocumentPath: true,
    ...initialSettings,
  }
  
  // Cache for external app info (set by main process)
  let cachedAppInfo: {
    appName?: string
    windowTitle?: string
    documentPath?: string
    bundleId?: string
  } = {}
  
  const provider: ContextProvider = {
    id: 'active-app',
    name: 'Active Application',
    category: 'application',
    priority: 90, // High priority
    
    async getContext(): Promise<ContextData> {
      const now = Date.now()
      
      // Try to get fresh info from main process if available
      if (typeof window !== 'undefined' && (window as any).contextAPI?.getActiveApp) {
        try {
          const freshInfo = await (window as any).contextAPI.getActiveApp()
          if (freshInfo) {
            cachedAppInfo = freshInfo
          }
        } catch (e) {
          // Use cached info
        }
      }
      
      const { appName, windowTitle, documentPath, bundleId } = cachedAppInfo
      
      // Build summary
      const parts: string[] = []
      if (appName) {
        parts.push(`Active app: ${appName}`)
      }
      if (settings.includeWindowTitle && windowTitle) {
        parts.push(`Window: ${windowTitle}`)
      }
      if (settings.includeDocumentPath && documentPath) {
        // Show just filename
        const filename = documentPath.split(/[/\\]/).pop() || documentPath
        parts.push(`Document: ${filename}`)
      }
      
      if (parts.length === 0) {
        parts.push('No active application detected')
      }
      
      return {
        summary: parts.join(', '),
        details: {
          appName: appName || 'Unknown',
          windowTitle: windowTitle || '',
          documentPath: documentPath || '',
          bundleId: bundleId || '',
          // Infer document type from extension
          documentType: documentPath ? inferDocumentType(documentPath) : undefined,
        },
        timestamp: now,
        ttlMs: 5000, // Short TTL - app focus changes frequently
      }
    },
    
    configure(newSettings: ProviderSettings): void {
      settings = { ...settings, ...newSettings as ActiveAppProviderSettings }
    },
    
    isEnabled(): boolean {
      return enabled
    },
    
    enable(): void {
      enabled = true
    },
    
    disable(): void {
      enabled = false
    },
    
    getSettingsSchema(): SettingsSchema {
      return {
        fields: [
          {
            key: 'includeWindowTitle',
            label: 'Include window title',
            type: 'boolean',
            default: true,
          },
          {
            key: 'includeDocumentPath',
            label: 'Include document path',
            type: 'boolean',
            default: true,
          },
        ],
      }
    },
  }
  
  // Allow external update of app info
  ;(provider as any).setAppInfo = (info: typeof cachedAppInfo) => {
    cachedAppInfo = info
  }
  
  return provider
}

/**
 * Infer document type from file extension
 */
function inferDocumentType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() || ''
  
  const typeMap: Record<string, string> = {
    // Code
    js: 'JavaScript',
    ts: 'TypeScript',
    jsx: 'React JSX',
    tsx: 'React TSX',
    py: 'Python',
    rb: 'Ruby',
    go: 'Go',
    rs: 'Rust',
    java: 'Java',
    c: 'C',
    cpp: 'C++',
    cs: 'C#',
    swift: 'Swift',
    kt: 'Kotlin',
    php: 'PHP',
    
    // Web
    html: 'HTML',
    css: 'CSS',
    scss: 'SCSS',
    less: 'LESS',
    
    // Data
    json: 'JSON',
    xml: 'XML',
    yaml: 'YAML',
    yml: 'YAML',
    csv: 'CSV',
    
    // Documents
    md: 'Markdown',
    txt: 'Text',
    pdf: 'PDF',
    doc: 'Word Document',
    docx: 'Word Document',
    xls: 'Excel',
    xlsx: 'Excel',
    ppt: 'PowerPoint',
    pptx: 'PowerPoint',
    
    // Media
    png: 'Image',
    jpg: 'Image',
    jpeg: 'Image',
    gif: 'Image',
    svg: 'SVG',
    mp4: 'Video',
    mov: 'Video',
    mp3: 'Audio',
    wav: 'Audio',
  }
  
  return typeMap[ext] || ext.toUpperCase()
}
