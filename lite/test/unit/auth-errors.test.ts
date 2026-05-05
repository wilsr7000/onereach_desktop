/**
 * AuthError conformance tests.
 *
 * Runs the uniform error contract per Rule 12 (LITE-RULES.md).
 */

// Import directly from the error-conformance file -- the harness/index.js
// barrel re-exports launch.ts (which imports @playwright/test), and other
// auth tests vi.mock('electron'). Use the narrow path everywhere for
// consistency.
import { runErrorConformanceContract } from '../harness/error-conformance.js';
import { AuthError, AUTH_ERROR_CODES, type AuthErrorCode } from '../../auth/api.js';

runErrorConformanceContract({
  name: 'AuthError',
  ErrorClass: AuthError,
  codeEnum: AUTH_ERROR_CODES,
  modulePrefix: 'AUTH_',
  constructErrorWithCode: (code) =>
    new AuthError({
      code: code as AuthErrorCode,
      message: 'sample auth error',
      context: { op: 'sample' },
      remediation: 'Sample remediation hint.',
    }),
});
