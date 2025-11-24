/**
 * React + TypeScript Project Template
 */

import { ProjectTemplate } from '../types';

export const reactTypescriptTemplate: ProjectTemplate = {
  id: 'react-typescript',
  name: 'React + TypeScript',
  description: 'Modern React application with TypeScript, hooks, and best practices',
  icon: '⚛️',
  category: 'frontend',
  tags: ['react', 'typescript', 'frontend', 'spa', 'vite'],
  version: '1.0.0',
  builtIn: true,

  // ─────────────────────────────────────────────────────────────
  // AI Behavior
  // ─────────────────────────────────────────────────────────────
  
  systemPrompt: `You are an expert React and TypeScript developer. Follow these conventions:

## Code Style
- Use functional components with hooks (no class components)
- Use TypeScript strict mode - always define proper types
- Prefer named exports over default exports
- Use arrow functions for components and handlers
- Keep components small and focused (< 150 lines)

## File Organization
- One component per file
- Co-locate tests with components (Component.test.tsx)
- Co-locate styles with components (Component.module.css or styled-components)
- Use barrel exports (index.ts) for clean imports

## React Best Practices
- Use React.memo() for expensive renders
- Use useMemo/useCallback appropriately (don't over-optimize)
- Custom hooks should start with "use" prefix
- Prefer controlled components
- Use React Query or SWR for server state
- Use Zustand or Jotai for client state (avoid Redux unless necessary)

## TypeScript Conventions
- Define Props interface above component
- Use 'interface' for object shapes, 'type' for unions/primitives
- Avoid 'any' - use 'unknown' if type is truly unknown
- Use generics for reusable components
- Export types that consumers need

## Naming Conventions
- Components: PascalCase (UserProfile.tsx)
- Hooks: camelCase with 'use' prefix (useAuth.ts)
- Utils: camelCase (formatDate.ts)
- Constants: SCREAMING_SNAKE_CASE
- Types/Interfaces: PascalCase with descriptive names

## Testing
- Write tests for business logic and user interactions
- Use React Testing Library (not Enzyme)
- Test behavior, not implementation
- Use MSW for API mocking`,

  model: 'gpt-4',

  // ─────────────────────────────────────────────────────────────
  // Context Management
  // ─────────────────────────────────────────────────────────────
  
  autoIncludePatterns: [
    'src/App.tsx',
    'src/main.tsx',
    'src/index.tsx',
    'tsconfig.json',
    'package.json',
    'src/types/**/*.ts',
    'src/hooks/**/*.ts',
  ],
  
  ignorePatterns: [
    'node_modules/**',
    'dist/**',
    'build/**',
    '.git/**',
    'coverage/**',
    '*.log',
    '.env*',
    '*.lock',
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
  ],
  
  primaryExtensions: ['.tsx', '.ts', '.css', '.json'],
  maxAutoIncludeFiles: 10,

  // ─────────────────────────────────────────────────────────────
  // Quality Gates
  // ─────────────────────────────────────────────────────────────
  
  testCommand: 'npm test',
  lintCommand: 'npm run lint',
  typeCheckCommand: 'npx tsc --noEmit',
  formatCommand: 'npm run format',
  autoLint: true,

  // ─────────────────────────────────────────────────────────────
  // Custom Commands
  // ─────────────────────────────────────────────────────────────
  
  commands: [
    {
      name: 'component',
      description: 'Generate a new React component with TypeScript',
      prompt: `Create a new React component called {{name}} in src/components/{{name}}/

The component should:
- Be a functional component with TypeScript
- Have a Props interface
- Include basic styling (CSS module or styled-components based on project setup)
- Include a basic test file
- Export from an index.ts barrel file

{{#if withState}}
Include local state management with useState/useReducer as appropriate.
{{/if}}

{{#if withApi}}
Include data fetching with React Query or the project's data fetching pattern.
{{/if}}

Component purpose: {{description}}`,
      requiredInputs: [
        {
          name: 'name',
          description: 'Component name (PascalCase)',
          type: 'string',
          placeholder: 'UserProfile',
          validation: '^[A-Z][a-zA-Z0-9]*$',
        },
        {
          name: 'description',
          description: 'What does this component do?',
          type: 'string',
          placeholder: 'Displays user profile information',
        },
      ],
      optionalInputs: [
        {
          name: 'withState',
          description: 'Include state management',
          type: 'boolean',
          defaultValue: false,
        },
        {
          name: 'withApi',
          description: 'Include API data fetching',
          type: 'boolean',
          defaultValue: false,
        },
      ],
      example: '/component UserProfile "Displays user avatar and info"',
    },
    {
      name: 'hook',
      description: 'Generate a custom React hook',
      prompt: `Create a custom React hook called use{{name}} in src/hooks/use{{name}}.ts

The hook should:
- Follow React hooks rules
- Have proper TypeScript types for parameters and return value
- Include JSDoc documentation
- Handle cleanup in useEffect if needed
- Include a test file

Hook purpose: {{description}}

{{#if withApi}}
This hook fetches data from an API. Use React Query or the project's data fetching pattern.
{{/if}}`,
      requiredInputs: [
        {
          name: 'name',
          description: 'Hook name (without "use" prefix)',
          type: 'string',
          placeholder: 'Auth',
          validation: '^[A-Z][a-zA-Z0-9]*$',
        },
        {
          name: 'description',
          description: 'What does this hook do?',
          type: 'string',
          placeholder: 'Manages authentication state',
        },
      ],
      optionalInputs: [
        {
          name: 'withApi',
          description: 'Hook fetches data from API',
          type: 'boolean',
          defaultValue: false,
        },
      ],
      example: '/hook Auth "Manages user authentication state"',
    },
    {
      name: 'page',
      description: 'Generate a new page/route component',
      prompt: `Create a new page component for the {{route}} route in src/pages/{{name}}Page.tsx

The page should:
- Be a functional component with TypeScript
- Include any necessary data fetching
- Have proper loading and error states
- Be responsive
- Include SEO meta tags if using a meta framework

Page purpose: {{description}}`,
      requiredInputs: [
        {
          name: 'name',
          description: 'Page name (PascalCase)',
          type: 'string',
          placeholder: 'Dashboard',
        },
        {
          name: 'route',
          description: 'URL route path',
          type: 'string',
          placeholder: '/dashboard',
        },
        {
          name: 'description',
          description: 'What does this page display?',
          type: 'string',
          placeholder: 'Main dashboard with user stats',
        },
      ],
      example: '/page Dashboard /dashboard "Main user dashboard"',
    },
    {
      name: 'context',
      description: 'Generate a React Context with provider',
      prompt: `Create a React Context for {{name}} in src/contexts/{{name}}Context.tsx

Include:
- Context creation with createContext
- Provider component with proper typing
- Custom hook (use{{name}}) for consuming the context
- TypeScript interfaces for the context value
- Error boundary for missing provider

Context purpose: {{description}}`,
      requiredInputs: [
        {
          name: 'name',
          description: 'Context name (PascalCase)',
          type: 'string',
          placeholder: 'Theme',
        },
        {
          name: 'description',
          description: 'What state does this context manage?',
          type: 'string',
          placeholder: 'Application theme (light/dark mode)',
        },
      ],
      example: '/context Theme "Manages light/dark theme"',
    },
    {
      name: 'test',
      description: 'Generate tests for a component',
      prompt: `Create comprehensive tests for the {{component}} component.

Use React Testing Library and follow these practices:
- Test user interactions, not implementation details
- Use accessible queries (getByRole, getByLabelText)
- Test loading, error, and success states
- Mock API calls with MSW if needed
- Include edge cases

Focus on testing: {{focus}}`,
      requiredInputs: [
        {
          name: 'component',
          description: 'Component to test',
          type: 'file',
        },
        {
          name: 'focus',
          description: 'What aspects to focus testing on',
          type: 'string',
          placeholder: 'Form validation and submission',
        },
      ],
      example: '/test src/components/LoginForm.tsx "Form validation"',
    },
    {
      name: 'refactor',
      description: 'Refactor a component following best practices',
      prompt: `Refactor the {{component}} component to improve:

{{#if performance}}
- Performance: Add memoization, reduce re-renders
{{/if}}
{{#if readability}}
- Readability: Better naming, extract functions, add comments
{{/if}}
{{#if typescript}}
- TypeScript: Stricter types, remove any, add generics
{{/if}}
{{#if accessibility}}
- Accessibility: ARIA labels, keyboard navigation, focus management
{{/if}}

Keep the same functionality but improve code quality.`,
      requiredInputs: [
        {
          name: 'component',
          description: 'Component to refactor',
          type: 'file',
        },
      ],
      optionalInputs: [
        { name: 'performance', description: 'Improve performance', type: 'boolean', defaultValue: true },
        { name: 'readability', description: 'Improve readability', type: 'boolean', defaultValue: true },
        { name: 'typescript', description: 'Improve TypeScript', type: 'boolean', defaultValue: true },
        { name: 'accessibility', description: 'Improve accessibility', type: 'boolean', defaultValue: false },
      ],
      example: '/refactor src/components/UserList.tsx',
    },
  ],

  // ─────────────────────────────────────────────────────────────
  // Scaffolding
  // ─────────────────────────────────────────────────────────────
  
  scaffold: {
    directories: [
      'src/components',
      'src/hooks',
      'src/pages',
      'src/contexts',
      'src/utils',
      'src/types',
      'src/api',
      'src/assets',
    ],
    
    files: [
      {
        path: 'src/types/index.ts',
        content: `/**
 * Shared TypeScript types
 */

export interface User {
  id: string;
  email: string;
  name: string;
  avatar?: string;
}

export interface ApiResponse<T> {
  data: T;
  error?: string;
  status: number;
}
`,
      },
      {
        path: 'src/hooks/index.ts',
        content: `/**
 * Custom hooks barrel export
 */

// export { useAuth } from './useAuth';
// export { useLocalStorage } from './useLocalStorage';
`,
      },
      {
        path: 'src/components/index.ts',
        content: `/**
 * Components barrel export
 */

// export { Button } from './Button';
// export { Input } from './Input';
`,
      },
      {
        path: 'src/utils/cn.ts',
        content: `/**
 * Utility for conditionally joining classNames
 */

export function cn(...classes: (string | undefined | null | false)[]): string {
  return classes.filter(Boolean).join(' ');
}
`,
      },
    ],
    
    variables: [
      {
        name: 'projectName',
        description: 'Name of the project',
        source: 'prompt',
      },
      {
        name: 'author',
        description: 'Author name',
        source: 'config',
        defaultValue: 'Developer',
      },
    ],
    
    postCreateCommands: [
      'npm install',
    ],
    
    dependencies: {
      npm: [
        'react',
        'react-dom',
        'typescript',
        '@types/react',
        '@types/react-dom',
      ],
    },
  },
};

export default reactTypescriptTemplate;

