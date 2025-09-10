const clipboardEx = require('electron-clipboard-extended');
const { app, BrowserWindow, globalShortcut, ipcMain, dialog, protocol, net, shell, session, nativeImage, clipboard: electronClipboard } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { HTMLPreviewSystem } = require('./html-preview-system');

class ClipboardManager {
  constructor() {
    this.history = [];
    this.spaces = [];
    this.pinnedItems = new Set();
    this.currentSpace = null;
    this.spacesEnabled = true;
    this.screenshotCaptureEnabled = false;
    this.clipboardWindow = null;
    this.blackHoleWindow = null;
    this.monitoredFiles = new Set();
    this.fileWatchers = new Map();
    
    // Initialize HTML preview system
    this.htmlPreviewSystem = new HTMLPreviewSystem();
    
    // Track pending async operations
    this.pendingOperations = new Map(); // itemId -> Set of promises
    
    this.pdfThumbnailWindow = null; // Hidden window for PDF rendering
    this.pdfThumbnailRequests = new Map(); // Track pending thumbnail requests
    this.pdfThumbnailReady = false; // Whether PDF renderer is ready
    this.storageRoot = path.join(os.homedir(), 'Documents', 'OR-Spaces');
    this.historyFilePath = path.join(app.getPath('userData'), 'clipboard-history.json');
    this.spacesFilePath = path.join(app.getPath('userData'), 'clipboard-spaces.json');
    this.preferencesFilePath = path.join(app.getPath('userData'), 'clipboard-preferences.json');
    this.pendingImages = [];
    this.lastTextContent = '';
    this.lastTextTimestamp = 0;
    this.lastHtmlContent = '';
    this.lastImageHash = null;
    this.maxHistorySize = 1000; // Maximum number of items to keep in memory
    this.clipboardCheckInterval = null; // Store interval reference
    
    // Set up file-based storage in Documents folder (not hidden)
    this.ensureStorageDirectories();
    
    // Migrate from old location if it exists
    this.migrateFromOldLocation();
    
    // Load data from disk - IMPORTANT: Load spaces before history!
    this.loadPreferences();
    this.loadSpaces();  // Load spaces first
    this.loadHistory(); // Then load history (which may need to know about spaces)
    
    // Update space counts after both spaces and history are loaded
    this.updateSpaceCounts();
    
    // DISABLED: Automatic clipboard monitoring
    // The black hole functionality is sufficient for clipboard management
    // Set up clipboard monitoring
    // this.setupClipboardWatcher();
    
    // Set up screenshot monitoring only if enabled
    if (this.screenshotCaptureEnabled) {
      this.setupScreenshotWatcher();
    }
    
    // Set up IPC handlers
    this.setupIPC();
    
    // Initialize PDF thumbnail renderer
    this.initializePDFRenderer();
    
    // DISABLED: CPU protection timer since clipboard monitoring is disabled
    // Add CPU protection - pause monitoring after 30 minutes to prevent runaway CPU usage
    // setTimeout(() => {
    //   if (!this.isPaused) {
    //     console.log('Auto-pausing clipboard monitoring after 30 minutes to prevent CPU issues');
    //     this.isPaused = true;
    //     
    //     // Show notification to user
    //     BrowserWindow.getAllWindows().forEach(window => {
    //       window.webContents.send('show-notification', {
    //         title: 'Clipboard Monitoring Paused',
    //         body: 'Monitoring paused to save CPU. Use manual check or restart to resume.'
    //       });
    //     });
    //   }
    // }, 30 * 60 * 1000); // 30 minutes
  }
  
  setupClipboardWatcher() {
    // Add a startup delay to prevent high CPU usage on launch
    console.log('Clipboard monitoring will start in 3 seconds...');
    // REMOVED: isPaused is no longer needed since clipboard monitoring is disabled
    // this.isPaused = true; // Start paused
    
    setTimeout(() => {
      console.log('Starting clipboard monitoring...');
      // REMOVED: isPaused is no longer needed since clipboard monitoring is disabled
      // this.isPaused = false;
      
      try {
        // Monitor text changes
        clipboardEx
          .on('text-changed', () => {
            // Skip if already processing or paused
            if (this.isProcessing) return;
            this.isProcessing = true;
            
            try {
              console.log('=== TEXT-CHANGED EVENT FIRED ===');
              const formats = clipboardEx.availableFormats();
              console.log('Available formats on text-changed:', formats);
              
              const text = clipboardEx.readText();
              console.log('Text content:', text);
              
              if (text && text.trim()) {
                // Check if it's a file path
                const trimmedText = text.trim();
                
                // Enhanced file path detection
                const looksLikeFilePath = 
                  trimmedText.startsWith('/') ||  // Unix absolute path
                  trimmedText.startsWith('~') ||   // Unix home path
                  /^[a-zA-Z]:\\/.test(trimmedText) || // Windows path
                  /^\\\\/.test(trimmedText) ||     // UNC path
                  (trimmedText.includes('/') && !trimmedText.includes(' ') && fs.existsSync(trimmedText)); // Likely file path
                
                // Also check if it's just a filename (no path separators)
                const looksLikeFileName = !trimmedText.includes('/') && 
                                         !trimmedText.includes('\\') && 
                                         trimmedText.includes('.') &&
                                         !trimmedText.includes(' ') &&
                                         !trimmedText.includes('\n');
                
                if (looksLikeFilePath) {
                  console.log('Text handler: Detected potential file path:', trimmedText);
                  
                  // Check if the path exists
                  try {
                    const resolvedPath = trimmedText.startsWith('~') 
                      ? path.join(os.homedir(), trimmedText.slice(1))
                      : trimmedText;
                      
                    if (fs.existsSync(resolvedPath)) {
                      console.log('Text handler: File exists, processing as file');
                      this.handleFilePath(resolvedPath);
                      return; // Don't add as text
                    }
                  } catch (e) {
                    // Not a valid file path, continue as text
                  }
                } else if (looksLikeFileName) {
                  console.log('Text handler: Detected potential filename:', trimmedText);
                  
                  // Check if there's also a text/uri-list format which might have the full path
                  const formats = clipboardEx.availableFormats();
                  if (formats.includes('text/uri-list')) {
                    try {
                      const uriList = clipboardEx.readBuffer('text/uri-list').toString('utf8');
                      console.log('Text handler: Found URI list:', uriList);
                      console.log('Text handler: URI list length:', uriList.length);
                      console.log('Text handler: URI list hex (first 100 chars):', Buffer.from(uriList).toString('hex').substring(0, 100));
                      
                      // Parse file:// URLs from uri-list
                      const lines = uriList.split(/\r?\n/);
                      console.log('Text handler: URI list lines:', lines);
                      
                      for (const line of lines) {
                        console.log('Text handler: Checking line:', line);
                        if (line.startsWith('file://')) {
                          const filePath = decodeURIComponent(line.replace('file://', ''));
                          console.log('Text handler: Extracted file path:', filePath);
                          if (fs.existsSync(filePath) && path.basename(filePath) === trimmedText) {
                            console.log('Text handler: Found matching file from URI list:', filePath);
                            // Mark that we're processing this file
                            this.recentlyProcessedFile = trimmedText;
                            this.recentlyProcessedFileTime = Date.now();
                            this.handleFilePath(filePath);
                            return;
                          }
                        }
                      }
                    } catch (e) {
                      console.error('Error reading URI list:', e);
                    }
                  } else {
                    console.log('Text handler: No text/uri-list format found');
                  }
                  
                  // Try to find the file in common locations
                  const commonPaths = [
                    path.join(app.getPath('desktop'), trimmedText),
                    path.join(app.getPath('downloads'), trimmedText),
                    path.join(app.getPath('documents'), trimmedText),
                    path.join(app.getPath('home'), trimmedText),
                    path.join(process.cwd(), trimmedText)
                  ];
                  
                  console.log('Text handler: Checking common paths for filename:', trimmedText);
                  for (const testPath of commonPaths) {
                    console.log('Text handler: Checking path:', testPath);
                    if (fs.existsSync(testPath)) {
                      console.log('Text handler: Found file at:', testPath);
                      // Mark that we're processing this file
                      this.recentlyProcessedFile = trimmedText;
                      this.recentlyProcessedFileTime = Date.now();
                      this.handleFilePath(testPath);
                      return;
                    }
                  }
                  
                  console.log('Text handler: Could not find file in common locations');
                }
                
                // Check if we just processed a file with this name
                if (this.recentlyProcessedFile === trimmedText && 
                    Date.now() - this.recentlyProcessedFileTime < 2000) {
                  console.log('Text handler: Skipping text - just processed this as a file');
                  return;
                }
                
                // Also check if this might be a screenshot filename we just processed
                if (this.isScreenshot(trimmedText) && Date.now() - this.lastScreenshotTime < 3000) {
                  console.log('Text handler: Skipping text - likely screenshot filename');
                  return;
                }
                
                // Add as regular text
                this.addToHistory({
                  id: this.generateId(),
                  type: 'text',
                  content: text,
                  preview: this.truncateText(text, 100),
                  timestamp: Date.now(),
                  source: this.detectSource(text),
                  pinned: false,
                  spaceId: this.currentSpace
                });
              }
            } catch (e) {
              console.error('Error handling text change:', e);
            } finally {
              this.isProcessing = false;
            }
          })
          .on('image-changed', () => {
            // Skip if already processing or paused
            if (this.isProcessing) return;
            this.isProcessing = true;
            
            try {
              console.log('=== IMAGE-CHANGED EVENT FIRED ===');
              const formats = clipboardEx.availableFormats();
              console.log('Available formats on image-changed:', formats);
              
              // Check if clipboard has file formats - if so, this image is likely a file icon
              const hasFileFormats = formats.includes('NSFilenamesPboardType') || 
                                    formats.includes('FileNameW') ||
                                    formats.some(f => f.toLowerCase().includes('file'));
              
              // Also check for text/uri-list which often indicates file operations on macOS
              const hasUriList = formats.includes('text/uri-list');
              
              if (hasFileFormats || hasUriList) {
                console.log('File operation detected (formats or uri-list), processing as file instead');
                
                // If we have uri-list, try to process as file
                if (hasUriList) {
                  const text = clipboardEx.readText();
                  console.log('Image-changed: Text content:', text);
                  
                  // Always try to read and log the uri-list
                  let uriList = '';
                  try {
                    const uriListBuffer = clipboardEx.readBuffer('text/uri-list');
                    uriList = uriListBuffer.toString('utf8');
                    console.log('Image-changed: URI list raw:', uriList);
                    console.log('Image-changed: URI list hex:', uriListBuffer.toString('hex').substring(0, 200));
                  } catch (e) {
                    console.error('Image-changed: Error reading uri-list buffer:', e);
                  }
                  
                  if (text && text.trim()) {
                    const trimmedText = text.trim();
                    
                    // Check if it looks like a filename (has an extension)
                    const hasExtension = trimmedText.includes('.') && 
                                       !trimmedText.startsWith('.') && 
                                       trimmedText.lastIndexOf('.') > 0;
                    
                    if (hasExtension && !trimmedText.includes('/') && !trimmedText.includes('\\')) {
                      // Looks like a filename
                      console.log('Image-changed: Detected filename:', trimmedText);
                      
                      // Check common locations for the file
                      const commonPaths = [
                        path.join(app.getPath('desktop'), trimmedText),
                        path.join(app.getPath('downloads'), trimmedText),
                        path.join(app.getPath('documents'), trimmedText),
                        path.join(app.getPath('home'), trimmedText)
                      ];
                      
                      for (const testPath of commonPaths) {
                        console.log('Image-changed: Checking path:', testPath);
                        if (fs.existsSync(testPath)) {
                          console.log('Image-changed: Found file at:', testPath);
                          this.handleFilePath(testPath);
                          return;
                        }
                      }
                      
                      console.log('Image-changed: File not found in common locations');
                    }
                    
                    // Even if uri-list is empty, still check if we can parse it
                    if (uriList && uriList.trim()) {
                      try {
                        const lines = uriList.split(/\r?\n/);
                        for (const line of lines) {
                          if (line.startsWith('file://')) {
                            const filePath = decodeURIComponent(line.replace('file://', ''));
                            if (fs.existsSync(filePath)) {
                              console.log('Image-changed: Found file from URI:', filePath);
                              this.handleFilePath(filePath);
                              return;
                            }
                          }
                        }
                      } catch (e) {
                        console.error('Image-changed: Error parsing uri-list:', e);
                      }
                    }
                  }
                }
                
                return;
              }
              
              const image = clipboardEx.readImage();
              if (!image.isEmpty()) {
                const imageSize = image.getSize();
                
                // Skip common macOS file icon sizes when we just processed a file
                if (this.recentlyProcessedFile && 
                    Date.now() - this.recentlyProcessedFileTime < 3000 &&
                    ((imageSize.width === 1024 && imageSize.height === 1024) ||
                     (imageSize.width === 512 && imageSize.height === 512) ||
                     (imageSize.width === 256 && imageSize.height === 256))) {
                  console.log(`Skipping file icon image: ${imageSize.width}x${imageSize.height}`);
                  return;
                }
                
                // Additional check: if there's also text on clipboard that looks like a filename
                const text = clipboardEx.readText();
                if (text && !text.includes('/') && !text.includes('\\') && 
                    text.includes('.') && !text.includes(' ') && !text.includes('\n') &&
                    ((imageSize.width === 1024 && imageSize.height === 1024) ||
                     (imageSize.width === 512 && imageSize.height === 512) ||
                     (imageSize.width === 256 && imageSize.height === 256))) {
                  console.log(`Skipping file icon image for potential file: ${text}`);
                  return;
                }
                
                const base64 = image.toDataURL();
                
                // Add this image to pending images
                this.pendingImages.push({
                  image: image,
                  base64: base64,
                  size: imageSize,
                  pixelCount: imageSize.width * imageSize.height,
                  aspectRatio: imageSize.width / imageSize.height,
                  timestamp: Date.now()
                });
                
                console.log(`Image detected: ${imageSize.width}x${imageSize.height} (${this.pendingImages.length} total)`);
                
                // Clear any existing debounce timer
                if (this.imageDebounceTimer) {
                  clearTimeout(this.imageDebounceTimer);
                }
                
                // Set timer to process collected images
                this.imageDebounceTimer = setTimeout(() => {
                  if (this.pendingImages.length === 0) return;
                  
                  console.log(`Processing ${this.pendingImages.length} collected images...`);
                  
                  // Log all collected images for debugging
                  this.pendingImages.forEach((img, index) => {
                    console.log(`  Image ${index + 1}: ${img.size.width}x${img.size.height}, aspect ratio: ${img.aspectRatio.toFixed(2)}`);
                  });
                  
                  // Filter out likely OS icons based on multiple criteria
                  const validImages = this.pendingImages.filter(img => {
                    // Skip very small images
                    if (img.size.width <= 64 && img.size.height <= 64) {
                      console.log(`  Filtering out small image: ${img.size.width}x${img.size.height}`);
                      return false;
                    }
                    
                    // Skip square images that are exactly 128x128, 256x256, or 512x512 (common icon sizes)
                    if (img.aspectRatio === 1 && 
                        (img.pixelCount === 128*128 || img.pixelCount === 256*256 || img.pixelCount === 512*512)) {
                      console.log(`  Filtering out likely icon: ${img.size.width}x${img.size.height}`);
                      return false;
                    }
                    
                    return true;
                  });
                  
                  // If all images were filtered out as icons, use the largest one anyway
                  const imagesToConsider = validImages.length > 0 ? validImages : this.pendingImages;
                  
                  // Sort by pixel count (largest first)
                  imagesToConsider.sort((a, b) => b.pixelCount - a.pixelCount);
                  
                  // Use the largest image
                  const bestImage = imagesToConsider[0];
                  
                  // Create hash for duplicate detection
                  const imageHash = `${bestImage.size.width}x${bestImage.size.height}_${bestImage.base64.substring(0, 100)}`;
                  
                  // Check if this is a duplicate of the last image
                  if (this.lastImageHash !== imageHash) {
                    this.lastImageHash = imageHash;
                    
                    // Clear the hash after 2 seconds
                    setTimeout(() => {
                      this.lastImageHash = null;
                    }, 2000);
                    
                    // Generate thumbnail for display
                    const thumbnail = this.generateImageThumbnail(bestImage.base64);
                    
                    this.addToHistory({
                      id: this.generateId(),
                      type: 'image',
                      content: bestImage.base64,  // Keep original for copying
                      thumbnail: thumbnail,       // Add thumbnail for display
                      preview: 'Image',
                      timestamp: Date.now(),
                      dimensions: bestImage.size,
                      pinned: false,
                      spaceId: this.currentSpace
                    });
                    
                    console.log(`Selected best image: ${bestImage.size.width}x${bestImage.size.height} from ${this.pendingImages.length} candidates`);
                  } else {
                    console.log('Skipping duplicate image');
                  }
                  
                  // Clear pending images
                  this.pendingImages = [];
                }, 1000); // Increased to 1000ms window to reduce processing frequency
              }
            } catch (e) {
              console.error('Error handling screenshot:', e);
            } finally {
              this.isProcessing = false;
            }
          })
          .on('html-changed', async () => {
            if (this.isProcessing) return;
            
            const html = clipboardEx.readHTML();
            const text = clipboardEx.readText();
            if (html && html.trim()) {
              const item = {
                id: this.generateId(),
                type: 'html',
                content: html,
                plainText: text,
                preview: this.truncateText(text || this.stripHtml(html), 100),
                timestamp: Date.now(),
                pinned: false,
                spaceId: this.currentSpace
              };
              
              // Generate real HTML thumbnail
              try {
                console.log('Generating HTML thumbnail for clipboard content...');
                item.thumbnail = await this.htmlPreviewSystem.generateHTMLThumbnail(item);
                console.log('HTML thumbnail generated successfully');
              } catch (error) {
                console.error('Error generating HTML thumbnail:', error);
                // Fall back to SVG placeholder
                item.thumbnail = this.generateHTMLThumbnail('HTML Content', html.length);
              }
              
              this.addToHistory(item);
            }
          })
          .startWatching();
        
        // Also monitor file drops and clipboard file operations
        this.setupFileMonitoring();
      } catch (e) {
        console.error('Error setting up clipboard monitoring:', e);
      }
    }, 3000);
  }
  
