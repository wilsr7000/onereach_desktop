# Contributing to Onereach.ai Desktop

Thank you for your interest in contributing to Onereach.ai Desktop! This guide will help you get started.

## Quick Start

### 1. Prerequisites

- **Node.js** v20 or higher
- **npm** v9 or higher
- **macOS** 12+ (Apple Silicon or Intel) — Windows support is in progress
- **Git** for version control
- A code editor (we recommend [Cursor](https://cursor.sh) for AI-powered development)
- **API keys** (configured in-app via Settings > API Keys, not `.env`):
  - OpenAI (required — voice, transcription, embeddings)
  - Anthropic (required — agents, chat, analysis)
  - ElevenLabs (optional — Video Editor voice synthesis)

### 2. Clone

Direct collaborators can clone the repo directly:

```bash
git clone https://github.com/wilsr7000/onereach_desktop.git
cd onereach_desktop
```

External contributors should fork first, then clone their fork.

### 3. Install Dependencies

```bash
npm install
```

### 4. Run the Application

```bash
# Standard mode
npm start

# Development mode (with extra logging)
npm run dev
```

### 5. Make Changes

1. Create a feature branch (use your username as a prefix to avoid conflicts):
   ```bash
   git checkout -b yourname/short-description
   ```

2. Make your changes using Cursor or your preferred editor.
3. Test your changes (`npm test`, and `npm run test:journey` for E2E).
4. Commit with clear, descriptive messages:
   ```bash
   git add .
   git commit -m "feat: add new feature description"
   ```

5. Push the branch:
   ```bash
   git push -u origin yourname/short-description
   ```

6. Open a Pull Request against `main`:
   ```bash
   gh pr create --fill
   ```

> **Note**: Direct pushes to `main` are blocked by branch protection. All changes must land via PR. Force pushes and branch deletion on `main` are also disabled.

## Project Structure

```
onereach_desktop/
├── main.js                   # Main Electron process (backend)
├── renderer.js              # Main renderer process (frontend logic)
├── preload.js               # IPC bridge for secure communication
├── index.html               # Main application window
├── styles.css               # Global application styles
├── menu.js                  # Application menu configuration
├── browserWindow.js         # Window management utilities
│
├── assets/                  # Images, icons, and static resources
├── Flipboard-IDW-Feed/     # RSS Reader feature
├── templates/               # Template files
├── test/                    # Test files and test suites
├── scripts/                 # Build and release scripts
│
├── *-manager.js            # Various manager modules:
│   ├── auth-manager.js     # Authentication
│   ├── clipboard-manager.js # Clipboard operations
│   ├── module-manager.js   # Module system
│   ├── settings-manager.js # Settings persistence
│   └── template-manager.js # Template handling
│
├── *.html                  # Various UI windows
└── *.md                    # Documentation files
```

## Key Files to Know

### Core Application Files
- **`main.js`** - Main Electron process, handles app lifecycle, IPC, and system integration
- **`renderer.js`** - UI logic for the main window
- **`preload.js`** - Secure IPC bridge between main and renderer processes
- **`index.html`** - Main application interface
- **`menu.js`** - Application menu structure and handlers

### Feature-Specific Files
- **`clipboard-manager.js`** - Clipboard monitoring and management
- **`module-manager.js`** - Dynamic module loading system
- **`settings-manager.js`** - Settings persistence and retrieval
- **`gsx-file-sync.js`** - GSX (Global Service Exchange) integration
- **`idw-registry.js`** - IDW (Intelligent Digital Worker) management

### UI Windows
- **`settings.html`** - Application settings interface
- **`log-viewer.html`** - Log viewing and analysis
- **`test-runner.html`** - Integrated test runner
- **`clipboard-viewer.html`** - Clipboard history viewer
- **`tabbed-browser.html`** - Built-in browser interface

## Development Commands

```bash
# Run the app
npm start                    # Standard mode
npm run dev                  # Development mode (Mac/Linux)
npm run dev:win              # Development mode (Windows)

# Build & Package
npm run package              # Package for Mac & Windows
npm run package:mac          # Package for Mac only
npm run package:win          # Package for Windows only
npm run package:universal    # Universal build (all platforms)

# Testing
npm run test:wizard          # Test setup wizard
npm run test:idw             # Test IDW functionality
npm run test:blackhole       # Test black hole button
npm run test:gsx-sync        # Test GSX sync

# Distribution
npm run build:signed         # Build with code signing
npm run release              # Create release
```

## Development Guidelines

### Code Style
- Use consistent indentation (2 spaces recommended)
- Write clear, descriptive variable and function names
- Add comments for complex logic
- Follow existing code patterns in the project

### Commit Messages
Follow the [Conventional Commits](https://www.conventionalcommits.org/) format:

- `feat: add new feature`
- `fix: resolve bug in clipboard manager`
- `docs: update contributing guide`
- `style: format code`
- `refactor: reorganize module structure`
- `test: add tests for auth manager`
- `chore: update dependencies`

### Testing
- Test your changes on both Mac and Windows if possible
- Use the built-in test runner (`Cmd+Shift+T` or `Ctrl+Shift+T`)
- Add automated tests when appropriate
- Document manual testing steps in your PR

### Pull Request Process
1. Ensure your code follows the project's code style
2. Update documentation if you've changed functionality
3. Add screenshots/videos for UI changes
4. Link any related issues in your PR description
5. Request review from maintainers
6. Address review feedback promptly

## Common Development Tasks

### Adding a New Feature
1. Identify which files need modification
2. For UI features, update `index.html` and `renderer.js`
3. For backend features, update `main.js`
4. Add IPC handlers in `preload.js` if communication is needed
5. Update `menu.js` if adding menu items
6. Document your feature in the README

### Fixing a Bug
1. Reproduce the bug consistently
2. Check the logs (View → Log Viewer or `Cmd+Shift+L`)
3. Add console.log statements for debugging
4. Fix the issue
5. Test thoroughly to ensure no regressions

### Adding a New UI Window
1. Create an HTML file (e.g., `my-feature.html`)
2. Add corresponding renderer script if needed
3. Create a preload script if IPC is required
4. Update `main.js` to handle window creation
5. Add menu item in `menu.js` to open the window

## Using Cursor AI for Development

This project works great with [Cursor](https://cursor.sh)! Here are some tips:

1. **Ask Cursor to explain code**: Highlight any function and ask "What does this do?"
2. **Debug with AI**: Share error messages with Cursor for debugging help
3. **Generate code**: Describe what you want to build, and Cursor can scaffold it
4. **Refactor safely**: Ask Cursor to refactor code while maintaining functionality

## Getting Help

- **Documentation**: Check the various `.md` files in the repository
- **Issues**: Search existing issues or create a new one
- **Discussions**: Start a discussion for questions or ideas
- **Code Review**: Ask maintainers for guidance in your PR

## Project-Specific Notes

### Electron IPC Communication
This app uses Electron's IPC (Inter-Process Communication) for secure communication:
- **Main Process** (`main.js`): Backend logic, system access
- **Renderer Process** (`renderer.js`): Frontend UI, user interactions
- **Preload Scripts**: Secure bridge between main and renderer

### Module System
The app has a dynamic module loading system. See `MODULE-SYSTEM-README.md` for details.

### Clipboard Management
The clipboard manager monitors and stores clipboard history. See `CLIPBOARD-STORAGE-ARCHITECTURE.md`.

### Testing System
Built-in test runner with automated and manual tests. See `TEST-RUNNER-GUIDE.md`.

## Code Signing and Notarization (Maintainers Only)

For releasing signed builds:
- See `CODE-SIGNING-SETUP.md`
- See `NOTARIZATION-SETUP.md`
- Use `npm run build:signed`

## Release Process (Maintainers Only)

See `GITHUB-RELEASE-GUIDE.md` and `RELEASE-AUTOMATION.md` for release procedures.

## License

By contributing, you agree that your contributions will be licensed under the ISC License.

## Questions?

Don't hesitate to ask questions! Open an issue labeled "question" or start a discussion.

Happy coding! 🚀
