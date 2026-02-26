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
        $connection = $this->em->getConnection();
        $ttlSeconds = $this->readIntEnv('APP_SESSION_TTL_SECONDS', 43200);
        $maxSessions = $this->readIntEnv('APP_MAX_SESSIONS_PER_USER', 5);

        $connection->executeStatement('DELETE FROM user_session WHERE expires_at <= NOW()');

        $raw = bin2hex(random_bytes(32));
        $session = new UserSession(
            $user,
            hash('sha256', $raw),
            (new \DateTimeImmutable())->modify(sprintf('+%d seconds', $ttlSeconds))
        );

        $this->em->persist($session);
        $this->em->flush();

        if ($maxSessions > 0) {
            $connection->executeStatement(
                'DELETE FROM user_session
                 WHERE user_id = :uid
                   AND id NOT IN (
                     SELECT id FROM user_session
                     WHERE user_id = :uid
                     ORDER BY created_at DESC
                     LIMIT :max_sessions
                   )',
                [
                    'uid' => $user->getId(),
                    'max_sessions' => $maxSessions,
                ],
                [
                    'uid' => \PDO::PARAM_STR,
                    'max_sessions' => \PDO::PARAM_INT,
                ]
            );
        }

        return $raw;
    }

    private function readIntEnv(string $name, int $default): int
    {
        $raw = getenv($name);
        if ($raw === false || $raw === '') {
            return $default;
        }

        $value = (int) $raw;
        return $value > 0 ? $value : $default;
    }
}
