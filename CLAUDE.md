# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Ghost Secure is an end-to-end encrypted (E2EE) messaging web application. The UI is in French. It uses RSA-OAEP 4096-bit + AES-GCM hybrid encryption where private keys never leave the client browser. Production is deployed on Dokploy with a VPS and Supabase PostgreSQL in Singapore.

## Build & Development Commands

### Docker (full stack)
```bash
docker compose up --build                        # prod services (backend, ws, frontend)
docker compose --profile dev up --build           # includes local PostgreSQL for dev
```
Services: frontend (:3000), API (:8000), WebSocket (:8081)

### Frontend (Next.js 16 + TypeScript 5.8 + React 19)
```bash
cd frontend && npm install
cd frontend && npm run dev       # Dev server on :3000
cd frontend && npm run build     # Production build
cd frontend && npm run lint      # ESLint
```

### Backend (Symfony 7.1 + PHP 8.4 + Doctrine)
```bash
cd backend && composer install
cd backend && php bin/console doctrine:migrations:migrate --no-interaction
cd backend && php -S 0.0.0.0:8000 -t public    # Local dev only (prod uses PHP-FPM + Caddy)
cd backend && php bin/console app:ws-server      # WebSocket server on :8081 (separate terminal)
cd backend && php bin/console app:purge-expired  # Manually purge expired ephemeral messages
```

### Pre-PR checklist
```bash
cd frontend && npm run lint && npm run build
cd backend && php bin/console doctrine:migrations:migrate --no-interaction
```
No automated test suite exists yet. Manual validation covers: login, conversation list, send/receive messages, and call signaling.

## Architecture

**Monorepo** with two main applications:

- **`frontend/`** — Next.js App Router. Routes in `app/`, reusable components in `components/`, core utilities in `lib/`, shared types in `types/index.ts`.
- **`backend/`** — Symfony API served by PHP-FPM + Caddy (config in `docker/Caddyfile`). Controllers in `src/Controller/`, Doctrine entities in `src/Entity/`, services in `src/Service/`, CLI commands in `src/Command/`, migrations in `migrations/`.
- **`supabase/`** — SQL schema artifacts. Supabase is used for friend requests, call signaling, and realtime subscriptions (`useRealtime.ts` uses Supabase channels, not the custom WS server).
- **`docker-compose.yml`** — Orchestrates services. PostgreSQL service is `profiles: ["dev"]` only (production uses external Supabase DB).

### Encryption flow (critical context)

1. Client generates RSA-4096 keypair via Web Crypto API; private key stored in IndexedDB only (`lib/idb.ts` — no localStorage fallback), public key sent to server on registration.
2. To send a message: generate random AES-256 key, encrypt plaintext with AES-GCM, wrap the AES key with each recipient's RSA public key.
3. Backend stores only `{ciphertext, iv, wrappedKeys}` — it cannot decrypt messages.
4. Recipient unwraps their AES key with their private key and decrypts.
5. All crypto logic is in `frontend/lib/crypto.ts`.

### Key backend components

- **AuthController** — Registration/login with bcrypt password hashing, session tokens (32 random bytes, SHA-256 hashed in DB), IP-based rate limiting via `AuthThrottleService`.
- **ConversationController** — CRUD for conversations and messages; supports `direct` and `group` kinds; paginated message retrieval (latest N, default 200, max 500); expired message filtering in SQL.
- **WsServerCommand** — Ratchet WebSocket server for real-time message delivery and WebRTC call signaling. Auth via first message (`{"type":"auth","token":"..."}`), not query string. Includes periodic purge of expired messages.
- **PurgeExpiredMessagesCommand** — Standalone `app:purge-expired` command to delete expired ephemeral messages.
- **JsonFactory** — Centralized JSON response builder with CORS and security headers.

### Key frontend components

- **SecurityShell** — App wrapper enforcing security features (blur/tab-switch masking, copy/paste blocking, user watermark).
- **`middleware.ts`** — Next.js middleware generating per-request CSP nonces. CSP uses `nonce` + `strict-dynamic` (no `unsafe-inline` for scripts in production).
- **`lib/api.ts`** — HTTP client; dynamically resolves API base URL for non-localhost deployments.
- **`lib/idb.ts`** — IndexedDB wrapper for private key storage. Includes one-shot migration from legacy localStorage fallback. No insecure fallback — throws if IndexedDB unavailable.
- **`lib/useRealtime.ts`** — Supabase realtime subscription hook for incoming messages.
- **`app/chat/[id]/page.tsx`** — Conversation view with message decryption and rendering.
- **`app/call/page.tsx`** — WebRTC audio calls with client-side voice modification (presets: ghost, robot, deep, vader).

### Database (PostgreSQL 16 via Supabase, Doctrine ORM)

Five tables: `app_user`, `conversation`, `conversation_member`, `message`, `user_session`. Schema managed via Doctrine migrations in `backend/migrations/`. Supabase also has `friend_request` and `call_invite` tables managed client-side.

## Coding Conventions

- **TypeScript/React**: 2-space indentation, PascalCase components, camelCase functions/variables, lowercase route folders. Path alias `@/*` maps to project root.
- **PHP/Symfony**: PSR-12, 4-space indentation, PascalCase classes, camelCase methods, one class per file.
- **Commits**: `Verb + scope + intent` imperative style (e.g., `Fix ws auth token parsing`, `Add group chats with member add and leave flows`).

## Environment Variables

**Frontend** (`.env.local`): `NEXT_PUBLIC_API_BASE_URL`, `NEXT_PUBLIC_WS_BASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, TURN server credentials (`NEXT_PUBLIC_TURN_URL`, `_USERNAME`, `_CREDENTIAL`).

**Backend** (`.env`): `APP_ENV`, `APP_SECRET`, `DATABASE_URL`, `APP_ALLOWED_ORIGINS` (CORS whitelist), `APP_WS_ALLOW_EMPTY_ORIGIN`, `APP_SESSION_TTL_SECONDS`, `APP_MAX_SESSIONS_PER_USER`, rate-limit vars (`APP_AUTH_RATE_LIMIT_{SCOPE}_{MAX|WINDOW}`).

## Important Constraints

- Keep frontend and backend changes scoped to their folders; avoid cross-layer coupling.
- Crypto and session logic stays in `frontend/lib/`; domain logic stays in `backend/src/Service/`.
- The server must never handle plaintext messages or private keys.
- Private keys must only be stored in IndexedDB — never localStorage or any other accessible storage.
- CORS is handled at two layers: Caddy (`backend/docker/Caddyfile`) for preflight/headers, and `JsonFactory` for PHP-level response headers.
- CSP with nonces is set in `frontend/middleware.ts` — security headers without CSP are in `frontend/next.config.js`.
- The WS server authenticates via the first message after connection (not the URL query string) to prevent token leakage in logs.
- Production database is external Supabase PostgreSQL (not the local Docker postgres service).
