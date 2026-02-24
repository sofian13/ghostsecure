# Repository Guidelines

## Project Structure & Module Organization
This repository is a full-stack encrypted chat app.

- `frontend/`: Next.js 16 + TypeScript UI (`app/` routes, `components/`, `lib/`, `types/`).
- `backend/`: Symfony 7 API + WebSocket command (controllers in `src/Controller`, entities in `src/Entity`, services in `src/Service`, migrations in `migrations/`).
- `supabase/`: SQL and Supabase-related setup artifacts.
- `tools/`: local helper scripts/utilities.
- `docker-compose.yml`: orchestrates `frontend`, `backend`, `ws`, `postgres`, and `adminer`.

Keep frontend and backend changes scoped to their folders; avoid cross-layer coupling in shared files.

## Build, Test, and Development Commands
- `docker compose up --build`: starts full stack locally.
- `cd frontend && npm run dev`: runs Next.js dev server on `:3000`.
- `cd frontend && npm run build`: production build check.
- `cd frontend && npm run lint`: ESLint checks for TS/React code.
- `cd backend && composer install`: installs PHP dependencies.
- `cd backend && php bin/console doctrine:migrations:migrate --no-interaction`: applies DB migrations.
- `cd backend && php -S 0.0.0.0:8000 -t public`: runs Symfony HTTP API.
- `cd backend && php bin/console app:ws-server`: runs WebSocket server.

## Coding Style & Naming Conventions
- TypeScript/React: 2-space indentation, PascalCase for components (`MessageBubble.tsx`), camelCase for functions/variables, route folders in lowercase.
- PHP/Symfony: PSR-12 conventions, 4-space indentation, PascalCase classes, camelCase methods, one class per file.
- Prefer small, single-purpose services/controllers; keep crypto/session logic in `frontend/lib/` and domain logic in `backend/src/Service/`.

## Testing Guidelines
There is currently no committed automated test suite in `frontend/tests` or `backend/tests`.

Minimum validation before opening a PR:
- Run `npm run lint` and `npm run build` in `frontend/`.
- Run backend migrations and start both API + WS services.
- Manually verify login, conversation list, send/receive message, and call signaling paths.

When adding tests, use descriptive names such as `AuthControllerTest.php` or `chat-page.spec.ts`.

## Commit & Pull Request Guidelines
Recent commits use short, imperative messages (e.g., `Fix client env access for Supabase URL/key`).

- Commit format: `Verb + scope + intent` (example: `Fix ws auth token parsing`).
- Keep commits focused and atomic.
- PRs should include: summary, impacted areas (`frontend`, `backend`, infra), manual test steps, and screenshots/GIFs for UI changes.
- Link related issue/ticket when available, and note any env var or migration changes explicitly.
