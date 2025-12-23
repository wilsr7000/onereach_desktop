/**
 * Metadata Generation API Integration Tests
 * 
 * Actually calls Claude and GPT-5.2 APIs to generate metadata for sample files.
 * Tests model routing, schema validation, and response quality.
 * 
 * Run with: npm run test:metadata-api
 * 
 * Requirements:
 * - CLAUDE_API_KEY environment variable (for vision tasks)
 * - OPENAI_API_KEY environment variable (for text tasks with GPT-5.2)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// ============================================
// Configuration
// ============================================

const CONFIG = {
  claudeApiKey: process.env.CLAUDE_API_KEY || '',
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  claudeModel: 'claude-sonnet-4-20250514',
  openaiModel: 'gpt-5.2',
  timeout: 60000, // 60 seconds per API call
  verbose: true
};

// Colors for terminal output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  bold: '\x1b[1m'
};

// Test results
const results = {
  passed: 0,
  failed: 0,
  skipped: 0,
  tests: [],
  apiCalls: {
    claude: 0,
    openai: 0
  },
  totalTokens: 0
};

// ============================================
// Logging Utilities
// ============================================

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logSection(title) {
  log(`\n${'═'.repeat(60)}`, 'blue');
  log(`  ${title}`, 'blue');
  log('═'.repeat(60), 'blue');
}

function logTest(name, passed, details = '', model = '') {
  const status = passed ? '✓' : '✗';
  const color = passed ? 'green' : 'red';
  const modelInfo = model ? ` [${model}]` : '';
  log(`  ${status} ${name}${modelInfo}${details ? ` - ${details}` : ''}`, color);
  
  results.tests.push({ name, passed, details, model });
  if (passed) results.passed++;
  else results.failed++;
}

function logSkipped(name, reason) {
  log(`  ○ ${name} - SKIPPED: ${reason}`, 'yellow');
  results.skipped++;
}

// ============================================
// Sample Test Data
// ============================================

const testSamples = {
  // ============================================
  // VISION TESTS (Claude Sonnet 4)
  // ============================================
  
  // Screenshot/Image test - FULL SCHEMA
  screenshot: {
    type: 'image',
    expectedModel: 'claude-sonnet-4',
    isVision: true,
    fileName: 'enterprise-architecture.png',
    // Will load from OR-Spaces
    imagePath: '/Users/richardwilson/Documents/OR-Spaces/items/9c5d01ff77d510a4f8b3829456756de1/thumbnail.png',
    // Full image schema validation
    expectedFields: [
      'title',           // Clear, descriptive title
      'description',     // What's in the image
      'tags',            // Searchable tags
      'category',        // screenshot|photo|diagram|design|chart|document|ui-mockup|other
      'extracted_text',  // Any readable text in the image
      'app_detected',    // Specific app name if identifiable
      'source'           // Application or platform shown
    ],
    optionalFields: ['notes', 'instructions', 'ai_detected', 'visible_urls']
  },
  
  // YouTube video with transcript - FULL SCHEMA
  youtubeVideo: {
    type: 'video',
    expectedModel: 'gpt-5.2',
    fileName: 'tech-interview.mp4',
    duration: '12:45',
    transcript: `Welcome to this interview about the future of AI in enterprise software.

[Interviewer]: Today we're speaking with the CTO of a major tech company. Can you tell us about how AI is changing enterprise software?

[CTO]: Absolutely. We're seeing a fundamental shift in how businesses approach automation. Traditional rule-based systems are being replaced by intelligent agents that can understand context and make decisions.

[Interviewer]: What are the biggest challenges companies face when adopting AI?

[CTO]: The main challenges are data quality, integration with legacy systems, and building trust with end users. You can't just drop AI into an existing workflow - you need to redesign processes around the AI's capabilities.

[Interviewer]: Where do you see enterprise AI in five years?

[CTO]: I think we'll see AI assistants that truly understand business context. They'll be able to handle complex multi-step tasks, coordinate across systems, and even anticipate what users need before they ask.

[Interviewer]: Thank you for your insights.

[CTO]: My pleasure. Exciting times ahead.`,
    // Full video schema validation
    expectedFields: [
      'title',           // Clear video title
      'description',     // What the video is about
      'category',        // tutorial|interview|presentation|screen-recording|entertainment|educational|documentary|demo|other
      'topics',          // Main topics covered
      'speakers',        // Speaker names
      'keyPoints',       // Bullet point summaries
      'tags',            // Searchable tags
      'targetAudience'   // Who this is for
    ],
    optionalFields: ['shortDescription', 'longDescription', 'notes']
  },
  
  // ============================================
  // TEXT TESTS (GPT-5.2)
  // ============================================
  
  // Small text for code analysis (GPT-5.2) - FULL SCHEMA
  codeSmall: {
    type: 'code',
    expectedModel: 'gpt-5.2',
    fileName: 'useAuth.ts',
    fileExt: '.ts',
    content: `import { useState, useEffect } from 'react';
import { authService } from '../services/auth';

export function useAuth() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  
  const login = async (email, password) => {
    const result = await authService.login(email, password);
    setUser(result.user);
    return result;
  };
  
  useEffect(() => {
    authService.getCurrentUser().then(setUser).finally(() => setLoading(false));
  }, []);
  
  return { user, loading, login };
}`,
    // Full code schema validation
    expectedFields: [
      'title',           // What this code does
      'description',     // Purpose description
      'language',        // Programming language
      'purpose',         // Main purpose or use case
      'functions',       // Main functions or classes
      'dependencies',    // Libraries/frameworks used
      'tags',            // Technical tags
      'complexity'       // simple|moderate|complex
    ],
    optionalFields: ['notes']
  },
  
  // Large code file (GPT-5.2 - benefits from 256K context) - FULL SCHEMA
  codeLarge: {
    type: 'code',
    expectedModel: 'gpt-5.2',
    fileName: 'api-service.ts',
    fileExt: '.ts',
    content: generateLargeCodeSample(),
    expectedFields: [
      'title',
      'description',
      'language',
      'purpose',
      'functions',
      'dependencies',
      'tags',
      'complexity'
    ],
    optionalFields: ['notes']
  },
  
  // JSON data file (GPT-5.2) - FULL SCHEMA
  jsonData: {
    type: 'data',
    expectedModel: 'gpt-5.2',
    fileName: 'users.json',
    fileExt: '.json',
    content: JSON.stringify({
      users: [
        { id: 1, name: 'John Doe', email: 'john@example.com', role: 'admin', createdAt: '2024-01-01' },
        { id: 2, name: 'Jane Smith', email: 'jane@example.com', role: 'user', createdAt: '2024-01-15' },
        { id: 3, name: 'Bob Wilson', email: 'bob@example.com', role: 'moderator', createdAt: '2024-02-01' }
      ],
      pagination: { page: 1, perPage: 10, total: 100 },
      metadata: { exportedAt: '2024-12-01', version: '2.0' }
    }, null, 2),
    // Full data schema validation
    expectedFields: [
      'title',           // What this data represents
      'description',     // Description of contents
      'dataType',        // config|dataset|api-response|export|schema|log|other
      'format',          // JSON|CSV|YAML|XML|other
      'entities',        // Main entities in the data
      'keyFields',       // Important fields
      'tags'             // Searchable tags
    ],
    optionalFields: ['purpose', 'notes']
  },
  
  // Meeting notes (GPT-5.2) - FULL SCHEMA
  textNotes: {
    type: 'text',
    expectedModel: 'gpt-5.2',
    content: `Project Kickoff Meeting Notes
Date: December 10, 2024
Attendees: Sarah Chen (PM), Mike Johnson (Tech Lead), Lisa Park (Designer)

AGENDA:
1. Project Overview
2. Timeline Discussion
3. Resource Allocation
4. Risk Assessment

KEY DECISIONS:
- Launch date: March 15, 2025
- Budget approved: $250,000
- Team size: 5 developers + 2 designers

ACTION ITEMS:
[ ] Sarah: Create project timeline by Friday
[ ] Mike: Set up development environment
[ ] Lisa: Complete initial wireframes by next Monday

RISKS IDENTIFIED:
- Third-party API integration timeline uncertain
- Designer availability during February

NEXT MEETING: December 17, 2024 at 2pm`,
    // Full text schema validation
    expectedFields: [
      'title',           // Descriptive title
      'description',     // What the text is about
      'contentType',     // notes|article|documentation|message|list|meeting-notes|transcript|interview|other
      'topics',          // Main topics
      'keyPoints',       // Important points
      'actionItems',     // Any todos
      'tags'             // Searchable tags
    ],
    optionalFields: ['notes']
  },
  
  // URL (GPT-5.2) - FULL SCHEMA
  url: {
    type: 'url',
    expectedModel: 'gpt-5.2',
    content: 'https://react.dev/reference/react/hooks',
    pageTitle: 'Built-in React Hooks',
    pageDescription: 'React hooks let you use state and other React features in your components.',
    // Full URL schema validation
    expectedFields: [
      'title',           // Clear title for this link
      'description',     // What this link is about
      'urlType',         // article|documentation|tool|repository|video|social-media|resource|other
      'platform',        // Website or platform name
      'topics',          // Relevant topics
      'category',        // Domain category
      'tags'             // Searchable tags
    ],
    optionalFields: ['purpose', 'notes']
  },
  
  // HTML document (GPT-5.2) - FULL SCHEMA
  html: {
    type: 'html',
    expectedModel: 'gpt-5.2',
    content: `<h1>Product Requirements Document</h1>
<h2>User Authentication Feature</h2>
<p>Version 1.0 | Last Updated: December 2024</p>

<h3>Overview</h3>
<p>This document outlines the requirements for implementing secure user authentication in the OneReach.ai desktop application.</p>

<h3>Requirements</h3>
<ul>
  <li>OAuth 2.0 support (Google, GitHub, Microsoft)</li>
  <li>Two-factor authentication via TOTP</li>
  <li>Session management with automatic timeout</li>
  <li>Password requirements: min 12 chars, mixed case, numbers, symbols</li>
</ul>

<h3>Security Considerations</h3>
<p>All tokens must be stored securely using the system keychain. Session tokens expire after 24 hours of inactivity.</p>`,
    // Full HTML schema validation
    expectedFields: [
      'title',           // Document title
      'description',     // What document covers
      'documentType',    // article|report|webpage|documentation|presentation|email|other
      'topics',          // Main topics
      'keyPoints',       // Important points
      'tags'             // Searchable tags
    ],
    optionalFields: ['author', 'source', 'notes']
  },
  
  // Audio with transcript (GPT-5.2 for long transcripts) - FULL SCHEMA
  audio: {
    type: 'audio',
    expectedModel: 'gpt-5.2',
    fileName: 'podcast-episode-42.mp3',
    duration: '45:30',
    transcript: `Welcome to the AI Frontiers podcast. Today we're discussing the latest developments in language models and their applications in enterprise software.

Our guest today is Dr. Sarah Chen, who leads the AI research team at TechCorp. Sarah, can you tell us about your recent work?

[Sarah]: Thanks for having me. We've been focusing on making AI more accessible to non-technical users. The key insight is that natural language interfaces need to be not just accurate, but also predictable and trustworthy.

[Host]: That's fascinating. How do you measure trustworthiness in AI systems?

[Sarah]: Great question. We use a combination of metrics including consistency scoring, uncertainty quantification, and user feedback loops. The goal is to give users confidence in what the AI can and cannot do.

[The discussion continues about AI safety, enterprise adoption, and future trends...]`,
    // Full audio schema validation
    expectedFields: [
      'title',           // Audio title
      'description',     // What the audio is about
      'audioType',       // podcast|music|voice-memo|audiobook|interview|lecture|recording|other
      'topics',          // Main topics
      'speakers',        // Speaker names
      'keyPoints',       // Important points discussed
      'tags'             // Searchable tags
    ],
    optionalFields: ['genre', 'notes']
  }
};

// Generate a large code sample for testing context handling
function generateLargeCodeSample() {
  const functions = [];
  for (let i = 1; i <= 20; i++) {
    functions.push(`
/**
 * Process data batch ${i}
 * @param data - Input data array
 * @returns Processed results
 */
