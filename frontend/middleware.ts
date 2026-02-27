import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');

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
    apiBase,
    wsBase,
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
    "style-src 'self' 'unsafe-inline'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    `script-src-elem 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    `connect-src ${connectTargets}`,
    "worker-src 'self' blob:",
    "media-src 'self' blob:",
    "object-src 'none'",
    "form-action 'self'",
  ].join('; ');

  const response = NextResponse.next();
  response.headers.set('Content-Security-Policy', csp);
  response.headers.set('x-nonce', nonce);
  return response;
}

export const config = {
  matcher: [
    { source: '/((?!_next/static|_next/image|favicon.ico).*)' },
  ],
};
