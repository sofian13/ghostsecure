<?php

namespace App\Controller;

use App\Entity\User;
use App\Service\AuthService;
use App\Service\AuthThrottleService;
use App\Service\JsonFactory;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Routing\Attribute\Route;

#[Route('/api')]
class PreKeyController
{
    public function __construct(
        private readonly EntityManagerInterface $em,
        private readonly AuthService $auth,
        private readonly AuthThrottleService $throttle,
        private readonly JsonFactory $json
    ) {
    }

    #[Route('/keys/bundle', name: 'api_keys_upload', methods: ['POST', 'OPTIONS'])]
    public function uploadBundle(Request $request)
    {
        if ($request->isMethod('OPTIONS')) {
            return $this->json->ok(['ok' => true]);
        }

        $me = $this->auth->requireUser($request);
        if (!$me instanceof User) {
            return $this->json->error('Unauthorized.', 401);
        }

        $payload = json_decode($request->getContent(), true);
        if (!is_array($payload)) {
            return $this->json->error('Invalid JSON body.', 400);
        }

        $identityKey = trim((string) ($payload['identityKey'] ?? ''));
        $signedPrekey = trim((string) ($payload['signedPrekey'] ?? ''));
        $signedPrekeySignature = trim((string) ($payload['signedPrekeySignature'] ?? ''));
        $registrationId = (int) ($payload['registrationId'] ?? 0);
        $oneTimePreKeys = $payload['oneTimePreKeys'] ?? [];

        if ($identityKey === '' || $signedPrekey === '' || $signedPrekeySignature === '' || $registrationId <= 0) {
            return $this->json->error('identityKey, signedPrekey, signedPrekeySignature and registrationId are required.', 422);
        }

        if (!is_array($oneTimePreKeys)) {
            return $this->json->error('oneTimePreKeys must be an array.', 422);
        }

        $conn = $this->em->getConnection();

        $me->setIdentityKey($identityKey);
        $me->setSignedPrekey($signedPrekey);
        $me->setSignedPrekeySignature($signedPrekeySignature);
        $me->setRegistrationId($registrationId);
        $this->em->flush();

        // Upsert OTPKs: delete existing then insert new
        $conn->executeStatement(
            'DELETE FROM one_time_prekey WHERE user_id = :uid',
            ['uid' => $me->getId()]
        );

        foreach ($oneTimePreKeys as $otpk) {
            if (!is_array($otpk)) {
                continue;
            }
            $keyId = (int) ($otpk['keyId'] ?? 0);
            $publicKey = trim((string) ($otpk['publicKey'] ?? ''));
            if ($keyId <= 0 || $publicKey === '') {
                continue;
            }
            $conn->executeStatement(
                'INSERT INTO one_time_prekey (id, user_id, key_id, public_key, created_at)
                 VALUES (gen_random_uuid(), :uid, :kid, :pk, NOW())
                 ON CONFLICT (user_id, key_id) DO UPDATE SET public_key = EXCLUDED.public_key',
                ['uid' => $me->getId(), 'kid' => $keyId, 'pk' => $publicKey]
            );
        }

        return $this->json->ok(['ok' => true]);
    }

    #[Route('/users/{userId}/keys/bundle', name: 'api_keys_fetch', methods: ['GET', 'OPTIONS'])]
    public function fetchBundle(Request $request, string $userId)
    {
        if ($request->isMethod('OPTIONS')) {
            return $this->json->ok(['ok' => true]);
        }

        $me = $this->auth->requireUser($request);
        if (!$me instanceof User) {
            return $this->json->error('Unauthorized.', 401);
        }

        // Rate limit: prevent OTK exhaustion attacks.
        // Defaults: 10 req / 300s. Override via APP_AUTH_RATE_LIMIT_PREKEY_FETCH_MAX / _WINDOW.
        $throttleKey = sprintf('user:%s:peer:%s', $me->getId(), $userId);
        if (!$this->throttle->isAllowed('prekey_fetch', $throttleKey)) {
            return $this->json->error('Too many pre-key requests. Try again later.', 429);
        }

        // Require that the requester shares a conversation with the target
        $conn = $this->em->getConnection();
        $shared = $conn->fetchOne(
            'SELECT 1 FROM conversation_member cm1
             JOIN conversation_member cm2 ON cm1.conversation_id = cm2.conversation_id
             WHERE cm1.user_id = :me AND cm2.user_id = :peer
             LIMIT 1',
            ['me' => $me->getId(), 'peer' => $userId]
        );
        if (!$shared) {
            return $this->json->error('Forbidden.', 403);
        }

        $peer = $this->em->getRepository(User::class)->find($userId);
        if (!$peer instanceof User) {
            return $this->json->error('User not found.', 404);
        }

        if (!$peer->getIdentityKey() || !$peer->getSignedPrekey()) {
            return $this->json->error('User has no pre-key bundle.', 404);
        }

        // Atomically consume one OTPK (oldest first)
        $otpk = $conn->fetchAssociative(
            'DELETE FROM one_time_prekey
             WHERE id = (
                 SELECT id FROM one_time_prekey
                 WHERE user_id = :uid
                 ORDER BY created_at ASC
                 LIMIT 1
             )
             RETURNING key_id, public_key',
            ['uid' => $peer->getId()]
        );

        $result = [
            'userId' => $peer->getId(),
            'identityKey' => $peer->getIdentityKey(),
            'signedPrekey' => $peer->getSignedPrekey(),
            'signedPrekeySignature' => $peer->getSignedPrekeySignature(),
            'registrationId' => $peer->getRegistrationId(),
        ];

        if ($otpk && isset($otpk['key_id'], $otpk['public_key'])) {
            $result['oneTimePreKey'] = [
                'keyId' => (int) $otpk['key_id'],
                'publicKey' => $otpk['public_key'],
            ];
        }

        return $this->json->ok($result);
    }

    #[Route('/keys/count', name: 'api_keys_count', methods: ['GET', 'OPTIONS'])]
    public function count(Request $request)
    {
        if ($request->isMethod('OPTIONS')) {
            return $this->json->ok(['ok' => true]);
        }

        $me = $this->auth->requireUser($request);
        if (!$me instanceof User) {
            return $this->json->error('Unauthorized.', 401);
        }

        $count = (int) $this->em->getConnection()->fetchOne(
            'SELECT COUNT(*) FROM one_time_prekey WHERE user_id = :uid',
            ['uid' => $me->getId()]
        );

        return $this->json->ok(['count' => $count]);
    }
}
