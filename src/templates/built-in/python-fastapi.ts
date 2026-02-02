/**
 * Python FastAPI Project Template
 */

import { ProjectTemplate } from '../types';

export const pythonFastApiTemplate: ProjectTemplate = {
  id: 'python-fastapi',
  name: 'Python FastAPI',
  description: 'Modern Python API with FastAPI, type hints, and async support',
  icon: '🐍',
  category: 'backend',
  tags: ['python', 'fastapi', 'api', 'async', 'backend'],
  version: '1.0.0',
  builtIn: true,

  // ─────────────────────────────────────────────────────────────
  // AI Behavior
  // ─────────────────────────────────────────────────────────────
  
  systemPrompt: `You are an expert Python developer specializing in FastAPI. Follow these conventions:

## Code Style
- Follow PEP 8 style guide
- Use type hints everywhere (Python 3.10+ syntax preferred)
- Use async/await for I/O operations
- Keep functions small and focused
- Use docstrings (Google style)

## Project Structure
- app/main.py - FastAPI application
- app/routers/ - Route modules
- app/models/ - Pydantic models and SQLAlchemy models
- app/services/ - Business logic
- app/core/ - Config, security, dependencies
- app/db/ - Database setup and repositories
- tests/ - Test files

## FastAPI Best Practices
- Use Pydantic models for request/response validation
- Use dependency injection for shared resources
- Use background tasks for non-blocking operations
- Implement proper error handling with HTTPException
- Use tags and descriptions for API documentation

## Database
- Use SQLAlchemy 2.0 with async support
- Use Alembic for migrations
- Define models with proper relationships
- Use repository pattern for data access

## Security
- Use OAuth2 with JWT tokens
- Hash passwords with passlib[bcrypt]
- Validate all inputs with Pydantic
- Use CORS middleware appropriately
- Never log sensitive data

## Testing
- Use pytest with pytest-asyncio
- Use httpx for async test client
- Use factories for test data
- Mock external services`,

  model: 'gpt-4',

  // ─────────────────────────────────────────────────────────────
  // Context Management
  // ─────────────────────────────────────────────────────────────
  
  autoIncludePatterns: [
    'app/main.py',
    'app/core/config.py',
    'app/models/**/*.py',
    'app/routers/**/*.py',
    'pyproject.toml',
    'requirements.txt',
  ],
  
  ignorePatterns: [
    '__pycache__/**',
    '*.pyc',
    '.venv/**',
    'venv/**',
    '.git/**',
    '.pytest_cache/**',
    '.mypy_cache/**',
    '*.egg-info/**',
    'dist/**',
    'build/**',
    '.env',
  ],
  
  primaryExtensions: ['.py', '.toml', '.yaml'],
  maxAutoIncludeFiles: 10,

  // ─────────────────────────────────────────────────────────────
  // Quality Gates
  // ─────────────────────────────────────────────────────────────
  
  testCommand: 'pytest',
  lintCommand: 'ruff check .',
  typeCheckCommand: 'mypy app',
  formatCommand: 'ruff format .',
  autoLint: true,

  // ─────────────────────────────────────────────────────────────
  // Custom Commands
  // ─────────────────────────────────────────────────────────────
  
  commands: [
    {
      name: 'router',
      description: 'Generate a new FastAPI router with CRUD endpoints',
      prompt: `Create a FastAPI router for {{resource}} resource:

1. Router: app/routers/{{resource}}.py
   - GET /{{resource}}s/ (list with pagination)
   - GET /{{resource}}s/{id} (get one)
   - POST /{{resource}}s/ (create)
   - PUT /{{resource}}s/{id} (update)
   - DELETE /{{resource}}s/{id} (delete)

2. Schemas: app/models/{{resource}}_schema.py
   - {{resource}}Base (shared fields)
   - {{resource}}Create (for POST)
   - {{resource}}Update (for PUT, all optional)
   - {{resource}}Response (for responses)
   - {{resource}}List (paginated response)

3. Service: app/services/{{resource}}_service.py
   - Business logic with dependency injection

Fields: {{fields}}

Use async/await, proper type hints, and docstrings.`,
      requiredInputs: [
        {
          name: 'resource',
          description: 'Resource name (singular, snake_case)',
          type: 'string',
          placeholder: 'user',
          validation: '^[a-z][a-z0-9_]*$',
        },
        {
          name: 'fields',
          description: 'Resource fields',
          type: 'string',
          placeholder: 'name: str, email: EmailStr, age: int | None',
        },
      ],
      example: '/router user "name: str, email: EmailStr"',
    },
    {
      name: 'model',
      description: 'Generate SQLAlchemy model with Pydantic schemas',
      prompt: `Create a SQLAlchemy model and Pydantic schemas for {{name}}:

1. SQLAlchemy Model: app/db/models/{{name}}.py
   - Use SQLAlchemy 2.0 syntax
   - Include proper column types
   - Add indexes and constraints
   - Include relationships if needed

2. Pydantic Schemas: app/models/{{name}}_schema.py
   - Base, Create, Update, Response schemas
   - Use proper validators

Fields: {{fields}}
Relationships: {{relationships}}`,
      requiredInputs: [
        {
          name: 'name',
          description: 'Model name (PascalCase)',
          type: 'string',
          placeholder: 'User',
        },
        {
          name: 'fields',
          description: 'Model fields',
          type: 'string',
          placeholder: 'id: int (pk), name: str, email: str (unique)',
        },
      ],
      optionalInputs: [
        {
          name: 'relationships',
          description: 'Related models',
          type: 'string',
          placeholder: 'posts: List[Post], profile: Profile (one-to-one)',
        },
      ],
      example: '/model User "id: int, name: str, email: str"',
    },
    {
      name: 'dependency',
      description: 'Generate a FastAPI dependency',
      prompt: `Create a FastAPI dependency {{name}} in app/core/dependencies.py

The dependency should:
- Use proper type hints
- Be async if needed
- Handle errors appropriately
- Include docstring

Purpose: {{description}}

{{#if cached}}
Cache the result for performance.
{{/if}}`,
      requiredInputs: [
        {
          name: 'name',
          description: 'Dependency name (snake_case)',
          type: 'string',
          placeholder: 'get_current_user',
        },
        {
          name: 'description',
          description: 'What does this dependency do?',
          type: 'string',
          placeholder: 'Extracts and validates JWT token, returns user',
        },
      ],
      optionalInputs: [
        {
          name: 'cached',
          description: 'Cache the dependency result',
          type: 'boolean',
          defaultValue: false,
        },
      ],
      example: '/dependency get_db "Returns async database session"',
    },
    {
      name: 'migration',
      description: 'Generate an Alembic migration',
      prompt: `Create an Alembic migration for: {{description}}

Run: alembic revision --autogenerate -m "{{name}}"

Then modify the generated migration to include:
{{changes}}

Include proper upgrade() and downgrade() functions.`,
      requiredInputs: [
        {
          name: 'name',
          description: 'Migration name',
          type: 'string',
          placeholder: 'add_users_table',
        },
        {
          name: 'description',
          description: 'What does this migration do?',
          type: 'string',
          placeholder: 'Creates users table',
        },
        {
          name: 'changes',
          description: 'Schema changes',
          type: 'string',
          placeholder: 'Add email column, create index on email',
        },
      ],
      example: '/migration add_users "Creates users table"',
    },
    {
      name: 'test',
      description: 'Generate pytest tests for an endpoint',
      prompt: `Create pytest tests for the {{endpoint}} endpoints.

File: tests/test_{{name}}.py

Include:
- Test all CRUD operations
- Test validation errors
- Test authentication (if protected)
- Test edge cases
- Use pytest fixtures
- Use httpx AsyncClient
- Use factory_boy for test data`,
      requiredInputs: [
        {
          name: 'name',
          description: 'Test file name',
          type: 'string',
          placeholder: 'users',
        },
        {
          name: 'endpoint',
          description: 'Endpoint path',
          type: 'string',
          placeholder: '/api/v1/users',
        },
      ],
      example: '/test users /api/v1/users',
    },
    {
      name: 'background',
      description: 'Generate a background task',
      prompt: `Create a background task {{name}} in app/tasks/{{name}}.py

The task should:
- Be async
- Have proper error handling
- Log progress
- Be idempotent if possible

Purpose: {{description}}

Include a function to enqueue this task from a route.`,
      requiredInputs: [
        {
          name: 'name',
          description: 'Task name (snake_case)',
          type: 'string',
          placeholder: 'send_email',
        },
        {
          name: 'description',
          description: 'What does this task do?',
          type: 'string',
          placeholder: 'Sends welcome email to new user',
        },
      ],
      example: '/background send_email "Sends welcome email"',
    },
  ],

  // ─────────────────────────────────────────────────────────────
  // Scaffolding
  // ─────────────────────────────────────────────────────────────
  
  scaffold: {
    directories: [
      'app',
      'app/routers',
      'app/models',
      'app/services',
      'app/core',
      'app/db',
      'app/db/models',
      'app/tasks',
      'tests',
      'alembic',
    ],
    
    files: [
      {
        path: 'app/main.py',
        content: `"""FastAPI Application"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import settings
from app.routers import health

app = FastAPI(
    title=settings.PROJECT_NAME,
    version=settings.VERSION,
    description="API Documentation",
    docs_url="/docs",
    redoc_url="/redoc",
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Routers
app.include_router(health.router, tags=["Health"])
# app.include_router(users.router, prefix="/api/v1", tags=["Users"])


@app.on_event("startup")
async def startup():
    """Initialize services on startup."""
    pass


@app.on_event("shutdown")
async def shutdown():
    """Cleanup on shutdown."""
    pass
`,
      },
      {
        path: 'app/core/config.py',
        content: `"""Application Configuration"""

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Application settings loaded from environment."""
    
    PROJECT_NAME: str = "FastAPI App"
    VERSION: str = "1.0.0"
    DEBUG: bool = False
    
    # Database
    DATABASE_URL: str = "postgresql+asyncpg://user:pass@localhost/db"
    
    # Security
    SECRET_KEY: str = "change-me-in-production"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 30
    
    # CORS
    CORS_ORIGINS: list[str] = ["http://localhost:3000"]
    
    class Config:
        env_file = ".env"


settings = Settings()
`,
      },
      {
        path: 'app/routers/health.py',
        content: `"""Health Check Router"""

from fastapi import APIRouter

router = APIRouter()


@router.get("/health")
async def health_check():
    """Check if the API is running."""
    return {"status": "healthy"}


@router.get("/")
async def root():
    """API root endpoint."""
    return {"message": "Welcome to the API", "docs": "/docs"}
`,
      },
      {
        path: 'app/core/dependencies.py',
        content: `"""FastAPI Dependencies"""

from typing import AsyncGenerator
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import async_session


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """Get database session."""
    async with async_session() as session:
        try:
            yield session
        finally:
            await session.close()
`,
      },
      {
        path: 'requirements.txt',
        content: `fastapi>=0.100.0
uvicorn[standard]>=0.23.0
pydantic>=2.0.0
pydantic-settings>=2.0.0
sqlalchemy>=2.0.0
asyncpg>=0.28.0
alembic>=1.11.0
python-jose[cryptography]>=3.3.0
passlib[bcrypt]>=1.7.4
python-multipart>=0.0.6
httpx>=0.24.0
pytest>=7.4.0
pytest-asyncio>=0.21.0
ruff>=0.0.280
mypy>=1.4.0
`,
      },
      {
        path: '.env.example',
        content: `# Application
DEBUG=true
SECRET_KEY=your-secret-key-change-in-production

# Database
DATABASE_URL=postgresql+asyncpg://user:password@localhost:5432/dbname

# CORS (comma-separated)
CORS_ORIGINS=http://localhost:3000,http://localhost:8080
`,
      },
      {
        path: 'pyproject.toml',
        content: `[project]
name = "fastapi-app"
version = "1.0.0"
description = "FastAPI Application"
requires-python = ">=3.10"

[tool.ruff]
line-length = 88
select = ["E", "F", "I", "N", "W"]
ignore = ["E501"]

[tool.mypy]
python_version = "3.10"
strict = true
ignore_missing_imports = true

[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]
`,
      },
    ],
    
    postCreateCommands: [
      'python -m venv .venv',
      'source .venv/bin/activate && pip install -r requirements.txt',
      'cp .env.example .env',
    ],
    
    dependencies: {
      pip: [
        'fastapi',
        'uvicorn[standard]',
        'pydantic',
        'sqlalchemy',
        'asyncpg',
        'alembic',
      ],
    },
  },
};

export default pythonFastApiTemplate;

