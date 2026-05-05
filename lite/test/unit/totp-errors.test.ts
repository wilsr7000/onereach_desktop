/**
 * TotpError conformance tests.
 *
 * Runs the uniform error contract per Rule 12 (LITE-RULES.md).
 */

import { runErrorConformanceContract } from '../harness/error-conformance.js';
import { TotpError, TOTP_ERROR_CODES, type TotpErrorCode } from '../../totp/api.js';

runErrorConformanceContract({
  name: 'TotpError',
  ErrorClass: TotpError,
  codeEnum: TOTP_ERROR_CODES,
  modulePrefix: 'TOTP_',
  constructErrorWithCode: (code) =>
    new TotpError({
      code: code as TotpErrorCode,
      message: 'sample totp error',
      context: { op: 'sample' },
      remediation: 'Sample remediation hint.',
    }),
});
