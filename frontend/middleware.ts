import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

function isLocalHost(value: string): boolean {
  return value === 'localhost' || value === '127.0.0.1';
}

function resolveApiConnectTargets(request: NextRequest, apiBase: string): string[] {
  const targets = new Set<string>();
  const browserHost = request.nextUrl.hostname;

  if (apiBase) {
    targets.add(apiBase);
    try {
      const parsed = new URL(apiBase);
      if (isLocalHost(parsed.hostname) && !isLocalHost(browserHost)) {
        parsed.hostname = browserHost;
        targets.add(parsed.toString().replace(/\/+$/, ''));
      }
    } catch {
      // Keep raw env value only when parsing fails.
    }
    return Array.from(targets);
  }

  targets.add(`${request.nextUrl.protocol}//${browserHost}:8000`);
  return Array.from(targets);
}

function resolveWsConnectTargets(request: NextRequest, wsBase: string): string[] {
  const targets = new Set<string>();
  const browserHost = request.nextUrl.hostname;

  if (wsBase) {
    targets.add(wsBase);
    try {
      const parsed = new URL(wsBase);
      if (isLocalHost(parsed.hostname) && !isLocalHost(browserHost)) {
        parsed.hostname = browserHost;
        targets.add(parsed.toString().replace(/\/+$/, ''));
      }
    } catch {
      // Keep raw env value only when parsing fails.
    }
    return Array.from(targets);
  }

  const scheme = request.nextUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  targets.add(`${scheme}//${browserHost}:8081`);
  return Array.from(targets);
}

export function middleware(request: NextRequest) {
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64');

  const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? '';
  const wsBase = process.env.NEXT_PUBLIC_WS_BASE_URL ?? '';
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  let supabaseHost = '';
  try {
    supabaseHost = supabaseUrl ? new URL(supabaseUrl).host : '';
  } catch {
    supabaseHost = '';
  }

  const connectTargets = [
    "'self'",
    ...resolveApiConnectTargets(request, apiBase),
    ...resolveWsConnectTargets(request, wsBase),
    supabaseUrl,
    supabaseHost ? `https://${supabaseHost}` : '',
    supabaseHost ? `wss://${supabaseHost}` : '',
  ].filter(Boolean).join(' ');

  const csp = [
    "default-src 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `style-src 'self' 'unsafe-inline'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    `script-src-elem 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    `connect-src ${connectTargets}`,
    "worker-src 'self' blob:",
    "media-src 'self' blob:",
    "object-src 'none'",
    "form-action 'self'",
    "upgrade-insecure-requests",
  ].join('; ');

  const response = NextResponse.next({
    headers: { 'x-nonce': nonce },
  });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [
    { source: '/((?!_next/static|_next/image|favicon.ico).*)' },
  ],
};
