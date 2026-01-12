/**
 * Error Fixtures
 * Part of the Governed Self-Improving Agent Runtime Testing Infrastructure
 */

/**
 * Create a generic application error
 */
export function createAppError(overrides = {}) {
  return {
    type: overrides.type || 'APPLICATION_ERROR',
    message: overrides.message || 'An application error occurred',
    code: overrides.code || 'ERR_UNKNOWN',
    timestamp: overrides.timestamp || new Date().toISOString(),
    stack: overrides.stack || new Error().stack,
    context: overrides.context || {},
    ...overrides
  };
}

/**
 * Create a thumbnail generation error
 */
export function createThumbnailError(itemId = 'item-123', overrides = {}) {
  return createAppError({
    type: 'THUMBNAIL_FAILED',
    message: `Failed to generate thumbnail for item ${itemId}`,
    code: 'ERR_THUMBNAIL_GEN',
    context: {
      itemId,
      sourceFile: '/path/to/source.jpg',
      reason: 'Image processing failed'
    },
    ...overrides
  });
}

/**
 * Create an index corruption error
 */
export function createIndexCorruptError(overrides = {}) {
  return createAppError({
    type: 'INDEX_CORRUPT',
    message: 'Space index is corrupted',
    code: 'ERR_INDEX_CORRUPT',
    context: {
      indexPath: '/path/to/index.json',
      parseError: 'Unexpected token at position 1234'
    },
    ...overrides
  });
}

/**
 * Create an API error
 */
export function createAPIError(statusCode = 500, overrides = {}) {
  const statusMessages = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    502: 'Bad Gateway',
    503: 'Service Unavailable'
  };

  return createAppError({
    type: 'API_ERROR',
    message: statusMessages[statusCode] || 'API Error',
    code: `ERR_HTTP_${statusCode}`,
    context: {
      statusCode,
      endpoint: '/api/example',
      method: 'POST'
    },
    ...overrides
  });
}

/**
 * Create an LLM error
 */
export function createLLMError(provider = 'claude', overrides = {}) {
  return createAppError({
    type: 'LLM_ERROR',
    message: 'LLM request failed',
    code: 'ERR_LLM_REQUEST',
    context: {
      provider,
      model: provider === 'claude' ? 'claude-3-opus' : 'gpt-4',
      tokenLimit: 4096,
      reason: 'Rate limit exceeded'
    },
    ...overrides
  });
}

/**
 * Create a file system error
 */
export function createFSError(operation = 'read', path = '/path/to/file', overrides = {}) {
  const messages = {
    read: 'Failed to read file',
    write: 'Failed to write file',
    delete: 'Failed to delete file',
    access: 'Permission denied'
  };

  return createAppError({
    type: 'FS_ERROR',
    message: messages[operation] || 'File system error',
    code: operation === 'access' ? 'EACCES' : 'ENOENT',
    context: {
      operation,
      path,
      errno: -2
    },
    ...overrides
  });
}

/**
 * Create an Aider error
 */
export function createAiderError(overrides = {}) {
  return createAppError({
    type: 'AIDER_ERROR',
    message: 'Aider process failed',
    code: 'ERR_AIDER',
    context: {
      command: 'generate',
      exitCode: 1,
      stderr: 'Error: Unable to connect to model'
    },
    ...overrides
  });
}

/**
 * Create an evaluation error
 */
export function createEvalError(agentType = 'expert', overrides = {}) {
  return createAppError({
    type: 'EVAL_ERROR',
    message: 'Evaluation failed',
    code: 'ERR_EVAL',
    context: {
      agentType,
      phase: 'scoring',
      reason: 'Agent timeout'
    },
    ...overrides
  });
}

export default {
  createAppError,
  createThumbnailError,
  createIndexCorruptError,
  createAPIError,
  createLLMError,
  createFSError,
  createAiderError,
  createEvalError
};