async function processBatch${i}(data: DataItem[]): Promise<ProcessedResult[]> {
  const results: ProcessedResult[] = [];
  
  for (const item of data) {
    try {
      const validated = await validateItem(item);
      const transformed = transformData(validated);
      const enriched = await enrichWithMetadata(transformed);
      results.push(enriched);
    } catch (error) {
      logger.error(\`Error processing item \${item.id}:\`, error);
      results.push({ ...item, error: error.message, status: 'failed' });
    }
  }
  
  return results;
}
`);
  }
  
  return `// API Service - Data Processing Module
// Generated for testing large context handling

import { DataItem, ProcessedResult, Config } from './types';
import { logger } from './logger';

interface ProcessingConfig {
  batchSize: number;
  retryCount: number;
  timeout: number;
}

const defaultConfig: ProcessingConfig = {
  batchSize: 100,
  retryCount: 3,
  timeout: 30000
};

${functions.join('\n')}

// Main export
export class DataProcessor {
  private config: ProcessingConfig;
  
  constructor(config: Partial<ProcessingConfig> = {}) {
    this.config = { ...defaultConfig, ...config };
  }
  
  async processAll(data: DataItem[]): Promise<ProcessedResult[]> {
    const batches = this.chunkArray(data, this.config.batchSize);
    const allResults: ProcessedResult[] = [];
    
    for (const batch of batches) {
      const results = await processBatch1(batch);
      allResults.push(...results);
    }
    
    return allResults;
  }
  
  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }
}
`;
}

// ============================================
// API Clients
// ============================================

/**
 * Call Claude API (for vision tasks)
 */
async function callClaude(content, apiKey, isVision = false, imageData = null) {
  return new Promise((resolve, reject) => {
    let messageContent;
    
    if (isVision && imageData) {
      messageContent = [
        { type: 'text', text: content },
        { 
          type: 'image', 
          source: { 
            type: 'base64', 
            media_type: 'image/png', 
            data: imageData 
          } 
        }
      ];
    } else {
      messageContent = content;
    }
    
    const postData = JSON.stringify({
      model: CONFIG.claudeModel,
      max_tokens: 2048,
      messages: [{ role: 'user', content: messageContent }]
    });

    const options = {
      hostname: 'api.anthropic.com',
      port: 443,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          if (res.statusCode !== 200) {
            reject(new Error(response.error?.message || `Claude API error: ${res.statusCode}`));
            return;
          }
          results.apiCalls.claude++;
          resolve(response);
        } catch (e) {
          reject(new Error('Failed to parse Claude response'));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(CONFIG.timeout, () => {
      req.destroy();
      reject(new Error('Claude API timeout'));
    });
    
    req.write(postData);
    req.end();
  });
}

/**
 * Call OpenAI API (GPT-5.2 for text tasks)
 */
async function callOpenAI(prompt, apiKey) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      model: CONFIG.openaiModel,
      messages: [
        { role: 'system', content: 'You are a metadata generator. Always respond with valid JSON only.' },
        { role: 'user', content: prompt }
      ],
      max_completion_tokens: 2048, // GPT-5.2 uses max_completion_tokens
      temperature: 0.3,
      response_format: { type: 'json_object' }
    });

    const options = {
      hostname: 'api.openai.com',
      port: 443,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          if (res.statusCode !== 200) {
            reject(new Error(response.error?.message || `OpenAI API error: ${res.statusCode}`));
            return;
          }
          results.apiCalls.openai++;
          if (response.usage) {
            results.totalTokens += response.usage.total_tokens;
          }
          resolve(response);
        } catch (e) {
          reject(new Error('Failed to parse OpenAI response'));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(CONFIG.timeout, () => {
      req.destroy();
      reject(new Error('OpenAI API timeout'));
    });
    
    req.write(postData);
    req.end();
  });
}

