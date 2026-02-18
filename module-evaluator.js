const fs = require('fs');
const path = require('path');
const unzipper = require('unzipper');

class ModuleEvaluator {
  async evaluateZip(zipPath) {
    const tempPath = path.join(require('electron').app.getPath('temp'), `module-eval-${Date.now()}`);
    const evaluation = {
      score: 0,
      checks: [],
      warnings: [],
      suggestions: [],
      details: {},
    };

    try {
      // Extract zip to temp directory
      await fs
        .createReadStream(zipPath)
        .pipe(unzipper.Extract({ path: tempPath }))
        .promise();

      // Find the module directory (might be nested)
      const moduleDir = this.findModuleDirectory(tempPath);
      if (!moduleDir) {
        evaluation.checks.push({ passed: false, message: 'No valid module directory found in ZIP' });
        evaluation.score = 0;
        return evaluation;
      }

      // Check manifest.json
      const manifestCheck = this.checkManifest(moduleDir);
      evaluation.checks.push(...manifestCheck.checks);
      evaluation.warnings.push(...manifestCheck.warnings);
      evaluation.details.manifest = manifestCheck.manifest;

      // Check file structure
      const structureCheck = this.checkFileStructure(moduleDir, manifestCheck.manifest);
      evaluation.checks.push(...structureCheck.checks);
      evaluation.warnings.push(...structureCheck.warnings);

      // Check code quality
      const codeCheck = await this.checkCodeQuality(moduleDir, manifestCheck.manifest);
      evaluation.checks.push(...codeCheck.checks);
      evaluation.warnings.push(...codeCheck.warnings);
      evaluation.suggestions.push(...codeCheck.suggestions);

      // Calculate score
      const totalChecks = evaluation.checks.length;
      const passedChecks = evaluation.checks.filter((c) => c.passed).length;
      evaluation.score = Math.round((passedChecks / totalChecks) * 100);

      // Add suggestions based on score
      if (evaluation.score < 100) {
        this.addGeneralSuggestions(evaluation);
      }

      return evaluation;
    } catch (error) {
      console.error('Error evaluating module:', error);
      throw error;
    } finally {
      // Clean up temp directory
      if (fs.existsSync(tempPath)) {
        fs.rmSync(tempPath, { recursive: true, force: true });
      }
    }
  }

  findModuleDirectory(basePath) {
    // Check if manifest.json is in the base path
    if (fs.existsSync(path.join(basePath, 'manifest.json'))) {
      return basePath;
    }

    // Check subdirectories (one level deep)
    const items = fs.readdirSync(basePath);
    for (const item of items) {
      const itemPath = path.join(basePath, item);
      if (fs.statSync(itemPath).isDirectory()) {
        if (fs.existsSync(path.join(itemPath, 'manifest.json'))) {
          return itemPath;
        }
      }
    }

    return null;
  }

  checkManifest(moduleDir) {
    const result = {
      checks: [],
      warnings: [],
      manifest: null,
    };

    const manifestPath = path.join(moduleDir, 'manifest.json');

    // Check if manifest exists
    if (!fs.existsSync(manifestPath)) {
      result.checks.push({ passed: false, message: 'manifest.json not found' });
      return result;
    }

    result.checks.push({ passed: true, message: 'manifest.json exists' });

    try {
      // Parse manifest
      const manifestContent = fs.readFileSync(manifestPath, 'utf8');
      const manifest = JSON.parse(manifestContent);
      result.manifest = manifest;

      // Check required fields
      const requiredFields = ['id', 'name', 'main'];
      for (const field of requiredFields) {
        if (manifest[field]) {
          result.checks.push({ passed: true, message: `Required field '${field}' is present` });
        } else {
          result.checks.push({ passed: false, message: `Required field '${field}' is missing` });
        }
      }

      // Check recommended fields
      const recommendedFields = ['version', 'description', 'menuLabel', 'dataDirectory'];
      for (const field of recommendedFields) {
        if (!manifest[field]) {
          result.warnings.push(`Recommended field '${field}' is missing`);
        }
      }

      // Validate ID format
      if (manifest.id) {
        if (!/^[a-z0-9-_.]+$/.test(manifest.id)) {
          result.warnings.push(
            'Module ID should only contain lowercase letters, numbers, hyphens, dots, and underscores'
          );
        }
      }

      // Check windowOptions
      if (manifest.windowOptions) {
        if (!manifest.windowOptions.width || !manifest.windowOptions.height) {
          result.warnings.push('windowOptions should include both width and height');
        }
      } else {
        result.warnings.push('No windowOptions specified - module will use default window size');
      }
    } catch (error) {
      result.checks.push({ passed: false, message: `Invalid manifest.json: ${error.message}` });
    }

    return result;
  }

