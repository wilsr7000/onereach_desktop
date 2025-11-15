/**
 * Mock API Server for Agentic University Lessons
 * 
 * This is a simple Express server that serves the dummy JSON data
 * for testing the dynamic tutorials page.
 * 
 * To run:
 * 1. npm install express cors body-parser
 * 2. node mock-api-server.js
 * 3. Server will run on http://localhost:3001
 */

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Load mock data
let mockData;
try {
  mockData = JSON.parse(fs.readFileSync(path.join(__dirname, 'lessons-api-response.json'), 'utf8'));
} catch (error) {
  console.error('Error loading mock data:', error);
  mockData = { error: 'Failed to load mock data' };
}

// Store for progress updates (in-memory for demo)
const progressStore = {};

// Routes

// Get user lessons
app.get('/api/users/:userId/lessons', (req, res) => {
  const { userId } = req.params;
  const { category, status, limit } = req.query;
  
  console.log(`[API] Fetching lessons for user: ${userId}`);
  console.log(`[API] Query params:`, { category, status, limit });
  
  // Simulate delay
  setTimeout(() => {
    // Customize response based on userId if needed
    const response = { ...mockData };
    
    // Apply filters if provided
    if (category) {
      response.categories = {
        [category]: response.categories[category]
      };
    }
    
    if (status === 'completed') {
      // Filter only completed lessons
      Object.keys(response.categories).forEach(cat => {
        response.categories[cat].lessons = response.categories[cat].lessons.filter(
          lesson => lesson.completed === true
        );
      });
    } else if (status === 'in-progress') {
      // Filter only in-progress lessons
      Object.keys(response.categories).forEach(cat => {
        response.categories[cat].lessons = response.categories[cat].lessons.filter(
          lesson => lesson.inProgress === true
        );
      });
    }
    
    // Add any stored progress updates
    if (progressStore[userId]) {
      Object.keys(response.categories).forEach(cat => {
        response.categories[cat].lessons.forEach(lesson => {
          if (progressStore[userId][lesson.id]) {
            lesson.progress = progressStore[userId][lesson.id];
          }
        });
      });
    }
    
    res.json(response);
  }, 500); // 500ms delay to simulate network
});

// Update lesson progress
app.post('/api/lessons/:lessonId/progress', (req, res) => {
  const { lessonId } = req.params;
  const { userId, progress, currentChapter, bookmarks, notes } = req.body;
  
  console.log(`[API] Updating progress for lesson ${lessonId}, user ${userId}: ${progress}%`);
  
  // Store progress in memory
  if (!progressStore[userId]) {
    progressStore[userId] = {};
  }
  progressStore[userId][lessonId] = progress;
  
  res.json({
    success: true,
    message: 'Progress updated successfully',
    data: {
      lessonId,
      progress,
      estimatedCompletion: progress < 100 ? `${Math.round((100 - progress) / 10)} min` : 'Completed'
    }
  });
});

// Complete lesson
app.post('/api/lessons/:lessonId/complete', (req, res) => {
  const { lessonId } = req.params;
  const { userId, score, completedAt, feedback } = req.body;
  
  console.log(`[API] Marking lesson ${lessonId} as complete for user ${userId}`);
  
  // Store completion
  if (!progressStore[userId]) {
    progressStore[userId] = {};
  }
  progressStore[userId][lessonId] = 100;
  
  res.json({
    success: true,
    message: 'Lesson marked as complete',
    data: {
      lessonId,
      score,
      completedAt: completedAt || new Date().toISOString(),
      achievement: score >= 90 ? 'Excellence Award' : null
    }
  });
});

// Get recommendations
app.get('/api/users/:userId/recommendations', (req, res) => {
  const { userId } = req.params;
  const { limit = 5, basedOn = 'history' } = req.query;
  
  console.log(`[API] Getting recommendations for user ${userId}`);
  
  const recommendations = mockData.recommendations.slice(0, limit).map(lessonId => ({
    lessonId,
    reason: `Based on your ${basedOn}`,
    confidence: Math.random() * 0.3 + 0.7 // Random confidence between 0.7-1.0
  }));
  
  res.json({
    success: true,
    recommendations
  });
});

// Get learning path
app.get('/api/users/:userId/learning-path', (req, res) => {
  const { userId } = req.params;
  
  console.log(`[API] Getting learning path for user ${userId}`);
  
  res.json({
    success: true,
    learningPath: mockData.learningPath
  });
});

// Get current user (for testing)
app.get('/api/users/current', (req, res) => {
  res.json({
    success: true,
    data: mockData.user
  });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: 'The requested endpoint does not exist',
      path: req.path
    }
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An internal server error occurred',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    }
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`
  🚀 Mock API Server is running!
  
  Base URL: http://localhost:${PORT}
  
  Available endpoints:
  - GET  /api/users/:userId/lessons
  - POST /api/lessons/:lessonId/progress
  - POST /api/lessons/:lessonId/complete
  - GET  /api/users/:userId/recommendations
  - GET  /api/users/:userId/learning-path
  - GET  /api/users/current
  - GET  /api/health
  
  Test with:
  curl http://localhost:${PORT}/api/users/user-123456/lessons
  
  To use with the app, update lessons-api.js:
  this.baseUrl = 'http://localhost:${PORT}/api';
  `);
});