  setupFileMonitoring() {
    // Track last processed file to avoid duplicates
    this.lastProcessedFile = null;
    this.lastFileProcessTime = 0;
    let checkCount = 0;
    
    // Check clipboard for files periodically (electron-clipboard-extended doesn't have file events)
    this.clipboardCheckInterval = setInterval(() => {
      checkCount++;
      if (checkCount % 10 === 0) { // Log every 10 checks (10 seconds)
        console.log(`File monitoring: Check #${checkCount}`);
      }
      
      if (this.isProcessing) return;
      
      // Only check every 5th iteration to reduce CPU usage
      if (checkCount % 5 !== 0) return;
      
      // Check if clipboard contains file paths (platform specific)
      const formats = clipboardEx.availableFormats();
      
      // Log available formats for debugging when files are detected
      const hasFileFormats = formats.some(f => 
        f.includes('File') || 
        f.includes('file') || 
        f.includes('NSFilenamesPboardType') ||
        f.includes('public.file-url')
      );
      
      if (hasFileFormats) {
        console.log('File monitoring: Clipboard formats detected:', formats);
      }
      
      if (process.platform === 'darwin') {
        // Try NSFilenamesPboardType first (most common)
        if (formats.includes('NSFilenamesPboardType')) {
          console.log('File monitoring: Detected file(s) on clipboard (macOS - NSFilenamesPboardType)');
          const buffer = clipboardEx.readBuffer('NSFilenamesPboardType');
          if (buffer && buffer.length > 0) {
            try {
              const files = this.parseMacFileList(buffer);
              console.log('File monitoring: Parsed files:', files);
              
              files.forEach(filePath => {
                // Skip if we just processed this file
                if (this.lastProcessedFile === filePath && 
                    Date.now() - this.lastFileProcessTime < 2000) {
                  console.log('File monitoring: Skipping recently processed file:', filePath);
                  return;
                }
                
                this.lastProcessedFile = filePath;
                this.lastFileProcessTime = Date.now();
                console.log('File monitoring: Processing file:', filePath);
                this.handleFilePath(filePath);
              });
            } catch (e) {
              console.error('File monitoring: Error parsing file list:', e);
            }
          }
        }
        // Also check for public.file-url
        else if (formats.includes('public.file-url')) {
          console.log('File monitoring: Detected file URL on clipboard (macOS - public.file-url)');
          const buffer = clipboardEx.readBuffer('public.file-url');
          if (buffer && buffer.length > 0) {
            try {
              // This format often contains file:// URLs
              const urlString = buffer.toString('utf8');
              console.log('File URL string:', urlString);
              
              // Extract file path from file:// URL
              if (urlString.startsWith('file://')) {
                const filePath = decodeURIComponent(urlString.replace('file://', ''));
                
                if (this.lastProcessedFile !== filePath || 
                    Date.now() - this.lastFileProcessTime > 2000) {
                  this.lastProcessedFile = filePath;
                  this.lastFileProcessTime = Date.now();
                  console.log('File monitoring: Processing file from URL:', filePath);
                  this.handleFilePath(filePath);
                }
              }
            } catch (e) {
              console.error('File monitoring: Error parsing file URL:', e);
            }
          }
        }
      } else if (process.platform === 'win32' && formats.includes('FileNameW')) {
        // Windows file handling
        const buffer = clipboardEx.readBuffer('FileNameW');
        if (buffer && buffer.length > 0) {
          const files = this.parseWindowsFileList(buffer);
          files.forEach(filePath => this.handleFilePath(filePath));
        }
      }
    }, 1000); // Check every 1 second instead of 200ms to reduce CPU usage
  }
  
