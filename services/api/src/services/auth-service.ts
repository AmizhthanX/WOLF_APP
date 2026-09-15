import {
  REFRESH_TOKEN_TTL_SECONDS,
  createRefreshToken,
  evaluateLockout,
  evaluateRefresh,
  hashPassword,
  issueAccessToken,
  needsRehash,
  parseRefreshToken,
  recordFailure,
  verifyPassword,
  verifySignature,
} from '@wolf/auth';
import {
  REFRESH_PROOF_MAX_SKEW_SECONDS,
  refreshProofPayload,
  refreshProofVariant,
  refreshTokenBinding,
  webRefreshProofPayload,
  type RefreshProof,
  type RefreshProofVariant,
  type SignOutReason,
} from '@wolf/protocol';
import { newId } from '@wolf/shared-types';
import type { DeviceKind, UserDevice } from '@wolf/shared-types';
import type { AppContext } from '../http/context.js';
import { withTransaction } from '@wolf/server-core';
import { deviceClockSkew, tooManyRequests, unauthorized } from '../http/errors.js';

export interface DeviceDescriptor {
  /** Existing device id when the client has one; a new device is created otherwise. */
  readonly id?: string;
  readonly kind: DeviceKind;
  readonly name: string;
  readonly platform?: string | null;
  readonly publicKey?: string | null;
}

export interface AuthResult {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: string;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: string;
  readonly device: UserDevice;
  readonly user: { readonly id: string; readonly email: string; readonly displayName: string };
}

/**
 * Authentication.
 *
 * The failure path is deliberately uniform: an unknown email and a wrong password produce
 * the same message and, as far as an outside observer can tell, the same work — so the
 * response cannot be used to discover whether an address is the owner's.
 */
export class AuthService {
  constructor(private readonly context: AppContext) {}

  async login(input: {
    email: string;
    password: string;
    device: DeviceDescriptor;
    sourceIp: string | null;
  }): Promise<AuthResult> {
    const { repos } = this.context;
    const now = this.context.now();
    const user = await repos.users.findByEmail(input.email);

    if (!user) {
      // Spend comparable effort so a missing account is not distinguishable by timing.
      await hashPassword(input.password, { cost: 2 ** 14, blockSize: 8, parallelization: 1, keyLength: 32 });
      await repos.audit.recordSecurityEvent({
        type: 'login-failure',
        sourceIp: input.sourceIp,
        detail: { reason: 'unknown-account' },
      });
      throw unauthorized('The email address or password is incorrect.');
    }

    const lockout = evaluateLockout(
      { failureCount: user.failedLoginCount, lastFailureAt: user.lastFailedLoginAt },
      now,
    );
    if (!lockout.allowed) {
      await repos.audit.recordSecurityEvent({
        type: 'brute-force-block',
        userId: user.id,
        sourceIp: input.sourceIp,
        detail: { retryAfterSeconds: lockout.retryAfterSeconds },
      });
      throw tooManyRequests(
        lockout.retryAfterSeconds,
        'Too many failed sign-in attempts for this account.',
      );
    }

    const passwordOk = await verifyPassword(input.password, user.passwordHash);
    if (!passwordOk) {
      const next = recordFailure(
        { failureCount: user.failedLoginCount, lastFailureAt: user.lastFailedLoginAt },
        now,
      );
      await repos.users.recordLoginFailure(user.id, next.failureCount, now);
      await repos.audit.record({
        category: 'authentication',
        action: 'auth.login',
        outcome: 'failure',
        riskLevel: 'medium',
        userId: user.id,
        sourceIp: input.sourceIp,
        errorCode: 'bad-credentials',
      });
      await repos.audit.recordSecurityEvent({
        type: 'login-failure',
        userId: user.id,
        sourceIp: input.sourceIp,
        detail: { failureCount: next.failureCount },
      });
      throw unauthorized('The email address or password is incorrect.');
    }

    // Opportunistically upgrade a hash that predates the current cost parameters.
    if (needsRehash(user.passwordHash)) {
      await repos.users.updatePasswordHash(user.id, await hashPassword(input.password));
    }

    const device = await this.resolveDevice(user.id, input.device);
    await repos.users.recordLoginSuccess(user.id, now);

    const result = await this.issueTokens({
      userId: user.id,
      device,
      authTime: Math.floor(now.getTime() / 1000),
      email: user.email,
      displayName: user.displayName,
    });

    await repos.audit.record({
      category: 'authentication',
      action: 'auth.login',
      outcome: 'success',
      riskLevel: 'medium',
      userId: user.id,
      deviceId: device.id,
      sourceIp: input.sourceIp,
      target: { deviceName: device.name, deviceKind: device.kind },
    });

    return result;
  }

