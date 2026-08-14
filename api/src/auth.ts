import { createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { AuthenticatedUser } from '@dailies/shared';
import type { GoogleSignIn } from './googleSignIn.js';

declare global { namespace Express { interface Request { user?: AuthenticatedUser } } }
const headerValue = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;
const cleanIap = (value?: string) => value?.replace(/^accounts\.google\.com:/, '');
const userFromEmail = (email: string, name?: string): AuthenticatedUser => {
  const fullName = name || email.split('@')[0].replace(/[._-]+/g, ' ');
  return { id: createHash('sha256').update(email.toLowerCase()).digest('hex'), email: email.toLowerCase(), fullName, firstName: fullName.split(/\s+/)[0], initials: fullName.split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join(''), plan: 'Creator studio' };
};

// Two verified identity sources, either of which the browser cannot forge:
// 1. Identity-Aware Proxy headers, injected by Google Cloud's HTTPS ingress in production.
// 2. A session this API itself signed after verifying a real Google ID token
//    (googleSignIn.ts) — for deployments with no IAP-fronted ingress.
export const authMiddleware = (googleSignIn?: GoogleSignIn) => (req: Request, _res: Response, next: NextFunction) => {
  const email = cleanIap(headerValue(req.headers['x-goog-authenticated-user-email']));
  const id = cleanIap(headerValue(req.headers['x-goog-authenticated-user-id']));
  if (email && id) req.user = { ...userFromEmail(email, headerValue(req.headers['x-goog-authenticated-user-name'])), id };
  else req.user = googleSignIn?.userFromSession(req);
  next();
};
export const requireAuth = (req: Request, res: Response, next: NextFunction) => req.user ? next() : res.status(401).json({ error: { code: 'AUTH_REQUIRED', message: 'Sign in with the configured Google identity provider.', retryable: false } });
