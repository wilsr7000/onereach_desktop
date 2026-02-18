const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

// Test configurations for all AI services
const AI_TEST_CONFIGS = {
  chatBots: {
    chatgpt: {
      name: 'ChatGPT',
      url: 'https://chat.openai.com/',
      apiUrl: 'https://platform.openai.com/docs/api-reference',
      loginSelectors: {
        loginButton: 'button:contains("Log in")',
        emailInput: 'input[name="username"], input[type="email"]',
        passwordInput: 'input[name="password"], input[type="password"]',
        submitButton: 'button[type="submit"]',
      },
      expectedElements: ['textarea[placeholder*="Message"]', 'button[data-testid="send-button"]'],
    },
    claude: {
      name: 'Claude',
      url: 'https://claude.ai/',
      apiUrl: 'https://docs.anthropic.com/claude/reference/getting-started-with-the-api',
      loginSelectors: {
        loginButton: 'button:contains("Log in")',
        emailInput: 'input[type="email"]',
        passwordInput: 'input[type="password"]',
        submitButton: 'button[type="submit"]',
      },
      expectedElements: ['textarea[placeholder*="Talk to Claude"]', 'button[aria-label="Send"]'],
    },
    perplexity: {
      name: 'Perplexity',
      url: 'https://www.perplexity.ai/',
      apiUrl: 'https://docs.perplexity.ai/',
      loginSelectors: {
        loginButton: 'button:contains("Sign in")',
        googleButton: 'button:contains("Continue with Google")',
      },
      expectedElements: ['textarea[placeholder*="Ask anything"]', 'button[aria-label="Submit"]'],
    },
    gemini: {
      name: 'Google Gemini',
      url: 'https://gemini.google.com/',
      apiUrl: 'https://ai.google.dev/docs',
      loginSelectors: {
        loginButton: 'a:contains("Sign in")',
        googleAccount: true,
      },
      expectedElements: ['div[contenteditable="true"]', 'button[aria-label="Send message"]'],
    },
  },

  imageCreators: {
    midjourney: {
      name: 'Midjourney',
      url: 'https://www.midjourney.com/',
      apiUrl: 'https://docs.midjourney.com/',
      loginSelectors: {
        loginButton: 'a:contains("Sign In")',
        discordAuth: true,
      },
      expectedElements: ['input[placeholder*="Imagine"]', 'button:contains("Generate")'],
    },
    stableDiffusion: {
      name: 'Stable Diffusion',
      url: 'https://stablediffusionweb.com/',
      apiUrl: 'https://stability.ai/developers',
      loginSelectors: {
        // Often no login required for web version
        optional: true,
      },
      expectedElements: ['textarea[placeholder*="prompt"]', 'button:contains("Generate")'],
    },
    ideogram: {
      name: 'Ideogram',
      url: 'https://ideogram.ai/',
      apiUrl: 'https://ideogram.ai/api',
      loginSelectors: {
        loginButton: 'button:contains("Sign in")',
        googleButton: 'button:contains("Continue with Google")',
      },
      expectedElements: ['textarea[placeholder*="Describe"]', 'button:contains("Generate")'],
    },
    dalle: {
      name: 'DALL-E 3',
      url: 'https://labs.openai.com/',
      apiUrl: 'https://platform.openai.com/docs/guides/images',
      loginSelectors: {
        loginButton: 'button:contains("Log in")',
        openAIAccount: true,
      },
      expectedElements: ['input[placeholder*="prompt"]', 'button:contains("Generate")'],
    },
    firefly: {
      name: 'Adobe Firefly',
      url: 'https://firefly.adobe.com/',
      apiUrl: 'https://developer.adobe.com/firefly-apis/docs/',
      loginSelectors: {
        loginButton: 'button:contains("Sign in")',
        adobeAccount: true,
      },
      expectedElements: ['textarea[placeholder*="Describe"]', 'button:contains("Generate")'],
    },
  },

  videoCreators: {
    veo3: {
      name: 'Google Veo3',
      url: 'https://veo.google.com/',
      apiUrl: 'https://developers.google.com/veo',
      loginSelectors: {
        googleAccount: true,
      },
      expectedElements: ['textarea[placeholder*="Describe"]', 'button:contains("Create")'],
    },
    runway: {
      name: 'Runway',
      url: 'https://runwayml.com/',
      apiUrl: 'https://docs.runwayml.com/',
      loginSelectors: {
        loginButton: 'a:contains("Log in")',
        emailInput: 'input[type="email"]',
        passwordInput: 'input[type="password"]',
      },
      expectedElements: ['div[class*="workspace"]', 'button:contains("Generate")'],
    },
    pika: {
      name: 'Pika',
      url: 'https://pika.art/',
      apiUrl: 'https://docs.pika.art/',
      loginSelectors: {
        loginButton: 'button:contains("Sign in")',
        googleButton: 'button:contains("Continue with Google")',
      },
      expectedElements: ['textarea[placeholder*="prompt"]', 'button:contains("Generate")'],
    },
    synthesia: {
      name: 'Synthesia',
      url: 'https://www.synthesia.io/',
      apiUrl: 'https://docs.synthesia.io/',
      loginSelectors: {
        loginButton: 'a:contains("Log in")',
        emailInput: 'input[name="email"]',
        passwordInput: 'input[name="password"]',
      },
      expectedElements: ['div[class*="editor"]', 'button:contains("Generate")'],
    },
    heygen: {
      name: 'HeyGen',
      url: 'https://www.heygen.com/',
      apiUrl: 'https://docs.heygen.com/docs',
      loginSelectors: {
        loginButton: 'button:contains("Sign in")',
        emailInput: 'input[type="email"]',
        passwordInput: 'input[type="password"]',
      },
      expectedElements: ['div[class*="studio"]', 'button:contains("Create")'],
    },
  },

  audioGenerators: {
    suno: {
      name: 'Suno AI',
      url: 'https://suno.ai/',
      apiUrl: 'https://docs.suno.ai/',
      category: 'music',
      loginSelectors: {
        loginButton: 'button:contains("Sign in")',
        googleButton: 'button:contains("Continue with Google")',
      },
      expectedElements: ['textarea[placeholder*="song"]', 'button:contains("Create")'],
    },
    udio: {
      name: 'Udio',
      url: 'https://www.udio.com/',
      apiUrl: 'https://docs.udio.com/',
      category: 'music',
      loginSelectors: {
        loginButton: 'button:contains("Sign in")',
        emailInput: 'input[type="email"]',
      },
      expectedElements: ['input[placeholder*="Describe"]', 'button:contains("Generate")'],
    },
    elevenlabs: {
      name: 'ElevenLabs',
      url: 'https://elevenlabs.io/',
      apiUrl: 'https://docs.elevenlabs.io/',
      category: 'narration',
      loginSelectors: {
        loginButton: 'a:contains("Log in")',
        emailInput: 'input[type="email"]',
        passwordInput: 'input[type="password"]',
      },
      expectedElements: ['textarea[placeholder*="text"]', 'button:contains("Generate")'],
    },
    playht: {
      name: 'Play.ht',
      url: 'https://play.ht/',
      apiUrl: 'https://docs.play.ht/',
      category: 'narration',
      loginSelectors: {
        loginButton: 'a:contains("Sign in")',
        emailInput: 'input[name="email"]',
        passwordInput: 'input[name="password"]',
      },
      expectedElements: ['textarea[placeholder*="text"]', 'button:contains("Generate")'],
    },
  },
};

