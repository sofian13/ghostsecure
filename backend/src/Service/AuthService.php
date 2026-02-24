<?php

namespace App\Service;

use App\Entity\User;
use App\Entity\UserSession;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\HttpFoundation\Request;

class AuthService
{
    public function __construct(private readonly EntityManagerInterface $em)
    {
    }

    public function requireUser(Request $request): ?User
    {
        $auth = $request->headers->get('Authorization', '');
        if (!str_starts_with($auth, 'Bearer ')) {
            return null;
        }

        $token = trim(substr($auth, 7));
        if ($token === '') {
            return null;
        }

        $session = $this->em->getRepository(UserSession::class)->findOneBy([
            'tokenHash' => hash('sha256', $token),
        ]);

        if (!$session instanceof UserSession || $session->isExpired()) {
            return null;
        }

        return $session->getUser();
    }

    public function issueToken(User $user): string
    {
        $raw = bin2hex(random_bytes(32));
        $session = new UserSession(
            $user,
            hash('sha256', $raw),
            new \DateTimeImmutable('+30 days')
        );

        $this->em->persist($session);
        $this->em->flush();

        return $raw;
    }
}
