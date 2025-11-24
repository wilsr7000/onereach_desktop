/**
 * Node.js API/Backend Project Template
 */

import { ProjectTemplate } from '../types';

export const nodeApiTemplate: ProjectTemplate = {
  id: 'node-api',
  name: 'Node.js API',
  description: 'RESTful API with Express/Fastify, TypeScript, and best practices',
  icon: '🟢',
  category: 'backend',
  tags: ['node', 'typescript', 'api', 'rest', 'express', 'backend'],
  version: '1.0.0',
  builtIn: true,

  // ─────────────────────────────────────────────────────────────
  // AI Behavior
  // ─────────────────────────────────────────────────────────────
  
  systemPrompt: `You are an expert Node.js backend developer. Follow these conventions:

## Architecture
- Use layered architecture: Routes → Controllers → Services → Repositories
- Keep business logic in services, not controllers
- Use dependency injection where appropriate
- Follow SOLID principles

## Code Style
- Use TypeScript with strict mode
- Async/await over callbacks or raw promises
- Use proper error handling with custom error classes
- Validate all inputs at the boundary (controllers)

## API Design
- Follow REST conventions (proper HTTP methods and status codes)
- Use consistent response format: { data, error, meta }
- Version APIs (/api/v1/...)
- Use plural nouns for resources (/users, not /user)
- Implement proper pagination for list endpoints

## Security
- Never trust user input - validate and sanitize everything
- Use parameterized queries (never string concatenation for SQL)
- Implement rate limiting
- Use helmet for security headers
- Store secrets in environment variables
- Hash passwords with bcrypt (cost factor 12+)

## Error Handling
- Create custom error classes (NotFoundError, ValidationError, etc.)
- Use centralized error handling middleware
- Log errors with context (request ID, user ID)
- Never expose stack traces in production

## Database
- Use migrations for schema changes
- Use transactions for multi-step operations
- Index frequently queried columns
- Use connection pooling

## Testing
- Unit test services with mocked dependencies
- Integration test API endpoints
- Use factories for test data
- Test error cases, not just happy paths`,

  model: 'gpt-4',

  // ─────────────────────────────────────────────────────────────
  // Context Management
  // ─────────────────────────────────────────────────────────────
  
  autoIncludePatterns: [
    'src/app.ts',
    'src/index.ts',
    'src/server.ts',
    'src/routes/index.ts',
    'src/types/**/*.ts',
    'src/config/**/*.ts',
    'package.json',
    'tsconfig.json',
    '.env.example',
  ],
  
  ignorePatterns: [
    'node_modules/**',
    'dist/**',
    'build/**',
    '.git/**',
    'coverage/**',
    '*.log',
    '.env',
    '.env.local',
    '*.lock',
    'package-lock.json',
  ],
  
  primaryExtensions: ['.ts', '.json', '.sql'],
  maxAutoIncludeFiles: 10,

  // ─────────────────────────────────────────────────────────────
  // Quality Gates
  // ─────────────────────────────────────────────────────────────
  
  testCommand: 'npm test',
  lintCommand: 'npm run lint',
  typeCheckCommand: 'npx tsc --noEmit',
  autoLint: true,
  autoTest: false,

  // ─────────────────────────────────────────────────────────────
  // Custom Commands
  // ─────────────────────────────────────────────────────────────
  
  commands: [
    {
      name: 'endpoint',
      description: 'Generate a new API endpoint with full CRUD',
      prompt: `Create a complete CRUD API for {{resource}} resource:

1. Route file: src/routes/{{resource}}.routes.ts
   - GET /{{resource}}s (list with pagination)
   - GET /{{resource}}s/:id (get one)
   - POST /{{resource}}s (create)
   - PUT /{{resource}}s/:id (update)
   - DELETE /{{resource}}s/:id (delete)

2. Controller: src/controllers/{{resource}}.controller.ts
   - Input validation
   - Proper HTTP status codes
   - Error handling

3. Service: src/services/{{resource}}.service.ts
   - Business logic
   - Database operations

4. Types: src/types/{{resource}}.types.ts
   - Request/Response interfaces
   - Entity interface

5. Validation: src/validators/{{resource}}.validator.ts
   - Zod or Joi schemas

Resource fields: {{fields}}

{{#if withAuth}}
Protect all routes except GET with authentication middleware.
{{/if}}`,
      requiredInputs: [
        {
          name: 'resource',
          description: 'Resource name (singular, lowercase)',
          type: 'string',
          placeholder: 'user',
          validation: '^[a-z][a-z0-9]*$',
        },
        {
          name: 'fields',
          description: 'Resource fields (comma-separated)',
          type: 'string',
          placeholder: 'name:string, email:string, age:number',
        },
      ],
      optionalInputs: [
        {
          name: 'withAuth',
          description: 'Add authentication middleware',
          type: 'boolean',
          defaultValue: true,
        },
      ],
      example: '/endpoint user "name:string, email:string, role:string"',
    },
    {
      name: 'middleware',
      description: 'Generate Express/Fastify middleware',
      prompt: `Create middleware called {{name}} in src/middleware/{{name}}.middleware.ts

The middleware should:
- Have proper TypeScript types
- Handle errors appropriately
- Include JSDoc documentation

Purpose: {{description}}

{{#if async}}
This is an async middleware that needs to await operations.
{{/if}}`,
      requiredInputs: [
        {
          name: 'name',
          description: 'Middleware name (camelCase)',
          type: 'string',
          placeholder: 'authenticate',
        },
        {
          name: 'description',
          description: 'What does this middleware do?',
          type: 'string',
          placeholder: 'Validates JWT token and attaches user to request',
        },
      ],
      optionalInputs: [
        {
          name: 'async',
          description: 'Is this async middleware?',
          type: 'boolean',
          defaultValue: true,
        },
      ],
      example: '/middleware rateLimit "Limits requests per IP"',
    },
    {
      name: 'service',
      description: 'Generate a service class',
      prompt: `Create a service class {{name}}Service in src/services/{{name}}.service.ts

The service should:
- Be a class with dependency injection
- Have proper TypeScript interfaces
- Include error handling
- Be unit testable

Purpose: {{description}}

Methods needed: {{methods}}`,
      requiredInputs: [
        {
          name: 'name',
          description: 'Service name (PascalCase)',
          type: 'string',
          placeholder: 'Email',
        },
        {
          name: 'description',
          description: 'What does this service do?',
          type: 'string',
          placeholder: 'Handles sending emails via SMTP',
        },
        {
          name: 'methods',
          description: 'Methods to include',
          type: 'string',
          placeholder: 'sendWelcome, sendPasswordReset, sendNotification',
        },
      ],
      example: '/service Email "Sends transactional emails"',
    },
    {
      name: 'migration',
      description: 'Generate a database migration',
      prompt: `Create a database migration for: {{description}}

File: src/migrations/{{timestamp}}_{{name}}.ts

Include:
- Up migration (apply changes)
- Down migration (rollback changes)
- Proper SQL with parameterized queries
- Index creation if needed

Changes: {{changes}}`,
      requiredInputs: [
        {
          name: 'name',
          description: 'Migration name (snake_case)',
          type: 'string',
          placeholder: 'add_users_table',
        },
        {
          name: 'description',
          description: 'What does this migration do?',
          type: 'string',
          placeholder: 'Creates users table with auth fields',
        },
        {
          name: 'changes',
          description: 'Describe the schema changes',
          type: 'string',
          placeholder: 'Add email, password_hash, created_at columns',
        },
      ],
      example: '/migration add_users_table "Creates users table"',
    },
    {
      name: 'test-api',
      description: 'Generate API integration tests',
      prompt: `Create integration tests for the {{endpoint}} endpoint.

File: src/__tests__/{{endpoint}}.test.ts

Include:
- Tests for all HTTP methods
- Authentication tests (if protected)
- Validation error tests
- Edge cases
- Use supertest for HTTP assertions
- Use factories for test data
- Clean up test data after each test`,
      requiredInputs: [
        {
          name: 'endpoint',
          description: 'Endpoint to test',
          type: 'string',
          placeholder: '/api/v1/users',
        },
      ],
      example: '/test-api /api/v1/users',
    },
    {
      name: 'error',
      description: 'Generate a custom error class',
      prompt: `Create a custom error class {{name}}Error in src/errors/{{name}}.error.ts

The error should:
- Extend a base AppError class
- Have a specific HTTP status code
- Include error code for client handling
- Be serializable to JSON

HTTP Status: {{status}}
Use case: {{description}}`,
      requiredInputs: [
        {
          name: 'name',
          description: 'Error name (PascalCase)',
          type: 'string',
          placeholder: 'NotFound',
        },
        {
          name: 'status',
          description: 'HTTP status code',
          type: 'selection',
          options: [
            { label: '400 Bad Request', value: '400' },
            { label: '401 Unauthorized', value: '401' },
            { label: '403 Forbidden', value: '403' },
            { label: '404 Not Found', value: '404' },
            { label: '409 Conflict', value: '409' },
            { label: '422 Unprocessable Entity', value: '422' },
            { label: '500 Internal Server Error', value: '500' },
          ],
        },
        {
          name: 'description',
          description: 'When is this error thrown?',
          type: 'string',
          placeholder: 'When a requested resource does not exist',
        },
      ],
      example: '/error NotFound 404 "Resource not found"',
    },
  ],

  // ─────────────────────────────────────────────────────────────
  // Scaffolding
  // ─────────────────────────────────────────────────────────────
  
  scaffold: {
    directories: [
      'src/routes',
      'src/controllers',
      'src/services',
      'src/middleware',
      'src/types',
      'src/config',
      'src/errors',
      'src/utils',
      'src/validators',
      'src/__tests__',
      'src/migrations',
    ],
    
    files: [
      {
        path: 'src/app.ts',
        content: `import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { errorHandler } from './middleware/errorHandler';
import { requestLogger } from './middleware/requestLogger';
import routes from './routes';

const app = express();

// Security middleware
app.use(helmet());
app.use(cors());

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Logging
app.use(requestLogger);

// Routes
app.use('/api/v1', routes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handling (must be last)
app.use(errorHandler);

export default app;
`,
      },
      {
        path: 'src/index.ts',
        content: `import app from './app';
import { config } from './config';

const PORT = config.port || 3000;

app.listen(PORT, () => {
  console.log(\`🚀 Server running on port \${PORT}\`);
  console.log(\`📝 API docs: http://localhost:\${PORT}/api/v1/docs\`);
});
`,
      },
      {
        path: 'src/config/index.ts',
        content: `export const config = {
  port: process.env.PORT || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  database: {
    url: process.env.DATABASE_URL,
  },
  jwt: {
    secret: process.env.JWT_SECRET || 'change-me-in-production',
    expiresIn: '7d',
  },
};
`,
      },
      {
        path: 'src/routes/index.ts',
        content: `import { Router } from 'express';

const router = Router();

// Mount route modules here
// router.use('/users', userRoutes);
// router.use('/auth', authRoutes);

export default router;
`,
      },
      {
        path: 'src/errors/AppError.ts',
        content: `export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly isOperational: boolean;

  constructor(
    message: string,
    statusCode: number = 500,
    code: string = 'INTERNAL_ERROR'
  ) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;

    Error.captureStackTrace(this, this.constructor);
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        statusCode: this.statusCode,
      },
    };
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string = 'Resource') {
    super(\`\${resource} not found\`, 404, 'NOT_FOUND');
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 400, 'VALIDATION_ERROR');
  }
}

export class UnauthorizedError extends AppError {
  constructor(message: string = 'Unauthorized') {
    super(message, 401, 'UNAUTHORIZED');
  }
}
`,
      },
      {
        path: 'src/middleware/errorHandler.ts',
        content: `import { Request, Response, NextFunction } from 'express';
import { AppError } from '../errors/AppError';

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
) {
  console.error('[Error]', err);

  if (err instanceof AppError) {
    return res.status(err.statusCode).json(err.toJSON());
  }

  // Unknown error
  return res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: process.env.NODE_ENV === 'production' 
        ? 'An unexpected error occurred' 
        : err.message,
    },
  });
}
`,
      },
      {
        path: 'src/middleware/requestLogger.ts',
        content: `import { Request, Response, NextFunction } from 'express';

export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(
      \`[\${new Date().toISOString()}] \${req.method} \${req.path} \${res.statusCode} \${duration}ms\`
    );
  });
  
  next();
}
`,
      },
      {
        path: '.env.example',
        content: `# Server
PORT=3000
NODE_ENV=development

# Database
DATABASE_URL=postgresql://user:password@localhost:5432/dbname

# JWT
JWT_SECRET=your-secret-key-change-in-production
`,
      },
    ],
    
    postCreateCommands: [
      'npm install',
      'cp .env.example .env',
    ],
    
    dependencies: {
      npm: [
        'express',
        'helmet',
        'cors',
        'dotenv',
        'typescript',
        '@types/express',
        '@types/node',
        '@types/cors',
      ],
    },
  },
};

export default nodeApiTemplate;