  async handleFilePath(filePath) {
    const fs = require('fs');
    const path = require('path');
    
    console.log('Processing file path:', filePath);
    
    try {
      if (!fs.existsSync(filePath)) {
        console.log('File does not exist:', filePath);
        return;
      }
      
      const stats = fs.statSync(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const fileName = path.basename(filePath);
      
      console.log(`File details: name=${fileName}, ext=${ext}, size=${stats.size}`);
      
      // Determine file type
      let fileType = 'file';
      let fileCategory = 'document';
      
      // Video extensions
      if (['.mp4', '.avi', '.mov', '.wmv', '.flv', '.mkv', '.webm', '.m4v', '.mpg', '.mpeg'].includes(ext)) {
        fileType = 'video';
        fileCategory = 'media';
      }
      // Audio extensions
      else if (['.mp3', '.wav', '.flac', '.aac', '.ogg', '.wma', '.m4a', '.opus', '.aiff', '.ape', '.amr', '.au'].includes(ext)) {
        fileType = 'audio';
        fileCategory = 'media';
      }
      // Image extensions (for files, not clipboard images)
      else if (['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.svg', '.webp', '.ico'].includes(ext)) {
        fileType = 'image-file';
        fileCategory = 'media';
      }
      // PDF files get their own type
      else if (ext === '.pdf') {
        fileType = 'pdf';
        fileCategory = 'document';
      }
      // Other document extensions
      else if (['.doc', '.docx', '.txt', '.rtf', '.odt', '.md'].includes(ext)) {
        fileCategory = 'document';
      }
      // Code extensions
      else if (['.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.cpp', '.c', '.h', '.cs', '.php', '.rb', '.go', '.rs', '.swift', '.kt', '.html', '.htm', '.css', '.scss', '.sass', '.less', '.ipynb'].includes(ext)) {
        fileCategory = 'code';
      }
      // Design files
      else if (['.fig', '.sketch', '.xd', '.ai', '.psd', '.psb', '.indd', '.afdesign', '.afphoto'].includes(ext)) {
        fileCategory = 'design';
      }
      // Archive extensions
      else if (['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2'].includes(ext)) {
        fileCategory = 'archive';
      }
      // Data extensions
      else if (['.json', '.xml', '.csv', '.tsv', '.yaml', '.yml'].includes(ext)) {
        fileCategory = 'data';
      }
      // GSX Flow files
      else if (fileName.toLowerCase().startsWith('flowsource_')) {
        fileCategory = 'flow';
        fileType = 'flow';
      }
      
      // For small text/code files, read content
      let fileContent = null;
      let preview = fileName;
      
      if (fileCategory === 'code' || (fileCategory === 'document' && (ext === '.txt' || ext === '.md'))) {
        if (stats.size < 1024 * 1024) { // Less than 1MB
          try {
            fileContent = fs.readFileSync(filePath, 'utf8');
            preview = this.truncateText(fileContent, 100);
          } catch (e) {
            // If can't read as text, just use filename
          }
        }
      }
      
      // Create thumbnail for media files if possible
      let thumbnail = null;
      let originalImage = null;
      
      // Create thumbnail for PDF files
      if (fileType === 'pdf') {
        // Use placeholder initially
        thumbnail = this.generatePDFPlaceholder(fileName, stats.size);
        
        // Try to generate native thumbnail in background (non-blocking)
        this.generatePDFThumbnail(filePath)
          .then(realThumbnail => {
            console.log('Generated native PDF thumbnail for:', fileName);
            // Update the item's thumbnail if it's still in history
            const item = this.history.find(h => h.filePath === filePath);
            if (item) {
              item.thumbnail = realThumbnail;
              this.notifyHistoryUpdate();
            }
          })
          .catch(e => {
            console.error('Error creating native PDF thumbnail:', e);
            // Keep using placeholder
          });
      }
      // Create thumbnail for HTML files
      else if (['.html', '.htm'].includes(ext)) {
        try {
          // Read HTML content for real preview
          const htmlContent = fs.readFileSync(filePath, 'utf8');
          const htmlItem = {
            id: this.generateId(),
            type: 'html',
            content: htmlContent,
            plainText: fileName,
            fileName: fileName
          };
          
          console.log('Generating real HTML thumbnail for file:', fileName);
          thumbnail = await this.htmlPreviewSystem.generateHTMLThumbnail(htmlItem);
          console.log('Generated real HTML thumbnail successfully');
        } catch (e) {
          console.error('Error creating real HTML thumbnail:', e);
          // Fall back to SVG placeholder
          thumbnail = this.generateHTMLThumbnail(fileName, stats.size);
        }
      }
      // Create thumbnail for image files
      else if (fileType === 'image-file' && stats.size < 50 * 1024 * 1024) { // Less than 50MB
        try {
          // Temporarily pause to prevent duplicate detection
          // REMOVED: isPaused is no longer needed since clipboard monitoring is disabled
          // this.isPaused = true;
          
          const imageData = fs.readFileSync(filePath);
          originalImage = `data:image/${ext.slice(1)};base64,${imageData.toString('base64')}`;
          
          // Generate thumbnail for display
          thumbnail = this.generateImageThumbnail(originalImage);
          
          // For image files, also add as an image item in clipboard
          // This allows the image to be pasted directly into other applications
          const imageItem = {
            id: this.generateId(),
            type: 'image',
            content: originalImage,  // Keep original for copying
            thumbnail: thumbnail,     // Add thumbnail for display
            preview: 'Image from file',
            timestamp: Date.now(),
            dimensions: null, // We could use image-size package to get dimensions
            pinned: false,
            spaceId: this.currentSpace,
            sourceFile: filePath,
            fileName: fileName
          };
          
          // Add the image item
          console.log(`Adding image from file: ${fileName}`);
          this.addToHistory(imageItem);
          
          // Resume monitoring after a short delay
          setTimeout(() => {
            // REMOVED: isPaused is no longer needed since clipboard monitoring is disabled
            // this.isPaused = false;
          }, 1000);
          
          // Don't return - also add as a file item for file operations
        } catch (e) {
          console.error('Error creating image from file:', e);
          // REMOVED: isPaused is no longer needed since clipboard monitoring is disabled
          // this.isPaused = false;
          // Couldn't create thumbnail
        }
      }
      
      // Check if this file was already added recently
      const recentItem = this.history.find(item => 
        item.type === 'file' && 
        item.filePath === filePath && 
        Date.now() - item.timestamp < 2000 // Within 2 seconds
      );
      
      if (recentItem) return;
      
      this.addToHistory({
        id: this.generateId(),
        type: 'file',
        fileType: fileType,
        fileCategory: fileCategory,
        filePath: filePath,
        fileName: fileName,
        fileExt: ext,
        fileSize: stats.size,
        content: fileContent,
        thumbnail: thumbnail,
        preview: preview,
        timestamp: Date.now(),
        pinned: false,
        spaceId: this.currentSpace
      });
      
    } catch (error) {
      console.error('Error handling file path:', error);
    }
  }
  
  isFilePath(text) {
    // Check if text looks like a file path
    const path = require('path');
    
    // Check for common path patterns
    if (process.platform === 'win32') {
      // Windows paths
      return /^[a-zA-Z]:\\/.test(text) || /^\\\\/.test(text);
    } else {
      // Unix paths
      return text.startsWith('/') || text.startsWith('~');
    }
  }
  
  parseMacFileList(buffer) {
    // Parse macOS file list from clipboard
    try {
      // First, try to parse as plist
      const plist = require('plist');
      try {
        const data = plist.parse(buffer);
        console.log('Parsed plist data:', data);
        return Array.isArray(data) ? data : [data];
      } catch (plistError) {
        // If plist parsing fails, try other approaches
        console.log('Plist parsing failed, trying alternative methods');
        
        // Try to parse as string
        const str = buffer.toString('utf8');
        if (str && str.trim()) {
          // Split by newlines or null characters
          const paths = str.split(/[\n\0]+/).filter(p => p.trim());
          if (paths.length > 0) {
            console.log('Parsed as string paths:', paths);
            return paths;
          }
        }
        
        // Try UTF-16
        const str16 = buffer.toString('utf16le');
        if (str16 && str16.trim()) {
          const paths = str16.split(/[\n\0]+/).filter(p => p.trim());
          if (paths.length > 0) {
            console.log('Parsed as UTF-16 paths:', paths);
            return paths;
          }
        }
      }
    } catch (e) {
      console.error('Error in parseMacFileList:', e);
    }
    return [];
  }
  
  parseWindowsFileList(buffer) {
    // Parse Windows file list from clipboard
    try {
      // Windows stores file paths as null-terminated wide strings
      const files = [];
      let start = 0;
      
      for (let i = 0; i < buffer.length - 1; i += 2) {
        if (buffer[i] === 0 && buffer[i + 1] === 0) {
          if (i > start) {
            const filePath = buffer.toString('utf16le', start, i);
            if (filePath) files.push(filePath);
          }
          start = i + 2;
        }
      }
      
      return files;
    } catch (e) {
      return [];
    }
  }
  
  setupIPC() {
    // Get clipboard history
    ipcMain.handle('clipboard:get-history', () => {
      console.log('IPC: Getting clipboard history, current length:', this.history.length);
      const historyToReturn = this.getHistory();
      console.log('IPC: Returning history items:', historyToReturn.length);
      if (historyToReturn.length > 0) {
        console.log('IPC: First item type:', historyToReturn[0].type);
      }
      return historyToReturn;
    });
    
    // Clear history
    ipcMain.handle('clipboard:clear-history', async () => {
      await this.clearHistory();
      return { success: true };
    });
    
    // Delete specific item
    ipcMain.handle('clipboard:delete-item', async (event, id) => {
      await this.deleteItem(id);
      return { success: true };
    });
    
    // Pin/unpin item
    ipcMain.handle('clipboard:toggle-pin', (event, id) => {
      return this.togglePin(id);
    });
    
    // Paste item (copy to clipboard)
    ipcMain.handle('clipboard:paste-item', (event, id) => {
      const item = this.history.find(h => h.id === id);
      if (item) {
        // REMOVED: No need to pause monitoring since it's disabled
        // this.isPaused = true; // Temporarily pause monitoring
        
        try {
          if (item.type === 'text') {
            clipboardEx.writeText(item.content);
          } else if (item.type === 'html') {
            clipboardEx.writeHTML(item.content);
            if (item.plainText) {
              clipboardEx.writeText(item.plainText);
            }
          } else if (item.type === 'image') {
            // For images, read from file system instead of using base64 data
            const { clipboard, nativeImage } = require('electron');
            const spaceDir = this.getSpaceDirectory(item.spaceId);
            const itemDir = path.join(spaceDir, item.id);
            const imagePath = path.join(itemDir, 'image.png');
            
            if (fs.existsSync(imagePath)) {
              // Read image file directly
              const image = nativeImage.createFromPath(imagePath);
              if (!image.isEmpty()) {
                clipboard.writeImage(image);
              } else {
                console.error('Failed to load image from path:', imagePath);
                // Fallback to base64 if file reading fails
                if (item.content) {
                  const fallbackImage = nativeImage.createFromDataURL(item.content);
                  clipboard.writeImage(fallbackImage);
                }
              }
            } else if (item.content) {
              // Fallback to base64 if file doesn't exist
              console.warn('Image file not found, using base64 fallback:', imagePath);
              const image = nativeImage.createFromDataURL(item.content);
              clipboard.writeImage(image);
            }
          } else if (item.type === 'file') {
            // Check if file exists
            if (!fs.existsSync(item.filePath)) {
              console.error('File does not exist:', item.filePath);
              return { success: false, error: 'File not found' };
            }
            
            // For now, just write the file path as text to avoid crashes
            // This will allow the path to be pasted as text in applications
            try {
              clipboardEx.writeText(item.filePath);
              console.log('File path written to clipboard as text:', item.filePath);
            } catch (err) {
              console.error('Error writing file path to clipboard:', err);
              return { success: false, error: err.message };
            }
          }
          
          // REMOVED: No need to unpause since monitoring is disabled
          // setTimeout(() => {
          //   this.isPaused = false;
          // }, 100);
          
          return { success: true };
        } catch (error) {
          console.error('Error pasting item:', error);
          // REMOVED: No need to unpause since monitoring is disabled
          // this.isPaused = false;
          return { success: false, error: error.message };
        }
      }
      return { success: false, error: 'Item not found' };
    });
    
    // Search history
    ipcMain.handle('clipboard:search', (event, query) => {
      return this.searchHistory(query);
    });
    
    // Get stats
    ipcMain.handle('clipboard:get-stats', () => {
      return {
        totalItems: this.history.length,
        pinnedItems: this.pinnedItems.size,
        typeBreakdown: this.getTypeBreakdown(),
        spaces: this.spaces.length
      };
    });
    
    // Spaces management
    ipcMain.handle('clipboard:get-spaces', () => {
      return this.getSpaces();
    });
    
    ipcMain.handle('clipboard:create-space', (event, space) => {
      return this.createSpace(space);
    });
    
    ipcMain.handle('clipboard:update-space', (event, id, updates) => {
      return this.updateSpace(id, updates);
    });
    
    ipcMain.handle('clipboard:delete-space', (event, id) => {
      return this.deleteSpace(id);
    });
    
    ipcMain.handle('clipboard:set-current-space', (event, spaceId) => {
      this.currentSpace = spaceId;
      return { success: true, currentSpace: this.currentSpace };
    });
    
    ipcMain.handle('clipboard:move-to-space', (event, itemId, spaceId) => {
      return this.moveItemToSpace(itemId, spaceId);
    });
    
    ipcMain.handle('clipboard:get-space-items', (event, spaceId) => {
      return this.getSpaceItems(spaceId);
    });
    
    // Get spaces enabled state
    ipcMain.handle('clipboard:get-spaces-enabled', () => {
      return this.spacesEnabled;
    });
    
    // Toggle spaces
    ipcMain.handle('clipboard:toggle-spaces', (event, enabled) => {
      this.toggleSpaces(enabled);
      return { success: true, spacesEnabled: this.spacesEnabled };
    });
    
    // Get active space
    ipcMain.handle('clipboard:get-active-space', () => {
      return {
        spaceId: this.currentSpace,
        spaceName: this.getSpaceName(this.currentSpace)
      };
    });
    
    // Open storage directory in file manager
    ipcMain.handle('clipboard:open-storage-directory', () => {
      const { shell } = require('electron');
      shell.openPath(this.storageRoot);
      return { success: true, path: this.storageRoot };
    });
    
    // Open space directory in file manager
    ipcMain.handle('clipboard:open-space-directory', (event, spaceId) => {
      const { shell } = require('electron');
      const spaceDir = this.getSpaceDirectory(spaceId);
      shell.openPath(spaceDir);
      return { success: true, path: spaceDir };
    });
    
    // Update item metadata
    ipcMain.handle('clipboard:update-metadata', (event, itemId, updates) => {
      const item = this.history.find(h => h.id === itemId);
      if (!item) {
        return { success: false, error: 'Item not found' };
      }
      
      const spaceDir = this.getSpaceDirectory(item.spaceId);
      const itemDir = path.join(spaceDir, itemId);
      const metadataPath = path.join(itemDir, 'metadata.json');
      
      try {
        // Read existing metadata
        let metadata = {};
        if (fs.existsSync(metadataPath)) {
          metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        }
        
        // Update metadata fields
        if (updates.description !== undefined) metadata.description = updates.description;
        if (updates.notes !== undefined) metadata.notes = updates.notes;
        if (updates.instructions !== undefined) metadata.instructions = updates.instructions;
        if (updates.tags !== undefined) metadata.tags = updates.tags;
        if (updates.source !== undefined) metadata.source = updates.source;
        if (updates.version !== undefined) metadata.version = updates.version;
        
        // AI-related metadata updates
        if (updates.ai_generated !== undefined) metadata.ai_generated = updates.ai_generated;
        if (updates.ai_assisted !== undefined) metadata.ai_assisted = updates.ai_assisted;
        if (updates.ai_model !== undefined) metadata.ai_model = updates.ai_model;
        if (updates.ai_provider !== undefined) metadata.ai_provider = updates.ai_provider;
        if (updates.ai_confidence !== undefined) metadata.ai_confidence = updates.ai_confidence;
        if (updates.ai_prompt !== undefined) metadata.ai_prompt = updates.ai_prompt;
        if (updates.ai_context !== undefined) metadata.ai_context = updates.ai_context;
        
        // Save updated metadata
        fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
        
        return { success: true, metadata };
      } catch (error) {
        console.error('Error updating metadata:', error);
        return { success: false, error: error.message };
      }
    });
    
    // Get item metadata
    ipcMain.handle('clipboard:get-metadata', (event, itemId) => {
      const item = this.history.find(h => h.id === itemId);
      if (!item) {
        return { success: false, error: 'Item not found' };
      }
      
      const spaceDir = this.getSpaceDirectory(item.spaceId);
      const itemDir = path.join(spaceDir, item.id);
      const metadataPath = path.join(itemDir, 'metadata.json');
      
      try {
        if (fs.existsSync(metadataPath)) {
          const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
          return { success: true, metadata };
        }
        return { success: false, error: 'Metadata not found' };
      } catch (error) {
        console.error('Error reading metadata:', error);
        return { success: false, error: error.message };
      }
    });
    
    // Get audio file as base64
    ipcMain.handle('clipboard:get-audio-data', (event, itemId) => {
      const item = this.history.find(h => h.id === itemId);
      if (!item || item.type !== 'file' || item.fileType !== 'audio') {
        return { success: false, error: 'Audio file not found' };
      }
      
      try {
        if (fs.existsSync(item.filePath)) {
          const audioData = fs.readFileSync(item.filePath);
          const base64 = audioData.toString('base64');
          const mimeType = this.getAudioMimeType(item.fileExt);
          const dataUrl = `data:${mimeType};base64,${base64}`;
          return { success: true, dataUrl };
        } else {
          return { success: false, error: 'Audio file no longer exists' };
        }
      } catch (error) {
        console.error('Error reading audio file:', error);
        return { success: false, error: error.message };
      }
    });
    
    // Search by tags
    ipcMain.handle('clipboard:search-by-tags', (event, tags) => {
      const results = [];
      
      this.history.forEach(item => {
        const spaceDir = this.getSpaceDirectory(item.spaceId);
        const itemDir = path.join(spaceDir, item.id);
        const metadataPath = path.join(itemDir, 'metadata.json');
        
        try {
          if (fs.existsSync(metadataPath)) {
            const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
            if (metadata.tags && metadata.tags.some(tag => tags.includes(tag))) {
              results.push({
                ...item,
                metadata
              });
            }
          }
        } catch (error) {
          console.error('Error searching tags:', error);
        }
      });
      
      return results;
    });
    
    // Search for AI-generated content
    ipcMain.handle('clipboard:search-ai-content', (event, options = {}) => {
      const results = [];
      
      this.history.forEach(item => {
        const spaceDir = this.getSpaceDirectory(item.spaceId);
        const itemDir = path.join(spaceDir, item.id);
        const metadataPath = path.join(itemDir, 'metadata.json');
        
        try {
          if (fs.existsSync(metadataPath)) {
            const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
            
            // Check AI-related criteria
            let matches = false;
            
            if (options.ai_generated && metadata.ai_generated) {
              matches = true;
            }
            if (options.ai_assisted && metadata.ai_assisted) {
              matches = true;
            }
            if (options.ai_provider && metadata.ai_provider === options.ai_provider) {
              matches = true;
            }
            if (options.ai_model && metadata.ai_model === options.ai_model) {
              matches = true;
            }
            if (options.includeAll && (metadata.ai_generated || metadata.ai_assisted)) {
              matches = true;
            }
            
            if (matches) {
              results.push({
                ...item,
                metadata
              });
            }
          }
        } catch (error) {
          console.error('Error searching AI content:', error);
        }
      });
      
      return results;
    });
    
    // Add diagnostic IPC handler
    ipcMain.handle('clipboard:diagnose', () => {
      const formats = clipboardEx.availableFormats();
      const diagnosis = {
        formats: formats,
        contents: {},
        isPaused: this.isProcessing  // Add pause status to diagnosis
      };
      
      // Try to read each format
      formats.forEach(format => {
        try {
          const buffer = clipboardEx.readBuffer(format);
          if (buffer && buffer.length > 0) {
            diagnosis.contents[format] = {
              size: buffer.length,
              preview: buffer.toString('utf8', 0, Math.min(100, buffer.length)),
              hex: buffer.toString('hex', 0, Math.min(50, buffer.length))
            };
          }
        } catch (e) {
          diagnosis.contents[format] = { error: e.message };
        }
      });
      
      // Also check standard clipboard methods
      try {
        diagnosis.text = clipboardEx.readText();
        diagnosis.html = clipboardEx.readHTML();
        const image = clipboardEx.readImage();
        if (!image.isEmpty()) {
          const size = image.getSize();
          diagnosis.image = { width: size.width, height: size.height };
        }
        
        // Special handling for text/uri-list
        if (formats.includes('text/uri-list')) {
          try {
            const uriList = clipboardEx.readBuffer('text/uri-list').toString('utf8');
            diagnosis.uriList = uriList.split(/\r?\n/).filter(line => line.trim());
          } catch (e) {
            diagnosis.uriListError = e.message;
          }
        }
      } catch (e) {
        diagnosis.error = e.message;
      }
      
      console.log('Clipboard diagnosis:', JSON.stringify(diagnosis, null, 2));
      return diagnosis;
    });
    
    // Add force resume handler
    ipcMain.handle('clipboard:force-resume', () => {
      console.log('Force resuming clipboard monitoring (was paused:', this.isProcessing, ')');
      this.isProcessing = false;
      return { success: true, wasPaused: this.isProcessing };
    });
    
    // Add manual check handler
    ipcMain.handle('clipboard:manual-check', () => {
      console.log('Manual clipboard check requested');
      
      // Get current clipboard contents
      const text = clipboardEx.readText();
      const formats = clipboardEx.availableFormats();
      
      console.log('Manual check - Text:', text);
      console.log('Manual check - Formats:', formats);
      
      // Check if it looks like a filename
      if (text && text.trim() && !text.includes('/') && !text.includes('\\') && 
          text.includes('.') && !text.includes(' ') && !text.includes('\n')) {
        
        const trimmedText = text.trim();
        console.log('Manual check - Detected filename:', trimmedText);
        
        // Check common locations for the file
        const commonPaths = [
          path.join(app.getPath('desktop'), trimmedText),
          path.join(app.getPath('downloads'), trimmedText),
          path.join(app.getPath('documents'), trimmedText),
          path.join(app.getPath('home'), trimmedText)
        ];
        
        for (const testPath of commonPaths) {
          if (fs.existsSync(testPath)) {
            console.log('Manual check - Found file at:', testPath);
            this.handleFilePath(testPath);
            return { success: true, processed: true, file: testPath };
          }
        }
      }
      
      // If not a file, just add as text
      if (text && text.trim()) {
        this.addToHistory({
          id: this.generateId(),
          type: 'text',
          content: text,
          preview: this.truncateText(text, 100),
          timestamp: Date.now(),
          source: this.detectSource(text),
          pinned: false,
          spaceId: this.currentSpace
        });
        return { success: true, processed: true, type: 'text' };
      }
      
      return { success: true, processed: false, message: 'No processable content found' };
    });
    
    // Get current user
    ipcMain.handle('clipboard:get-current-user', () => {
      return os.userInfo().username || 'Unknown';
    });
    
    // Black hole widget handlers
    ipcMain.handle('black-hole:add-text', (event, data) => {
      const item = {
        id: this.generateId(),
        type: 'text',
        content: data.content,
        preview: this.truncateText(data.content, 100),
        timestamp: Date.now(),
        source: 'black-hole',
        pinned: false,
        spaceId: data.spaceId || this.currentSpace
      };
      
      this.addToHistory(item);
      return { success: true, item };
    });
    
    ipcMain.handle('black-hole:add-html', async (event, data) => {
      const item = {
        id: this.generateId(),
        type: 'html',
        content: data.content,
        plainText: data.plainText,
        preview: this.truncateText(data.plainText || this.stripHtml(data.content), 100),
        timestamp: Date.now(),
        source: 'black-hole',
        pinned: false,
        spaceId: data.spaceId || this.currentSpace
      };
      
      // Generate real HTML thumbnail
      try {
        console.log('Generating HTML thumbnail for Black Hole item...');
        item.thumbnail = await this.htmlPreviewSystem.generateHTMLThumbnail(item);
        console.log('HTML thumbnail generated successfully');
      } catch (error) {
        console.error('Error generating HTML thumbnail:', error);
        // Fall back to SVG placeholder
        item.thumbnail = this.generateHTMLThumbnail('HTML Content', 0);
      }
      
      this.addToHistory(item);
      return { success: true, item };
    });
    
    ipcMain.handle('black-hole:add-image', (event, data) => {
      // Save image from data URL
      const item = {
        id: this.generateId(),
        type: 'image',
        content: data.dataUrl,
        preview: 'Image from Black Hole',
        timestamp: Date.now(),
        source: 'black-hole',
        pinned: false,
        spaceId: data.spaceId || this.currentSpace,
        fileName: data.fileName || 'image.png'
      };
      
      if (data.fileName) {
        item.fileName = data.fileName;
      }
      
      this.addToHistory(item);
      return { success: true, item };
    });
    
    ipcMain.handle('black-hole:add-file', (event, data) => {
      console.log('Black hole: Adding file to space:', data.spaceId);
      
      // Extract file extension and determine category
      const ext = path.extname(data.fileName).toLowerCase();
      let fileCategory = 'document';
      
      // Determine file category and type based on extension
      let fileType = data.fileType || 'unknown';
      
      if (['.mp4', '.avi', '.mov', '.wmv', '.flv', '.mkv', '.webm', '.m4v', '.mpg', '.mpeg'].includes(ext)) {
        fileType = 'video';
        fileCategory = 'media';
      } else if (['.mp3', '.wav', '.flac', '.aac', '.ogg', '.wma', '.m4a', '.opus', '.aiff', '.ape', '.amr', '.au'].includes(ext)) {
        fileType = 'audio';
        fileCategory = 'media';
      } else if (['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.svg', '.webp', '.ico'].includes(ext)) {
        fileType = 'image-file';
        fileCategory = 'media';
      } else if (ext === '.pdf') {
        fileType = 'pdf';
        fileCategory = 'document';
      } else if (['.doc', '.docx', '.txt', '.rtf', '.odt', '.md'].includes(ext)) {
        fileCategory = 'document';
      } else if (['.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.cpp', '.c', '.h', '.cs', '.php', '.rb', '.go', '.rs', '.swift', '.kt', '.html', '.htm', '.css', '.scss', '.sass', '.less', '.ipynb'].includes(ext)) {
        fileCategory = 'code';
      } else if (['.fig', '.sketch', '.xd', '.ai', '.psd', '.psb', '.indd', '.afdesign', '.afphoto'].includes(ext)) {
        fileCategory = 'design';
      } else if (['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2'].includes(ext)) {
        fileCategory = 'archive';
      } else if (['.json', '.xml', '.csv', '.tsv', '.yaml', '.yml'].includes(ext)) {
        fileCategory = 'data';
      } else if (data.fileName && data.fileName.toLowerCase().startsWith('flowsource_')) {
        fileCategory = 'flow';
        fileType = 'flow';
      }
      
      // Generate thumbnail for PDF files
      let thumbnail = null;
      if (fileType === 'pdf') {
        // For black hole, we only have filename, not full path, so use placeholder
        thumbnail = this.generatePDFPlaceholder(data.fileName, data.fileSize);
      } else if (['.html', '.htm'].includes(ext)) {
        thumbnail = this.generateHTMLThumbnail(data.fileName, data.fileSize);
      }
      
      const item = {
        id: this.generateId(),
        type: 'file',
        fileName: data.fileName,
        fileSize: data.fileSize,
        fileType: fileType,
        fileCategory: fileCategory,
        fileExt: ext,
        preview: `File: ${data.fileName}`,
        thumbnail: thumbnail,
        timestamp: Date.now(),
        pinned: false,
        spaceId: data.spaceId || this.currentSpace || 'unclassified',
        source: 'black-hole',
        // Include file data if provided (for PDFs)
        fileData: data.fileData || null
      };
      
      this.addToHistory(item);
      
      return { success: true };
    });
    
    // Toggle always on top for black hole
    ipcMain.on('black-hole:toggle-always-on-top', (event, enabled) => {
      if (this.blackHoleWindow && !this.blackHoleWindow.isDestroyed()) {
        this.blackHoleWindow.setAlwaysOnTop(enabled, 'floating');
      }
    });
    
    // Resize black hole window
    ipcMain.on('black-hole:resize-window', (event, { width, height }) => {
      if (this.blackHoleWindow && !this.blackHoleWindow.isDestroyed()) {
        this.blackHoleWindow.setSize(width, height, true);
        
        // Center the window on screen when expanding
        if (width > 150) {
          const { screen } = require('electron');
          const primaryDisplay = screen.getPrimaryDisplay();
          const { width: screenWidth, height: screenHeight } = primaryDisplay.workArea;
          const x = Math.round((screenWidth - width) / 2);
          const y = Math.round((screenHeight - height) / 2);
          this.blackHoleWindow.setPosition(x, y, true);
        }
      }
    });
    
    // Move black hole window
    ipcMain.on('black-hole:move-window', (event, { deltaX, deltaY }) => {
      if (this.blackHoleWindow && !this.blackHoleWindow.isDestroyed()) {
        const [currentX, currentY] = this.blackHoleWindow.getPosition();
        this.blackHoleWindow.setPosition(currentX + deltaX, currentY + deltaY, true);
      }
    });
    
    // Get black hole window position
    ipcMain.on('black-hole:get-position', (event) => {
      if (this.blackHoleWindow && !this.blackHoleWindow.isDestroyed()) {
        const [x, y] = this.blackHoleWindow.getPosition();
        event.reply('black-hole:position-response', { x, y });
      }
    });
    
    // Restore black hole window position
    ipcMain.on('black-hole:restore-position', (event, position) => {
      if (this.blackHoleWindow && !this.blackHoleWindow.isDestroyed() && position) {
        this.blackHoleWindow.setPosition(position.x, position.y, true);
      }
    });
    
    // Open black hole window handler
    ipcMain.handle('clipboard:open-black-hole', () => {
      this.createBlackHoleWindow();
      return { success: true };
    });
    
    // Open README notebook in default app
    ipcMain.handle('clipboard:open-space-notebook', (event, spaceId) => {
      const { shell } = require('electron');
      const spaceDir = this.getSpaceDirectory(spaceId);
      const notebookPath = path.join(spaceDir, 'README.ipynb');
      
      if (fs.existsSync(notebookPath)) {
        shell.openPath(notebookPath);
        return { success: true, path: notebookPath };
      }
      return { success: false, error: 'Notebook not found' };
    });
    
    // Screenshot capture settings
    ipcMain.handle('clipboard:get-screenshot-capture-enabled', () => {
      return this.screenshotCaptureEnabled;
    });
    
    ipcMain.handle('clipboard:toggle-screenshot-capture', (event, enabled) => {
      this.screenshotCaptureEnabled = enabled;
      this.savePreferences();
      
      // If enabling and watcher doesn't exist, set it up
      if (enabled && !this.screenshotWatcher) {
        console.log('Re-enabling screenshot watcher...');
        this.setupScreenshotWatcher();
      } else if (!enabled && this.screenshotWatcher) {
        // If disabling and watcher exists, stop it
        console.log('Disabling screenshot watcher...');
        this.screenshotWatcher.close();
        this.screenshotWatcher = null;
      }
      
      // Notify all windows
      BrowserWindow.getAllWindows().forEach(window => {
        window.webContents.send('clipboard:screenshot-capture-toggled', this.screenshotCaptureEnabled);
      });
      
      return { success: true, enabled: this.screenshotCaptureEnabled };
    });
  }
  
  // Spaces methods
  getSpaces() {
    return this.spaces;
  }
  
  createSpace(space) {
    const newSpace = {
      id: this.generateId(),
      name: space.name,
      icon: space.icon || '📁',
      color: space.color || '#64c8ff',
      createdAt: Date.now(),
      itemCount: 0,
      notebook: space.notebook || {}
    };
    
    this.spaces.push(newSpace);
    
    // Create directory for the new space
    const spaceDir = this.getSpaceDirectory(newSpace.id);
    if (!fs.existsSync(spaceDir)) {
      fs.mkdirSync(spaceDir, { recursive: true });
      console.log('Created space directory:', spaceDir);
    }
    
    // Create README.ipynb for the space
    this.createSpaceNotebook(newSpace);
    
    this.saveSpaces();
    this.notifySpacesUpdate();
    
    return { success: true, space: newSpace };
  }
  
  updateSpace(id, updates) {
    const space = this.spaces.find(s => s.id === id);
    if (space) {
      Object.assign(space, updates);
      
      // Update the notebook if notebook data is provided
      if (updates.notebook) {
        this.createSpaceNotebook(space);
      }
      
      this.saveSpaces();
      this.notifySpacesUpdate();
      return { success: true, space };
    }
    return { success: false };
  }
  
  // Create or update the README.ipynb for a space
  createSpaceNotebook(space) {
    const spaceDir = this.getSpaceDirectory(space.id);
    const notebookPath = path.join(spaceDir, 'README.ipynb');
    
    // Create Jupyter notebook structure
    const notebook = {
      "cells": [],
      "metadata": {
        "kernelspec": {
          "display_name": "Markdown",
          "language": "markdown",
          "name": "markdown"
        },
        "language_info": {
          "name": "markdown",
          "version": "1.0"
        },
        "onereach": {
          "space_id": space.id,
          "space_name": space.name,
          "space_icon": space.icon,
          "created_at": space.notebook.createdAt || new Date().toISOString(),
          "updated_at": space.notebook.updatedAt || new Date().toISOString(),
                      "author": space.notebook.author || os.userInfo().username || 'Unknown'
        }
      },
      "nbformat": 4,
      "nbformat_minor": 5
    };
    
    // Title cell
    notebook.cells.push({
      "cell_type": "markdown",
      "metadata": {},
      "source": [
        `# ${space.icon} ${space.name} Space\n`,
        `\n`,
        `**Created:** ${new Date(space.notebook.createdAt || space.createdAt).toLocaleDateString()}\n`,
                    `**Author:** ${space.notebook.author || os.userInfo().username || 'Unknown'}\n`,
        `**Last Updated:** ${new Date(space.notebook.updatedAt || Date.now()).toLocaleDateString()}`
      ]
    });
    
    // Description cell
    if (space.notebook.description) {
      notebook.cells.push({
        "cell_type": "markdown",
        "metadata": {},
        "source": [
          "## Description\n",
          `\n`,
          space.notebook.description
        ]
      });
    }
    
    // Objective cell
    if (space.notebook.objective) {
      notebook.cells.push({
        "cell_type": "markdown",
        "metadata": {},
        "source": [
          "## Objective\n",
          `\n`,
          space.notebook.objective
        ]
      });
    }
    
    // Instructions cell
    if (space.notebook.instructions) {
      notebook.cells.push({
        "cell_type": "markdown",
        "metadata": {},
        "source": [
          "## Instructions\n",
          `\n`,
          space.notebook.instructions
        ]
      });
    }
    
    // Tags cell
    if (space.notebook.tags && space.notebook.tags.length > 0) {
      notebook.cells.push({
        "cell_type": "markdown",
        "metadata": {},
        "source": [
          "## Tags\n",
          `\n`,
          ...space.notebook.tags.map(tag => `- ${tag}\n`)
        ]
      });
    }
    
    // Related Links cell
    if (space.notebook.links && space.notebook.links.length > 0) {
      notebook.cells.push({
        "cell_type": "markdown",
        "metadata": {},
        "source": [
          "## Related Links\n",
          `\n`,
          ...space.notebook.links.map(link => `- [${link}](${link})\n`)
        ]
      });
    }
    
    // Statistics cell
    notebook.cells.push({
      "cell_type": "markdown",
      "metadata": {},
      "source": [
        "## Space Statistics\n",
        `\n`,
        `- **Total Items:** ${space.itemCount || 0}\n`,
        `- **Space ID:** \`${space.id}\`\n`,
        `- **Storage Location:** \`${spaceDir}\`\n`
      ]
    });
    
    // Notes section (empty for user to fill)
    notebook.cells.push({
      "cell_type": "markdown",
      "metadata": {},
      "source": [
        "## Notes\n",
        `\n`,
        `_Add your notes here..._`
      ]
    });
    
    // Save the notebook
    fs.writeFileSync(notebookPath, JSON.stringify(notebook, null, 2));
    console.log('Created/Updated README.ipynb for space:', space.name);
  }
  
  deleteSpace(id) {
    // Remove space
    this.spaces = this.spaces.filter(s => s.id !== id);
    
    // Remove spaceId from all items in that space
    this.history.forEach(item => {
      if (item.spaceId === id) {
        item.spaceId = null;
      }
    });
    
    // If current space was deleted, reset to null
    if (this.currentSpace === id) {
      this.currentSpace = null;
    }
    
    this.saveSpaces();
    this.saveHistory();
    this.notifySpacesUpdate();
    this.notifyHistoryUpdate();
    
    return { success: true };
  }
  
  moveItemToSpace(itemId, spaceId) {
    console.log(`[MOVE] Starting move of item ${itemId} to space ${spaceId}`);
    
    const item = this.history.find(h => h.id === itemId);
    if (item) {
      const oldSpaceId = item.spaceId;
      
      // Normalize null to 'unclassified' for consistency
      const normalizedSpaceId = spaceId === null ? 'unclassified' : spaceId;
      
      console.log(`[MOVE] Found item. Old space: ${oldSpaceId}, New space: ${normalizedSpaceId}`);
      
      item.spaceId = normalizedSpaceId;
      
      // Move in file system
      this.moveItemInFileSystem(itemId, oldSpaceId, normalizedSpaceId);
      
      console.log(`[MOVE] Saving history...`);
      this.saveHistory();
      
      console.log(`[MOVE] Updating space counts...`);
      this.updateSpaceCounts();
      
      console.log(`[MOVE] Notifying history update...`);
      this.notifyHistoryUpdate();
      
      console.log(`[MOVE] Move completed successfully`);
      return { success: true };
    }
    
    console.log(`[MOVE] Item not found!`);
    return { success: false };
  }
  
  getSpaceItems(spaceId) {
    if (spaceId === null) {
      return this.history;
    }
    return this.history.filter(item => item.spaceId === spaceId);
  }
  
  updateSpaceCounts() {
    // Update item count for each space
    this.spaces.forEach(space => {
      space.itemCount = this.history.filter(item => item.spaceId === space.id).length;
    });
    this.saveSpaces();
    this.notifySpacesUpdate(); // Add this to notify UI about the updated counts
  }
  
  addToHistory(item) {
    // Check if item already exists (avoid duplicates)
    let existingIndex = -1;
    
    if (item.type === 'file' && item.filePath) {
      // For files, check by file path instead of content
      existingIndex = this.history.findIndex(h => 
        h.type === 'file' && h.filePath === item.filePath
      );
    } else {
      // For other types, check by content
      existingIndex = this.history.findIndex(h => 
        h.content === item.content && h.type === item.type
      );
    }
    
    // Ensure item has a spaceId - default to 'unclassified' if not set
    if (!item.spaceId) {
      item.spaceId = 'unclassified';
    }
    
    if (existingIndex !== -1) {
      // For screenshots, we might want to update even if it exists
      if (item.isScreenshot) {
        // Remove the old one and add as new
        const oldItem = this.history[existingIndex];
        this.history.splice(existingIndex, 1);
        
        // Delete old item from file system if it has a different ID
        if (oldItem.id !== item.id) {
          this.deleteItemFromFileSystem(oldItem.id, oldItem.spaceId);
        }
        
        // Continue to add as new item
      } else {
        // Move existing item to top with updated timestamp
        const existing = this.history.splice(existingIndex, 1)[0];
        existing.timestamp = Date.now();
        // Update space if currentSpace is set
        if (this.currentSpace !== null) {
          const oldSpaceId = existing.spaceId;
          existing.spaceId = this.currentSpace;
          // Move in file system if space changed
          if (oldSpaceId !== this.currentSpace) {
            this.moveItemInFileSystem(existing.id, oldSpaceId, this.currentSpace);
          }
        }
        this.history.unshift(existing);
        
        // Update space counts
        this.updateSpaceCounts();
        
        // Save to disk
        this.saveHistory();
        
        // Notify renderer
        this.notifyHistoryUpdate();
        return; // Exit early for existing items
      }
    }
    
    // Add metadata
    item = {
      ...item,
      dateCreated: new Date().toISOString(),
      source: this.detectSource(item.content || item.preview || ''),
      author: os.userInfo().username,
      version: '1.0.0',
      tags: this.autoGenerateTags(item)
    };
    
    // Add new item
    this.history.unshift(item);
    
    // Enforce history size limit - keep pinned items and recent items
    if (this.history.length > this.maxHistorySize) {
      // Separate pinned and unpinned items
      const pinnedItems = this.history.filter(h => h.pinned);
      const unpinnedItems = this.history.filter(h => !h.pinned);
      
      // Keep all pinned items and the most recent unpinned items
      const itemsToKeep = this.maxHistorySize - pinnedItems.length;
      const keptUnpinnedItems = unpinnedItems.slice(0, Math.max(itemsToKeep, 0));
      
      // Combine and update history
      this.history = [...pinnedItems, ...keptUnpinnedItems];
      
      console.log(`History size limit enforced: ${this.history.length} items kept (${pinnedItems.length} pinned)`);
    }
    
    // Save to file system
    this.saveItemToFileSystem(item);
    
    // Show notification when item is captured to a specific space
    if (this.currentSpace !== null) {
      const space = this.spaces.find(s => s.id === this.currentSpace);
      if (space) {
        BrowserWindow.getAllWindows().forEach(window => {
          window.webContents.send('show-notification', {
            title: `Captured to ${space.icon} ${space.name}`,
            body: this.getItemPreview(item)
          });
        });
      }
    }
    
    // Maintain max history size
    if (this.history.length > this.maxHistorySize) {
      // Remove oldest unpinned items
      const unpinnedItems = this.history.filter(h => !h.pinned);
      if (unpinnedItems.length > this.maxHistorySize) {
        const toRemove = unpinnedItems[unpinnedItems.length - 1];
        this.history = this.history.filter(h => h.id !== toRemove.id);
        // Also delete from file system
        this.deleteItemFromFileSystem(toRemove.id, toRemove.spaceId);
      }
    }
    
    // Update space counts
    this.updateSpaceCounts();
    
    // Save to disk
    this.saveHistory();
    
    // Notify renderer
    this.notifyHistoryUpdate();
  }
  
  getItemPreview(item) {
    if (item.type === 'text') {
      return item.preview || item.content.substring(0, 50) + '...';
    } else if (item.type === 'image') {
      return 'Image copied';
    } else if (item.type === 'file') {
      return `File: ${item.fileName}`;
    }
    return 'Item copied';
  }
  
  getHistory() {
    return this.history;
  }
  
  searchHistory(query) {
    if (!query || !query.trim()) {
      return this.history;
    }
    
    const lowerQuery = query.toLowerCase();
    return this.history.filter(item => {
      if (item.type === 'text' || item.type === 'html') {
        return item.content.toLowerCase().includes(lowerQuery) ||
               (item.preview && item.preview.toLowerCase().includes(lowerQuery));
      }
      return false;
    });
  }
  
  async deleteItem(id) {
    const item = this.history.find(h => h.id === id);
    if (item) {
      // Wait for any pending operations to complete
      const pendingOps = this.pendingOperations.get(id);
      if (pendingOps && pendingOps.size > 0) {
        console.log(`Waiting for ${pendingOps.size} pending operations to complete before deleting item ${id}`);
        try {
          // Wait for all pending operations with a timeout
          await Promise.race([
            Promise.all(Array.from(pendingOps)),
            new Promise((resolve) => setTimeout(resolve, 5000)) // 5 second timeout
          ]);
        } catch (e) {
          console.error('Error waiting for pending operations:', e);
        }
      }
      
      // Delete from file system
      this.deleteItemFromFileSystem(id, item.spaceId);
    }
    
    this.history = this.history.filter(h => h.id !== id);
    this.pinnedItems.delete(id);
    this.pendingOperations.delete(id); // Clean up pending operations
    this.updateSpaceCounts();
    this.saveHistory();
    this.notifyHistoryUpdate();
  }
  
  async clearHistory() {
    // Get items to delete
    const itemsToDelete = this.history.filter(h => !h.pinned);
    
    // Wait for any pending operations on items to be deleted
    await Promise.all(
      itemsToDelete.map(async (item) => {
        const pendingOps = this.pendingOperations.get(item.id);
        if (pendingOps && pendingOps.size > 0) {
          console.log(`Waiting for pending operations on item ${item.id} before clearing`);
          try {
            await Promise.race([
              Promise.all(Array.from(pendingOps)),
              new Promise((resolve) => setTimeout(resolve, 5000))
            ]);
          } catch (e) {
            console.error('Error waiting for pending operations:', e);
          }
        }
        // Delete from file system
        this.deleteItemFromFileSystem(item.id, item.spaceId);
        this.pendingOperations.delete(item.id);
      })
    );
    
    // Keep pinned items
    this.history = this.history.filter(h => h.pinned);
    this.updateSpaceCounts();
    this.saveHistory();
    this.notifyHistoryUpdate();
  }
  
  togglePin(id) {
    const item = this.history.find(h => h.id === id);
    if (item) {
      item.pinned = !item.pinned;
      if (item.pinned) {
        this.pinnedItems.add(id);
      } else {
        this.pinnedItems.delete(id);
      }
      this.saveHistory();
      this.notifyHistoryUpdate();
      return { success: true, pinned: item.pinned };
    }
    return { success: false };
  }
  
  loadHistory() {
    try {
      // First, load items from file system to ensure we have all items
      console.log('Loading items from file system...');
      const itemsFromFileSystem = this.loadItemsFromFileSystem();
      console.log(`Found ${itemsFromFileSystem.length} items in file system`);
      
      // Then try to load from history file
      if (fs.existsSync(this.historyFilePath)) {
        try {
          const data = fs.readFileSync(this.historyFilePath, 'utf8');
          const historyFromFile = JSON.parse(data);
          console.log(`Found ${historyFromFile.length} items in history file`);
          
          // Create a map of file system items by ID for quick lookup
          const fsItemsMap = new Map(itemsFromFileSystem.map(item => [item.id, item]));
          
          // Merge history: prefer file system data but preserve pinned status from history
          const mergedHistory = [];
          const processedIds = new Set();
          
          // First, add all items from history file, updating with file system data if available
          historyFromFile.forEach(histItem => {
            if (fsItemsMap.has(histItem.id)) {
              // Item exists in file system, use file system data but preserve pinned status
              const fsItem = fsItemsMap.get(histItem.id);
              
              // Log if spaceId differs
              if (fsItem.spaceId !== histItem.spaceId) {
                console.log(`[LOAD] SpaceId mismatch for item ${histItem.id}:`);
                console.log(`  History file: ${histItem.spaceId}`);
                console.log(`  File system: ${fsItem.spaceId}`);
                console.log(`  Using file system value: ${fsItem.spaceId}`);
              }
              
              // Preserve important properties from history that might not be in file system
              fsItem.pinned = histItem.pinned || false;
              
              // If the file system item is missing thumbnail but history has it, preserve it
              if (!fsItem.thumbnail && histItem.thumbnail) {
                fsItem.thumbnail = histItem.thumbnail;
              }
              
              mergedHistory.push(fsItem);
              processedIds.add(histItem.id);
            } else {
              // Item only in history file, keep it
              console.log(`[LOAD] Item ${histItem.id} only in history file, not in file system`);
              mergedHistory.push(histItem);
              processedIds.add(histItem.id);
            }
          });
          
          // Then add any items that are only in file system
          itemsFromFileSystem.forEach(fsItem => {
            if (!processedIds.has(fsItem.id)) {
              mergedHistory.push(fsItem);
            }
          });
          
          // Sort by timestamp (newest first)
          mergedHistory.sort((a, b) => b.timestamp - a.timestamp);
          
          this.history = mergedHistory;
          console.log(`Merged history contains ${this.history.length} items`);
          
          // Rebuild pinned items set
          this.pinnedItems = new Set(
            this.history.filter(h => h.pinned).map(h => h.id)
          );
        } catch (parseError) {
          console.error('Error parsing history file:', parseError);
          // If parsing fails, use items from file system
          this.history = itemsFromFileSystem;
        }
      } else {
        // No history file, use items from file system
        this.history = itemsFromFileSystem;
      }
      
      // Save the merged history
      if (this.history.length > 0) {
        this.saveHistory();
      }
      
    } catch (error) {
      console.error('Error loading clipboard history:', error);
      this.history = [];
    }
  }
  
  loadSpaces() {
    try {
      console.log(`[LOAD-SPACES] Loading spaces from: ${this.spacesFilePath}`);
      
      if (fs.existsSync(this.spacesFilePath)) {
        const fileSize = fs.statSync(this.spacesFilePath).size;
        console.log(`[LOAD-SPACES] Found spaces file (${fileSize} bytes)`);
        
        const data = fs.readFileSync(this.spacesFilePath, 'utf8');
        console.log(`[LOAD-SPACES] Raw file content:`, data);
        
        this.spaces = JSON.parse(data);
        console.log(`[LOAD-SPACES] Parsed ${this.spaces.length} spaces`);
        
        this.migrateSpaceIcons(); // Migrate old emoji icons to abstract ones
        // Don't update counts here - history hasn't been loaded yet
        
        // Ensure directories exist for all spaces
        this.spaces.forEach(space => {
          const spaceDir = this.getSpaceDirectory(space.id);
          if (!fs.existsSync(spaceDir)) {
            fs.mkdirSync(spaceDir, { recursive: true });
            console.log('Created directory for existing space:', spaceDir);
          }
        });
      } else {
        console.log(`[LOAD-SPACES] No spaces file found at: ${this.spacesFilePath}`);
        console.log(`[LOAD-SPACES] Creating default spaces...`);
        
        // Create default spaces on first run
        this.spaces = [
          { 
            id: 'unclassified', 
            name: 'Unclassified', 
            icon: '◯', 
            color: '#64c8ff', 
            itemCount: 0,
            notebook: {
              description: 'Default space for all clipboard items. Organize items into specific spaces as needed.',
              objective: 'Temporary holding area for clipboard content before organizing into dedicated spaces.',
              instructions: 'Use this space for:\n- New clipboard items that haven\'t been categorized\n- Quick captures that need sorting later\n- Items you\'re not sure where to place\n\nTip: Create new spaces for specific projects, topics, or workflows to better organize your clipboard history.',
              tags: ['default', 'unclassified', 'inbox'],
              links: [],
              author: os.userInfo().username || 'Unknown',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            }
          }
        ];
        
        // Create directories for default spaces
        this.spaces.forEach(space => {
          const spaceDir = this.getSpaceDirectory(space.id);
          if (!fs.existsSync(spaceDir)) {
            fs.mkdirSync(spaceDir, { recursive: true });
            console.log('Created directory for default space:', spaceDir);
          }
          // Create README.ipynb for each default space
          this.createSpaceNotebook(space);
        });
        
        this.saveSpaces();
      }
    } catch (error) {
      console.error('[LOAD-SPACES] Error loading clipboard spaces:', error);
      console.error('[LOAD-SPACES] Stack trace:', error.stack);
      this.spaces = [];
    }
    
    // Always ensure at least the unclassified space exists
    if (this.spaces.length === 0 || !this.spaces.find(s => s.id === 'unclassified')) {
      console.log('[LOAD-SPACES] Unclassified space not found, creating it...');
      
      const unclassifiedSpace = { 
        id: 'unclassified', 
        name: 'Unclassified', 
        icon: '◯', 
        color: '#64c8ff', 
        itemCount: 0,
        notebook: {
          description: 'Default space for all clipboard items. Organize items into specific spaces as needed.',
          objective: 'Temporary holding area for clipboard content before organizing into dedicated spaces.',
          instructions: 'Use this space for:\n- New clipboard items that haven\'t been categorized\n- Quick captures that need sorting later\n- Items you\'re not sure where to place\n\nTip: Create new spaces for specific projects, topics, or workflows to better organize your clipboard history.',
          tags: ['default', 'unclassified', 'inbox'],
          links: [],
          author: os.userInfo().username || 'Unknown',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      };
      
      // Add to beginning of spaces array
      this.spaces.unshift(unclassifiedSpace);
      
      // Create directory and notebook
      const spaceDir = this.getSpaceDirectory(unclassifiedSpace.id);
      if (!fs.existsSync(spaceDir)) {
        fs.mkdirSync(spaceDir, { recursive: true });
      }
      this.createSpaceNotebook(unclassifiedSpace);
      
      this.saveSpaces();
    }
  }
  
  migrateSpaceIcons() {
    // Map old emoji icons to new abstract ones
    const iconMap = {
      '💼': '◆',  // Work
      '✨': '●',  // Personal
      '⚡': '▲',  // Code
      '🧠': '◉',  // AI Prompts
      '🏠': '●',  // Old personal
      '💻': '▲',  // Old code
      '🤖': '◉',  // Old AI
      '📁': '◈',  // Folder
      '📋': '□',  // Clipboard
      '🎯': '◎',  // Target
      '': '◇',  // Diamond
      '🔮': '⬢',  // Crystal ball
      '🌟': '✦',  // Star
      '🚀': '△',  // Rocket
      '🎨': '◐',  // Palette
      '🔥': '▽',  // Fire
      '💡': '○',  // Light bulb
      '🌱': '◒',  // Seedling
      '🏆': '■',  // Trophy
      '✏️': '◊',  // Pencil
      '📊': '⬡',  // Chart
      '🔗': '⬟',  // Link
      '🔐': '◈',  // Lock
      '🌈': '✧'   // Rainbow
    };
    
    let updated = false;
    this.spaces.forEach(space => {
      if (iconMap[space.icon]) {
        space.icon = iconMap[space.icon];
        updated = true;
      }
    });
    
    if (updated) {
      this.saveSpaces();
    }
  }
  
  saveHistory() {
    try {
      fs.writeFileSync(this.historyFilePath, JSON.stringify(this.history, null, 2));
    } catch (error) {
      console.error('Error saving clipboard history:', error);
    }
  }
  
  saveSpaces() {
    try {
      console.log(`[SAVE-SPACES] Saving ${this.spaces.length} spaces to: ${this.spacesFilePath}`);
      console.log(`[SAVE-SPACES] Spaces data:`, JSON.stringify(this.spaces, null, 2));
      
      fs.writeFileSync(this.spacesFilePath, JSON.stringify(this.spaces, null, 2));
      
      // Verify the file was written
      if (fs.existsSync(this.spacesFilePath)) {
        const fileSize = fs.statSync(this.spacesFilePath).size;
        console.log(`[SAVE-SPACES] Successfully saved spaces file (${fileSize} bytes)`);
      } else {
        console.error(`[SAVE-SPACES] File was not created at: ${this.spacesFilePath}`);
      }
    } catch (error) {
      console.error('[SAVE-SPACES] Error saving clipboard spaces:', error);
      console.error('[SAVE-SPACES] Stack trace:', error.stack);
    }
  }
  
  notifyHistoryUpdate() {
    // Send update to all windows
    BrowserWindow.getAllWindows().forEach(window => {
      window.webContents.send('clipboard:history-updated', this.history);
    });
  }
  
  notifySpacesUpdate() {
    // Send spaces update to all windows
    BrowserWindow.getAllWindows().forEach(window => {
      window.webContents.send('clipboard:spaces-updated', this.spaces);
    });
    
    // Refresh the application menu to update space list
    const { refreshApplicationMenu } = require('./menu');
    refreshApplicationMenu();
  }
  
  // Helper methods
  generateId() {
    return crypto.randomBytes(16).toString('hex');
  }
  
  truncateText(text, maxLength) {
    if (!text || text.length <= maxLength) return text;
    return text.substring(0, maxLength) + '...';
  }
  
  stripHtml(html) {
    return html.replace(/<[^>]*>/g, '');
  }
  
  detectSource(text) {
    // Try to detect the source of the clipboard content
    if (text.includes('```') || /function|const|let|var|class/.test(text)) {
      return 'code';
    }
    if (/^https?:\/\//.test(text)) {
      return 'url';
    }
    if (text.includes('@') && text.includes('.')) {
      return 'email';
    }
    
    // Detect spreadsheet/tabular data first (before generic data)
    const lines = text.trim().split('\n');
    if (lines.length > 1) {
      // Tab-separated values (TSV) - common when copying from spreadsheets
      const firstLineTabs = (lines[0].match(/\t/g) || []).length;
      if (firstLineTabs > 0) {
        const looksLikeTSV = lines.slice(0, Math.min(5, lines.length)).every(line => 
          (line.match(/\t/g) || []).length === firstLineTabs
        );
        if (looksLikeTSV) return 'spreadsheet';
      }
      
      // Comma-separated values (CSV)
      const firstLineCommas = (lines[0].match(/,/g) || []).length;
      if (firstLineCommas > 0) {
        const looksLikeCSV = lines.slice(0, Math.min(5, lines.length)).every(line => 
          (line.match(/,/g) || []).length === firstLineCommas
        );
        if (looksLikeCSV) return 'spreadsheet';
      }
      
      // Pipe-separated values
      const firstLinePipes = (lines[0].match(/\|/g) || []).length;
      if (firstLinePipes > 1) {
        const looksLikePSV = lines.slice(0, Math.min(5, lines.length)).every(line => 
          (line.match(/\|/g) || []).length === firstLinePipes
        );
        if (looksLikePSV) return 'spreadsheet';
      }
    }
    
    // Detect data formats
    // JSON detection
    try {
      const trimmed = text.trim();
      if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || 
          (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        JSON.parse(trimmed);
        return 'data';
      }
    } catch (e) {
      // Not valid JSON
    }
    
    // XML detection
    if (text.includes('<?xml') || (text.includes('<') && text.includes('>') && text.includes('</'))) {
      return 'data';
    }
    
    // YAML detection
    if (text.includes(':') && (text.includes('\n  ') || text.includes('\n- '))) {
      return 'data';
    }
    
    return 'text';
  }
  
  formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
  
  getAudioMimeType(ext) {
    const mimeTypes = {
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.flac': 'audio/flac',
      '.aac': 'audio/aac',
      '.ogg': 'audio/ogg',
      '.wma': 'audio/x-ms-wma',
      '.m4a': 'audio/mp4',
      '.opus': 'audio/opus',
      '.aiff': 'audio/aiff',
      '.ape': 'audio/ape',
      '.amr': 'audio/amr',
      '.au': 'audio/basic'
    };
    return mimeTypes[ext] || 'audio/mpeg';
  }
  
  getTypeBreakdown() {
    const breakdown = {};
    this.history.forEach(item => {
      breakdown[item.type] = (breakdown[item.type] || 0) + 1;
    });
    return breakdown;
  }
  
  // Create clipboard viewer window
  createClipboardWindow() {
    if (this.clipboardWindow && !this.clipboardWindow.isDestroyed()) {
      this.clipboardWindow.focus();
      return;
    }
    
    this.clipboardWindow = new BrowserWindow({
      width: 1400,
      height: 900,
      frame: false,
      transparent: true,
      alwaysOnTop: false,  // Changed to false so it doesn't always stay on top
      resizable: true,     // Allow resizing
      minWidth: 1200,      // Minimum width
      minHeight: 700,      // Minimum height
      skipTaskbar: false,  // Show in taskbar for easier access
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js')
      }
    });
    
    this.clipboardWindow.loadFile('clipboard-viewer.html');
    
    // Remove the blur close behavior for a workspace window
    // Users can close with Esc or close button
    
    this.clipboardWindow.on('closed', () => {
      this.clipboardWindow = null;
    });
  }
  
  // Create black hole widget window
  createBlackHoleWindow(position, startExpanded = false) {
    if (this.blackHoleWindow) {
      this.blackHoleWindow.focus();
      return;
    }
    
    // Use expanded size if startExpanded is true (for downloads)
    const width = startExpanded ? 600 : 150;
    const height = startExpanded ? 800 : 150;
    
    if (startExpanded) {
      console.log('Creating Black Hole window in expanded mode for space selection');
    }
    
    const windowConfig = {
      width: width,
      height: height,
      transparent: true,
      frame: false,
      alwaysOnTop: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      hasShadow: false,  // Remove window shadow
      backgroundColor: '#00000000',  // Fully transparent background
      show: false,  // Don't show immediately
      skipTaskbar: true,  // Don't show in taskbar
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js')
      }
    };
    
    // Don't set x,y in config if we have a position - we'll use setBounds instead
    
    this.blackHoleWindow = new BrowserWindow(windowConfig);
    
    // If position is provided, set bounds to ensure exact positioning
    if (position && position.x !== undefined && position.y !== undefined) {
      console.log('Setting Black Hole window bounds to position:', position);
      this.blackHoleWindow.setBounds({
        x: position.x,
        y: position.y,
        width: width,
        height: height
      });
    } else {
      // Use saved position as fallback
      const savedPosition = this.getBlackHolePosition();
      if (savedPosition) {
        console.log('Using saved Black Hole position:', savedPosition);
        this.blackHoleWindow.setBounds({
          x: savedPosition.x,
          y: savedPosition.y,
          width: width,
          height: height
        });
      }
    }
    
    // Add debugging for position
    const [x, y] = this.blackHoleWindow.getPosition();
    console.log('Black Hole window created at actual position:', { x, y });
    
    // Load the HTML file with proper path resolution for both dev and production
    const blackHolePath = path.join(__dirname, 'black-hole.html');
    console.log('Loading black hole from:', blackHolePath);
    this.blackHoleWindow.loadFile(blackHolePath);
    
    // Show window when ready
    this.blackHoleWindow.once('ready-to-show', () => {
      // Ensure position is set one more time before showing
      if (position && position.x !== undefined && position.y !== undefined) {
        this.blackHoleWindow.setPosition(position.x, position.y);
      }
      
      this.blackHoleWindow.show();
      console.log('Black Hole window shown');
      
      // Verify position after showing
      const [showX, showY] = this.blackHoleWindow.getPosition();
      console.log('Black Hole window position after show:', { x: showX, y: showY });
      
      // Get screen bounds to ensure window is on screen
      const { screen } = require('electron');
      const primaryDisplay = screen.getPrimaryDisplay();
      const { x: screenX, y: screenY, width: screenWidth, height: screenHeight } = primaryDisplay.bounds;
      console.log('Primary display bounds:', { x: screenX, y: screenY, width: screenWidth, height: screenHeight });
      
      // Check if window is within screen bounds
      if (showX < screenX || showX > screenX + screenWidth - 150 || 
          showY < screenY || showY > screenY + screenHeight - 150) {
        console.warn('Black Hole window is outside screen bounds! Repositioning...');
        // Adjust position to keep it on screen
        const adjustedX = Math.max(screenX, Math.min(showX, screenX + screenWidth - 150));
        const adjustedY = Math.max(screenY, Math.min(showY, screenY + screenHeight - 150));
        this.blackHoleWindow.setPosition(adjustedX, adjustedY);
        console.log('Repositioned to stay on screen:', { x: adjustedX, y: adjustedY });
      }
    });
    
    // Make window click-through except for the actual content
    this.blackHoleWindow.setIgnoreMouseEvents(false);
    
    // Make window draggable but keep always on top
    this.blackHoleWindow.setAlwaysOnTop(true, 'floating');
    
    // Save window position on move
    this.blackHoleWindow.on('moved', () => {
      const [x, y] = this.blackHoleWindow.getPosition();
      this.saveBlackHolePosition(x, y);
    });
    
    this.blackHoleWindow.on('closed', () => {
      this.blackHoleWindow = null;
      
      // Notify all windows that the black hole widget was closed
      BrowserWindow.getAllWindows().forEach(window => {
        window.webContents.send('black-hole-closed');
      });
    });
  }
  
