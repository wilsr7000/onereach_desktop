const fs = require('fs');
const path = require('path');
const unzipper = require('unzipper');
const archiver = require('archiver');
const ai = require('./lib/ai-service');
const { getSettingsManager } = require('./settings-manager');

class ModuleAIReviewer {
  constructor() {
    this.settingsManager = getSettingsManager();
  }

  async reviewAndFix(zipPath) {
    const tempPath = path.join(require('electron').app.getPath('temp'), `module-ai-review-${Date.now()}`);
    const fixedZipPath = path.join(require('electron').app.getPath('temp'), `module-fixed-${Date.now()}.zip`);
    
    try {
      // Extract module
      await fs.createReadStream(zipPath)
        .pipe(unzipper.Extract({ path: tempPath }))
        .promise();
      
      const moduleDir = this.findModuleDirectory(tempPath);
      if (!moduleDir) {
        throw new Error('No valid module directory found in ZIP');
      }
      
      // Get module files for review
      const files = await this.collectModuleFiles(moduleDir);
      
      // Review with Claude
      const review = await this.reviewWithClaude(files);
      
      if (review.needsFixes) {
        // Apply fixes
        await this.applyFixes(moduleDir, review.fixes);
        
        // Create new ZIP with fixes
        await this.createZip(moduleDir, fixedZipPath);
        
        // Verify fixes
        const verification = await this.verifyFixes(fixedZipPath);
        
        return {
          success: true,
          review: review,
          fixedZipPath: fixedZipPath,
          verification: verification
        };
      } else {
        return {
          success: true,
          review: review,
          needsFixes: false
        };
      }
      
    } catch (error) {
      console.error('Error in AI review:', error);
      throw error;
    } finally {
      // Clean up temp directory
      if (fs.existsSync(tempPath)) {
        fs.rmSync(tempPath, { recursive: true, force: true });
      }
    }
  }

  findModuleDirectory(basePath) {
    if (fs.existsSync(path.join(basePath, 'manifest.json'))) {
      return basePath;
    }
    
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

  async collectModuleFiles(moduleDir) {
    const files = {};
    const items = fs.readdirSync(moduleDir);
    
    for (const item of items) {
      const itemPath = path.join(moduleDir, item);
      const stat = fs.statSync(itemPath);
      
      if (stat.isFile() && !item.startsWith('.')) {
        // Only include text files for review
        const ext = path.extname(item).toLowerCase();
        if (['.json', '.js', '.html', '.css', '.md', '.txt'].includes(ext)) {
          const content = fs.readFileSync(itemPath, 'utf8');
          files[item] = content;
        }
      }
    }
    
    return files;
  }

  async reviewWithClaude(files) {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('Claude API key not configured');
    }

    const prompt = `You are reviewing a OneReach desktop module. Analyze the following files and identify any issues that need fixing.

CRITICAL REQUIREMENTS for OneReach modules:
1. MUST use window.moduleDataPath for ALL data storage (NOT localStorage/sessionStorage)
2. MUST have valid manifest.json with required fields: id, name, main
3. MUST check moduleAPI.claude.testConnection() before using Claude API
4. MUST handle errors with try/catch blocks
5. MUST use relative paths for all assets

Files to review:
${Object.entries(files).map(([name, content]) => `
=== ${name} ===
${content}
`).join('\n')}

Respond with a JSON object containing:
{
  "needsFixes": boolean,
  "issues": [
    {
      "severity": "error|warning",
      "file": "filename",
      "issue": "description",
      "line": "line number or range if applicable"
    }
  ],
  "fixes": [
    {
      "file": "filename",
      "type": "replace|create|delete",
      "original": "original code (for replace)",
      "fixed": "fixed code",
      "description": "what was fixed"
    }
  ],
  "summary": "overall assessment",
  "score": 0-100
}

Focus on:
- localStorage/sessionStorage usage (must be replaced with fs operations)
- Missing error handling
- Incorrect data storage patterns
- Missing Claude API availability checks
- Invalid manifest.json
- Security issues`;

    try {
      const response = await ai.json(prompt, {
        profile: 'standard',
        maxTokens: 4000,
        temperature: 0.2,
        feature: 'ai-reviewer'
      });

      // Response is already parsed JSON from ai.json()
      return response;
    } catch (error) {
      console.error('Claude API error:', error);
      throw error;
    }
  }