// ============================================
// Test Functions
// ============================================

/**
 * Build prompt for metadata generation
 */
function buildPrompt(sample) {
  const prompts = {
    code: `Analyze this code file and generate metadata.

FILE: ${sample.fileName || 'code'}
EXTENSION: ${sample.fileExt || ''}

CODE:
\`\`\`
${sample.content}
\`\`\`

Respond with JSON: { "title": "", "description": "", "language": "", "purpose": "", "functions": [], "dependencies": [], "complexity": "", "tags": [], "notes": "" }`,

    data: `Analyze this data file and generate metadata.

FILE: ${sample.fileName || 'data'}
FORMAT: ${sample.fileExt || ''}

DATA:
${sample.content}

Respond with JSON: { "title": "", "description": "", "dataType": "", "format": "", "entities": [], "keyFields": [], "purpose": "", "tags": [], "notes": "" }`,

    text: `Analyze this text and generate metadata.

CONTENT:
${sample.content}

Respond with JSON: { "title": "", "description": "", "contentType": "", "topics": [], "keyPoints": [], "actionItems": [], "tags": [], "notes": "" }`,

    url: `Analyze this URL and generate metadata.

URL: ${sample.content}
${sample.pageTitle ? `TITLE: ${sample.pageTitle}` : ''}
${sample.pageDescription ? `DESCRIPTION: ${sample.pageDescription}` : ''}

Respond with JSON: { "title": "", "description": "", "urlType": "", "platform": "", "topics": [], "category": "", "tags": [], "notes": "" }`,

    html: `Analyze this HTML document and generate metadata.

CONTENT:
${sample.content}

Respond with JSON: { "title": "", "description": "", "documentType": "", "topics": [], "keyPoints": [], "author": "", "tags": [], "notes": "" }`,

    audio: `Analyze this audio file information and generate metadata.

FILE: ${sample.fileName || 'audio'}
DURATION: ${sample.duration || 'Unknown'}

TRANSCRIPT:
${sample.transcript || 'No transcript available'}

Respond with JSON: { "title": "", "description": "", "audioType": "", "topics": [], "speakers": [], "keyPoints": [], "tags": [], "notes": "" }`,

    video: `Analyze this video file with transcript and generate detailed metadata.

FILE: ${sample.fileName || 'video'}
DURATION: ${sample.duration || 'Unknown'}

TRANSCRIPT:
${sample.transcript || 'No transcript available'}

Analyze the content thoroughly. Identify speakers, main topics, and key points discussed.

Respond with JSON: { "title": "", "description": "", "category": "interview|tutorial|presentation|documentary|other", "topics": [], "speakers": [], "keyPoints": [], "targetAudience": "", "tags": [], "notes": "" }`
  };

  return prompts[sample.type] || prompts.text;
}