  // Save black hole window position
  saveBlackHolePosition(x, y) {
    try {
      const prefs = {
        ...this.loadPreferencesData(),
        blackHolePosition: { x, y }
      };
      fs.writeFileSync(this.preferencesFilePath, JSON.stringify(prefs, null, 2));
    } catch (error) {
      console.error('Error saving black hole position:', error);
    }
  }
  
  // Get saved black hole window position
  getBlackHolePosition() {
    try {
      const prefs = this.loadPreferencesData();
      return prefs.blackHolePosition || null;
    } catch (error) {
      console.error('Error loading black hole position:', error);
      return null;
    }
  }
  
  // Load preferences data
  loadPreferencesData() {
    try {
      if (fs.existsSync(this.preferencesFilePath)) {
        return JSON.parse(fs.readFileSync(this.preferencesFilePath, 'utf8'));
      }
    } catch (error) {
      console.error('Error loading preferences data:', error);
    }
    return {};
  }
  
  // Register global shortcut
  registerShortcut() {
    const shortcut = process.platform === 'darwin' ? 'Cmd+Shift+V' : 'Ctrl+Shift+V';
    
    globalShortcut.register(shortcut, () => {
      this.createClipboardWindow();
    });
  }
  
  // Cleanup
  destroy() {
    // DISABLED: No need to stop watching since clipboard monitoring is disabled
    // clipboardEx.stopWatching();
    globalShortcut.unregisterAll();
    if (this.clipboardWindow && !this.clipboardWindow.isDestroyed()) {
      this.clipboardWindow.close();
    }
    if (this.blackHoleWindow && !this.blackHoleWindow.isDestroyed()) {
      this.blackHoleWindow.close();
    }
    if (this.pdfThumbnailWindow && !this.pdfThumbnailWindow.isDestroyed()) {
      this.pdfThumbnailWindow.close();
    }
    // Clear any pending image debounce timer
    if (this.imageDebounceTimer) {
      clearTimeout(this.imageDebounceTimer);
    }
    // Clear file monitoring interval
    if (this.clipboardCheckInterval) {
      clearInterval(this.clipboardCheckInterval);
      this.clipboardCheckInterval = null;
    }
    // Clear pending images
    this.pendingImages = [];
    
    // Stop screenshot watcher
    if (this.screenshotWatcher) {
      this.screenshotWatcher.close();
      this.screenshotWatcher = null;
    }
    
    console.log('Clipboard manager cleaned up');
  }
  
