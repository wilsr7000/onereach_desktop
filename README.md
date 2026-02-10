# Onereach.ai

A cross-platform desktop application built with Electron for Mac and Windows.

## Features

- Modern and responsive UI
- Cross-platform compatibility (macOS and Windows)
- Secure IPC communication between main and renderer processes
- **Centralized AI Service**: Unified `lib/ai-service.js` for all LLM calls (OpenAI, Anthropic) with model profiles, auto-retry, provider fallback, circuit breakers, and cost monitoring
- **AI Run Times RSS Reader**: Advanced RSS reader with intelligent reading time estimation
- IDW (Intelligent Digital Worker) environment management
- GSX (Global Service Exchange) integration
- Reading progress tracking and analytics

## Development

Want to contribute? Check out our **[Contributing Guide](CONTRIBUTING.md)** for detailed instructions!

### Prerequisites

- Node.js (v14 or higher)
- npm (v6 or higher)

### Installation

```bash
# Clone the repository
git clone https://github.com/wilsr7000/onereach_desktop.git
cd onereach_desktop

# Install dependencies
npm install
```

### Development Commands

```bash
# Start the application in development mode
npm run dev

# Package the application for both Mac and Windows
npm run package

# Package for Mac only



# Package for Windows only
npm run package:win
```

## AI Run Times RSS Reader

The AI Run Times feature provides an advanced RSS reader specifically designed for UX Magazine and other design-focused content.

### Key Features

- **Intelligent Reading Time Estimation**: Calculates accurate reading times based on actual article content (7-35 minutes)
- **Real-time Content Fetching**: Uses Electron's native networking to bypass CORS limitations
- **Progress Tracking**: Visual progress bars show reading completion status
- **Article Analytics**: Tracks reading time and engagement metrics
- **Responsive Grid Layout**: Modern tile-based interface with article previews
- **External Link Handling**: Seamlessly opens related links in your default browser

### How It Works

1. **Content Analysis**: The app fetches full article content and analyzes word count
2. **Smart Estimation**: Calculates reading time using 200 words per minute average
3. **Dynamic Updates**: Reading times update from "Loading..." to accurate estimates
4. **Visual Feedback**: Green highlights indicate when reading times are updated
5. **Progress Tracking**: Blue progress bars show reading completion (e.g., "2:30 / 14:00")

### Accessing AI Run Times

1. Open the Onereach.ai application
2. Navigate to **View → AI Run Times** in the menu bar
3. The RSS reader will automatically load UX Magazine articles
4. Click on any article tile to read the full content

### Technical Implementation

- **Server-side Processing**: Reading time calculations happen in the main Electron process
- **IPC Communication**: Real-time updates sent to the renderer via Inter-Process Communication
- **HTML Content Parsing**: Extracts plain text from article HTML for accurate word counting
- **Caching Prevention**: Dynamic cache-busting ensures fresh content loading
- **Error Handling**: Graceful fallbacks for network issues or parsing errors

## Integrated Test Runner

The application includes a comprehensive test runner for automated testing and manual test checklists.

### Key Features

- **Hidden Access**: Activated with keyboard shortcut for security
- **Automated Tests**: Pre-configured tests for core functionality
- **Manual Checklists**: Track UI/UX testing with notes
- **Test History**: View previous test runs and statistics
- **Report Export**: Generate Markdown reports for documentation

### Accessing the Test Runner

1. Press `Cmd+Alt+H` (Mac) or `Ctrl+Alt+H` (Windows) to activate the test menu
2. Navigate to **Help → 🧬 Integrated Test Runner**
3. Or use the shortcut: `Cmd+Shift+T` (Mac) or `Ctrl+Shift+T` (Windows)

### Test Categories

#### Automated Tests
- **Core Functionality**: Clipboard monitoring, source detection, search
- **Spaces Management**: Space creation, item movement, deletion
- **Settings & Storage**: Settings persistence, API encryption
- **Performance**: Search speed, memory usage

#### Manual Tests
- **Visual & UX**: UI appearance, animations, window resizing
- **OS Integration**: Drag & drop, system tray, notifications

### Running Tests

**Automated Tests:**
1. Select tests by checking boxes (Ctrl+A to select all)
2. Click "Run Selected Tests" or "Run All Tests"
3. View real-time progress and logs
4. Export results as Markdown reports

**Manual Tests:**
1. Check off tests as completed
2. Add notes for each test
3. Progress is automatically saved

