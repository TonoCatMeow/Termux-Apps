// Simple local authentication: password login + HMAC-signed session cookie.
//
// PANEL_PASSWORD  - login password (default: "pi")
// PANEL_SECRET    - HMAC secret; random per process start if unset, which
//                   simply invalidates all sessions on restart.

import crypto from 'crypto';
import { NextFunction, Request, Response } from 'express';

const PASSWORD = process.env.PANEL_PASSWORD || 'pi';
const SECRET = process.env.PANEL_SECRET || crypto.randomBytes(32).toString('hex');
const TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

export const SESSION_COOKIE = 'panel_session';

export function createToken(): string {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + TTL_MS })).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyToken(token?: string | null): boolean {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expect = crypto.createHmac('sha256', SECRET).update(payload).digest();
  let got: Buffer;
  try {
    got = Buffer.from(sig, 'base64url');
  } catch {
    return false;
  }
  if (expect.length !== got.length || !crypto.timingSafeEqual(expect, got)) return false;
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof p.exp === 'number' && p.exp > Date.now();
  } catch {
    return false;
  }
}

export function checkPassword(pw: unknown): boolean {
  const a = Buffer.from(String(pw ?? ''));
  const b = Buffer.from(PASSWORD);
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

export function parseCookieHeader(header?: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try {
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
      }
    }
  }
  return out;
}

export function tokenFromRequest(req: Request): string | null {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  return parseCookieHeader(req.headers.cookie)[SESSION_COOKIE] || null;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (verifyToken(tokenFromRequest(req))) {
    next();
    return;
  }
  res.status(401).json({ error: 'unauthorized' });
}

export const sessionTtlSeconds = TTL_MS / 1000;