  /**
   * Rotate a refresh token.
   *
   * A token presented twice means it was copied, so the whole family is revoked and every
   * session on that device ends. Losing a session is the correct outcome when the
   * alternative is letting a stolen token keep working.
   *
   * A device that registered an identity key at sign-in must also sign the refresh with it. A
   * refresh without that signature, or with another key's, is a token that left the device, and
   * is answered the same way as a replay. A correct signature by a clock too far from the
   * server's is refused without revoking anything: the device proved it holds its key.
   */
  async refresh(input: {
    refreshToken: string;
    /** The device the client claims to be; must match the token's device. */
    deviceId: string;
    /** The device key's signature over this refresh, or null when the client sent none. */
    proof: RefreshProof | null;
    sourceIp: string | null;
  }): Promise<AuthResult> {
    const { repos } = this.context;
    const parsed = parseRefreshToken(input.refreshToken);
    if (!parsed) throw unauthorized('The refresh token is malformed.');

    const stored = await repos.refreshTokens.findByTokenId(parsed.tokenId);
    const decision = evaluateRefresh({
      token: input.refreshToken,
      stored,
      deviceId: input.deviceId,
      now: this.context.now(),
    });

    if (decision.outcome === 'revoke-family') {
      await withTransaction(this.context.db, async (client) => {
        await repos.refreshTokens.revokeFamily(decision.familyId, client);
        if (stored) await repos.sessions.endAllForDevice(stored.deviceId, 'token-replay', client);
      });
      await repos.audit.recordSecurityEvent({
        type: 'token-replay',
        userId: stored?.userId ?? null,
        deviceId: stored?.deviceId ?? null,
        sourceIp: input.sourceIp,
        detail: { familyId: decision.familyId },
      });
      throw unauthorized(
        'This refresh token was already used, so every token for the device was revoked.',
      );
    }

    if (decision.outcome === 'reject') {
      throw unauthorized(`The refresh token was rejected (${decision.reason}).`);
    }

    const device = await repos.devices.findActive(decision.stored.deviceId, decision.stored.userId);
    if (!device) throw unauthorized('The device is no longer authorized.');

    const user = await repos.users.findById(decision.stored.userId);
    if (!user) throw unauthorized('The account no longer exists.');

    const proven = await this.checkDeviceProof(device, input.refreshToken, input.proof);
    if (proven.outcome === 'clock') {
      await repos.audit.recordSecurityEvent({
        type: 'device-proof-failure',
        userId: user.id,
        deviceId: device.id,
        sourceIp: input.sourceIp,
        detail: { reason: 'clock-skew', variant: proven.variant, skewSeconds: Math.round(proven.skewSeconds) },
      });
      throw deviceClockSkew(proven.skewSeconds, REFRESH_PROOF_MAX_SKEW_SECONDS);
    }
    if (proven.outcome === 'refused') {
      await withTransaction(this.context.db, async (client) => {
        await repos.refreshTokens.revokeFamily(decision.stored.familyId, client);
        await repos.sessions.endAllForDevice(device.id, 'token-replay', client);
      });
      await repos.audit.recordSecurityEvent({
        type: 'device-proof-failure',
        userId: user.id,
        deviceId: device.id,
        sourceIp: input.sourceIp,
        detail: { reason: proven.reason, variant: proven.variant, familyId: decision.stored.familyId },
      });
      throw unauthorized(
        "The refresh was not signed with this device's key, so every token for the device was revoked.",
      );
    }

    const consumed = await repos.refreshTokens.consume(decision.stored.tokenId);
    if (!consumed) {
      // Another request rotated this token first; treat it as a replay rather than racing.
      throw unauthorized('The refresh token was already used.');
    }

    return this.issueTokens({
      userId: user.id,
      device,
      // Refreshing does not re-prove the password, so auth_time carries forward the last
      // time it actually was proven. A high-risk action still demands a fresh entry.
      authTime: Math.floor((user.lastLoginAt ?? user.createdAt).getTime() / 1000),
      familyId: decision.stored.familyId,
      email: user.email,
      displayName: user.displayName,
    });
  }

