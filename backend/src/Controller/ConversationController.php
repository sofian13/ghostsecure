<?php

namespace App\Controller;

use App\Entity\Conversation;
use App\Entity\ConversationMember;
use App\Entity\Message;
use App\Entity\User;
use App\Service\AuthService;
use App\Service\JsonFactory;
use App\Service\MessageSerializer;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Routing\Attribute\Route;

#[Route('/api')]
class ConversationController
{
    public function __construct(
        private readonly EntityManagerInterface $em,
        private readonly AuthService $auth,
        private readonly JsonFactory $json,
        private readonly MessageSerializer $messageSerializer
    ) {
    }

    #[Route('/conversations', name: 'api_conversations_list', methods: ['GET', 'OPTIONS'])]
    public function list(Request $request)
    {
        if ($request->isMethod('OPTIONS')) {
            return $this->json->ok(['ok' => true]);
        }

        $me = $this->auth->requireUser($request);
        if (!$me instanceof User) {
            return $this->json->error('Unauthorized.', 401);
        }
        $rows = $this->em->getConnection()->fetchAllAssociative(
            'SELECT c.id, MAX(m.created_at) AS updated_at
             FROM conversation c
             INNER JOIN conversation_member cm ON cm.conversation_id = c.id
             LEFT JOIN message m ON m.conversation_id = c.id
             WHERE cm.user_id = :uid
             GROUP BY c.id
             ORDER BY updated_at DESC NULLS LAST, c.id DESC',
            ['uid' => $me->getId()]
        );

        $result = [];
        foreach ($rows as $row) {
            $peer = $this->em->getConnection()->fetchAssociative(
                'SELECT u.id, u.public_key
                 FROM conversation_member cm
                 INNER JOIN app_user u ON u.id = cm.user_id
                 WHERE cm.conversation_id = :cid AND cm.user_id != :uid
                 LIMIT 1',
                ['cid' => $row['id'], 'uid' => $me->getId()]
            );

            if (!$peer) {
                continue;
            }

            $result[] = [
                'id' => $row['id'],
                'peerId' => $peer['id'],
                'peerPublicKey' => $peer['public_key'],
                'updatedAt' => $row['updated_at'] ?? (new \DateTimeImmutable())->format(DATE_ATOM),
            ];
        }

        return $this->json->ok($result);
    }

    #[Route('/conversations', name: 'api_conversations_create', methods: ['POST', 'OPTIONS'])]
    public function create(Request $request)
    {
        if ($request->isMethod('OPTIONS')) {
            return $this->json->ok(['ok' => true]);
        }

        $me = $this->auth->requireUser($request);
        if (!$me instanceof User) {
            return $this->json->error('Unauthorized.', 401);
        }
        $payload = json_decode($request->getContent(), true);
        $peerUserId = trim((string) ($payload['peerUserId'] ?? ''));
        if ($peerUserId === '') {
            return $this->json->error('peerUserId is required.', 422);
        }

        $peer = $this->em->getRepository(User::class)->find($peerUserId);
        if (!$peer instanceof User) {
            return $this->json->error('Peer not found.', 404);
        }

        $existing = $this->em->getConnection()->fetchOne(
            'SELECT cm1.conversation_id
             FROM conversation_member cm1
             INNER JOIN conversation_member cm2 ON cm1.conversation_id = cm2.conversation_id
             WHERE cm1.user_id = :u1 AND cm2.user_id = :u2
             LIMIT 1',
            ['u1' => $me->getId(), 'u2' => $peer->getId()]
        );

        if (is_string($existing)) {
            return $this->json->ok([
                'id' => $existing,
                'peerId' => $peer->getId(),
                'peerPublicKey' => $peer->getPublicKey(),
                'updatedAt' => (new \DateTimeImmutable())->format(DATE_ATOM),
            ]);
        }

        $conversation = new Conversation(self::uuid());
        $this->em->persist($conversation);
        $this->em->persist(new ConversationMember($conversation, $me));
        $this->em->persist(new ConversationMember($conversation, $peer));
        $this->em->flush();

        return $this->json->ok([
            'id' => $conversation->getId(),
            'peerId' => $peer->getId(),
            'peerPublicKey' => $peer->getPublicKey(),
            'updatedAt' => (new \DateTimeImmutable())->format(DATE_ATOM),
        ], 201);
    }

