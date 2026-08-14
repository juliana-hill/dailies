import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { OAuth2Client } from 'google-auth-library';
import type { AuthenticatedUser } from '@dailies/shared';
import type { Config } from './config.js';

// Real Google sign-in for environments with no Identity-Aware Proxy in front of the API
// (this hackathon's dev/demo deployment). The API never accepts a browser-supplied
// identity: it verifies a Google-issued ID token cryptographically, then hands the
// browser a session it signed itself. authMiddleware trusts that session, not the client.

const STATE_COOKIE = 'dailies_oauth_state';
const SESSION_COOKIE = 'dailies_session';
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface GoogleSignIn {
  configured: boolean;
  start(res: Response): void;
  callback(req: Request, res: Response): Promise<void>;
  signOut(res: Response): void;
  userFromSession(req: Request): AuthenticatedUser | undefined;
}

export class DisabledGoogleSignIn implements GoogleSignIn {
  configured = false;
  start(res: Response) { res.status(503).json({ error: { code: 'GOOGLE_SIGN_IN_NOT_CONFIGURED', message: 'Google sign-in is not configured for this deployment.', retryable: false } }); }
  async callback(_req: Request, res: Response) { res.status(503).end(); }
  signOut(res: Response) { res.redirect('/'); }
  userFromSession() { return undefined; }
}

export class OAuthGoogleSignIn implements GoogleSignIn {
  configured = true;
  private readonly secret: Buffer;
  private readonly cookieSecure: boolean;

  constructor(private readonly config: Config) {
    this.secret = Buffer.from(config.SESSION_SECRET!, 'utf8');
    this.cookieSecure = config.NODE_ENV === 'production';
  }

  private oauth() {
    return new OAuth2Client({ clientId: this.config.GOOGLE_SIGN_IN_CLIENT_ID, clientSecret: this.config.GOOGLE_SIGN_IN_CLIENT_SECRET, redirectUri: this.config.GOOGLE_SIGN_IN_REDIRECT_URI });
  }

  start(res: Response) {
    const state = randomUUID();
    res.cookie(STATE_COOKIE, state, { httpOnly: true, secure: this.cookieSecure, sameSite: 'lax', maxAge: 10 * 60_000, path: '/api/auth/google' });
    const url = this.oauth().generateAuthUrl({ scope: ['openid', 'email', 'profile'], state, prompt: 'select_account' });
    res.redirect(url);
  }

  async callback(req: Request, res: Response) {
    const expectedState = readCookie(req, STATE_COOKIE);
    const state = String(req.query.state || '');
    const code = String(req.query.code || '');
    res.clearCookie(STATE_COOKIE, { path: '/api/auth/google' });
    if (!expectedState || !state || !code || !safeEqual(expectedState, state)) throw new Error('The Google sign-in request is invalid or expired');
    const oauth = this.oauth();
    const { tokens } = await oauth.getToken(code);
    if (!tokens.id_token) throw new Error('Google did not return an identity token');
    const ticket = await oauth.verifyIdToken({ idToken: tokens.id_token, audience: this.config.GOOGLE_SIGN_IN_CLIENT_ID });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email) throw new Error('Google did not return a verified identity');
    if (!payload.email_verified) throw new Error('Sign in with a verified Google email address');
    const user: AuthenticatedUser = userFromGoogle(payload.sub, payload.email, payload.name);
    const session = signSession({ sub: payload.sub, email: user.email, name: user.fullName, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS }, this.secret);
    res.cookie(SESSION_COOKIE, session, { httpOnly: true, secure: this.cookieSecure, sameSite: 'lax', maxAge: SESSION_TTL_SECONDS * 1000, path: '/' });
    res.redirect(this.config.GOOGLE_SIGN_IN_SUCCESS_URL || `${this.config.CORS_ORIGIN}/studio/`);
  }

  signOut(res: Response) {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.redirect(this.config.GOOGLE_SIGN_IN_SUCCESS_URL || `${this.config.CORS_ORIGIN}/studio/`);
  }

  userFromSession(req: Request): AuthenticatedUser | undefined {
    const token = readCookie(req, SESSION_COOKIE);
    if (!token) return undefined;
    const claims = verifySession(token, this.secret);
    if (!claims || claims.exp < Math.floor(Date.now() / 1000)) return undefined;
    return userFromGoogle(claims.sub, claims.email, claims.name);
  }
}

export function createGoogleSignIn(config: Config): GoogleSignIn {
  return config.GOOGLE_SIGN_IN_CLIENT_ID && config.GOOGLE_SIGN_IN_CLIENT_SECRET && config.GOOGLE_SIGN_IN_REDIRECT_URI && config.SESSION_SECRET
    ? new OAuthGoogleSignIn(config)
    : new DisabledGoogleSignIn();
}

function userFromGoogle(sub: string, email: string, name?: string): AuthenticatedUser {
  const fullName = name || email.split('@')[0].replace(/[._-]+/g, ' ');
  return { id: `google-oauth2:${sub}`, email: email.toLowerCase(), fullName, firstName: fullName.split(/\s+/)[0], initials: fullName.split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join(''), plan: 'Creator studio' };
}

function signSession(claims: { sub: string; email: string; name: string; exp: number }, secret: Buffer) {
  const body = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function verifySession(token: string, secret: Buffer): { sub: string; email: string; name: string; exp: number } | undefined {
  const [body, signature] = token.split('.');
  if (!body || !signature) return undefined;
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  if (!safeEqual(signature, expected)) return undefined;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return undefined; }
}

function safeEqual(a: string, b: string) {
  const bufferA = Buffer.from(a); const bufferB = Buffer.from(b);
  return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB);
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie; if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return undefined;
}