  /**
   * End a sign-in. `reason` is the client's own account of why — a person signing out, or a browser
   * that lost the device key its sign-in was bound to — and is kept as metadata on the audit record.
   */
  async logout(refreshToken: string, reason: SignOutReason = 'signed-out'): Promise<void> {
    const parsed = parseRefreshToken(refreshToken);
    if (!parsed) return;
    const stored = await this.context.repos.refreshTokens.findByTokenId(parsed.tokenId);
    if (!stored) return;

    await withTransaction(this.context.db, async (client) => {
      await this.context.repos.refreshTokens.revokeFamily(stored.familyId, client);
      await this.context.repos.sessions.endAllForDevice(stored.deviceId, 'signed-out', client);
    });
    await this.context.repos.audit.record({
      category: 'authentication',
      action: 'auth.logout',
      outcome: 'success',
      riskLevel: 'low',
      userId: stored.userId,
      deviceId: stored.deviceId,
      target: { reason },
    });
  }

  /**
   * Re-enter the password to refresh `auth_time`, unlocking high and critical risk actions
   * without forcing a full sign-in.
   */
  async reauthenticate(input: {
    userId: string;
    deviceId: string;
    password: string;
    sourceIp: string | null;
  }): Promise<{ accessToken: string; accessTokenExpiresAt: string }> {
    const { repos } = this.context;
    const now = this.context.now();
    const user = await repos.users.findById(input.userId);
    if (!user) throw unauthorized('The account no longer exists.');

    const lockout = evaluateLockout(
      { failureCount: user.failedLoginCount, lastFailureAt: user.lastFailedLoginAt },
      now,
    );
    if (!lockout.allowed) {
      throw tooManyRequests(lockout.retryAfterSeconds, 'Too many failed attempts for this account.');
    }

    if (!(await verifyPassword(input.password, user.passwordHash))) {
      const next = recordFailure(
        { failureCount: user.failedLoginCount, lastFailureAt: user.lastFailedLoginAt },
        now,
      );
      await repos.users.recordLoginFailure(user.id, next.failureCount, now);
      await repos.audit.record({
        category: 'authentication',
        action: 'auth.reauthenticate',
        outcome: 'failure',
        riskLevel: 'high',
        userId: user.id,
        deviceId: input.deviceId,
        sourceIp: input.sourceIp,
        errorCode: 'bad-credentials',
      });
      throw unauthorized('The password is incorrect.');
    }

    await repos.users.recordLoginSuccess(user.id, now);
    const device = await repos.devices.findActive(input.deviceId, user.id);
    if (!device) throw unauthorized('The device is no longer authorized.');

    const issued = issueAccessToken({
      signer: this.context.signer,
      issuer: this.context.config.tokens.issuer,
      audience: this.context.config.tokens.audience,
      subject: user.id,
      deviceId: device.id,
      authTime: Math.floor(now.getTime() / 1000),
      now: now.getTime(),
    });

    await repos.audit.record({
      category: 'authentication',
      action: 'auth.reauthenticate',
      outcome: 'success',
      riskLevel: 'high',
      userId: user.id,
      deviceId: device.id,
      sourceIp: input.sourceIp,
    });

    return {
      accessToken: issued.token,
      accessTokenExpiresAt: issued.expiresAt.toISOString(),
    };
  }

