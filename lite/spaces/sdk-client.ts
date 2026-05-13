/**
 * Spaces SDK client (internal).
 *
 * Wraps Cypher access through `lite/neon/api.ts` so the rest of the
 * Spaces module never talks to Neon directly. Borrows the pattern from
 * `lite/files/sdk-client.ts` (which wraps `@or-sdk/files`).
 *
 * Phase 0 ships a STUB. Every method throws `SPACES_NOT_INITIALIZED`
 * so the surface exists for the conformance contract and the IPC layer
 * has something to call against -- but no Cypher fires yet. Phase 1
 * lands the real `listSpaces` + `items.list(Uncategorized)` queries.
 *
 * @internal -- consumers go through `getSpacesApi()`.
 */

import { SpacesError } from './errors.js';
import type {
  Space,
  Item,
  ItemSummary,
  ListOpts,
} from './types.js';
import type { SpaceScope } from './scope.js';

export interface SdkSpacesClientConfig {
  /**
   * Resolver for the active OneReach auth env. The neon client picks
   * up the `mult` token from `lite/auth/`; this hook is here so the
   * sdk-client can be unit-tested without a live auth session.
   */
  getAuthEnv?: () => string | null;
}

/**
 * Phase 0 stub. All methods reject with `SPACES_NOT_INITIALIZED`.
 *
 * Phase 1+ wires each method to the corresponding Cypher query. See
 * the spaces plan, Phase 1 + Phase 2 sections, for the query bodies.
 */
export class SdkSpacesClient {
  /**
   * Resolver for the active OneReach auth env. Threaded through from
   * `SdkSpacesClientConfig` so Phase 1 can fetch the active env at call
   * time without grabbing it eagerly at construction (the auth session
   * may not exist yet when this client is built at boot).
   */
  protected readonly getAuthEnv: () => string | null;

  constructor(config: SdkSpacesClientConfig = {}) {
    this.getAuthEnv = config.getAuthEnv ?? ((): string | null => null);
  }

  async listSpaces(): Promise<Space[]> {
    throw notInitialized('listSpaces');
  }

  async getUncategorizedCount(): Promise<number> {
    throw notInitialized('getUncategorizedCount');
  }

  async listItems(
    _scope: SpaceScope,
    _opts?: ListOpts
  ): Promise<ItemSummary[]> {
    throw notInitialized('listItems');
  }

  async getItem(_id: string): Promise<Item | null> {
    throw notInitialized('getItem');
  }
}

function notInitialized(method: string): SpacesError {
  return new SpacesError({
    code: 'SPACES_NOT_INITIALIZED',
    message: `spaces.${method}() called before Phase 1 implementation`,
    remediation:
      'This method is reserved for Phase 1+ of the Spaces module. The Phase 0 scaffold only verifies the surface.',
    context: { method },
  });
}
