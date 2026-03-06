# Lessons API Documentation

## Overview
This API provides personalized learning content for the Agentic University tutorials system.

## Base URL
```
https://learning.staging.onereach.ai/api
```

## Authentication
Include user authentication token in headers:
```
Authorization: Bearer <token>
```

## Endpoints

### 1. Get User Lessons
Fetch personalized lesson content for a specific user.

**Endpoint:** `GET /users/{userId}/lessons`

**Parameters:**
- `userId` (path parameter): The unique identifier of the user

**Query Parameters (optional):**
- `category`: Filter by specific category (e.g., "workflows", "integrations")
- `status`: Filter by status ("completed", "in-progress", "not-started")
- `limit`: Maximum number of lessons to return per category (default: 50)

**Response:** See `lessons-api-response.json` for complete structure

**Example Request:**
```bash
curl -X GET "https://learning.staging.onereach.ai/api/users/user-123456/lessons" \
  -H "Authorization: Bearer your-token-here"
```

### 2. Update Lesson Progress
Track user progress on a specific lesson.

**Endpoint:** `POST /lessons/{lessonId}/progress`

**Request Body:**
```json
{
  "userId": "user-123456",
  "progress": 75,
  "currentChapter": 3,
  "lastViewedAt": "2024-11-15T10:30:00Z",
  "bookmarks": [180, 420],
  "notes": [
    {
      "timestamp": 180,
      "note": "Important configuration step"
    }
  ]
}
```

**Response:**
```json
{
  "success": true,
  "message": "Progress updated successfully",
  "data": {
    "lessonId": "wf-001",
    "progress": 75,
    "estimatedCompletion": "5 min"
  }
}
```

### 3. Complete Lesson
Mark a lesson as completed.

**Endpoint:** `POST /lessons/{lessonId}/complete`

**Request Body:**
```json
{
  "userId": "user-123456",
  "score": 92,
  "completedAt": "2024-11-15T11:00:00Z",
  "feedback": "Great lesson!"
}
```

### 4. Get Recommendations
Get personalized lesson recommendations.

**Endpoint:** `GET /users/{userId}/recommendations`

**Query Parameters:**
- `limit`: Number of recommendations (default: 5)
- `basedOn`: Recommendation basis ("history", "popular", "ai")

**Response:**
```json
{
  "success": true,
  "recommendations": [
    {
      "lessonId": "wf-002",
      "reason": "Based on your progress in Workflow Fundamentals",
      "confidence": 0.92
    }
  ]
}
```

### 5. Get Learning Path
Get user's learning path and milestones.

**Endpoint:** `GET /users/{userId}/learning-path`

**Response:**
```json
{
  "success": true,
  "learningPath": {
    "id": "path-beginner",
    "name": "Beginner to Pro",
    "progress": 8,
    "totalLessons": 25,
    "currentLesson": "gs-003",
    "nextLesson": "gs-004",
    "estimatedCompletion": "3 weeks"
  }
}
```

## Data Models

### Lesson Object
```typescript
interface Lesson {
  id: string;
  title: string;
  description: string;
  duration: string;
  url: string;
  thumbnail: {
    type: "gradient" | "image";
    colors?: string[];
    imageUrl?: string;
  };
  progress: number;
  difficulty: "beginner" | "intermediate" | "advanced";
  category: string;
  tags: string[];
  // Optional fields
  completed?: boolean;
  inProgress?: boolean;
  new?: boolean;
  recommended?: boolean;
  completedAt?: string;
  startedAt?: string;
  lastViewedAt?: string;
  score?: number;
  instructor?: {
    name: string;
    avatar: string;
  };
  videoUrl?: string;
  prerequisites?: string[];
  relatedLessons?: string[];
}
```

### User Progress Object
```typescript
interface UserProgress {
  completed: number;
  inProgress: number;
  total: number;
  totalMinutes: number;
  completedMinutes: number;
  averageScore: number;
  streak: number;
  badges: string[];
}
```

### Category Object
```typescript
interface Category {
  name: string;
  description: string;
  icon: string;
  color: string;
  totalLessons: number;
  totalDuration: string;
  lessons: Lesson[];
}
```

## Response Codes

| Code | Description |
|------|-------------|
| 200 | Success |
| 201 | Created (progress saved) |
| 400 | Bad Request |
| 401 | Unauthorized |
| 404 | User or Lesson not found |
| 429 | Rate limit exceeded |
| 500 | Internal server error |

## Rate Limiting
- 100 requests per minute per user
- 1000 requests per hour per user

## Caching
- Lesson content is cached for 5 minutes
- User progress is real-time (no caching)
- Recommendations are cached for 15 minutes

## Error Response Format
```json
{
  "success": false,
  "error": {
    "code": "LESSON_NOT_FOUND",
    "message": "The requested lesson does not exist",
    "details": {}
  },
  "timestamp": "2024-11-15T10:00:00Z"
}
```

## Implementation Notes

1. **User Context:** If no userId is provided, the API should attempt to extract it from the authentication token.

2. **Progress Tracking:** Progress should be automatically saved every 30 seconds when a user is watching a video.

3. **Recommendations:** Use machine learning to improve recommendations based on:
   - User's learning history
   - Similar users' patterns
   - Course completion rates
   - Time of day preferences

4. **Performance:** 
   - Use CDN for video and image content
   - Implement pagination for large lesson lists
   - Use database indexing on frequently queried fields

5. **Analytics Events to Track:**
   - Lesson started
   - Lesson completed
   - Progress checkpoints (25%, 50%, 75%)
   - Quiz attempts and scores
   - Time spent per lesson
   - Drop-off points

## Testing

Use the provided `lessons-api-response.json` as mock data for development and testing. The file contains a complete response structure with all possible fields and states.

### Test User IDs
- `user-123456` - Regular user with progress
- `user-new` - New user with no progress
- `user-premium` - Premium subscription user
- `user-test` - Test user for development

## Webhook Events

The API can send webhooks for the following events:
- `lesson.started`
- `lesson.completed`
- `milestone.reached`
- `streak.achieved`
- `path.completed`

Configure webhook URL in user settings or application configuration.