  /**
   * Whether a refresh proves it comes from its device.
   *
   * A device that registered no key at sign-in is not asked: there is nothing to prove against. The
   * dashboard always registers one now; a browser signed in before it did, or a client that sends
   * none, is the stated limit — not a quiet exception.
   *
   * What the key signs is fixed by the device's recorded kind, never by the request. A phone signs its
   * refresh token; a browser, whose page never holds the token, signs the token's binding, which is
   * recomputed here from the token actually presented. Either way the signature is bound to one
   * single-use token.
   */
  private async checkDeviceProof(
    device: UserDevice,
    refreshToken: string,
    proof: RefreshProof | null,
  ): Promise<
    | { readonly outcome: 'not-required' | 'proven' }
    | { readonly outcome: 'clock'; readonly variant: RefreshProofVariant; readonly skewSeconds: number }
    | { readonly outcome: 'refused'; readonly variant: RefreshProofVariant; readonly reason: 'missing' | 'bad-signature' }
  > {
    if (!device.publicKey) return { outcome: 'not-required' };
    const variant = refreshProofVariant(device.kind);
    if (!proof) return { outcome: 'refused', variant, reason: 'missing' };

    const payload =
      variant === 'web'
        ? webRefreshProofPayload(device.id, await refreshTokenBinding(refreshToken), proof.signedAt)
        : refreshProofPayload(device.id, refreshToken, proof.signedAt);
    if (!verifySignature(device.publicKey, payload, proof.signature)) {
      return { outcome: 'refused', variant, reason: 'bad-signature' };
    }

    const skewSeconds = Math.abs(this.context.now().getTime() - new Date(proof.signedAt).getTime()) / 1000;
    if (!(skewSeconds <= REFRESH_PROOF_MAX_SKEW_SECONDS)) return { outcome: 'clock', variant, skewSeconds };
    return { outcome: 'proven' };
  }

  private async resolveDevice(userId: string, descriptor: DeviceDescriptor): Promise<UserDevice> {
    if (descriptor.id) {
      const found = await this.context.repos.devices.findActive(descriptor.id, userId);
      // A device bound to a key stays bound to it. A sign-in naming its id with another key, or none,
      // makes a new device: a password proves the owner, not possession of that device's key.
      const existing = found && (!found.publicKey || found.publicKey === (descriptor.publicKey ?? '')) ? found : null;
      if (existing) {
        await this.context.repos.devices.touch(existing.id, this.context.now());
        return existing;
      }
      // A revoked or unknown device id must not silently resurrect; a new device is
      // created instead, so the revoked one stays revoked in the device list.
    }

    return this.context.repos.devices.create({
      id: newId(),
      userId,
      kind: descriptor.kind,
      name: descriptor.name,
      platform: descriptor.platform ?? null,
      publicKey: descriptor.publicKey ?? null,
    });
  }

  private async issueTokens(input: {
    userId: string;
    device: UserDevice;
    authTime: number;
    familyId?: string;
    email: string;
    displayName: string;
  }): Promise<AuthResult> {
    const now = this.context.now();
    const access = issueAccessToken({
      signer: this.context.signer,
      issuer: this.context.config.tokens.issuer,
      audience: this.context.config.tokens.audience,
      subject: input.userId,
      deviceId: input.device.id,
      authTime: input.authTime,
      now: now.getTime(),
    });

    const refresh = createRefreshToken(input.familyId);
    const refreshExpiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000);

    await this.context.repos.refreshTokens.insert({
      tokenId: refresh.tokenId,
      familyId: refresh.familyId,
      userId: input.userId,
      deviceId: input.device.id,
      secretHash: refresh.secretHash,
      expiresAt: refreshExpiresAt,
    });

    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt.toISOString(),
      refreshToken: refresh.token,
      refreshTokenExpiresAt: refreshExpiresAt.toISOString(),
      device: input.device,
      user: { id: input.userId, email: input.email, displayName: input.displayName },
    };
  }
}
