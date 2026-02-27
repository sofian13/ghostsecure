# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Ghost Secure is an end-to-end encrypted (E2EE) messaging web application. The UI is in French. It uses RSA-OAEP 4096-bit + AES-GCM hybrid encryption where private keys never leave the client browser.

## Build & Development Commands

### Docker (full stack)
```bash
docker compose up --build
```
Services: frontend (:3000), API (:8000), WebSocket (:8081), PostgreSQL (:5432), Adminer (:8080)

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
cd backend && php -S 0.0.0.0:8000 -t public    # HTTP API server
cd backend && php bin/console app:ws-server      # WebSocket server on :8081 (separate terminal)
```

### Pre-PR checklist
```bash
cd frontend && npm run lint && npm run build
cd backend && php bin/console doctrine:migrations:migrate --no-interaction
# Verify API + WS servers start successfully
```

No automated test suite exists yet. Manual validation covers: login, conversation list, send/receive messages, and call signaling.

## Architecture

**Monorepo** with two main applications:

- **`frontend/`** — Next.js App Router. Routes in `app/`, reusable components in `components/`, core utilities in `lib/`, shared types in `types/index.ts`.
- **`backend/`** — Symfony API. Controllers in `src/Controller/`, Doctrine entities in `src/Entity/`, services in `src/Service/`, CLI commands in `src/Command/`, migrations in `migrations/`.
- **`supabase/`** — SQL schema artifacts (Supabase used for friend requests/supplementary features).
- **`docker-compose.yml`** — Orchestrates all services.

### Encryption flow (critical context)

1. Client generates RSA-4096 keypair via Web Crypto API; private key stored in IndexedDB (`lib/idb.ts`), public key sent to server on registration.
2. To send a message: generate random AES-256 key, encrypt plaintext with AES-GCM, wrap the AES key with each recipient's RSA public key.
3. Backend stores only `{ciphertext, iv, wrappedKeys}` — it cannot decrypt messages.
4. Recipient unwraps their AES key with their private key and decrypts.
5. All crypto logic is in `frontend/lib/crypto.ts`.

### Key backend components

- **AuthController** — Registration/login with bcrypt password hashing, session tokens (32 random bytes, SHA-256 hashed in DB), IP-based rate limiting.
- **ConversationController** — CRUD for conversations and messages; supports `direct` and `group` conversation kinds; handles ephemeral message expiry.
- **WsServerCommand** — Ratchet WebSocket server for real-time message delivery and WebRTC call signaling.
- **JsonFactory** — Centralized JSON response builder with CORS headers.

### Key frontend components

- **SecurityShell** — App wrapper enforcing security features (blur/tab-switch masking, copy/paste blocking, user watermark).
- **`lib/api.ts`** — HTTP client; dynamically resolves API base URL for non-localhost deployments.
- **`lib/useRealtime.ts`** — WebSocket polling hook for real-time updates.
- **`app/chat/[id]/page.tsx`** — Conversation view with message decryption and rendering.
- **`app/call/page.tsx`** — WebRTC audio calls with client-side voice modification.

### Database (PostgreSQL 16, Doctrine ORM)

Five tables: `app_user`, `conversation`, `conversation_member`, `message`, `user_session`. Schema managed via Doctrine migrations in `backend/migrations/`.

## Coding Conventions

- **TypeScript/React**: 2-space indentation, PascalCase components, camelCase functions/variables, lowercase route folders. Path alias `@/*` maps to project root.
- **PHP/Symfony**: PSR-12, 4-space indentation, PascalCase classes, camelCase methods, one class per file.
- **Commits**: `Verb + scope + intent` imperative style (e.g., `Fix ws auth token parsing`, `Add group chats with member add and leave flows`).

## Environment Variables

**Frontend** (`.env.local`): `NEXT_PUBLIC_API_BASE_URL`, `NEXT_PUBLIC_WS_BASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, TURN server credentials.

**Backend** (`.env`): `APP_ENV`, `APP_SECRET`, `DATABASE_URL`, `APP_ALLOWED_ORIGINS` (CORS whitelist), `APP_SESSION_TTL_SECONDS`, `APP_MAX_SESSIONS_PER_USER`.

## Important Constraints

- Keep frontend and backend changes scoped to their folders; avoid cross-layer coupling.
- Crypto and session logic stays in `frontend/lib/`; domain logic stays in `backend/src/Service/`.
- The server must never handle plaintext messages or private keys.
- CORS origins are validated against `APP_ALLOWED_ORIGINS` in `JsonFactory`.
- CSP and security headers are configured in `frontend/next.config.js`.
