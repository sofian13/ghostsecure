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
            return $this->json->error('User already exists.', 409);
        }

        if (!$this->validatePublicKey($publicKey)) {
            return $this->json->error('Invalid public key format.', 422);
        }

        $user = new User($userId, $publicKey);
        $user->setSecretHash(password_hash($secret, PASSWORD_DEFAULT));
        $this->em->persist($user);

        $this->em->flush();
        $token = $this->auth->issueToken($user);
        $this->logger->info('User registered', ['userId' => $userId]);

        return $this->json->ok([
            'userId' => $user->getId(),
            'token' => $token,
            'publicKey' => $user->getPublicKey(),
        ], 201);
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
        $this->throttle->reset('login_user', $userScopeKey);
        $this->throttle->reset('login_user_only', $userOnlyKey);
        $this->logger->info('Login success', ['userId' => $userId]);

        return $this->json->ok([
            'userId' => $user->getId(),
            'token' => $token,
            'publicKey' => $user->getPublicKey(),
        ]);
    }

    #[Route('/auth/logout', name: 'api_auth_logout', methods: ['POST', 'OPTIONS'])]
    public function logout(Request $request)
    {
        if ($request->isMethod('OPTIONS')) {
            return $this->json->ok(['ok' => true]);
        }

        $auth = trim((string) $request->headers->get('Authorization', ''));
        if (!str_starts_with($auth, 'Bearer ')) {
            return $this->json->error('Missing token.', 401);
        }
        $token = substr($auth, 7);
        $tokenHash = hash('sha256', $token);

        $this->em->getConnection()->executeStatement(
            'DELETE FROM user_session WHERE token_hash = :hash',
            ['hash' => $tokenHash]
        );

        return $this->json->ok(['ok' => true]);
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
        // Behind a reverse proxy (Dokploy/Traefik), use the rightmost non-proxy IP
        // to prevent spoofing via a crafted X-Forwarded-For header.
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

        $ip = trim((string) $request->getClientIp());
        return $ip !== '' ? $ip : 'unknown';
    }
}