### Test Data Storage

Test data is stored in the app's user data directory:
- `test-results.json` - Automated test results
- `test-history.json` - Historical test runs
- `manual-test-notes.json` - Notes for manual tests
- `manual-test-status.json` - Manual test completion status

## Project Structure

```
onereach-ai/
├── assets/                    # Static assets like images and icons
├── Flipboard-IDW-Feed/       # AI Run Times RSS Reader
│   ├── uxmag.html           # RSS reader interface
│   ├── uxmag-script.js      # Reader functionality and logic
│   ├── uxmag-styles.css     # Reader styling
│   └── preload.js           # RSS reader IPC bridge
├── test-runner.html          # Integrated test runner interface
├── test-runner.js            # Test runner implementation
├── TEST-RUNNER-GUIDE.md      # Test runner documentation
├── main.js                   # Main process file
├── preload.js               # Main preload script for secure IPC
├── renderer.js              # Renderer process script
├── index.html               # Main application window
├── styles.css               # Application styles
├── menu.js                  # Application menu configuration
├── browserWindow.js         # Window management utilities
└── package.json             # Project configuration
```

## Building and Distribution

The application uses electron-builder for packaging and distribution. Configuration is in the `build` section of package.json.

### Icon Generation

Before packaging the application, you'll need to convert the SVG icon to platform-specific formats:

1. For macOS (.icns):
   - Convert SVG to a 1024x1024 PNG
   - Use a tool like `iconutil` (macOS) or online converters to create an .icns file
   - Place it in `assets/icons/icon.icns`

2. For Windows (.ico):
   - Convert SVG to multiple PNG sizes (16x16, 32x32, 48x48, 64x64, 128x128, 256x256)
   - Use a tool like `ImageMagick` or online converters to create an .ico file
   - Place it in `assets/icons/icon.ico`

3. For Linux:
   - Create PNG files in multiple sizes (16x16, 32x32, 48x48, 64x64, 128x128, 256x256, 512x512)
   - Name them according to their size (e.g., `16x16.png`, `32x32.png`, etc.)
   - Place them in the `assets/icons` directory

#### Example conversion commands:

```bash
# Using ImageMagick to convert SVG to PNG
convert -background none -size 1024x1024 assets/icons/icon.svg assets/icons/icon.png

# For Windows, create an .ico file
convert assets/icons/icon.png -define icon:auto-resize=256,128,64,48,32,16 assets/icons/icon.ico
```

## Troubleshooting

### AI Run Times RSS Reader

**Reading times show "Loading..." indefinitely:**
- Check your internet connection
- Restart the application
- Check the console for network errors (View → Toggle Developer Tools)

**Articles not loading or showing wrong content:**
- Clear the application cache by restarting
- Verify the RSS feed is accessible: https://uxmag.com/feed
- Check for JavaScript errors in the developer console

**Progress bars showing "0:00 / Loading...":**
- This indicates the reading time calculation is in progress
- Wait a few seconds for the background processing to complete
- If it persists, check the main process logs for errors

**Performance Issues:**
- The app fetches article content in the background for accurate reading times
- Initial load may take 10-30 seconds depending on network speed
- Subsequent loads use cached data for better performance

### General Troubleshooting

**Application won't start:**
- Ensure Node.js v14+ is installed
- Run `npm install` to update dependencies
- Check for port conflicts if running in development mode

**Menu items not appearing:**
- Restart the application
- Check IDW configuration files in user data directory
- Verify GSX links configuration

## Development Notes

### AI Run Times Implementation Details

The AI Run Times RSS reader uses several advanced techniques:

1. **Electron Native Networking**: Bypasses browser CORS limitations using `net.request()`
2. **HTML Content Parsing**: Strips HTML tags and extracts plain text for word counting
3. **Dynamic IPC Updates**: Real-time communication between main and renderer processes
4. **Cache Management**: Prevents stale JavaScript from interfering with updates
5. **Error Recovery**: Graceful fallbacks when network requests fail

### Key Files for AI Run Times

- `main.js`: Contains `calculateReadingTimeFromHTML()` and article fetching logic
- `Flipboard-IDW-Feed/preload.js`: IPC bridge for RSS reader
- `Flipboard-IDW-Feed/uxmag-script.js`: Main reader logic and UI updates
- `Flipboard-IDW-Feed/uxmag.html`: Reader interface with cache-busting

## License

This project is licensed under the ISC License. 



