<?php

namespace App\Controller;

use App\Entity\User;
use App\Service\AuthService;
use App\Service\JsonFactory;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Routing\Attribute\Route;

#[Route('/api')]
class AuthController
{
    public function __construct(
        private readonly EntityManagerInterface $em,
        private readonly AuthService $auth,
        private readonly JsonFactory $json
    ) {
    }

    #[Route('/auth/register', name: 'api_auth_register', methods: ['POST', 'OPTIONS'])]
    public function register(Request $request)
    {
        if ($request->isMethod('OPTIONS')) {
            return $this->json->ok(['ok' => true]);
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
        if (strlen($secret) < 6) {
            return $this->json->error('secret must contain at least 6 characters.', 422);
        }

        $existing = $this->em->getRepository(User::class)->find($userId);
        if ($existing instanceof User) {
            $hash = $existing->getSecretHash();
            if (is_string($hash) && $hash !== '' && !password_verify($secret, $hash)) {
                return $this->json->error('User already exists.', 409);
            }
            $user = $existing;
            $user->setPublicKey($publicKey);
        } else {
            $user = new User($userId, $publicKey);
            $this->em->persist($user);
        }
        $user->setSecretHash(password_hash($secret, PASSWORD_DEFAULT));

        $this->em->flush();
        $token = $this->auth->issueToken($user);

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

        $payload = json_decode($request->getContent(), true);
        if (!is_array($payload)) {
            return $this->json->error('Invalid JSON body.', 400);
        }

        $userId = trim((string) ($payload['userId'] ?? ''));
        $secret = (string) ($payload['secret'] ?? '');
        $publicKey = trim((string) ($payload['publicKey'] ?? ''));

        if ($userId === '' || $secret === '') {
            return $this->json->error('userId and secret are required.', 422);
        }

        $user = $this->em->getRepository(User::class)->find($userId);
        if (!$user instanceof User) {
            return $this->json->error('Invalid credentials.', 401);
        }

        $hash = $user->getSecretHash();
        if (!is_string($hash) || $hash === '' || !password_verify($secret, $hash)) {
            return $this->json->error('Invalid credentials.', 401);
        }

        if ($publicKey !== '') {
            $user->setPublicKey($publicKey);
            $this->em->flush();
        }

        $token = $this->auth->issueToken($user);

        return $this->json->ok([
            'userId' => $user->getId(),
            'token' => $token,
            'publicKey' => $user->getPublicKey(),
        ]);
    }
}
