import { z } from "zod";
import { RuntimeBoundaryError } from "./errors.js";
import type { Clock, IdSource } from "./types.js";

export const NativeVaultGrantSchema = z.object({
  patronId: z.string().min(1).max(100),
  capabilityId: z.string().min(1).max(100),
  verifiedGrantId: z.string().min(16).max(200),
  expiresAt: z.iso.datetime({ offset: true })
}).strict();

type VaultAuthorization = {
  authorizationId: string;
  patronId: string;
  capabilityId: string;
  expiresAt: string;
  used: boolean;
};

export class VaultAuthorizationService {
  readonly #clock: Clock;
  readonly #ids: IdSource;
  readonly #authorizations = new Map<string, VaultAuthorization>();
  readonly #seenGrantIds = new Set<string>();

  constructor(clock: Clock, ids: IdSource) {
    this.#clock = clock;
    this.#ids = ids;
  }

  issue(nativeGrant: unknown): Omit<VaultAuthorization, "used"> {
    const grant = NativeVaultGrantSchema.parse(nativeGrant);
    if (this.#seenGrantIds.has(grant.verifiedGrantId)) {
      throw new RuntimeBoundaryError("VAULT_GRANT_REPLAY", "That device authorization has already been used.");
    }
    const maxExpiry = this.#clock.now().getTime() + 2 * 60_000;
    if (new Date(grant.expiresAt).getTime() <= this.#clock.now().getTime() || new Date(grant.expiresAt).getTime() > maxExpiry) {
      throw new RuntimeBoundaryError("VAULT_GRANT_STALE", "That device authorization has expired.");
    }
    this.#seenGrantIds.add(grant.verifiedGrantId);
    const authorization: VaultAuthorization = {
      authorizationId: this.#ids.next("vault_auth"),
      patronId: grant.patronId,
      capabilityId: grant.capabilityId,
      expiresAt: grant.expiresAt,
      used: false
    };
    if (this.#authorizations.has(authorization.authorizationId)) {
      throw new RuntimeBoundaryError("ID_COLLISION", "A generated identifier could not be used safely.");
    }
    this.#authorizations.set(authorization.authorizationId, authorization);
    return {
      authorizationId: authorization.authorizationId,
      patronId: authorization.patronId,
      capabilityId: authorization.capabilityId,
      expiresAt: authorization.expiresAt
    };
  }

  consume(authorizationId: string, patronId: string, capabilityId: string): void {
    const authorization = this.#authorizations.get(authorizationId);
    if (!authorization) throw new RuntimeBoundaryError("VAULT_AUTH_UNKNOWN", "That vault authorization is not available.");
    if (authorization.used) throw new RuntimeBoundaryError("VAULT_AUTH_REPLAY", "That vault authorization has already been used.");
    if (authorization.patronId !== patronId || authorization.capabilityId !== capabilityId) {
      throw new RuntimeBoundaryError("VAULT_AUTH_SCOPE", "That vault authorization does not allow this action.");
    }
    if (new Date(authorization.expiresAt).getTime() <= this.#clock.now().getTime()) {
      throw new RuntimeBoundaryError("VAULT_AUTH_STALE", "That vault authorization has expired.");
    }
    authorization.used = true;
  }
}