  async applyFixes(moduleDir, fixes) {
    for (const fix of fixes) {
      const filePath = path.join(moduleDir, fix.file);
      
      switch (fix.type) {
        case 'replace':
          // Read current file
          let content = '';
          if (fs.existsSync(filePath)) {
            content = fs.readFileSync(filePath, 'utf8');
          }
          
          // Apply replacement
          if (fix.original && fix.fixed) {
            content = content.replace(fix.original, fix.fixed);
          } else if (fix.fixed) {
            // Full file replacement
            content = fix.fixed;
          }
          
          // Write fixed content
          fs.writeFileSync(filePath, content, 'utf8');
          console.log(`Fixed ${fix.file}: ${fix.description}`);
          break;
          
        case 'create':
          // Create new file
          fs.writeFileSync(filePath, fix.fixed || '', 'utf8');
          console.log(`Created ${fix.file}: ${fix.description}`);
          break;
          
        case 'delete':
          // Delete file
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`Deleted ${fix.file}: ${fix.description}`);
          }
          break;
      }
    }
  }

  async createZip(sourceDir, outputPath) {
    return new Promise((resolve, reject) => {
      const output = fs.createWriteStream(outputPath);
      const archive = archiver('zip', { zlib: { level: 9 } });
      
      output.on('close', () => {
        console.log(`Created fixed module ZIP: ${archive.pointer()} bytes`);
        resolve();
      });
      
      archive.on('error', (err) => {
        reject(err);
      });
      
      archive.pipe(output);
      
      // Get the module directory name
      const moduleName = path.basename(sourceDir);
      
      // Add all files maintaining directory structure
      archive.directory(sourceDir, moduleName);
      
      archive.finalize();
    });
  }

  async verifyFixes(zipPath) {
    // Run a quick verification on the fixed module
    const ModuleEvaluator = require('./module-evaluator');
    const evaluator = new ModuleEvaluator();
    
    try {
      const evaluation = await evaluator.evaluateZip(zipPath);
      return {
        success: evaluation.score >= 80,
        score: evaluation.score,
        remainingIssues: evaluation.checks.filter(c => !c.passed).map(c => c.message)
      };
    } catch (error) {
      console.error('Error verifying fixes:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  getApiKey() {
    // Check for new llmConfig structure first
    const llmConfig = this.settingsManager.get('llmConfig');
    if (llmConfig && llmConfig.anthropic && llmConfig.anthropic.apiKey) {
      return llmConfig.anthropic.apiKey;
    }
    
    // Fallback to legacy structure
    return this.settingsManager.get('llmApiKey') || '';
  }

  async generateFixReport(review, verification) {
    const report = [];
    
    report.push('# Module AI Review Report\n');
    report.push(`**Score**: ${review.score}/100\n`);
    report.push(`**Summary**: ${review.summary}\n`);
    
    if (review.issues.length > 0) {
      report.push('## Issues Found\n');
      for (const issue of review.issues) {
        const icon = issue.severity === 'error' ? '❌' : '⚠️';
        report.push(`${icon} **${issue.file}**: ${issue.issue}`);
        if (issue.line) {
          report.push(` (line ${issue.line})`);
        }
        report.push('\n');
      }
    }
    
    if (review.fixes.length > 0) {
      report.push('\n## Fixes Applied\n');
      for (const fix of review.fixes) {
        report.push(`✅ **${fix.file}**: ${fix.description}\n`);
      }
    }
    
    if (verification) {
      report.push('\n## Verification Results\n');
      report.push(`**New Score**: ${verification.score}/100\n`);
      
      if (verification.remainingIssues.length > 0) {
        report.push('\n### Remaining Issues:\n');
        for (const issue of verification.remainingIssues) {
          report.push(`- ${issue}\n`);
        }
      } else {
        report.push('✅ All issues resolved!\n');
      }
    }
    
    return report.join('');
  }
}

module.exports = ModuleAIReviewer; 