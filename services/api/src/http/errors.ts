import { WolfError } from '@wolf/shared-types';
import type { ErrorArea } from '@wolf/shared-types';

/**
 * Error factories.
 *
 * Every failure the API returns names the problem, the cause, the current state, and what
 * to do next. "Something went wrong" is never an acceptable answer, so there is no generic
 * factory here — each situation gets a specific one.
 */

export function unauthorized(cause: string, area: ErrorArea = 'AUTH'): WolfError {
  return new WolfError({
    code: 'auth.unauthorized',
    problem: 'You are not signed in.',
    cause,
    currentState: 'The request was not performed.',
    recommendedAction: 'Sign in again and retry.',
    area,
    httpStatus: 401,
  });
}

export function forbidden(cause: string, recommendedAction: string): WolfError {
  return new WolfError({
    code: 'auth.forbidden',
    problem: 'This action is not permitted for the current session.',
    cause,
    currentState: 'Nothing was changed.',
    recommendedAction,
    area: 'AUTH',
    httpStatus: 403,
  });
}

export function notFound(what: string): WolfError {
  return new WolfError({
    code: 'resource.not_found',
    problem: `${what} was not found.`,
    cause: 'No matching record exists for this account.',
    currentState: 'Nothing was changed.',
    recommendedAction: 'Refresh the list and try again.',
    area: 'API',
    httpStatus: 404,
  });
}

export function conflict(problem: string, cause: string, recommendedAction: string): WolfError {
  return new WolfError({
    code: 'resource.conflict',
    problem,
    cause,
    currentState: 'Nothing was changed.',
    recommendedAction,
    area: 'API',
    httpStatus: 409,
  });
}

export function tooManyRequests(retryAfterSeconds: number, cause: string): WolfError {
  return new WolfError({
    code: 'rate.limited',
    problem: 'Too many attempts.',
    cause,
    currentState: 'The request was rejected without being processed.',
    recommendedAction: `Wait ${retryAfterSeconds} seconds and try again.`,
    area: 'AUTH',
    httpStatus: 429,
    detail: { retryAfterSeconds },
    context: { retryAfterSeconds },
  });
}

export function pcOffline(pcName: string): WolfError {
  return new WolfError({
    code: 'pc.offline',
    problem: `${pcName} is not connected.`,
    cause: 'The WOLF agent on this PC has no active link to the cloud.',
    currentState: 'The command was not queued.',
    recommendedAction:
      'Check that the PC is powered on and online, or wake it from the Power section.',
    area: 'AGENT',
    httpStatus: 409,
  });
}

export function killSwitchEngaged(pcName: string): WolfError {
  return new WolfError({
    code: 'pc.remote_access_disabled',
    problem: `Remote access to ${pcName} is disabled.`,
    cause: 'The WOLF kill switch is engaged for this PC.',
    currentState: 'The command was rejected and nothing ran on the PC.',
    recommendedAction:
      'Re-enable remote access from the WOLF Control Panel on the PC itself. ' +
      'For security, this cannot be done remotely.',
    area: 'AGENT',
    httpStatus: 409,
  });
}

/**
 * The agent build on this PC does not implement the command. Reported explicitly rather
 * than queueing something that can never run.
 */
export function unsupportedCommand(commandType: string, pcName: string): WolfError {
  return new WolfError({
    code: 'command.unsupported',
    problem: `${pcName} cannot perform this action.`,
    cause: `The agent installed on this PC does not implement "${commandType}".`,
    currentState: 'The command was not queued.',
    recommendedAction: 'Update the WOLF agent on this PC, then try again.',
    area: 'CMD',
    httpStatus: 409,
  });
}

export function missingCapability(capability: string): WolfError {
  return new WolfError({
    code: 'session.capability_missing',
    problem: 'This session is not authorized for that capability.',
    cause: `The session was created without the "${capability}" capability.`,
    currentState: 'Nothing was changed.',
    recommendedAction: 'Start a session that requests this capability, then retry.',
    area: 'AUTH',
    httpStatus: 403,
  });
}

export function confirmationRequired(action: string, riskLevel: string): WolfError {
  return new WolfError({
    code: 'command.confirmation_required',
    problem: `${action} needs to be confirmed.`,
    cause: `This action is classified ${riskLevel} risk.`,
    currentState: 'Nothing was changed.',
    recommendedAction: 'Confirm the action to proceed.',
    area: 'CMD',
    httpStatus: 428,
    // The client re-sends this exact level with the confirmation. A UI that showed a
    // milder level cannot confirm the stronger action by accident.
    context: { riskLevel, action },
  });
}

export function reauthenticationRequired(action: string, maxAgeSeconds: number): WolfError {
  return new WolfError({
    code: 'command.reauth_required',
    problem: `${action} needs your password.`,
    cause: `This action requires a password re-entry within the last ${maxAgeSeconds} seconds.`,
    currentState: 'Nothing was changed.',
    recommendedAction: 'Re-enter your password and retry the action.',
    area: 'AUTH',
    httpStatus: 428,
    context: { maxAgeSeconds, action },
  });
}

export function privilegedGrantRequired(action: string): WolfError {
  return new WolfError({
    code: 'command.privileged_grant_required',
    problem: `${action} requires privileged authorization.`,
    cause: 'This action is classified critical risk and needs an explicit privileged grant.',
    currentState: 'Nothing was changed.',
    recommendedAction: 'Request privileged authorization for this session, then retry.',
    area: 'PRIV',
    httpStatus: 428,
    context: { riskLevel: 'critical', action },
  });
}

export function internalError(cause: string, detail?: unknown): WolfError {
  return new WolfError({
    code: 'internal.error',
    problem: 'WOLF could not complete the request.',
    cause,
    currentState: 'The request may not have been applied. Check the PC before retrying.',
    recommendedAction: 'Retry. If it keeps happening, check the service logs for the reference id.',
    area: 'API',
    httpStatus: 500,
    detail,
  });
}