    #[Route('/conversations/{id}', name: 'api_conversations_detail', methods: ['GET', 'OPTIONS'])]
    public function detail(Request $request, string $id)
    {
        if ($request->isMethod('OPTIONS')) {
            return $this->json->ok(['ok' => true]);
        }

        $me = $this->auth->requireUser($request);
        if (!$me instanceof User) {
            return $this->json->error('Unauthorized.', 401);
        }
        if (!$this->hasAccess($me->getId(), $id)) {
            return $this->json->error('Forbidden.', 403);
        }

        $rows = $this->em->getConnection()->fetchAllAssociative(
            'SELECT u.id, u.public_key FROM conversation_member cm
             INNER JOIN app_user u ON u.id = cm.user_id
             WHERE cm.conversation_id = :cid',
            ['cid' => $id]
        );

        $participants = array_map(static fn (array $row) => [
            'id' => $row['id'],
            'publicKey' => $row['public_key'],
        ], $rows);

        return $this->json->ok(['id' => $id, 'participants' => $participants]);
    }

    #[Route('/conversations/{id}/messages', name: 'api_messages_list', methods: ['GET', 'OPTIONS'])]
    public function messages(Request $request, string $id)
    {
        if ($request->isMethod('OPTIONS')) {
            return $this->json->ok(['ok' => true]);
        }

        $me = $this->auth->requireUser($request);
        if (!$me instanceof User) {
            return $this->json->error('Unauthorized.', 401);
        }
        if (!$this->hasAccess($me->getId(), $id)) {
            return $this->json->error('Forbidden.', 403);
        }

        $conversationRef = $this->em->getReference(Conversation::class, $id);
        $items = $this->em->createQueryBuilder()
            ->select('m')
            ->from(Message::class, 'm')
            ->where('m.conversation = :conversation')
            ->setParameter('conversation', $conversationRef)
            ->orderBy('m.createdAt', 'ASC')
            ->addOrderBy('m.id', 'ASC')
            ->getQuery()
            ->getResult();

        $now = new \DateTimeImmutable();
        $serialized = [];
        foreach ($items as $item) {
            if ($item->getExpiresAt() && $item->getExpiresAt() < $now) {
                continue;
            }
            $serialized[] = $this->messageSerializer->serialize($item);
        }

        return $this->json->ok($serialized);
    }

    #[Route('/conversations/{id}/messages', name: 'api_messages_create', methods: ['POST', 'OPTIONS'])]
    public function postMessage(Request $request, string $id)
    {
        if ($request->isMethod('OPTIONS')) {
            return $this->json->ok(['ok' => true]);
        }

        $me = $this->auth->requireUser($request);
        if (!$me instanceof User) {
            return $this->json->error('Unauthorized.', 401);
        }
        if (!$this->hasAccess($me->getId(), $id)) {
            return $this->json->error('Forbidden.', 403);
        }

        $payload = json_decode($request->getContent(), true);
        if (!is_array($payload)) {
            return $this->json->error('Invalid JSON body.', 400);
        }

        $ciphertext = trim((string) ($payload['ciphertext'] ?? ''));
        $iv = trim((string) ($payload['iv'] ?? ''));
        $wrappedKeys = $payload['wrappedKeys'] ?? null;
        $expiresInSeconds = (int) ($payload['expiresInSeconds'] ?? 0);

        if ($ciphertext === '' || $iv === '' || !is_array($wrappedKeys) || count($wrappedKeys) === 0) {
            return $this->json->error('ciphertext, iv and wrappedKeys are required.', 422);
        }

        $conversation = $this->em->getRepository(Conversation::class)->find($id);
        if (!$conversation instanceof Conversation) {
            return $this->json->error('Conversation not found.', 404);
        }

        $expiresAt = null;
        if ($expiresInSeconds > 0) {
            $expiresAt = new \DateTimeImmutable(sprintf('+%d seconds', min($expiresInSeconds, 86400)));
        }

        $message = new Message(self::uuid(), $conversation, $me, $ciphertext, $iv, $wrappedKeys, $expiresAt);
        $this->em->persist($message);
        $this->em->flush();

        return $this->json->ok($this->messageSerializer->serialize($message), 201);
    }

    private function hasAccess(string $userId, string $conversationId): bool
    {
        $exists = $this->em->getConnection()->fetchOne(
            'SELECT 1 FROM conversation_member WHERE conversation_id = :cid AND user_id = :uid LIMIT 1',
            ['cid' => $conversationId, 'uid' => $userId]
        );

        return (bool) $exists;
    }

    private static function uuid(): string
    {
        $data = random_bytes(16);
        $data[6] = chr((ord($data[6]) & 0x0f) | 0x40);
        $data[8] = chr((ord($data[8]) & 0x3f) | 0x80);

        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}
