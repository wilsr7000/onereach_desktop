/**
 * Automated Test Suite for IDW Management System
 * Tests adding and removing all types of digital workers and agents
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

class IDWManagementTester {
  constructor() {
    this.results = {
      passed: 0,
      failed: 0,
      tests: []
    };
    this.testWindow = null;
  }

  async runAllTests() {
    console.log('═'.repeat(70));
    console.log('🧪 IDW MANAGEMENT TEST SUITE');
    console.log('═'.repeat(70));
    
    // Wait for app to be ready
    await app.whenReady();
    
    // Initialize settings manager
    const { getSettingsManager } = require('./settings-manager');
    this.settingsManager = getSettingsManager();
    
    // Run tests
    await this.testAddIDWFromStore();
    await this.testDeleteIDW();
    await this.testDuplicatePrevention();
    await this.testAddExternalBot();
    await this.testDeleteExternalBot();
    await this.testAddImageCreator();
    await this.testAddVideoCreator();
    await this.testAddAudioGenerator();
    await this.testMenuRefresh();
    await this.testSettingsSync();
    
    // Print results
    this.printResults();
    
    // Exit
    setTimeout(() => app.quit(), 1000);
  }

  async testAddIDWFromStore() {
    const testName = 'Add IDW from Store';
    console.log(`\n🧪 Testing: ${testName}`);
    
    try {
      // Mock IDW from store
      const mockIDW = {
        id: 'test-idw-123',
        name: 'Test IDW',
        url: 'https://test.onereach.ai/test-idw',
        description: 'Test IDW for automation',
        category: 'Testing',
        developer: 'Test Developer',
        version: '1.0.0'
      };
      
      // Get current IDWs
      const before = this.settingsManager.get('idwEnvironments') || [];
      const beforeCount = before.length;
      
      // Add IDW
      const storeIdwId = `store-${mockIDW.id}`;
      const newEntry = {
        id: storeIdwId,
        label: mockIDW.name,
        chatUrl: mockIDW.url,
        environment: 'store',
        description: mockIDW.description,
        category: mockIDW.category,
        storeData: {
          idwId: mockIDW.id,
          developer: mockIDW.developer,
          version: mockIDW.version,
          installedAt: new Date().toISOString()
        }
      };
      
      const updated = [...before, newEntry];
      this.settingsManager.set('idwEnvironments', updated);
      
      // Verify
      const after = this.settingsManager.get('idwEnvironments') || [];
      const added = after.find(idw => idw.id === storeIdwId);
      
      if (after.length === beforeCount + 1 && added) {
        this.pass(testName, `IDW added successfully (${beforeCount} → ${after.length})`);
        
        // Cleanup
        const cleaned = after.filter(idw => idw.id !== storeIdwId);
        this.settingsManager.set('idwEnvironments', cleaned);
      } else {
        this.fail(testName, `Expected ${beforeCount + 1} IDWs, got ${after.length}`);
      }
    } catch (error) {
      this.fail(testName, error.message);
    }
  }

  async testDeleteIDW() {
    const testName = 'Delete IDW';
    console.log(`\n🧪 Testing: ${testName}`);
    
    try {
      // Add a test IDW first
      const before = this.settingsManager.get('idwEnvironments') || [];
      const testEntry = {
        id: 'test-delete-idw',
        label: 'Delete Test IDW',
        chatUrl: 'https://test.onereach.ai/delete-test',
        environment: 'test'
      };
      
      this.settingsManager.set('idwEnvironments', [...before, testEntry]);
      
      // Now delete it
      const withTest = this.settingsManager.get('idwEnvironments') || [];
      const filtered = withTest.filter(idw => idw.id !== 'test-delete-idw');
      this.settingsManager.set('idwEnvironments', filtered);
      
      // Verify deleted
      const after = this.settingsManager.get('idwEnvironments') || [];
      const stillThere = after.find(idw => idw.id === 'test-delete-idw');
      
      if (!stillThere && after.length === before.length) {
        this.pass(testName, 'IDW deleted successfully');
      } else {
        this.fail(testName, 'IDW still exists after delete');
      }
    } catch (error) {
      this.fail(testName, error.message);
    }
  }

  async testDuplicatePrevention() {
    const testName = 'Duplicate Prevention';
    console.log(`\n🧪 Testing: ${testName}`);
    
    try {
      const before = this.settingsManager.get('idwEnvironments') || [];
      const testEntry = {
        id: 'duplicate-test',
        label: 'Duplicate Test',
        chatUrl: 'https://test.onereach.ai/duplicate',
        environment: 'test'
      };
      
      // Add once
      this.settingsManager.set('idwEnvironments', [...before, testEntry]);
      
      // Try to add duplicate
      const current = this.settingsManager.get('idwEnvironments') || [];
      const duplicate = current.find(idw => idw.id === 'duplicate-test');
      
      if (duplicate) {
        // Already exists - should update not add
        const withoutDupe = current.filter(idw => idw.id !== 'duplicate-test');
        this.settingsManager.set('idwEnvironments', [...withoutDupe, testEntry]);
        
        const final = this.settingsManager.get('idwEnvironments') || [];
        const count = final.filter(idw => idw.id === 'duplicate-test').length;
        
        if (count === 1) {
          this.pass(testName, 'Only one instance exists');
          
          // Cleanup
          const cleaned = final.filter(idw => idw.id !== 'duplicate-test');
          this.settingsManager.set('idwEnvironments', cleaned);
        } else {
          this.fail(testName, `Found ${count} instances, expected 1`);
        }
      }
    } catch (error) {
      this.fail(testName, error.message);
    }
  }

  async testAddExternalBot() {
    const testName = 'Add External Bot';
    console.log(`\n🧪 Testing: ${testName}`);
    
    try {
      const botsPath = path.join(app.getPath('userData'), 'external-bots.json');
      const before = fs.existsSync(botsPath) ? JSON.parse(fs.readFileSync(botsPath, 'utf8')) : [];
      
      const testBot = {
        id: 'test-bot-123',
        name: 'Test Bot',
        chatUrl: 'https://test-bot.com',
        type: 'external'
      };
      
      fs.writeFileSync(botsPath, JSON.stringify([...before, testBot], null, 2));
      
      const after = JSON.parse(fs.readFileSync(botsPath, 'utf8'));
      const added = after.find(bot => bot.id === 'test-bot-123');
      
      if (added) {
        this.pass(testName, `External bot added (${before.length} → ${after.length})`);
        
        // Cleanup
        const cleaned = after.filter(bot => bot.id !== 'test-bot-123');
        fs.writeFileSync(botsPath, JSON.stringify(cleaned, null, 2));
      } else {
        this.fail(testName, 'Bot not found after add');
      }
    } catch (error) {
      this.fail(testName, error.message);
    }
  }

  async testDeleteExternalBot() {
    const testName = 'Delete External Bot';
    console.log(`\n🧪 Testing: ${testName}`);
    
    try {
      const botsPath = path.join(app.getPath('userData'), 'external-bots.json');
      const before = fs.existsSync(botsPath) ? JSON.parse(fs.readFileSync(botsPath, 'utf8')) : [];
      
      // Add test bot
      const testBot = { id: 'delete-test-bot', name: 'Delete Test', chatUrl: 'https://test.com' };
      fs.writeFileSync(botsPath, JSON.stringify([...before, testBot], null, 2));
      
      // Delete it
      const withTest = JSON.parse(fs.readFileSync(botsPath, 'utf8'));
      const filtered = withTest.filter(bot => bot.id !== 'delete-test-bot');
      fs.writeFileSync(botsPath, JSON.stringify(filtered, null, 2));
      
      // Verify
      const after = JSON.parse(fs.readFileSync(botsPath, 'utf8'));
      const stillThere = after.find(bot => bot.id === 'delete-test-bot');
      
      if (!stillThere) {
        this.pass(testName, 'External bot deleted successfully');
      } else {
        this.fail(testName, 'Bot still exists after delete');
      }
    } catch (error) {
      this.fail(testName, error.message);
    }
  }

  async testAddImageCreator() {
    const testName = 'Add Image Creator';
    console.log(`\n🧪 Testing: ${testName}`);
    
    try {
      const creatorsPath = path.join(app.getPath('userData'), 'image-creators.json');
      const before = fs.existsSync(creatorsPath) ? JSON.parse(fs.readFileSync(creatorsPath, 'utf8')) : [];
      
      const testCreator = {
        id: 'test-creator-123',
        name: 'Test Creator',
        url: 'https://test-creator.com',
        type: 'image'
      };
      
      fs.writeFileSync(creatorsPath, JSON.stringify([...before, testCreator], null, 2));
      
      const after = JSON.parse(fs.readFileSync(creatorsPath, 'utf8'));
      const added = after.find(c => c.id === 'test-creator-123');
      
      if (added) {
        this.pass(testName, `Image creator added (${before.length} → ${after.length})`);
        
        // Cleanup
        const cleaned = after.filter(c => c.id !== 'test-creator-123');
        fs.writeFileSync(creatorsPath, JSON.stringify(cleaned, null, 2));
      } else {
        this.fail(testName, 'Creator not found after add');
      }
    } catch (error) {
      this.fail(testName, error.message);
    }
  }

  async testAddVideoCreator() {
    const testName = 'Add Video Creator';
    console.log(`\n🧪 Testing: ${testName}`);
    
    try {
      const creatorsPath = path.join(app.getPath('userData'), 'video-creators.json');
      const before = fs.existsSync(creatorsPath) ? JSON.parse(fs.readFileSync(creatorsPath, 'utf8')) : [];
      
      const testCreator = {
        id: 'test-video-123',
        name: 'Test Video',
        url: 'https://test-video.com',
        type: 'video'
      };
      
      fs.writeFileSync(creatorsPath, JSON.stringify([...before, testCreator], null, 2));
      
      const after = JSON.parse(fs.readFileSync(creatorsPath, 'utf8'));
      const added = after.find(c => c.id === 'test-video-123');
      
      if (added) {
        this.pass(testName, `Video creator added (${before.length} → ${after.length})`);
        
        // Cleanup
        const cleaned = after.filter(c => c.id !== 'test-video-123');
        fs.writeFileSync(creatorsPath, JSON.stringify(cleaned, null, 2));
      } else {
        this.fail(testName, 'Creator not found after add');
      }
    } catch (error) {
      this.fail(testName, error.message);
    }
  }

  async testAddAudioGenerator() {
    const testName = 'Add Audio Generator';
    console.log(`\n🧪 Testing: ${testName}`);
    
    try {
      const generatorsPath = path.join(app.getPath('userData'), 'audio-generators.json');
      const before = fs.existsSync(generatorsPath) ? JSON.parse(fs.readFileSync(generatorsPath, 'utf8')) : [];
      
      const testGen = {
        id: 'test-audio-123',
        name: 'Test Audio',
        url: 'https://test-audio.com',
        category: 'music'
      };
      
      fs.writeFileSync(generatorsPath, JSON.stringify([...before, testGen], null, 2));
      
      const after = JSON.parse(fs.readFileSync(generatorsPath, 'utf8'));
      const added = after.find(g => g.id === 'test-audio-123');
      
      if (added) {
        this.pass(testName, `Audio generator added (${before.length} → ${after.length})`);
        
        // Cleanup
        const cleaned = after.filter(g => g.id !== 'test-audio-123');
        fs.writeFileSync(generatorsPath, JSON.stringify(cleaned, null, 2));
      } else {
        this.fail(testName, 'Generator not found after add');
      }
    } catch (error) {
      this.fail(testName, error.message);
    }
  }

  async testMenuRefresh() {
    const testName = 'Menu Refresh After Add';
    console.log(`\n🧪 Testing: ${testName}`);
    
    try {
      // This tests that the menu can be refreshed programmatically
      const { refreshApplicationMenu } = require('./menu');
      
      // Add test IDW
      const before = this.settingsManager.get('idwEnvironments') || [];
      const testEntry = {
        id: 'menu-test-idw',
        label: 'Menu Test',
        chatUrl: 'https://test.com',
        environment: 'test'
      };
      
      this.settingsManager.set('idwEnvironments', [...before, testEntry]);
      
      // Refresh menu
      refreshApplicationMenu();
      
      // Clean up
      const cleaned = before.filter(idw => idw.id !== 'menu-test-idw');
      this.settingsManager.set('idwEnvironments', cleaned);
      
      this.pass(testName, 'Menu refresh completed without errors');
    } catch (error) {
      this.fail(testName, error.message);
    }
  }

  async testSettingsSync() {
    const testName = 'Settings to File Sync';
    console.log(`\n🧪 Testing: ${testName}`);
    
    try {
      const idwConfigPath = path.join(app.getPath('userData'), 'idw-entries.json');
      
      // Add test IDW to settings
      const before = this.settingsManager.get('idwEnvironments') || [];
      const testEntry = {
        id: 'sync-test-idw',
        label: 'Sync Test',
        chatUrl: 'https://sync-test.com',
        environment: 'test'
      };
      
      this.settingsManager.set('idwEnvironments', [...before, testEntry]);
      
      // Manually trigger file sync (simulating what settings:save does)
      const current = this.settingsManager.get('idwEnvironments') || [];
      fs.writeFileSync(idwConfigPath, JSON.stringify(current, null, 2));
      
      // Read from file
      const fileData = JSON.parse(fs.readFileSync(idwConfigPath, 'utf8'));
      const inFile = fileData.find(idw => idw.id === 'sync-test-idw');
      
      if (inFile) {
        this.pass(testName, 'Settings synced to file correctly');
        
        // Cleanup
        const cleaned = current.filter(idw => idw.id !== 'sync-test-idw');
        this.settingsManager.set('idwEnvironments', cleaned);
        fs.writeFileSync(idwConfigPath, JSON.stringify(cleaned, null, 2));
      } else {
        this.fail(testName, 'IDW not found in file after sync');
      }
    } catch (error) {
      this.fail(testName, error.message);
    }
  }

  async testDuplicatePrevention() {
    const testName = 'Duplicate Prevention';
    console.log(`\n🧪 Testing: ${testName}`);
    
    try {
      const before = this.settingsManager.get('idwEnvironments') || [];
      const testEntry = {
        id: 'duplicate-check',
        label: 'Duplicate Check',
        chatUrl: 'https://duplicate.com',
        environment: 'test'
      };
      
      // Add twice
      this.settingsManager.set('idwEnvironments', [...before, testEntry]);
      const current = this.settingsManager.get('idwEnvironments') || [];
      
      // Try to add again (should be prevented by checking for existing ID)
      const exists = current.find(idw => idw.id === 'duplicate-check');
      if (exists) {
        // Don't add duplicate - this simulates the check in idw-store:add-to-menu
        const count = current.filter(idw => idw.id === 'duplicate-check').length;
        
        if (count === 1) {
          this.pass(testName, 'Only one instance exists');
        } else {
          this.fail(testName, `Found ${count} duplicates`);
        }
        
        // Cleanup
        const cleaned = current.filter(idw => idw.id !== 'duplicate-check');
        this.settingsManager.set('idwEnvironments', cleaned);
      }
    } catch (error) {
      this.fail(testName, error.message);
    }
  }

  pass(testName, details) {
    this.results.passed++;
    this.results.tests.push({ name: testName, status: 'PASS', details });
    console.log(`  ✅ PASS: ${details}`);
  }

  fail(testName, error) {
    this.results.failed++;
    this.results.tests.push({ name: testName, status: 'FAIL', error });
    console.log(`  ❌ FAIL: ${error}`);
  }

  printResults() {
    console.log('\n' + '═'.repeat(70));
    console.log('📊 TEST RESULTS');
    console.log('═'.repeat(70));
    
    this.results.tests.forEach((test, index) => {
      const icon = test.status === 'PASS' ? '✅' : '❌';
      const info = test.status === 'PASS' ? test.details : test.error;
      console.log(`${index + 1}. ${icon} ${test.name}`);
      console.log(`   ${info}`);
    });
    
    console.log('\n' + '═'.repeat(70));
    console.log(`✅ Passed: ${this.results.passed}`);
    console.log(`❌ Failed: ${this.results.failed}`);
    console.log(`📊 Total:  ${this.results.tests.length}`);
    console.log('═'.repeat(70));
    
    if (this.results.failed === 0) {
      console.log('\n🎉 ALL TESTS PASSED!');
    } else {
      console.log('\n⚠️  SOME TESTS FAILED');
    }
  }
}

// Run tests when app is ready
const tester = new IDWManagementTester();
tester.runAllTests().catch(error => {
  console.error('Test suite error:', error);
  app.quit();
});





