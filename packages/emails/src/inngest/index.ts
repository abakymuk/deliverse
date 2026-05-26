/**
 * Inngest function registry — single source of truth for what the platform
 * app's `/api/inngest` route handler registers.
 *
 * Both apps' `inngest` clients are the same instance (re-exported from
 * `./client`). Only `apps/platform/src/app/api/inngest/route.ts` should
 * pass `functions` to `serve()`. Per ADR-0009 decision #5, double
 * registration causes duplicate sends.
 */

import type { InngestFunction } from 'inngest';
import { otpRequestedHandler } from './otp';

export { inngest } from './client';
export { otpRequestedHandler };

export const functions: InngestFunction.Any[] = [otpRequestedHandler];
