const fs = require('fs');
const path = require('path');

class TemplateManager {
  constructor() {
    this.templatesDir = path.join(__dirname, 'templates', 'export');
    this.templates = new Map();
    this.loadTemplates();
  }

  loadTemplates() {
    try {
      // Get all template files
      const templateFiles = fs.readdirSync(this.templatesDir)
        .filter(file => file.endsWith('.json'));
      
      // Load each template
      templateFiles.forEach(file => {
        try {
          const templatePath = path.join(this.templatesDir, file);
          const templateData = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
          this.templates.set(templateData.id, templateData);
        } catch (error) {
          console.error(`Error loading template ${file}:`, error);
        }
      });
      
      console.log(`Loaded ${this.templates.size} export templates`);
    } catch (error) {
      console.error('Error loading templates:', error);
    }
  }

  getAllTemplates() {
    return Array.from(this.templates.values()).map(template => ({
      id: template.id,
      name: template.name,
      description: template.description,
      icon: template.icon,
      category: template.category
    }));
  }

  getTemplate(id) {
    return this.templates.get(id);
  }

  saveTemplate(template) {
    const templatePath = path.join(this.templatesDir, `${template.id}.json`);
    fs.writeFileSync(templatePath, JSON.stringify(template, null, 2));
    this.templates.set(template.id, template);
  }

  deleteTemplate(id) {
    const templatePath = path.join(this.templatesDir, `${id}.json`);
    if (fs.existsSync(templatePath)) {
      fs.unlinkSync(templatePath);
      this.templates.delete(id);
    }
  }
}

// Export singleton instance
let templateManager;

function getTemplateManager() {
  if (!templateManager) {
    templateManager = new TemplateManager();
  }
  return templateManager;
}

module.exports = { getTemplateManager }; 