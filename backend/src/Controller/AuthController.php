<?php

namespace App\Controller;

use App\Entity\User;
use App\Service\AuthService;
use App\Service\AuthThrottleService;
use App\Service\JsonFactory;
use Doctrine\ORM\EntityManagerInterface;
use Psr\Log\LoggerInterface;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Routing\Attribute\Route;

#[Route('/api')]
class AuthController
{
    public function __construct(
        private readonly EntityManagerInterface $em,
        private readonly AuthService $auth,
        private readonly AuthThrottleService $throttle,
        private readonly JsonFactory $json,
        private readonly LoggerInterface $logger
    ) {
    }

    #[Route('/auth/register', name: 'api_auth_register', methods: ['POST', 'OPTIONS'])]
    public function register(Request $request)
    {
        if ($request->isMethod('OPTIONS')) {
            return $this->json->ok(['ok' => true]);
        }

        if (!$this->isJsonContentType($request)) {
            return $this->json->error('Content-Type must be application/json.', 415);
        }

        $ip = $this->extractClientIp($request);
        $globalKey = sprintf('ip:%s', $ip);
        if (!$this->throttle->isAllowed('register', $globalKey)) {
            $this->logger->warning('Register rate limit hit', ['ip' => $ip]);
            return $this->json->error('Too many registration attempts. Try again later.', 429);
        }

        $payload = json_decode($request->getContent(), true);
        if (!is_array($payload)) {
            return $this->json->error('Invalid JSON body.', 400);
        }

        $publicKey = trim((string) ($payload['publicKey'] ?? ''));
        $userId = trim((string) ($payload['userId'] ?? ''));
        $secret = (string) ($payload['secret'] ?? '');

        if ($publicKey === '' || $userId === '' || $secret === '') {
            return $this->json->error('publicKey, userId and secret are required.', 422);
        }

        if (!preg_match('/^[a-z0-9_-]{3,24}$/', $userId)) {
            return $this->json->error('userId format is invalid.', 422);
        }
        if (strlen($secret) < 8 || strlen($secret) > 72) {
            return $this->json->error('secret must be between 8 and 72 characters.', 422);
        }

        $existing = $this->em->getRepository(User::class)->find($userId);
        if ($existing instanceof User) {
            return $this->json->error('Registration failed.', 409);
        }

        if (!$this->validatePublicKey($publicKey)) {
            return $this->json->error('Invalid public key format.', 422);
        }

        $proof = trim((string) ($payload['proof'] ?? ''));
        if ($proof !== '') {
            $derBytes = base64_decode($publicKey, true);
            if ($derBytes === false) {
                return $this->json->error('Invalid public key encoding.', 422);
            }
            $pem = "-----BEGIN PUBLIC KEY-----\n" . chunk_split(base64_encode($derBytes), 64, "\n") . "-----END PUBLIC KEY-----";
            $sig = base64_decode($proof, true);
            if ($sig === false) {
                return $this->json->error('Invalid proof encoding.', 422);
            }
            $pubKeyResource = openssl_pkey_get_public($pem);
            if ($pubKeyResource === false) {
                return $this->json->error('Invalid public key for proof verification.', 422);
            }
            $ok = openssl_verify($userId, $sig, $pubKeyResource, OPENSSL_ALGO_SHA256);
            if ($ok !== 1) {
                return $this->json->error('Proof of key possession failed.', 422);
            }
        }

        $user = new User($userId, $publicKey);
        $user->setSecretHash(password_hash($secret, PASSWORD_DEFAULT));
        $ecdhPublicKey = trim((string) ($payload['ecdhPublicKey'] ?? ''));
        if ($ecdhPublicKey !== '') {
            $user->setEcdhPublicKey($ecdhPublicKey);
        }

        // Optional inline pre-key bundle at registration
        $preKeyBundle = $payload['preKeyBundle'] ?? null;
        if (is_array($preKeyBundle)) {
            $ik = trim((string) ($preKeyBundle['identityKey'] ?? ''));
            $spk = trim((string) ($preKeyBundle['signedPrekey'] ?? ''));
            $spkSig = trim((string) ($preKeyBundle['signedPrekeySignature'] ?? ''));
            $regId = (int) ($preKeyBundle['registrationId'] ?? 0);
            if ($ik !== '' && $spk !== '' && $spkSig !== '' && $regId > 0) {
                $user->setIdentityKey($ik);
                $user->setSignedPrekey($spk);
                $user->setSignedPrekeySignature($spkSig);
                $user->setRegistrationId($regId);
            }
        }

        $this->em->persist($user);

        $this->em->flush();

        // Insert OTPKs after flush so user row exists
        if (is_array($preKeyBundle) && is_array($preKeyBundle['oneTimePreKeys'] ?? null)) {
            $conn = $this->em->getConnection();
            foreach ($preKeyBundle['oneTimePreKeys'] as $otpk) {
                if (!is_array($otpk)) {
                    continue;
                }
                $keyId = (int) ($otpk['keyId'] ?? 0);
                $pk = trim((string) ($otpk['publicKey'] ?? ''));
                if ($keyId <= 0 || $pk === '') {
                    continue;
                }
                $conn->executeStatement(
                    'INSERT INTO one_time_prekey (id, user_id, key_id, public_key, created_at)
                     VALUES (gen_random_uuid(), :uid, :kid, :pk, NOW())
                     ON CONFLICT (user_id, key_id) DO NOTHING',
                    ['uid' => $userId, 'kid' => $keyId, 'pk' => $pk]
                );
            }
        }
        $token = $this->auth->issueToken($user);
        $ttl = $this->auth->getSessionTtl();
        $this->logger->info('User registered', ['userId' => $userId]);

        return $this->json->okWithCookie([
            'userId' => $user->getId(),
            'publicKey' => $user->getPublicKey(),
            'expiresAt' => (new \DateTimeImmutable(sprintf('+%d seconds', $ttl)))->format(DATE_ATOM),
        ], $token, $ttl, 201);
    }