class ExternalAITestSuite {
  constructor() {
    this.testResults = [];
    this.wizardWindow = null;
    this.testWindow = null;
  }

  async runAllTests() {
    console.log('🧪 Starting External AI Test Suite');
    console.log('📘 ================================');

    const startTime = Date.now();

    try {
      // Test Chat Bots
      await this.testCategory('chatBots', 'Chat Bots');

      // Test Image Creators
      await this.testCategory('imageCreators', 'Image Creators');

      // Test Video Creators
      await this.testCategory('videoCreators', 'Video Creators');

      // Test Audio Generators
      await this.testCategory('audioGenerators', 'Audio Generators');
    } catch (error) {
      console.error('❌ Test suite error:', error);
    }

    // Print summary
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    this.printSummary(duration);
  }

  async testCategory(category, categoryName) {
    console.log(`\n📂 Testing ${categoryName}...`);

    const services = AI_TEST_CONFIGS[category];

    for (const [key, config] of Object.entries(services)) {
      await this.testService(category, key, config);
    }
  }

  async testService(category, serviceKey, config) {
    console.log(`\n🔍 Testing ${config.name}...`);

    const testResult = {
      category,
      service: config.name,
      url: config.url,
      timestamp: new Date().toISOString(),
      tests: {
        urlLoads: false,
        loginAvailable: false,
        expectedElements: false,
        apiDocumentationUrl: false,
      },
    };

    try {
      // Create test window
      this.testWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        show: false,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          webSecurity: true,
        },
      });

      // Test 1: URL loads
      console.log(`  ✓ Loading ${config.url}...`);
      await this.testWindow.loadURL(config.url);
      testResult.tests.urlLoads = true;
      console.log(`  ✅ URL loads successfully`);

      // Test 2: Check for login elements
      if (!config.loginSelectors?.optional) {
        const loginTestResult = await this.testLoginElements(config);
        testResult.tests.loginAvailable = loginTestResult;
        console.log(`  ${loginTestResult ? '✅' : '❌'} Login elements ${loginTestResult ? 'found' : 'not found'}`);
      } else {
        testResult.tests.loginAvailable = 'optional';
        console.log(`  ℹ️  Login is optional for this service`);
      }

      // Test 3: Check API documentation URL
      if (config.apiUrl) {
        try {
          const apiResponse = await fetch(config.apiUrl, { method: 'HEAD' });
          testResult.tests.apiDocumentationUrl = apiResponse.ok;
          console.log(
            `  ${apiResponse.ok ? '✅' : '❌'} API documentation ${apiResponse.ok ? 'accessible' : 'not accessible'}`
          );
        } catch (error) {
          testResult.tests.apiDocumentationUrl = false;
          console.log(`  ❌ API documentation check failed:`, error.message);
        }
      }

      // Test 4: Expected elements (would need actual login)
      console.log(`  ℹ️  Expected elements test requires login credentials`);
      testResult.tests.expectedElements = 'requires-login';
    } catch (error) {
      console.error(`  ❌ Error testing ${config.name}:`, error.message);
      testResult.error = error.message;
    } finally {
      if (this.testWindow && !this.testWindow.isDestroyed()) {
        this.testWindow.close();
      }
    }

    this.testResults.push(testResult);
  }

  async testLoginElements(config) {
    try {
      const result = await this.testWindow.webContents.executeJavaScript(`
        (function() {
          const selectors = ${JSON.stringify(config.loginSelectors)};
          const found = {};
          
          // Check for various login indicators
          if (selectors.loginButton) {
            found.loginButton = document.querySelector(selectors.loginButton) !== null ||
                               document.querySelector('button:contains("Sign in")') !== null ||
                               document.querySelector('button:contains("Log in")') !== null;
          }
          
          if (selectors.emailInput) {
            found.emailInput = document.querySelector(selectors.emailInput) !== null;
          }
          
          if (selectors.googleButton) {
            found.googleAuth = document.querySelector(selectors.googleButton) !== null ||
                              document.querySelector('button:contains("Google")') !== null;
          }
          
          if (selectors.discordAuth) {
            found.discordAuth = document.querySelector('button:contains("Discord")') !== null;
          }
          
          if (selectors.adobeAccount) {
            found.adobeAuth = document.querySelector('button:contains("Adobe")') !== null;
          }
          
          // Return true if any login method found
          return Object.values(found).some(v => v === true);
        })();
      `);

      return result;
    } catch (error) {
      console.log('    Login element check error:', error.message);
      return false;
    }
  }

  printSummary(duration) {
    console.log('\n📘 ================================');
    console.log('🧪 Test Suite Results');
    console.log('📘 ================================');
    console.log(`📘 Duration: ${duration} seconds`);
    console.log(`📘 Total services tested: ${this.testResults.length}`);

    // Count successes by category
    const categories = {
      chatBots: { total: 0, passed: 0 },
      imageCreators: { total: 0, passed: 0 },
      videoCreators: { total: 0, passed: 0 },
      audioGenerators: { total: 0, passed: 0 },
    };

    this.testResults.forEach((result) => {
      categories[result.category].total++;
      if (
        result.tests.urlLoads &&
        (result.tests.loginAvailable === true || result.tests.loginAvailable === 'optional')
      ) {
        categories[result.category].passed++;
      }
    });

    console.log('\n📊 Results by Category:');
    Object.entries(categories).forEach(([cat, stats]) => {
      const categoryName = cat.replace(/([A-Z])/g, ' $1').trim();
      console.log(`  ${categoryName}: ${stats.passed}/${stats.total} passed`);
    });

    // Save detailed report
    const reportPath = path.join(__dirname, `external-ai-test-report-${Date.now()}.json`);
    fs.writeFileSync(
      reportPath,
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          duration: duration,
          summary: categories,
          details: this.testResults,
        },
        null,
        2
      )
    );

    console.log(`\n📘 Detailed report saved to: ${reportPath}`);
  }
}

// Run tests if called directly
if (require.main === module) {
  app.whenReady().then(async () => {
    const testSuite = new ExternalAITestSuite();
    await testSuite.runAllTests();
    app.quit();
  });
}

module.exports = ExternalAITestSuite;
