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
        $clientGeneratedUserId = trim((string) ($payload['clientGeneratedUserId'] ?? ''));

        if ($publicKey === '' || $clientGeneratedUserId === '') {
            return $this->json->error('publicKey and clientGeneratedUserId are required.', 422);
        }

        $existing = $this->em->getRepository(User::class)->find($clientGeneratedUserId);
        if ($existing instanceof User) {
            $user = $existing;
            $user->setPublicKey($publicKey);
        } else {
            $user = new User($clientGeneratedUserId, $publicKey);
            $this->em->persist($user);
        }

        $this->em->flush();
        $token = $this->auth->issueToken($user);

        return $this->json->ok([
            'userId' => $user->getId(),
            'token' => $token,
        ], 201);
    }
}