    #[Route('/auth/login', name: 'api_auth_login', methods: ['POST', 'OPTIONS'])]
    public function login(Request $request)
    {
        if ($request->isMethod('OPTIONS')) {
            return $this->json->ok(['ok' => true]);
        }

        if (!$this->isJsonContentType($request)) {
            return $this->json->error('Content-Type must be application/json.', 415);
        }

        $ip = $this->extractClientIp($request);
        $globalKey = sprintf('ip:%s', $ip);
        if (!$this->throttle->isAllowed('login', $globalKey)) {
            $this->logger->warning('Login rate limit hit', ['ip' => $ip]);
            return $this->json->error('Too many login attempts. Try again later.', 429);
        }

        $payload = json_decode($request->getContent(), true);
        if (!is_array($payload)) {
            return $this->json->error('Invalid JSON body.', 400);
        }

        $userId = trim((string) ($payload['userId'] ?? ''));
        $secret = (string) ($payload['secret'] ?? '');
        $userScopeKey = sprintf('ip:%s:user:%s', $ip, strtolower($userId));
        if ($userId !== '' && !$this->throttle->isAllowed('login_user', $userScopeKey)) {
            $this->logger->warning('Login user rate limit hit', ['userId' => $userId, 'ip' => $ip]);
            return $this->json->error('Too many login attempts. Try again later.', 429);
        }

        $userOnlyKey = sprintf('user:%s', strtolower($userId));
        if ($userId !== '' && !$this->throttle->isAllowed('login_user_only', $userOnlyKey)) {
            $this->logger->warning('Login user-only rate limit hit', ['userId' => $userId]);
            return $this->json->error('Too many login attempts. Try again later.', 429);
        }

        if ($userId === '' || $secret === '') {
            return $this->json->error('userId and secret are required.', 422);
        }

        $user = $this->em->getRepository(User::class)->find($userId);
        if (!$user instanceof User) {
            $this->logger->notice('Login failed: user not found', ['userId' => $userId, 'ip' => $ip]);
            return $this->json->error('Invalid credentials.', 401);
        }

        $hash = $user->getSecretHash();
        if (!is_string($hash) || $hash === '') {
            $this->logger->notice('Login failed: no secret hash', ['userId' => $userId, 'ip' => $ip]);
            return $this->json->error('Invalid credentials.', 401);
        }
        if (!password_verify($secret, $hash)) {
            $this->logger->notice('Login failed: wrong password', ['userId' => $userId, 'ip' => $ip]);
            return $this->json->error('Invalid credentials.', 401);
        }

        $token = $this->auth->issueToken($user);
        $ttl = $this->auth->getSessionTtl();
        $this->throttle->reset('login_user', $userScopeKey);
        $this->throttle->reset('login_user_only', $userOnlyKey);
        $this->logger->info('Login success', ['userId' => $userId]);

        return $this->json->okWithCookie([
            'userId' => $user->getId(),
            'publicKey' => $user->getPublicKey(),
            'expiresAt' => (new \DateTimeImmutable(sprintf('+%d seconds', $ttl)))->format(DATE_ATOM),
        ], $token, $ttl);
    }