  checkFileStructure(moduleDir, manifest) {
    const result = {
      checks: [],
      warnings: [],
    };

    if (!manifest) {
      return result;
    }

    // Check if main file exists
    if (manifest.main) {
      const mainPath = path.join(moduleDir, manifest.main);
      if (fs.existsSync(mainPath)) {
        result.checks.push({ passed: true, message: `Main file '${manifest.main}' exists` });
      } else {
        result.checks.push({ passed: false, message: `Main file '${manifest.main}' not found` });
      }
    }

    // Check for common files
    const files = fs.readdirSync(moduleDir);

    // Check for README
    if (!files.some((f) => f.toLowerCase().includes('readme'))) {
      result.warnings.push('No README file found - consider adding documentation');
    }

    // Check for package.json if node_modules exists
    if (files.includes('node_modules') && !files.includes('package.json')) {
      result.warnings.push('node_modules found but no package.json - dependencies may not install correctly');
    }

    // Check file count
    const fileCount = this.countFiles(moduleDir);
    if (fileCount > 1000) {
      result.warnings.push(`Module contains ${fileCount} files - consider reducing size`);
    }

    return result;
  }

  async checkCodeQuality(moduleDir, manifest) {
    const result = {
      checks: [],
      warnings: [],
      suggestions: [],
    };

    if (!manifest || !manifest.main) {
      return result;
    }

    // Read main HTML file
    const mainPath = path.join(moduleDir, manifest.main);
    if (!fs.existsSync(mainPath)) {
      return result;
    }

    const htmlContent = fs.readFileSync(mainPath, 'utf8');

    // Check for localStorage usage
    const jsFiles = this.findJavaScriptFiles(moduleDir, htmlContent);
    let usesLocalStorage = false;
    let usesCorrectStorage = false;
    let checksClaudeAPI = false;
    let hasErrorHandling = false;

    for (const jsFile of jsFiles) {
      const jsContent = fs.readFileSync(jsFile, 'utf8');

      // Check for localStorage
      if (/localStorage\s*\.|sessionStorage\s*\./.test(jsContent)) {
        usesLocalStorage = true;
      }

      // Check for correct storage pattern
      if (/window\.moduleDataPath|moduleDataPath/.test(jsContent)) {
        usesCorrectStorage = true;
      }

      // Check for Claude API usage
      if (/moduleAPI\.claude\.testConnection/.test(jsContent)) {
        checksClaudeAPI = true;
      }

      // Check for error handling
      if (/try\s*{[\s\S]*?}\s*catch/.test(jsContent)) {
        hasErrorHandling = true;
      }
    }

    // Add checks
    if (usesLocalStorage) {
      result.checks.push({
        passed: false,
        message: 'Module uses localStorage/sessionStorage instead of file system',
      });
      result.suggestions.push('Replace localStorage with fs.writeFileSync using window.moduleDataPath');
    } else {
      result.checks.push({
        passed: true,
        message: 'Module does not use localStorage/sessionStorage',
      });
    }

    if (usesCorrectStorage) {
      result.checks.push({
        passed: true,
        message: 'Module uses correct data storage pattern (moduleDataPath)',
      });
    } else {
      result.checks.push({
        passed: false,
        message: 'Module does not use moduleDataPath for data storage',
      });
      result.suggestions.push('Use window.moduleDataPath for all file storage operations');
    }

    // Add warnings for best practices
    if (!checksClaudeAPI && /moduleAPI\.claude/.test(jsFiles.map((f) => fs.readFileSync(f, 'utf8')).join(''))) {
      result.warnings.push("Module uses Claude API but does not check if it's available first");
      result.suggestions.push('Always check moduleAPI.claude.testConnection() before using Claude features');
    }

    if (!hasErrorHandling) {
      result.warnings.push('Limited error handling detected - consider adding try/catch blocks');
    }

    // Check HTML structure
    if (!/<meta\s+charset=["']UTF-8["']/i.test(htmlContent)) {
      result.warnings.push('HTML missing UTF-8 charset meta tag');
    }

    return result;
  }

  findJavaScriptFiles(moduleDir, htmlContent) {
    const jsFiles = [];

    // Find script tags in HTML
    const scriptMatches = htmlContent.match(/<script\s+src=["']([^"']+)["']/gi) || [];
    for (const match of scriptMatches) {
      const srcMatch = match.match(/src=["']([^"']+)["']/i);
      if (srcMatch) {
        const scriptPath = path.join(moduleDir, srcMatch[1]);
        if (fs.existsSync(scriptPath)) {
          jsFiles.push(scriptPath);
        }
      }
    }

    // Also check for .js files in the directory
    const files = fs.readdirSync(moduleDir);
    for (const file of files) {
      if (file.endsWith('.js')) {
        const filePath = path.join(moduleDir, file);
        if (!jsFiles.includes(filePath)) {
          jsFiles.push(filePath);
        }
      }
    }

    return jsFiles;
  }

  countFiles(dir) {
    let count = 0;
    const items = fs.readdirSync(dir);

    for (const item of items) {
      const itemPath = path.join(dir, item);
      const stat = fs.statSync(itemPath);

      if (stat.isDirectory()) {
        count += this.countFiles(itemPath);
      } else {
        count++;
      }
    }

    return count;
  }

  addGeneralSuggestions(evaluation) {
    if (evaluation.score < 50) {
      evaluation.suggestions.push('Consider reviewing the Module Packaging Instructions for best practices');
    }

    if (!evaluation.details.manifest?.dataDirectory) {
      evaluation.suggestions.push('Add a dataDirectory field to manifest.json for organized data storage');
    }

    if (!evaluation.details.manifest?.version) {
      evaluation.suggestions.push('Add version field to track module updates');
    }
  }
}

module.exports = ModuleEvaluator;