/**
 * Validate metadata has expected fields
 */
function validateMetadata(metadata, expectedFields) {
  const missing = expectedFields.filter(field => !(field in metadata));
  const present = expectedFields.filter(field => field in metadata);
  
  return {
    valid: missing.length === 0,
    missing,
    present,
    hasTitle: !!metadata.title,
    hasTags: Array.isArray(metadata.tags) && metadata.tags.length > 0
  };
}

/**
 * Run test for a sample
 */
async function runTest(name, sample) {
  const startTime = Date.now();
  
  try {
    // Determine which API to use based on whether vision is needed
    const isVisionTest = sample.isVision || sample.type === 'image';
    const useOpenAI = !isVisionTest && ['code', 'text', 'data', 'html', 'url', 'audio', 'video'].includes(sample.type);
    const apiKey = useOpenAI ? CONFIG.openaiApiKey : CONFIG.claudeApiKey;
    const modelUsed = useOpenAI ? 'gpt-5.2' : 'claude-sonnet-4';
    
    if (!apiKey) {
      logSkipped(name, `${useOpenAI ? 'OpenAI' : 'Claude'} API key not set`);
      return;
    }
    
    // Call API
    log(`  → Testing ${name} with ${modelUsed}...`, 'dim');
    
    let response;
    
    if (isVisionTest) {
      // Vision test with Claude
      let imageData = null;
      if (sample.imagePath && fs.existsSync(sample.imagePath)) {
        const imageBuffer = fs.readFileSync(sample.imagePath);
        imageData = imageBuffer.toString('base64');
      }
      
      if (!imageData) {
        logSkipped(name, 'Image file not found');
        return;
      }
      
      const prompt = `Analyze this image and generate metadata for a knowledge management system.

Describe what you see in detail. Generate JSON with ALL these required fields:
{
  "title": "Clear descriptive title (3-8 words)",
  "description": "2-3 sentence description of what's in the image",
  "category": "screenshot|photo|diagram|design|chart|document|ui-mockup|other",
  "extracted_text": "Any visible text, labels, headings in the image",
  "app_detected": "Application name if identifiable (e.g., Chrome, VS Code, Figma)",
  "source": "Platform or application shown (website domain, app name, tool)",
  "tags": ["relevant", "searchable", "tags"]
}

IMPORTANT: Include ALL fields above. For extracted_text, include key visible text. For source, identify the platform/tool shown.

Respond with valid JSON only.`;

      response = await callClaude(prompt, apiKey, true, imageData);
      const text = response.content[0]?.text;
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      response.metadata = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
      
    } else if (useOpenAI) {
      // Text test with GPT-5.2
      const prompt = buildPrompt(sample);
      response = await callOpenAI(prompt, apiKey);
      const content = response.choices[0]?.message?.content;
      response.metadata = JSON.parse(content);
    } else {
      // Fallback to Claude for other types
      const prompt = buildPrompt(sample);
      response = await callClaude(prompt, apiKey);
      const text = response.content[0]?.text;
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      response.metadata = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
    }
    
    // Validate
    const validation = validateMetadata(response.metadata, sample.expectedFields);
    const duration = Date.now() - startTime;
    
    // Report results
    if (validation.valid) {
      logTest(name, true, `${duration}ms`, modelUsed);
      
      if (CONFIG.verbose) {
        log(`    Title: "${response.metadata.title}"`, 'dim');
        if (response.metadata.tags) {
          log(`    Tags: [${response.metadata.tags.slice(0, 5).join(', ')}${response.metadata.tags.length > 5 ? '...' : ''}]`, 'dim');
        }
        if (response.metadata.speakers) {
          log(`    Speakers: [${response.metadata.speakers.join(', ')}]`, 'dim');
        }
      }
    } else {
      logTest(name, false, `Missing: ${validation.missing.join(', ')}`, modelUsed);
    }
    
  } catch (error) {
    logTest(name, false, error.message, '');
  }
}

