# Ghost Secure

Ghost Secure est une webapp de messagerie chiffrée de bout en bout (E2EE), anonyme, texte-only, avec design sombre futuriste.

## Stack
- Frontend: Next.js (App Router, TypeScript), Web Crypto API, IndexedDB
- Backend: Symfony API + Doctrine ORM
- Database: PostgreSQL
- Realtime: WebSocket (Ratchet) + polling DB sécurisé
- Audio call: WebRTC (DTLS-SRTP) + voice modifier côté client

## Fonctions implémentées
- Génération de paire de clés locale (RSA-OAEP 4096) dans le navigateur
- Clé privée stockée localement en IndexedDB
- Chiffrement hybride AES-GCM + wrapping RSA pour chaque participant
- Backend ne stocke que `ciphertext`, `iv`, `wrappedKeys`
- Messages éphémères (TTL configurable)
- Tap to reveal pour afficher un message
- Blocage sélection/copy/paste
- Masquage automatique des messages au blur/changement d'onglet
- Watermark discret avec ID utilisateur
- WebSocket temps réel pour réception messages et signalisation WebRTC
- Interface audio WebRTC + modificateur de voix (distorsion légère)

## Lancer avec Docker
```bash
docker compose up --build
```

Services:
- Frontend: `http://localhost:3000`
- API Symfony: `http://localhost:8000`
- WebSocket: `ws://localhost:8081`

## Lancer sans Docker
### Backend
```bash
cd backend
composer install
php bin/console doctrine:migrations:migrate --no-interaction
php -S 0.0.0.0:8000 -t public
```

Dans un second terminal:
```bash
cd backend
php bin/console app:ws-server
```

### Frontend
```bash
cd frontend
npm install
cp .env.example .env.local
npm run dev
```

## Endpoints API
- `POST /api/auth/register`
- `GET /api/conversations`
- `POST /api/conversations`
- `GET /api/conversations/{id}`
- `GET /api/conversations/{id}/messages`
- `POST /api/conversations/{id}/messages`
- `GET /api/health`

## Notes sécurité
- Le serveur ne reçoit jamais la clé privée.
- Le serveur ne peut pas lire le contenu des messages.
- Les appels WebRTC sont chiffrés au niveau transport (DTLS-SRTP).
- Pour production: ajouter rate limiting, rotation token, CSP stricte, audit crypto, HSM/KMS pour secrets serveur.

## Préparation iOS/Swift
- Le protocole E2EE est compatible avec un portage Swift (CryptoKit + WebSocket + WebRTC).
- Les formats échangés (`ciphertext`, `iv`, `wrappedKeys`) sont déjà prêts pour une implémentation mobile native.