  // Initialize PDF thumbnail renderer window
  initializePDFRenderer() {
    console.log('Initializing PDF thumbnail renderer...');
    try {
      // Create hidden window for PDF rendering
      this.pdfThumbnailWindow = new BrowserWindow({
        width: 800,
        height: 600,
        show: false,
        webPreferences: {
          nodeIntegration: true,
          contextIsolation: false,
          offscreen: true,
          webSecurity: false // Allow loading from CDN
        }
      });
      
      // Load the PDF renderer HTML as data URL for better compatibility
      const rendererHTML = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>PDF Thumbnail Generator</title>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
    <script>
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    </script>
</head>
<body>
    <canvas id="pdf-canvas" style="display: none;"></canvas>
    <script>
        const { ipcRenderer } = require('electron');
        const fs = require('fs');
        
        // PDF thumbnail generation function
        async function generatePDFThumbnail(pdfPath, options = {}) {
          const {
            maxWidth = 200,
            maxHeight = 260,
            quality = 0.8
          } = options;

          console.log('Generating thumbnail for:', pdfPath);

          try {
            // Check if file exists
            if (!fs.existsSync(pdfPath)) {
              throw new Error('PDF file not found');
            }

            // Read PDF file
            const data = new Uint8Array(fs.readFileSync(pdfPath));
            
            // Load the PDF document
            const loadingTask = pdfjsLib.getDocument({ data });
            const pdf = await loadingTask.promise;
            
            // Get the first page
            const page = await pdf.getPage(1);
            
            // Calculate scale to fit within max dimensions
            const viewport = page.getViewport({ scale: 1.0 });
            const scaleX = maxWidth / viewport.width;
            const scaleY = maxHeight / viewport.height;
            const scale = Math.min(scaleX, scaleY);
            
            // Get scaled viewport
            const scaledViewport = page.getViewport({ scale });
            
            // Create canvas
            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            canvas.width = scaledViewport.width;
            canvas.height = scaledViewport.height;
            
            // Render PDF page to canvas
            const renderContext = {
              canvasContext: context,
              viewport: scaledViewport,
            };
            
            await page.render(renderContext).promise;
            
            // Add white background if needed
            const tempCanvas = document.createElement('canvas');
            const tempContext = tempCanvas.getContext('2d');
            tempCanvas.width = canvas.width;
            tempCanvas.height = canvas.height;
            
            // Fill white background
            tempContext.fillStyle = '#ffffff';
            tempContext.fillRect(0, 0, tempCanvas.width, tempCanvas.height);
            
            // Draw the PDF content on top
            tempContext.drawImage(canvas, 0, 0);
            
            // Convert to data URL
            const dataUrl = tempCanvas.toDataURL('image/jpeg', quality);
            
            // Clean up
            page.cleanup();
            await pdf.cleanup();
            await pdf.destroy();
            
            return dataUrl;
            
          } catch (error) {
            console.error('Error generating PDF thumbnail:', error);
            throw error;
          }
        }

        // IPC handler for thumbnail requests
        ipcRenderer.on('generate-pdf-thumbnail', async (event, { pdfPath, requestId, options }) => {
          try {
            const thumbnail = await generatePDFThumbnail(pdfPath, options);
            ipcRenderer.send('pdf-thumbnail-result', {
              requestId,
              success: true,
              thumbnail
            });
          } catch (error) {
            ipcRenderer.send('pdf-thumbnail-result', {
              requestId,
              success: false,
              error: error.message
            });
          }
        });

        // Notify main process that renderer is ready
        console.log('PDF thumbnail generator ready');
        ipcRenderer.send('pdf-thumbnail-generator-ready');
    </script>
</body>
</html>`;
      
      this.pdfThumbnailWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(rendererHTML)}`);
      
      // Debug: Log any console messages from the renderer
      this.pdfThumbnailWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
        console.log(`[PDF Renderer] ${message}`);
      });
      
      // Handle loading errors
      this.pdfThumbnailWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
        console.error('[PDF Renderer] Failed to load:', errorDescription);
      });
      
      // Handle renderer ready
      ipcMain.once('pdf-thumbnail-generator-ready', () => {
        console.log('PDF thumbnail generator is ready');
        this.pdfThumbnailReady = true;
        
        // Process any pending requests
        for (const [requestId, request] of this.pdfThumbnailRequests) {
          this.pdfThumbnailWindow.webContents.send('generate-pdf-thumbnail', {
            pdfPath: request.pdfPath,
            requestId: requestId,
            options: request.options
          });
        }
      });
      
      // Handle thumbnail results
      ipcMain.on('pdf-thumbnail-result', (event, data) => {
        const { requestId, success, thumbnail, error } = data;
        const request = this.pdfThumbnailRequests.get(requestId);
        
        if (request) {
          if (success) {
            request.resolve(thumbnail);
          } else {
            console.error('PDF thumbnail generation failed:', error);
            request.reject(new Error(error));
          }
          this.pdfThumbnailRequests.delete(requestId);
        }
      });
      
    } catch (error) {
      console.error('Failed to initialize PDF renderer:', error);
      this.pdfThumbnailReady = false;
    }
  }
  
  // Generate PDF thumbnail using the renderer process
  async generatePDFThumbnailAsync(pdfPath, options = {}) {
    console.log(`[Main] Requesting PDF thumbnail for: ${pdfPath}`);
    return new Promise((resolve, reject) => {
      const requestId = this.generateId();
      
      // Store the request
      this.pdfThumbnailRequests.set(requestId, {
        pdfPath,
        options,
        resolve,
        reject
      });
      
      // If renderer is ready, send the request immediately
      if (this.pdfThumbnailReady && this.pdfThumbnailWindow && !this.pdfThumbnailWindow.isDestroyed()) {
        this.pdfThumbnailWindow.webContents.send('generate-pdf-thumbnail', {
          pdfPath,
          requestId,
          options
        });
      } else {
        // Otherwise it will be processed when renderer is ready
        console.log('PDF renderer not ready, request queued');
      }
      
      // Timeout after 10 seconds
      setTimeout(() => {
        if (this.pdfThumbnailRequests.has(requestId)) {
          this.pdfThumbnailRequests.delete(requestId);
          reject(new Error('PDF thumbnail generation timed out'));
        }
      }, 10000);
    });
  }
  
  loadPreferences() {
    try {
      if (fs.existsSync(this.preferencesFilePath)) {
        const data = fs.readFileSync(this.preferencesFilePath, 'utf8');
        const prefs = JSON.parse(data);
        this.spacesEnabled = prefs.spacesEnabled !== undefined ? prefs.spacesEnabled : true;
        this.screenshotCaptureEnabled = prefs.screenshotCaptureEnabled !== undefined ? prefs.screenshotCaptureEnabled : true;
        // Load current space from preferences, default to 'unclassified' if null
        if (prefs.currentSpace !== undefined) {
          this.currentSpace = prefs.currentSpace || 'unclassified';
        }
      }
    } catch (error) {
      console.error('Error loading clipboard preferences:', error);
    }
  }
  
  savePreferences() {
    try {
      const prefs = {
        spacesEnabled: this.spacesEnabled,
        screenshotCaptureEnabled: this.screenshotCaptureEnabled,
        currentSpace: this.currentSpace
      };
      fs.writeFileSync(this.preferencesFilePath, JSON.stringify(prefs, null, 2));
    } catch (error) {
      console.error('Error saving clipboard preferences:', error);
    }
  }
  
  toggleSpaces(enabled) {
    this.spacesEnabled = enabled;
    this.savePreferences();
    
    // Notify all windows about the change
    BrowserWindow.getAllWindows().forEach(window => {
      window.webContents.send('clipboard:spaces-toggled', this.spacesEnabled);
    });
    
    // Update the menu checkbox state
    const { Menu } = require('electron');
    const menu = Menu.getApplicationMenu();
    if (menu) {
      const clipboardMenu = menu.items.find(item => item.label === 'Clipboard');
      if (clipboardMenu && clipboardMenu.submenu) {
        const toggleItem = clipboardMenu.submenu.items.find(item => item.label === 'Toggle Spaces');
        if (toggleItem) {
          toggleItem.checked = this.spacesEnabled;
        }
      }
    }
  }
  
  setActiveSpace(spaceId) {
    this.currentSpace = spaceId;
    this.savePreferences();
    
    // Get space name for notification
    let spaceName = 'All Items';
    if (spaceId) {
      const space = this.spaces.find(s => s.id === spaceId);
      if (space) {
        spaceName = `${space.icon} ${space.name}`;
      }
    }
    
    // Notify all windows about the change
    BrowserWindow.getAllWindows().forEach(window => {
      window.webContents.send('clipboard:active-space-changed', {
        spaceId: this.currentSpace,
        spaceName: spaceName
      });
      
      // Show notification
      window.webContents.send('show-notification', {
        title: 'Clipboard Space Changed',
        body: `Now capturing to: ${spaceName}`
      });
    });
  }
  
  getSpaceName(spaceId) {
    if (spaceId === null) {
      return 'All Items';
    }
    const space = this.spaces.find(s => s.id === spaceId);
    return space ? `${space.icon} ${space.name}` : 'Unknown Space';
  }
  
  // Add after the constructor
  ensureStorageDirectories() {
    // Create main storage directory
    if (!fs.existsSync(this.storageRoot)) {
      fs.mkdirSync(this.storageRoot, { recursive: true });
      console.log('Created OR-Spaces directory:', this.storageRoot);
    }
    
    // Create "All Items" directory for items not in any space
    const allItemsPath = path.join(this.storageRoot, '_All_Items');
    if (!fs.existsSync(allItemsPath)) {
      fs.mkdirSync(allItemsPath, { recursive: true });
    }
  }
  
  // Get the directory path for a space
  getSpaceDirectory(spaceId) {
    if (spaceId === null) {
      return path.join(this.storageRoot, '_All_Items');
    }
    const space = this.spaces.find(s => s.id === spaceId);
    if (space) {
      // Sanitize space name for filesystem
      const safeName = space.name.replace(/[^a-zA-Z0-9-_ ]/g, '').trim();
      return path.join(this.storageRoot, `${safeName}_${spaceId}`);
    }
    return path.join(this.storageRoot, '_All_Items');
  }
  
  // Save item to file system
  saveItemToFileSystem(item) {
    const spaceDir = this.getSpaceDirectory(item.spaceId);
    
    // Ensure space directory exists
    if (!fs.existsSync(spaceDir)) {
      fs.mkdirSync(spaceDir, { recursive: true });
    }
    
    const itemDir = path.join(spaceDir, item.id);
    fs.mkdirSync(itemDir, { recursive: true });
    
    // Save metadata with enhanced fields
    const metadata = {
      id: item.id,
      type: item.type,
      timestamp: item.timestamp,
      dateCreated: new Date(item.timestamp).toISOString(),
      pinned: item.pinned,
      spaceId: item.spaceId,
      preview: item.preview,
      description: '',  // User can add description of what this item is
      notes: '',  // User can add notes later
      instructions: '',  // Usage instructions or context
      source: this.detectItemSource(item),  // Auto-detect source
      author: os.userInfo().username || 'Unknown',  // Current system user
      version: '1.0.0',  // Version tracking
      tags: this.autoGenerateTags(item),  // Auto-generate initial tags
      // AI-related metadata
      ai_generated: false,  // Whether content was generated by AI
      ai_assisted: false,  // Whether content was co-authored with AI
      ai_model: '',  // AI model used (e.g., "GPT-4", "Claude 3", "Gemini Pro")
      ai_provider: '',  // AI provider (e.g., "OpenAI", "Anthropic", "Google")
      ai_confidence: null,  // Confidence score if applicable (0-1)
      ai_prompt: '',  // The prompt used to generate content
      ai_context: ''  // Additional context about AI usage
    };
    
    // Save content based on type
    if (item.type === 'text') {
      fs.writeFileSync(path.join(itemDir, 'content.txt'), item.content, 'utf8');
      metadata.source = item.source || this.detectSource(item.content);
      metadata.wordCount = item.content.split(/\s+/).filter(word => word.length > 0).length;
      metadata.characterCount = item.content.length;
    } else if (item.type === 'html') {
      fs.writeFileSync(path.join(itemDir, 'content.html'), item.content, 'utf8');
      if (item.plainText) {
        fs.writeFileSync(path.join(itemDir, 'plain.txt'), item.plainText, 'utf8');
        metadata.wordCount = item.plainText.split(/\s+/).filter(word => word.length > 0).length;
      }
      
      // Save HTML thumbnail if available
      if (item.thumbnail) {
        console.log('Saving HTML thumbnail to filesystem');
        // Determine the correct file extension based on the data URL
        const isSvg = item.thumbnail.startsWith('data:image/svg+xml');
        const extension = isSvg ? 'svg' : 'png';
        const thumbData = item.thumbnail.replace(/^data:image\/[^;]+;base64,/, '');
        fs.writeFileSync(path.join(itemDir, `thumbnail.${extension}`), thumbData, 'base64');
      }
    } else if (item.type === 'image') {
      // Save image from base64
      const base64Data = item.content.replace(/^data:image\/[^;]+;base64,/, '');
      fs.writeFileSync(path.join(itemDir, 'image.png'), base64Data, 'base64');
      if (item.dimensions) {
        metadata.dimensions = item.dimensions;
        metadata.aspectRatio = (item.dimensions.width / item.dimensions.height).toFixed(2);
        metadata.pixelCount = item.dimensions.width * item.dimensions.height;
      }
      
      // Save thumbnail if available
      if (item.thumbnail) {
        const isSvg = item.thumbnail.startsWith('data:image/svg+xml');
        const extension = isSvg ? 'svg' : 'png';
        const thumbData = item.thumbnail.replace(/^data:image\/[^;]+;base64,/, '');
        fs.writeFileSync(path.join(itemDir, `thumbnail.${extension}`), thumbData, 'base64');
      }
    } else if (item.type === 'file') {
      // For files from black hole widget, we might not have a filePath
      const destPath = path.join(itemDir, item.fileName);
      
      if (item.fileData) {
        // We have file data (e.g., from black hole widget for PDFs)
        try {
          console.log('Saving file from base64 data:', item.fileName);
          console.log('File type:', item.fileType);
          console.log('File category:', item.fileCategory);
          console.log('Destination path:', destPath);
          const buffer = Buffer.from(item.fileData, 'base64');
          fs.writeFileSync(destPath, buffer);
          console.log('File saved successfully:', destPath);
          console.log('File exists:', fs.existsSync(destPath));
        } catch (err) {
          console.error('Error saving file from data:', err);
        }
      } else if (item.filePath && fs.existsSync(item.filePath)) {
        // Copy the original file
        try {
          fs.copyFileSync(item.filePath, destPath);
        } catch (err) {
          console.error('Error copying file:', err);
          // If copy fails, just save a reference
          fs.writeFileSync(path.join(itemDir, 'file-reference.txt'), item.filePath, 'utf8');
        }
      }
      
      metadata.fileType = item.fileType;
      metadata.fileCategory = item.fileCategory;
      metadata.fileName = item.fileName;
      metadata.fileExt = item.fileExt;
      metadata.fileSize = item.fileSize;
      metadata.fileSizeHuman = this.formatFileSize(item.fileSize);
      metadata.originalPath = item.filePath;
      
      // Handle PDF thumbnails
      console.log('Checking PDF thumbnail generation - fileType:', item.fileType, 'destPath exists:', fs.existsSync(destPath));
      if (item.fileType === 'pdf' && fs.existsSync(destPath)) {
        console.log('Generating PDF thumbnail for saved file:', destPath);
        
        // Track this async operation
        if (!this.pendingOperations.has(item.id)) {
          this.pendingOperations.set(item.id, new Set());
        }
        
        // Generate native thumbnail asynchronously
        const thumbnailPromise = this.generatePDFThumbnail(destPath)
          .then(realThumbnail => {
            console.log('Generated native PDF thumbnail for saved file');
            // Save the thumbnail
            try {
              // Check if item still exists before writing
              if (fs.existsSync(itemDir)) {
                const isSvg = realThumbnail.startsWith('data:image/svg+xml');
                const extension = isSvg ? 'svg' : 'png';
                const thumbData = realThumbnail.replace(/^data:image\/[^;]+;base64,/, '');
                fs.writeFileSync(path.join(itemDir, `thumbnail.${extension}`), thumbData, 'base64');
                
                // Update the item in history
                const historyItem = this.history.find(h => h.id === item.id);
                if (historyItem) {
                  historyItem.thumbnail = realThumbnail;
                  this.notifyHistoryUpdate();
                }
              } else {
                console.log('Item directory was deleted, skipping thumbnail save');
              }
            } catch (e) {
              console.error('Error saving PDF thumbnail:', e);
            }
          })
          .catch(e => {
            console.error('Failed to generate native PDF thumbnail:', e);
            // Save placeholder thumbnail if generation fails
            if (item.thumbnail && fs.existsSync(itemDir)) {
              const isSvg = item.thumbnail.startsWith('data:image/svg+xml');
              const extension = isSvg ? 'svg' : 'png';
              const thumbData = item.thumbnail.replace(/^data:image\/[^;]+;base64,/, '');
              fs.writeFileSync(path.join(itemDir, `thumbnail.${extension}`), thumbData, 'base64');
            }
          })
          .finally(() => {
            // Remove from pending operations
            const pending = this.pendingOperations.get(item.id);
            if (pending) {
              pending.delete(thumbnailPromise);
              if (pending.size === 0) {
                this.pendingOperations.delete(item.id);
              }
            }
          });
        
        // Add to pending operations
        this.pendingOperations.get(item.id).add(thumbnailPromise);
      } else {
        // Save thumbnail if available for non-PDF files
        if (item.thumbnail) {
          const isSvg = item.thumbnail.startsWith('data:image/svg+xml');
          const extension = isSvg ? 'svg' : 'png';
          const thumbData = item.thumbnail.replace(/^data:image\/[^;]+;base64,/, '');
          fs.writeFileSync(path.join(itemDir, `thumbnail.${extension}`), thumbData, 'base64');
        }
      }
    }
    
    // Save metadata
    fs.writeFileSync(path.join(itemDir, 'metadata.json'), JSON.stringify(metadata, null, 2));
    
    console.log(`Saved ${item.type} item to:`, itemDir);
  }
  
  // Move item between spaces in file system
  moveItemInFileSystem(itemId, fromSpaceId, toSpaceId) {
    // Normalize null to 'unclassified' for consistency
    const normalizedFromSpaceId = fromSpaceId === null ? 'unclassified' : fromSpaceId;
    const normalizedToSpaceId = toSpaceId === null ? 'unclassified' : toSpaceId;
    
    const fromDir = this.getSpaceDirectory(normalizedFromSpaceId);
    const toDir = this.getSpaceDirectory(normalizedToSpaceId);
    
    const fromPath = path.join(fromDir, itemId);
    const toPath = path.join(toDir, itemId);
    
    console.log(`[MOVE-FS] Moving item from ${fromPath} to ${toPath}`);
    
    if (fs.existsSync(fromPath)) {
      // Ensure target directory exists
      if (!fs.existsSync(toDir)) {
        fs.mkdirSync(toDir, { recursive: true });
        console.log(`[MOVE-FS] Created target directory: ${toDir}`);
      }
      
      // Move the directory
      try {
        fs.renameSync(fromPath, toPath);
        console.log(`[MOVE-FS] Successfully moved directory`);
      } catch (error) {
        console.error(`[MOVE-FS] Error moving directory:`, error);
        throw error;
      }
      
      // Update the metadata.json file with the new spaceId
      const metadataPath = path.join(toPath, 'metadata.json');
      if (fs.existsSync(metadataPath)) {
        try {
          const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
          metadata.spaceId = normalizedToSpaceId;
          fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
          console.log(`[MOVE-FS] Updated metadata.json with new spaceId: ${normalizedToSpaceId}`);
        } catch (error) {
          console.error('[MOVE-FS] Error updating metadata.json:', error);
        }
      } else {
        console.error(`[MOVE-FS] metadata.json not found at: ${metadataPath}`);
      }
    } else {
      console.error(`[MOVE-FS] Source path does not exist: ${fromPath}`);
    }
  }
  
  // Delete item from file system
  deleteItemFromFileSystem(itemId, spaceId) {
    const spaceDir = this.getSpaceDirectory(spaceId);
    const itemPath = path.join(spaceDir, itemId);
    
    if (fs.existsSync(itemPath)) {
      try {
        // First, try to remove any read-only flags on files
        const files = fs.readdirSync(itemPath);
        files.forEach(file => {
          const filePath = path.join(itemPath, file);
          try {
            // Make writable on Unix-like systems
            if (process.platform !== 'win32') {
              fs.chmodSync(filePath, 0o666);
            }
          } catch (e) {
            // Ignore permission errors
          }
        });
        
        // Now delete the directory
        fs.rmSync(itemPath, { recursive: true, force: true, maxRetries: 3 });
        console.log('Deleted item from filesystem:', itemPath);
      } catch (error) {
        console.error('Error deleting item from filesystem:', error);
        
        // Try alternative deletion method
        try {
          // On Windows, sometimes files are locked, wait a bit and retry
          if (process.platform === 'win32') {
            setTimeout(() => {
              fs.rmSync(itemPath, { recursive: true, force: true });
            }, 100);
          }
        } catch (e) {
          console.error('Failed to delete item after retry:', e);
        }
      }
    }
  }
  
  // Load items from file system (for recovery/migration)
  loadItemsFromFileSystem() {
    const items = [];
    
    // Read all space directories
    const entries = fs.readdirSync(this.storageRoot, { withFileTypes: true });
    
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const spaceDir = path.join(this.storageRoot, entry.name);
        const itemDirs = fs.readdirSync(spaceDir, { withFileTypes: true });
        
        for (const itemDir of itemDirs) {
          if (itemDir.isDirectory() && itemDir.name !== 'README.ipynb') {
            const itemPath = path.join(spaceDir, itemDir.name);
            const metadataPath = path.join(itemPath, 'metadata.json');
            
            if (fs.existsSync(metadataPath)) {
              try {
                const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
                
                // Reconstruct item based on type
                const item = { ...metadata };
                
                if (item.type === 'text') {
                  const contentPath = path.join(itemPath, 'content.txt');
                  if (fs.existsSync(contentPath)) {
                    item.content = fs.readFileSync(contentPath, 'utf8');
                  }
                } else if (item.type === 'html') {
                  const contentPath = path.join(itemPath, 'content.html');
                  if (fs.existsSync(contentPath)) {
                    item.content = fs.readFileSync(contentPath, 'utf8');
                  }
                  const plainPath = path.join(itemPath, 'plain.txt');
                  if (fs.existsSync(plainPath)) {
                    item.plainText = fs.readFileSync(plainPath, 'utf8');
                  }
                  
                  // Load HTML thumbnail if available
                  let thumbPath = path.join(itemPath, 'thumbnail.png');
                  let thumbExt = 'png';
                  if (!fs.existsSync(thumbPath)) {
                    // Check for SVG thumbnail
                    thumbPath = path.join(itemPath, 'thumbnail.svg');
                    thumbExt = 'svg+xml';
                  }
                  if (fs.existsSync(thumbPath)) {
                    const thumbData = fs.readFileSync(thumbPath);
                    item.thumbnail = `data:image/${thumbExt};base64,${thumbData.toString('base64')}`;
                  }
                } else if (item.type === 'image') {
                  const imagePath = path.join(itemPath, 'image.png');
                  if (fs.existsSync(imagePath)) {
                    // Don't load the full base64 data to avoid memory issues
                    // Just store a reference to the file path
                    item.imagePath = imagePath;
                    // Only load base64 for small images (under 1MB) for preview purposes
                    const stats = fs.statSync(imagePath);
                    if (stats.size < 1024 * 1024) { // 1MB
                      const imageData = fs.readFileSync(imagePath);
                      item.content = `data:image/png;base64,${imageData.toString('base64')}`;
                    } else {
                      // For large images, create a placeholder
                      item.content = null;
                      item.largeImage = true;
                      item.imageSize = stats.size;
                    }
                    
                    // Load thumbnail if available
                    let thumbPath = path.join(itemPath, 'thumbnail.png');
                    let thumbExt = 'png';
                    if (!fs.existsSync(thumbPath)) {
                      // Check for SVG thumbnail
                      thumbPath = path.join(itemPath, 'thumbnail.svg');
                      thumbExt = 'svg+xml';
                    }
                    if (fs.existsSync(thumbPath)) {
                      const thumbData = fs.readFileSync(thumbPath);
                      item.thumbnail = `data:image/${thumbExt};base64,${thumbData.toString('base64')}`;
                    } else if (item.content) {
                      // Generate thumbnail if we have content but no saved thumbnail
                      item.thumbnail = this.generateImageThumbnail(item.content);
                    }
                  }
                } else if (item.type === 'file') {
                  // Check if file exists in our storage
                  const filePath = path.join(itemPath, item.fileName);
                  if (fs.existsSync(filePath)) {
                    item.filePath = filePath;
                  } else {
                    // Use original path reference
                    item.filePath = item.originalPath;
                  }
                  
                  // Load thumbnail if available
                  let thumbPath = path.join(itemPath, 'thumbnail.png');
                  let thumbExt = 'png';
                  if (!fs.existsSync(thumbPath)) {
                    // Check for SVG thumbnail
                    thumbPath = path.join(itemPath, 'thumbnail.svg');
                    thumbExt = 'svg+xml';
                  }
                  if (fs.existsSync(thumbPath)) {
                    const thumbData = fs.readFileSync(thumbPath);
                    item.thumbnail = `data:image/${thumbExt};base64,${thumbData.toString('base64')}`;
                  }
                }
                
                // Ensure timestamp is a number
                if (typeof item.timestamp === 'string') {
                  item.timestamp = new Date(item.timestamp).getTime();
                }
                
                items.push(item);
              } catch (error) {
                console.error('Error loading item from filesystem:', error);
              }
            }
          }
        }
      }
    }
    
    // Sort items by timestamp in descending order (newest first)
    items.sort((a, b) => b.timestamp - a.timestamp);
    
    return items;
  }
  
  // Add these methods after the existing helper methods
  
  detectItemSource(item) {
    // Try to detect where the item came from
    if (item.type === 'text') {
      const content = item.content.toLowerCase();
      
      // Check for common patterns
      if (content.includes('http://') || content.includes('https://')) {
        const urlMatch = content.match(/https?:\/\/([^\/\s]+)/);
        if (urlMatch) {
          return `Web: ${urlMatch[1]}`;
        }
      }
      
      if (content.includes('git clone') || content.includes('npm install')) {
        return 'Terminal/Console';
      }
      
      if (content.includes('function') || content.includes('const') || content.includes('import')) {
        return 'Code Editor';
      }
      
      if (content.includes('@') && content.includes('.com')) {
        return 'Email';
      }
    } else if (item.type === 'image') {
      return 'Screenshot/Image';
    } else if (item.type === 'file') {
      return `File System: ${path.dirname(item.filePath || '')}`;
    }
    
    return 'Clipboard';
  }
  
  autoGenerateTags(item) {
    const tags = [];
    
    // Add type tag
    tags.push(item.type);
    
    if (item.type === 'text') {
      const content = item.content.toLowerCase();
      
      // Programming language detection
      if (content.includes('function') || content.includes('const') || content.includes('var')) {
        tags.push('javascript');
      }
      if (content.includes('import') && content.includes('from')) {
        tags.push('python', 'javascript');
      }
      if (content.includes('def ') && content.includes(':')) {
        tags.push('python');
      }
      if (content.includes('<?php')) {
        tags.push('php');
      }
      if (content.includes('SELECT') || content.includes('FROM') || content.includes('WHERE')) {
        tags.push('sql');
      }
      
      // Content type detection
      if (content.includes('http://') || content.includes('https://')) {
        tags.push('url', 'link');
      }
      if (content.includes('@') && content.includes('.')) {
        tags.push('email');
      }
      if (content.includes('```')) {
        tags.push('markdown', 'code');
      }
      if (content.match(/\d{3}-\d{3}-\d{4}/)) {
        tags.push('phone');
      }
      
      // Add tag based on detected source
      if (item.source === 'code') {
        tags.push('snippet');
      }
      
      // AI-related content detection
      if (content.includes('chatgpt') || content.includes('openai') || content.includes('gpt-')) {
        tags.push('ai-content', 'openai');
      }
      if (content.includes('claude') || content.includes('anthropic')) {
        tags.push('ai-content', 'anthropic');
      }
      if (content.includes('gemini') || content.includes('bard')) {
        tags.push('ai-content', 'google-ai');
      }
      if (content.includes('prompt:') || content.includes('generate') || content.includes('ai assistant')) {
        tags.push('ai-prompt');
      }
      if (content.includes('```') && (content.includes('ai') || content.includes('llm'))) {
        tags.push('ai-code');
      }
    } else if (item.type === 'image') {
      tags.push('visual', 'media');
      
      if (item.dimensions) {
        // Add size-based tags
        const pixels = item.dimensions.width * item.dimensions.height;
        if (pixels > 2000000) tags.push('high-res');
        if (pixels < 100000) tags.push('thumbnail');
        
        // Add aspect ratio tags
        const ratio = item.dimensions.width / item.dimensions.height;
        if (Math.abs(ratio - 1) < 0.1) tags.push('square');
        if (ratio > 1.5) tags.push('landscape');
        if (ratio < 0.67) tags.push('portrait');
      }
    } else if (item.type === 'file') {
      tags.push(item.fileCategory || 'file');
      
      // Add extension as tag
      if (item.fileExt) {
        tags.push(item.fileExt.substring(1)); // Remove the dot
      }
      
      // Add size-based tags
      if (item.fileSize) {
        if (item.fileSize > 10 * 1024 * 1024) tags.push('large');
        if (item.fileSize < 1024) tags.push('small');
      }
    }
    
    // Add space as tag if assigned
    if (item.spaceId) {
      const space = this.spaces.find(s => s.id === item.spaceId);
      if (space) {
        tags.push(space.name.toLowerCase().replace(/\s+/g, '-'));
      }
    }
    
    // Remove duplicates and return
    return [...new Set(tags)];
  }
  
  // Add after the ensureStorageDirectories method
  migrateFromOldLocation() {
    const oldRoot = path.join(app.getPath('userData'), 'OR-Spaces');
    
    // Check if old location exists
    if (fs.existsSync(oldRoot)) {
      console.log('Found old OR-Spaces location, migrating to Documents...');
      
      try {
        // Get all entries from old location
        const entries = fs.readdirSync(oldRoot, { withFileTypes: true });
        
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const oldPath = path.join(oldRoot, entry.name);
            const newPath = path.join(this.storageRoot, entry.name);
            
            // Copy directory recursively
            this.copyDirectoryRecursive(oldPath, newPath);
            console.log(`Migrated: ${entry.name}`);
          }
        }
        
        // Rename old directory to indicate it's been migrated
        const backupPath = oldRoot + '_migrated_' + Date.now();
        fs.renameSync(oldRoot, backupPath);
        console.log(`Old location renamed to: ${backupPath}`);
        
        // Show notification
        const { BrowserWindow } = require('electron');
        BrowserWindow.getAllWindows().forEach(window => {
          window.webContents.send('show-notification', {
            title: 'Clipboard Storage Migrated',
            body: 'Your clipboard items have been moved to Documents/OR-Spaces for easier access!'
          });
        });
      } catch (error) {
        console.error('Error migrating clipboard storage:', error);
      }
    }
  }
  
  copyDirectoryRecursive(source, target) {
    if (!fs.existsSync(target)) {
      fs.mkdirSync(target, { recursive: true });
    }
    
    const entries = fs.readdirSync(source, { withFileTypes: true });
    
    for (const entry of entries) {
      const sourcePath = path.join(source, entry.name);
      const targetPath = path.join(target, entry.name);
      
      if (entry.isDirectory()) {
        this.copyDirectoryRecursive(sourcePath, targetPath);
      } else {
        fs.copyFileSync(sourcePath, targetPath);
      }
    }
  }
  
  setupScreenshotWatcher() {
    const desktopPath = app.getPath('desktop');
    const fs = require('fs');
    const path = require('path');
    
    // Track processed screenshots to avoid duplicates
    this.processedScreenshots = new Set();
    this.lastScreenshotTime = 0; // Track last screenshot processing time
    
    // Watch for new files on desktop
    if (fs.existsSync(desktopPath)) {
      console.log('Setting up screenshot watcher for:', desktopPath);
      
      // Use fs.watch for real-time monitoring
      this.screenshotWatcher = fs.watch(desktopPath, (eventType, filename) => {
        if (eventType === 'rename' && filename) {
          // Check if it's a screenshot
          if (this.isScreenshot(filename)) {
            const fullPath = path.join(desktopPath, filename);
            
            // Small delay to ensure file is fully written
            setTimeout(() => {
              if (fs.existsSync(fullPath) && !this.processedScreenshots.has(fullPath)) {
                this.handleScreenshot(fullPath);
              }
            }, 500);
          }
        }
      });
      
      // Also check for screenshots that might have been created while app was closed
      this.checkExistingScreenshots();
    }
  }
  
  isScreenshot(filename) {
    if (!filename) return false;
    
    // Common screenshot naming patterns
    const screenshotPatterns = [
      /^Screenshot\s+\d{4}-\d{2}-\d{2}\s+at\s+\d{1,2}\.\d{2}\.\d{2}\s+(AM|PM)\.png$/i, // macOS default
      /^Screen\s*Shot\s+\d{4}-\d{2}-\d{2}\s+at\s+\d{1,2}\.\d{2}\.\d{2}\s+(AM|PM)\.png$/i, // macOS variant
      /^Screenshot_\d+\.png$/i, // Generic numbered
      /^Screenshot\s+\d{4}-\d{2}-\d{2}\s+\d{6}\.png$/i, // Date-time format
      /^Capture\.PNG$/i, // Windows Snipping Tool
      /^Screenshot\s*\(\d+\)\.png$/i, // Windows numbered
      /^image\.png$/i, // Generic
      /^Screen\s*Recording\s+\d{4}-\d{2}-\d{2}\s+at\s+\d{1,2}\.\d{2}\.\d{2}\s+(AM|PM)\.(mov|mp4)$/i // Screen recordings
    ];
    
    return screenshotPatterns.some(pattern => pattern.test(filename));
  }
  
  checkExistingScreenshots() {
    const desktopPath = app.getPath('desktop');
    const fs = require('fs');
    const path = require('path');
    
    try {
      const files = fs.readdirSync(desktopPath);
      const now = Date.now();
      
      files.forEach(filename => {
        if (this.isScreenshot(filename)) {
          const fullPath = path.join(desktopPath, filename);
          const stats = fs.statSync(fullPath);
          
          // Only process screenshots from the last 5 minutes
          if (now - stats.mtimeMs < 5 * 60 * 1000) {
            if (!this.processedScreenshots.has(fullPath)) {
              console.log('Found recent screenshot:', filename);
              this.handleScreenshot(fullPath);
            }
          }
        }
      });
    } catch (error) {
      console.error('Error checking existing screenshots:', error);
    }
  }
  
  handleScreenshot(screenshotPath) {
    const fs = require('fs');
    const path = require('path');
    
    console.log('Processing screenshot:', screenshotPath);
    
    try {
      // Mark as processed
      this.processedScreenshots.add(screenshotPath);
      
      // Clean up old entries (keep only last 100)
      if (this.processedScreenshots.size > 100) {
        const entries = Array.from(this.processedScreenshots);
        entries.slice(0, entries.length - 100).forEach(path => {
          this.processedScreenshots.delete(path);
        });
      }
      
      if (!fs.existsSync(screenshotPath)) {
        console.log('Screenshot file not found:', screenshotPath);
        return;
      }
      
      const stats = fs.statSync(screenshotPath);
      const ext = path.extname(screenshotPath).toLowerCase();
      const fileName = path.basename(screenshotPath);
      
      // Check if we already have this screenshot in history (by filename)
      const existingScreenshot = this.history.find(item => 
        item.type === 'file' && 
        item.fileName === fileName &&
        item.isScreenshot === true &&
        Date.now() - item.timestamp < 10000 // Within last 10 seconds
      );
      
      if (existingScreenshot) {
        console.log('Screenshot already in history:', fileName);
        return;
      }
      
      // Check if capture is enabled and we have an active space
      if (!this.screenshotCaptureEnabled) {
        console.log('Screenshot capture is disabled');
        return;
      }
      
      if (!this.currentSpace || this.currentSpace === null) {
        console.log('No active space for screenshot capture');
        return;
      }
      
      // Determine if it's an image or video
      const isVideo = ['.mov', '.mp4', '.avi', '.mkv'].includes(ext);
      const fileType = isVideo ? 'video' : 'image-file';
      const fileCategory = 'media';
      
      // For images, create thumbnail
      let thumbnail = null;
      let originalImage = null;
      if (!isVideo && stats.size < 50 * 1024 * 1024) { // Less than 50MB
        try {
          const imageData = fs.readFileSync(screenshotPath);
          originalImage = `data:image/${ext.slice(1)};base64,${imageData.toString('base64')}`;
          // Generate thumbnail for display
          thumbnail = this.generateImageThumbnail(originalImage);
        } catch (e) {
          console.error('Error creating screenshot thumbnail:', e);
        }
      }
      
      // Create clipboard item
      const item = {
        id: this.generateId(),
        type: 'file',
        fileType: fileType,
        fileCategory: fileCategory,
        filePath: screenshotPath,
        fileName: fileName,
        fileExt: ext,
        fileSize: stats.size,
        thumbnail: thumbnail,
        preview: `Screenshot: ${fileName}`,
        timestamp: Date.now(),
        pinned: false,
        spaceId: this.currentSpace,
        source: 'screenshot',
        isScreenshot: true
      };
      
      console.log('Adding screenshot to history:', {
        id: item.id,
        fileName: item.fileName,
        spaceId: item.spaceId,
        historyLength: this.history.length
      });
      
      // Add to history
      this.addToHistory(item);
      
      // Show notification
      const space = this.spaces.find(s => s.id === this.currentSpace);
      if (space) {
        BrowserWindow.getAllWindows().forEach(window => {
          window.webContents.send('show-notification', {
            title: 'Screenshot Captured',
            body: `Added to ${space.icon} ${space.name}`
          });
        });
      }
      
      console.log(`Screenshot added to space: ${this.currentSpace}`);
      
    } catch (error) {
      console.error('Error handling screenshot:', error);
    }
  }
  
  /**
   * Generate thumbnail for PDF file using macOS Quick Look
   * @param {string} filePath - Path to PDF file
   * @returns {string} Base64 data URL of thumbnail
   */
  async generatePDFThumbnail(filePath) {
    console.log('[PDF-THUMB] === Starting PDF thumbnail generation ===');
    console.log('[PDF-THUMB] File path:', filePath);
    console.log('[PDF-THUMB] File exists:', fs.existsSync(filePath));
    
    // Windows compatibility: Return generic PDF icon for now
    if (process.platform !== 'darwin') {
      console.log('[PDF-THUMB] Non-macOS platform detected, returning generic PDF icon');
      const fileName = path.basename(filePath);
      const fileSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
      return this.generatePDFPlaceholder(fileName, fileSize);
    }
    
    try {
      // Check if file exists first
      if (!fs.existsSync(filePath)) {
        console.error('[PDF-THUMB] ERROR: PDF file does not exist:', filePath);
        const placeholder = this.generatePDFPlaceholder(path.basename(filePath), 0);
        console.log('[PDF-THUMB] Returning placeholder (file not found)');
        return placeholder;
      }
      
      // Get file info
      const stats = fs.statSync(filePath);
      console.log('[PDF-THUMB] File size:', stats.size, 'bytes');
      
      // Use macOS Quick Look (qlmanage) to generate thumbnail - this is what Finder uses
      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);
      
      // Create temp directory for thumbnail
      let tempDir = path.join(app.getPath('temp'), 'pdf-thumbnails');
      console.log('[PDF-THUMB] Temp directory:', tempDir);
      
      if (!fs.existsSync(tempDir)) {
        try {
          fs.mkdirSync(tempDir, { recursive: true });
          console.log('[PDF-THUMB] Created temp directory');
        } catch (mkdirError) {
          console.error('[PDF-THUMB] Failed to create temp directory:', mkdirError);
          // Try alternative temp location
          const altTempDir = path.join('/tmp', 'pdf-thumbnails-' + Date.now());
          fs.mkdirSync(altTempDir, { recursive: true });
          tempDir = altTempDir;
          console.log('[PDF-THUMB] Using alternative temp directory:', tempDir);
        }
      }
      
      console.log('[PDF-THUMB] Using qlmanage to generate thumbnail...');
      const startTime = Date.now();
      
      // Check if qlmanage exists
      try {
        const { stdout: whichOut } = await execAsync('which qlmanage');
        console.log('[PDF-THUMB] qlmanage found at:', whichOut.trim());
      } catch (whichError) {
        console.error('[PDF-THUMB] qlmanage not found in PATH:', whichError);
      }
      
      // Log environment for debugging
      console.log('[PDF-THUMB] PATH:', process.env.PATH);
      console.log('[PDF-THUMB] Running as:', process.platform, process.arch);
      console.log('[PDF-THUMB] Node version:', process.version);
      console.log('[PDF-THUMB] Electron version:', process.versions.electron);
      
      try {
        // Escape file paths for shell command
        const escapedFilePath = filePath.replace(/(['"`$\\])/g, '\\$1');
        const escapedTempDir = tempDir.replace(/(['"`$\\])/g, '\\$1');
        const command = `qlmanage -t -s 512 -o "${escapedTempDir}" "${escapedFilePath}" 2>&1`;
        
        console.log('[PDF-THUMB] Executing command:', command);
        
        // Try with full path to qlmanage first
        let execResult;
        try {
          execResult = await execAsync(command, {
            timeout: 10000, // 10 second timeout
            maxBuffer: 1024 * 1024 * 10, // 10MB buffer
            env: { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin:' + process.env.PATH }
          });
        } catch (firstError) {
          console.log('[PDF-THUMB] First attempt failed, trying with explicit path...');
          const commandWithPath = command.replace('qlmanage', '/usr/bin/qlmanage');
          console.log('[PDF-THUMB] Command with path:', commandWithPath);
          execResult = await execAsync(commandWithPath, {
            timeout: 10000,
            maxBuffer: 1024 * 1024 * 10
          });
        }
        
        const { stdout, stderr } = execResult;
        
        const generateTime = Date.now() - startTime;
        console.log('[PDF-THUMB] qlmanage generation took:', generateTime, 'ms');
        
        if (stdout) console.log('[PDF-THUMB] stdout:', stdout);
        if (stderr) console.log('[PDF-THUMB] stderr:', stderr);
        
        // List files in temp directory to see what was generated
        console.log('[PDF-THUMB] Checking temp directory contents...');
        const tempFiles = fs.readdirSync(tempDir);
        console.log('[PDF-THUMB] Files in temp directory:', tempFiles);
        
        // Find the generated thumbnail - qlmanage adds .png extension
        const baseName = path.basename(filePath);
        let thumbnailPath = path.join(tempDir, `${baseName}.png`);
        
        // Check if file exists, if not try without spaces
        if (!fs.existsSync(thumbnailPath)) {
          console.log('[PDF-THUMB] Primary path not found, checking alternatives...');
          // Try to find any PNG file that was just created
          const pngFiles = tempFiles.filter(f => f.endsWith('.png') && f.includes(baseName.substring(0, 10)));
          if (pngFiles.length > 0) {
            thumbnailPath = path.join(tempDir, pngFiles[0]);
            console.log('[PDF-THUMB] Found alternative thumbnail:', pngFiles[0]);
          }
        }
        
        if (fs.existsSync(thumbnailPath)) {
          console.log('[PDF-THUMB] Thumbnail found at:', thumbnailPath);
          const thumbStats = fs.statSync(thumbnailPath);
          console.log('[PDF-THUMB] Thumbnail size:', thumbStats.size, 'bytes');
          
          // Read the thumbnail and convert to base64
          const thumbnailBuffer = fs.readFileSync(thumbnailPath);
          const base64 = thumbnailBuffer.toString('base64');
          const dataUrl = `data:image/png;base64,${base64}`;
          
          // Clean up temp file
          try {
            fs.unlinkSync(thumbnailPath);
            console.log('[PDF-THUMB] Cleaned up temp file');
          } catch (e) {
            console.warn('[PDF-THUMB] Could not delete temp file:', e.message);
          }
          
          console.log('[PDF-THUMB] SUCCESS: Generated Quick Look thumbnail');
          console.log('[PDF-THUMB] Data URL length:', dataUrl.length);
          console.log('[PDF-THUMB] Data URL preview:', dataUrl.substring(0, 100) + '...');
          return dataUrl;
        } else {
          console.error('[PDF-THUMB] qlmanage did not generate expected thumbnail file');
          console.error('[PDF-THUMB] Expected path:', thumbnailPath);
          console.error('[PDF-THUMB] Available files:', tempFiles);
        }
      } catch (error) {
        console.error('[PDF-THUMB] qlmanage error:', error.message);
        console.error('[PDF-THUMB] Error code:', error.code);
        console.error('[PDF-THUMB] Error stdout:', error.stdout);
        console.error('[PDF-THUMB] Error stderr:', error.stderr);
        // Fall through to try native method
      }
      
      // Clean up any old thumbnails in temp directory before generating new ones
      try {
        const oldFiles = fs.readdirSync(tempDir);
        oldFiles.forEach(file => {
          if (file.endsWith('.png')) {
            try {
              fs.unlinkSync(path.join(tempDir, file));
            } catch (e) {
              // Ignore cleanup errors
            }
          }
        });
      } catch (cleanupError) {
        // Ignore cleanup errors
      }
      
      // Try native method as last fallback
      console.log('[PDF-THUMB] Trying native method as final fallback...');
      const thumbnail = await nativeImage.createThumbnailFromPath(filePath, {
        width: 256,
        height: 256
      });
      
      if (!thumbnail.isEmpty()) {
        const size = thumbnail.getSize();
        console.log('[PDF-THUMB] Native thumbnail dimensions:', size.width, 'x', size.height);
        const dataUrl = thumbnail.toDataURL();
        console.log('[PDF-THUMB] SUCCESS: Generated native thumbnail');
        return dataUrl;
      }
      
    } catch (error) {
      console.error('[PDF-THUMB] ERROR generating PDF thumbnail:', error.message);
    }

    console.log('[PDF-THUMB] All methods failed, returning placeholder');
    const fileName = path.basename(filePath);
    const fileSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
    const placeholder = this.generatePDFPlaceholder(fileName, fileSize);
    return placeholder;
  }

  /**
   * Generate SVG placeholder for PDF (fallback)
   * @param {string} filename - File name  
   * @param {number} fileSize - File size in bytes
   * @returns {string} Data URL of SVG placeholder
   */
  generatePDFPlaceholder(filename, fileSize) {
    const displayName = filename.length > 20 ? filename.substring(0, 17) + '...' : filename;
    const formattedSize = this.formatFileSize(fileSize);
    
    const svg = `
      <svg width="256" height="256" xmlns="http://www.w3.org/2000/svg">
        <!-- Background -->
        <rect width="256" height="256" fill="#ffffff" stroke="#e0e0e0" stroke-width="1"/>
        
        <!-- Header with PDF icon -->
        <rect width="256" height="60" fill="#dc2626" />
        
        <!-- PDF Icon -->
        <text x="128" y="40" font-family="Arial, sans-serif" font-size="24" font-weight="bold" fill="white" text-anchor="middle">PDF</text>
        
        <!-- File name -->
        <text x="128" y="85" font-family="Arial, sans-serif" font-size="14" fill="#333" text-anchor="middle">${displayName}</text>
        
        <!-- File size -->
        <text x="128" y="105" font-family="Arial, sans-serif" font-size="12" fill="#666" text-anchor="middle">${formattedSize}</text>
        
        <!-- Document lines -->
        <g opacity="0.5">
          <rect x="30" y="130" width="196" height="8" fill="#e0e0e0" rx="2"/>
          <rect x="30" y="148" width="150" height="8" fill="#e0e0e0" rx="2"/>
          <rect x="30" y="166" width="180" height="8" fill="#e0e0e0" rx="2"/>
          <rect x="30" y="184" width="120" height="8" fill="#e0e0e0" rx="2"/>
          <rect x="30" y="202" width="160" height="8" fill="#e0e0e0" rx="2"/>
        </g>
      </svg>
    `;
    
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  }
  
  loadPreferences() {
    try {
      if (fs.existsSync(this.preferencesFilePath)) {
        const data = fs.readFileSync(this.preferencesFilePath, 'utf8');
        const prefs = JSON.parse(data);
        this.spacesEnabled = prefs.spacesEnabled !== undefined ? prefs.spacesEnabled : true;
        this.screenshotCaptureEnabled = prefs.screenshotCaptureEnabled !== undefined ? prefs.screenshotCaptureEnabled : true;
        // Load current space from preferences, default to 'unclassified' if null
        if (prefs.currentSpace !== undefined) {
          this.currentSpace = prefs.currentSpace || 'unclassified';
        }
      }
    } catch (error) {
      console.error('Error loading clipboard preferences:', error);
    }
  }
  
  savePreferences() {
    try {
      const prefs = {
        spacesEnabled: this.spacesEnabled,
        screenshotCaptureEnabled: this.screenshotCaptureEnabled,
        currentSpace: this.currentSpace
      };
      fs.writeFileSync(this.preferencesFilePath, JSON.stringify(prefs, null, 2));
    } catch (error) {
      console.error('Error saving clipboard preferences:', error);
    }
  }
  
  toggleSpaces(enabled) {
    this.spacesEnabled = enabled;
    this.savePreferences();
    
    // Notify all windows about the change
    BrowserWindow.getAllWindows().forEach(window => {
      window.webContents.send('clipboard:spaces-toggled', this.spacesEnabled);
    });
    
    // Update the menu checkbox state
    const { Menu } = require('electron');
    const menu = Menu.getApplicationMenu();
    if (menu) {
      const clipboardMenu = menu.items.find(item => item.label === 'Clipboard');
      if (clipboardMenu && clipboardMenu.submenu) {
        const toggleItem = clipboardMenu.submenu.items.find(item => item.label === 'Toggle Spaces');
        if (toggleItem) {
          toggleItem.checked = this.spacesEnabled;
        }
      }
    }
  }
  
  setActiveSpace(spaceId) {
    this.currentSpace = spaceId;
    this.savePreferences();
    
    // Get space name for notification
    let spaceName = 'All Items';
    if (spaceId) {
      const space = this.spaces.find(s => s.id === spaceId);
      if (space) {
        spaceName = `${space.icon} ${space.name}`;
      }
    }
    
    // Notify all windows about the change
    BrowserWindow.getAllWindows().forEach(window => {
      window.webContents.send('clipboard:active-space-changed', {
        spaceId: this.currentSpace,
        spaceName: spaceName
      });
      
      // Show notification
      window.webContents.send('show-notification', {
        title: 'Clipboard Space Changed',
        body: `Now capturing to: ${spaceName}`
      });
    });
  }
  
  getSpaceName(spaceId) {
    if (spaceId === null) {
      return 'All Items';
    }
    const space = this.spaces.find(s => s.id === spaceId);
    return space ? `${space.icon} ${space.name}` : 'Unknown Space';
  }
  
  // Add after the constructor
  ensureStorageDirectories() {
    // Create main storage directory
    if (!fs.existsSync(this.storageRoot)) {
      fs.mkdirSync(this.storageRoot, { recursive: true });
      console.log('Created OR-Spaces directory:', this.storageRoot);
    }
    
    // Create "All Items" directory for items not in any space
    const allItemsPath = path.join(this.storageRoot, '_All_Items');
    if (!fs.existsSync(allItemsPath)) {
      fs.mkdirSync(allItemsPath, { recursive: true });
    }
  }
  
  // Get the directory path for a space
  getSpaceDirectory(spaceId) {
    if (spaceId === null) {
      return path.join(this.storageRoot, '_All_Items');
    }
    const space = this.spaces.find(s => s.id === spaceId);
    if (space) {
      // Sanitize space name for filesystem
      const safeName = space.name.replace(/[^a-zA-Z0-9-_ ]/g, '').trim();
      return path.join(this.storageRoot, `${safeName}_${spaceId}`);
    }
    return path.join(this.storageRoot, '_All_Items');
  }
  

  
  // Generate a preview thumbnail for HTML files
  generateHTMLThumbnail(fileName, fileSize) {
    try {
      // Create a clean SVG thumbnail for HTML files
      const maxChars = 20;
      const displayName = fileName.length > maxChars ? 
        fileName.substring(0, maxChars - 3) + '...' : fileName;
      
      // Escape special characters for XML/SVG
      const escapedName = displayName
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
      
      const formattedSize = this.formatFileSize(fileSize)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      
      // Create SVG that will render properly as an image
      const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="200" height="260" viewBox="0 0 200 260" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <filter id="shadow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="2"/>
      <feOffset dx="2" dy="2" result="offsetblur"/>
      <feFlood flood-color="#000000" flood-opacity="0.1"/>
      <feComposite in2="offsetblur" operator="in"/>
      <feMerge>
        <feMergeNode/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>
  
  <!-- Background -->
  <rect width="200" height="260" fill="#f8f8f8"/>
  
  <!-- Document shape -->
  <g filter="url(#shadow)">
    <rect x="20" y="20" width="160" height="220" rx="2" fill="white" stroke="#ddd" stroke-width="1"/>
  </g>
  
  <!-- HTML tags icon -->
  <text x="100" y="65" text-anchor="middle" font-family="monospace" font-size="24" font-weight="bold" fill="#e34c26">&lt;/&gt;</text>
  
  <!-- HTML label -->
  <rect x="70" y="80" width="60" height="20" rx="3" fill="#e34c26"/>
  <text x="100" y="95" text-anchor="middle" font-family="Arial, sans-serif" font-size="12" font-weight="bold" fill="white">HTML</text>
  
  <!-- File name -->
  <text x="100" y="125" text-anchor="middle" font-family="Arial, sans-serif" font-size="13" fill="#333">${escapedName}</text>
  
  <!-- File size -->
  <text x="100" y="145" text-anchor="middle" font-family="Arial, sans-serif" font-size="11" fill="#666">${formattedSize}</text>
  
  <!-- Code preview lines (HTML-like) -->
  <g font-family="monospace" font-size="9" fill="#666">
    <text x="30" y="170">&lt;div class="container"&gt;</text>
    <text x="40" y="182" fill="#e34c26">&lt;h1&gt;</text>
    <text x="62" y="182">Title</text>
    <text x="87" y="182" fill="#e34c26">&lt;/h1&gt;</text>
    <text x="40" y="194" fill="#e34c26">&lt;p&gt;</text>
    <text x="55" y="194">Content...</text>
    <text x="105" y="194" fill="#e34c26">&lt;/p&gt;</text>
    <text x="30" y="206">&lt;/div&gt;</text>
  </g>
  
  <!-- Folded corner -->
  <path d="M 160 20 L 180 40 L 160 40 Z" fill="#f0f0f0" stroke="#ddd" stroke-width="1"/>
</svg>`;
      
      // Convert to base64 data URL
      const base64 = Buffer.from(svg, 'utf8').toString('base64');
      return `data:image/svg+xml;base64,${base64}`;
      
    } catch (error) {
      console.error('Error generating HTML thumbnail:', error);
      
      // Simple fallback SVG
      const fallbackSvg = `<svg width="200" height="260" xmlns="http://www.w3.org/2000/svg">
        <rect width="200" height="260" fill="#f8f8f8"/>
        <rect x="20" y="20" width="160" height="220" fill="white" stroke="#ddd"/>
        <text x="100" y="70" text-anchor="middle" font-family="monospace" font-size="30" font-weight="bold" fill="#e34c26">&lt;/&gt;</text>
        <rect x="70" y="85" width="60" height="20" fill="#e34c26"/>
        <text x="100" y="99" text-anchor="middle" font-size="12" font-weight="bold" fill="white">HTML</text>
      </svg>`;
      
      return `data:image/svg+xml;base64,${Buffer.from(fallbackSvg).toString('base64')}`;
    }
  }
  
  // Add this method after the truncateText method (around line 2135)
  generateImageThumbnail(base64Data, maxWidth = 400, maxHeight = 400) {
    try {
      const { nativeImage } = require('electron');
      
      // Create native image from base64
      const image = nativeImage.createFromDataURL(base64Data);
      if (image.isEmpty()) {
        console.log('Failed to create image from base64 data');
        return base64Data; // Return original if failed
      }
      
      const size = image.getSize();
      console.log(`Original image size: ${size.width}x${size.height}`);
      
      // Check if image needs resizing
      if (size.width <= maxWidth && size.height <= maxHeight) {
        return base64Data; // Return original if small enough
      }
      
      // Calculate new dimensions maintaining aspect ratio
      const aspectRatio = size.width / size.height;
      let newWidth = maxWidth;
      let newHeight = maxHeight;
      
      if (aspectRatio > 1) {
        // Landscape
        newHeight = Math.round(maxWidth / aspectRatio);
      } else {
        // Portrait or square
        newWidth = Math.round(maxHeight * aspectRatio);
      }
      
      // Resize the image
      const resized = image.resize({
        width: newWidth,
        height: newHeight,
        quality: 'good'
      });
      
      // Convert back to base64
      const thumbnail = resized.toDataURL();
      console.log(`Generated thumbnail: ${newWidth}x${newHeight}`);
      
      return thumbnail;
    } catch (error) {
      console.error('Error generating thumbnail:', error);
      return base64Data; // Return original on error
    }
  }
}

module.exports = ClipboardManager;