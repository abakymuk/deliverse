/**
 * Catch-all Better-Auth route handler.
 * Handles all /api/auth/* endpoints (login, signup, callback, etc.)
 */

import { auth } from '@/lib/auth';
import { toNextJsHandler } from 'better-auth/next-js';

export const { POST, GET } = toNextJsHandler(auth);
