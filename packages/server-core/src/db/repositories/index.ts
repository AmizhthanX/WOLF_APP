import type { Database } from '../pool.js';
import { AuditRepository } from './audit.js';
import { CommandRepository } from './commands.js';
import { DeviceRepository } from './devices.js';
import { EnrollmentRepository } from './enrollment.js';
import { PcRepository } from './pcs.js';
import { RefreshTokenRepository } from './refresh-tokens.js';
import { RemoteDesktopRepository } from './remote-desktop.js';
import { SessionRepository } from './sessions.js';
import { TelemetryRepository } from './telemetry.js';
import { UserRepository } from './users.js';

export * from './audit.js';
export * from './commands.js';
export * from './devices.js';
export * from './enrollment.js';
export * from './pcs.js';
export * from './refresh-tokens.js';
export * from './remote-desktop.js';
export * from './sessions.js';
export * from './telemetry.js';
export * from './users.js';

export interface Repositories {
  readonly users: UserRepository;
  readonly devices: DeviceRepository;
  readonly refreshTokens: RefreshTokenRepository;
  readonly pcs: PcRepository;
  readonly enrollment: EnrollmentRepository;
  readonly sessions: SessionRepository;
  readonly commands: CommandRepository;
  readonly remoteDesktop: RemoteDesktopRepository;
  readonly telemetry: TelemetryRepository;
  readonly audit: AuditRepository;
}

export function createRepositories(db: Database): Repositories {
  return {
    users: new UserRepository(db),
    devices: new DeviceRepository(db),
    refreshTokens: new RefreshTokenRepository(db),
    pcs: new PcRepository(db),
    enrollment: new EnrollmentRepository(db),
    sessions: new SessionRepository(db),
    commands: new CommandRepository(db),
    remoteDesktop: new RemoteDesktopRepository(db),
    telemetry: new TelemetryRepository(db),
    audit: new AuditRepository(db),
  };
}