    #[Route('/auth/logout', name: 'api_auth_logout', methods: ['POST', 'OPTIONS'])]
    public function logout(Request $request)
    {
        if ($request->isMethod('OPTIONS')) {
            return $this->json->ok(['ok' => true]);
        }

        $token = '';
        $auth = trim((string) $request->headers->get('Authorization', ''));
        if (str_starts_with($auth, 'Bearer ')) {
            $token = substr($auth, 7);
        }
        if ($token === '') {
            $token = (string) $request->cookies->get('ghost_token', '');
        }
        if ($token === '') {
            return $this->json->error('Missing token.', 401);
        }

        $tokenHash = hash('sha256', $token);

        $this->em->getConnection()->executeStatement(
            'DELETE FROM user_session WHERE token_hash = :hash',
            ['hash' => $tokenHash]
        );

        $response = $this->json->ok(['ok' => true]);
        $response->headers->clearCookie('ghost_token', '/');
        return $response;
    }

    #[Route('/auth/logout-all', name: 'api_auth_logout_all', methods: ['POST', 'OPTIONS'])]
    public function logoutAll(Request $request)
    {
        if ($request->isMethod('OPTIONS')) {
            return $this->json->ok(['ok' => true]);
        }

        $me = $this->auth->requireUser($request);
        if (!$me instanceof User) {
            return $this->json->error('Unauthorized.', 401);
        }

        $deleted = $this->em->getConnection()->executeStatement(
            'DELETE FROM user_session WHERE user_id = :uid',
            ['uid' => $me->getId()]
        );
        $this->logger->info('Logout all sessions', ['userId' => $me->getId(), 'count' => $deleted]);

        return $this->json->ok(['ok' => true, 'sessionsRevoked' => $deleted]);
    }

    private function validatePublicKey(string $publicKey): bool
    {
        $len = strlen($publicKey);
        if ($len < 500 || $len > 5000) {
            return false;
        }
        return (bool) preg_match('#^[A-Za-z0-9+/=\s]+$#', $publicKey);
    }

    private function isJsonContentType(Request $request): bool
    {
        $contentType = (string) $request->headers->get('Content-Type', '');
        return str_contains($contentType, 'application/json');
    }

    private function extractClientIp(Request $request): string
    {
        // Use Symfony's trusted proxy mechanism. The app is behind Caddy/Traefik,
        // so Request::getClientIp() returns the correct IP when trusted proxies
        // are configured (see public/index.php or Symfony trusted_proxies config).
        // Fallback: if X-Forwarded-For exists, use only the rightmost entry
        // (added by the last trusted proxy — not spoofable by the client).
        $ip = $request->getClientIp();

        if ($ip !== null && $ip !== '' && $ip !== '127.0.0.1') {
            return $ip;
        }

        // Manual fallback for environments without trusted proxy config
        $forwarded = trim((string) $request->headers->get('X-Forwarded-For', ''));
        if ($forwarded !== '') {
            $parts = array_values(array_filter(
                array_map(static fn (string $item): string => trim($item), explode(',', $forwarded))
            ));
            // Rightmost entry is the one added by the trusted reverse proxy
            $rightmost = end($parts);
            if ($rightmost !== false && $rightmost !== '') {
                return $rightmost;
            }
        }

        return $ip !== null && $ip !== '' ? $ip : 'unknown';
    }
}