// ============================================
// Main Test Runner
// ============================================

async function runAllTests() {
  log('\n', 'reset');
  log('╔══════════════════════════════════════════════════════════╗', 'cyan');
  log('║     Metadata Generation API Integration Tests            ║', 'cyan');
  log('║     Testing Claude (vision) + GPT-5.2 (text)             ║', 'cyan');
  log('╚══════════════════════════════════════════════════════════╝', 'cyan');
  
  // Check API keys
  logSection('API Key Check');
  
  if (CONFIG.claudeApiKey) {
    log('  ✓ Claude API key configured', 'green');
  } else {
    log('  ✗ Claude API key missing (set CLAUDE_API_KEY)', 'yellow');
  }
  
  if (CONFIG.openaiApiKey) {
    log('  ✓ OpenAI API key configured', 'green');
  } else {
    log('  ✗ OpenAI API key missing (set OPENAI_API_KEY)', 'yellow');
  }
  
  if (!CONFIG.claudeApiKey && !CONFIG.openaiApiKey) {
    log('\n  No API keys configured. Set environment variables:', 'red');
    log('  export CLAUDE_API_KEY=your-claude-key', 'dim');
    log('  export OPENAI_API_KEY=your-openai-key', 'dim');
    return false;
  }
  
  // Run Vision Tests (Claude)
  logSection('Claude Vision Tests (Images)');
  
  const visionTests = [
    ['Screenshot Analysis', testSamples.screenshot]
  ];
  
  for (const [name, sample] of visionTests) {
    await runTest(name, sample);
    await new Promise(r => setTimeout(r, 500));
  }
  
  // Run Video Tests (GPT-5.2 with transcript)
  logSection('Video Analysis Tests (with Transcript)');
  
  const videoTests = [
    ['YouTube Video with Transcript', testSamples.youtubeVideo]
  ];
  
  for (const [name, sample] of videoTests) {
    await runTest(name, sample);
    await new Promise(r => setTimeout(r, 500));
  }
  
  // Run Text Tests (GPT-5.2)
  logSection('GPT-5.2 Text Analysis Tests');
  
  const textTests = [
    ['Code (small)', testSamples.codeSmall],
    ['JSON Data', testSamples.jsonData],
    ['Meeting Notes', testSamples.textNotes],
    ['URL Analysis', testSamples.url],
    ['HTML Document', testSamples.html],
    ['Audio with Transcript', testSamples.audio]
  ];
  
  for (const [name, sample] of textTests) {
    await runTest(name, sample);
    // Small delay between API calls
    await new Promise(r => setTimeout(r, 500));
  }
  
  // Summary
  logSection('Test Summary');
  
  const total = results.passed + results.failed;
  log(`  Total tests: ${total}`, 'dim');
  log(`  ✓ Passed: ${results.passed}`, 'green');
  log(`  ✗ Failed: ${results.failed}`, results.failed > 0 ? 'red' : 'dim');
  log(`  ○ Skipped: ${results.skipped}`, 'yellow');
  log('', 'reset');
  log(`  API Calls:`, 'dim');
  log(`    Claude: ${results.apiCalls.claude}`, 'dim');
  log(`    OpenAI (GPT-5.2): ${results.apiCalls.openai}`, 'dim');
  if (results.totalTokens > 0) {
    log(`    Total tokens: ${results.totalTokens.toLocaleString()}`, 'dim');
  }
  log('', 'reset');
  
  const allPassed = results.failed === 0 && results.passed > 0;
  log(allPassed ? '✓ All tests passed!' : '✗ Some tests failed or were skipped', allPassed ? 'green' : 'yellow');
  
  return allPassed;
}

// Run tests
runAllTests().then(success => {
  process.exit(success ? 0 : 1);
}).catch(error => {
  console.error('Test runner error:', error);
  process.exit(1);
});






































