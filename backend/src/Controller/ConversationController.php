<?php

namespace App\Controller;

use App\Entity\Conversation;
use App\Entity\ConversationMember;
use App\Entity\Message;
use App\Entity\User;
use App\Service\AuthService;
use App\Service\AuthThrottleService;
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
        private readonly AuthThrottleService $throttle,
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
            'SELECT c.id, c.kind, c.title, MAX(m.created_at) AS updated_at,
                    COUNT(DISTINCT cm_all.user_id) AS member_count
             FROM conversation c
             INNER JOIN conversation_member cm ON cm.conversation_id = c.id
             INNER JOIN conversation_member cm_all ON cm_all.conversation_id = c.id
             LEFT JOIN message m ON m.conversation_id = c.id
             WHERE cm.user_id = :uid
             GROUP BY c.id, c.kind, c.title
             ORDER BY updated_at DESC NULLS LAST, c.id DESC',
            ['uid' => $me->getId()]
        );

        $result = [];
        foreach ($rows as $row) {
            $isGroup = ($row['kind'] ?? Conversation::KIND_DIRECT) === Conversation::KIND_GROUP;
            $peer = null;
            if (!$isGroup) {
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
            }

            $groupLabel = trim((string) ($row['title'] ?? ''));
            $memberCount = (int) ($row['member_count'] ?? 0);

            $result[] = [
                'id' => $row['id'],
                'kind' => $isGroup ? Conversation::KIND_GROUP : Conversation::KIND_DIRECT,
                'title' => $isGroup ? ($groupLabel !== '' ? $groupLabel : 'Groupe') : null,
                'memberCount' => $memberCount,
                'peerId' => $isGroup ? ($groupLabel !== '' ? $groupLabel : 'Groupe') : $peer['id'],
                'peerPublicKey' => $isGroup ? null : $peer['public_key'],
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

        if (!$this->throttle->isAllowed('create_conversation', sprintf('user:%s', $me->getId()))) {
            return $this->json->error('Too many requests. Try again later.', 429);
        }

        $payload = json_decode($request->getContent(), true);
        if (!is_array($payload)) {
            return $this->json->error('Invalid JSON body.', 400);
        }

        $kind = trim((string) ($payload['kind'] ?? Conversation::KIND_DIRECT));
        if ($kind === Conversation::KIND_GROUP) {
            return $this->createGroupConversation($me, $payload);
        }

        return $this->createDirectConversation($me, $payload);
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
            'SELECT u.id, u.public_key, u.ecdh_public_key, u.identity_key, u.signed_prekey, u.signed_prekey_signature, u.registration_id
             FROM conversation_member cm
             INNER JOIN app_user u ON u.id = cm.user_id
             WHERE cm.conversation_id = :cid',
            ['cid' => $id]
        );

        $participants = array_map(static fn (array $row) => array_filter([
            'id' => $row['id'],
            'publicKey' => $row['public_key'],
            'ecdhPublicKey' => $row['ecdh_public_key'] ?? null,
            'identityKey' => $row['identity_key'] ?? null,
            'signedPrekey' => $row['signed_prekey'] ?? null,
            'signedPrekeySignature' => $row['signed_prekey_signature'] ?? null,
            'registrationId' => $row['registration_id'] ?? null,
        ], static fn ($v) => $v !== null), $rows);

        $conversation = $this->em->getRepository(Conversation::class)->find($id);
        if (!$conversation instanceof Conversation) {
            return $this->json->error('Conversation not found.', 404);
        }

        return $this->json->ok([
            'id' => $id,
            'kind' => $conversation->getKind(),
            'title' => $conversation->getTitle(),
            'participants' => $participants,
        ]);
    }

    #[Route('/conversations/{id}/members', name: 'api_conversations_add_member', methods: ['POST', 'OPTIONS'])]
    public function addMember(Request $request, string $id)
    {
        if ($request->isMethod('OPTIONS')) {
            return $this->json->ok(['ok' => true]);
        }

        $me = $this->auth->requireUser($request);
        if (!$me instanceof User) {
            return $this->json->error('Unauthorized.', 401);
        }

        if (!$this->throttle->isAllowed('add_member', sprintf('user:%s', $me->getId()))) {
            return $this->json->error('Too many requests. Try again later.', 429);
        }

        if (!$this->hasAccess($me->getId(), $id)) {
            return $this->json->error('Forbidden.', 403);
        }

        $conversation = $this->em->getRepository(Conversation::class)->find($id);
        if (!$conversation instanceof Conversation) {
            return $this->json->error('Conversation not found.', 404);
        }
        if (!$conversation->isGroup()) {
            return $this->json->error('Only group conversations support member management.', 422);
        }

        $memberCount = (int) $this->em->getConnection()->fetchOne(
            'SELECT COUNT(*) FROM conversation_member WHERE conversation_id = :cid',
            ['cid' => $conversation->getId()]
        );
        if ($memberCount >= 100) {
            return $this->json->error('Group member limit reached (max 100).', 422);
        }

        $payload = json_decode($request->getContent(), true);
        if (!is_array($payload)) {
            return $this->json->error('Invalid JSON body.', 400);
        }
        $newUserId = strtolower(trim((string) ($payload['userId'] ?? '')));
        if ($newUserId === '') {
            return $this->json->error('userId is required.', 422);
        }

        $newUser = $this->em->getRepository(User::class)->find($newUserId);
        if (!$newUser instanceof User) {
            return $this->json->error('User not found.', 404);
        }

        if (!$this->isFriend($me->getId(), $newUser->getId())) {
            return $this->json->error('You must be friends to add a member.', 403);
        }

        $exists = $this->em->getConnection()->fetchOne(
            'SELECT 1 FROM conversation_member WHERE conversation_id = :cid AND user_id = :uid LIMIT 1',
            ['cid' => $conversation->getId(), 'uid' => $newUser->getId()]
        );
        if (!$exists) {
            $this->em->persist(new ConversationMember($conversation, $newUser));
            $this->em->flush();
        }

        return $this->json->ok(['ok' => true]);
    }

    #[Route('/conversations/{id}/members/me', name: 'api_conversations_leave', methods: ['DELETE', 'OPTIONS'])]
    public function leaveGroup(Request $request, string $id)
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

        $conversation = $this->em->getRepository(Conversation::class)->find($id);
        if (!$conversation instanceof Conversation) {
            return $this->json->error('Conversation not found.', 404);
        }
        if (!$conversation->isGroup()) {
            return $this->json->error('Only group conversations can be left.', 422);
        }

        $member = $this->em->getRepository(ConversationMember::class)->findOneBy([
            'conversation' => $conversation,
            'user' => $me,
        ]);
        if ($member instanceof ConversationMember) {
            $this->em->remove($member);
            $this->em->flush();
        }

        $remaining = (int) $this->em->getConnection()->fetchOne(
            'SELECT COUNT(*) FROM conversation_member WHERE conversation_id = :cid',
            ['cid' => $conversation->getId()]
        );
        if ($remaining === 0) {
            $this->em->remove($conversation);
            $this->em->flush();
        }

        return $this->json->ok(['ok' => true]);
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

        if (!$this->throttle->isAllowed('fetch_messages', sprintf('user:%s', $me->getId()))) {
            return $this->json->error('Too many requests. Try again later.', 429);
        }

        if (!$this->hasAccess($me->getId(), $id)) {
            return $this->json->error('Forbidden.', 403);
        }

        $limit = min((int) ($request->query->get('limit', 200)), 500);

        $conversationRef = $this->em->getReference(Conversation::class, $id);

        // Fetch the latest N messages (DESC), then reverse to return ASC order
        $qb = $this->em->createQueryBuilder()
            ->select('m')
            ->from(Message::class, 'm')
            ->where('m.conversation = :conversation')
            ->andWhere('m.expiresAt IS NULL OR m.expiresAt > :now')
            ->setParameter('conversation', $conversationRef)
            ->setParameter('now', new \DateTimeImmutable())
            ->orderBy('m.createdAt', 'DESC')
            ->addOrderBy('m.id', 'DESC')
            ->setMaxResults($limit);

        $items = array_reverse($qb->getQuery()->getResult());

        $serialized = [];
        foreach ($items as $item) {
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

        if (!$this->throttle->isAllowed('send_message', sprintf('user:%s', $me->getId()))) {
            return $this->json->error('Too many requests. Try again later.', 429);
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

        $maxCiphertextBytes = $this->readIntEnv('APP_MESSAGE_MAX_CIPHERTEXT_BYTES', 8 * 1024 * 1024);
        if (strlen($ciphertext) > $maxCiphertextBytes) {
            return $this->json->error(sprintf('ciphertext exceeds maximum size (%d bytes).', $maxCiphertextBytes), 422);
        }
        if (strlen($iv) > 64) {
            return $this->json->error('iv exceeds maximum length.', 422);
        }
        $wrappedKeysJson = json_encode($wrappedKeys);
        $maxWrappedKeysBytes = $this->readIntEnv('APP_MESSAGE_MAX_WRAPPED_KEYS_BYTES', 256 * 1024);
        if ($wrappedKeysJson !== false && strlen($wrappedKeysJson) > $maxWrappedKeysBytes) {
            return $this->json->error(sprintf('wrappedKeys exceeds maximum size (%d bytes).', $maxWrappedKeysBytes), 422);
        }

        $conversation = $this->em->getRepository(Conversation::class)->find($id);
        if (!$conversation instanceof Conversation) {
            return $this->json->error('Conversation not found.', 404);
        }

        $memberIds = $this->em->getConnection()->fetchFirstColumn(
            'SELECT user_id FROM conversation_member WHERE conversation_id = :cid',
            ['cid' => $id]
        );
        foreach (array_keys($wrappedKeys) as $keyUserId) {
            if (!in_array(strtolower(trim((string) $keyUserId)), $memberIds, true)) {
                return $this->json->error('wrappedKeys contains non-member user IDs.', 422);
            }
        }

        $expiresAt = null;
        if ($expiresInSeconds > 0) {
            $expiresAt = new \DateTimeImmutable(sprintf('+%d seconds', min($expiresInSeconds, 86400)));
        }

        $ephemeralPublicKey = trim((string) ($payload['ephemeralPublicKey'] ?? ''));
        $ratchetHeader = trim((string) ($payload['ratchetHeader'] ?? ''));
        // Sealed sender: don't store the sender identity in the database.
        // The sender ID is encrypted inside the message payload (envelope v2/v3).
        $message = new Message(self::uuid(), $conversation, null, $ciphertext, $iv, $wrappedKeys, $expiresAt, $ephemeralPublicKey !== '' ? $ephemeralPublicKey : null, $ratchetHeader !== '' ? $ratchetHeader : null);
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

    private function isFriend(string $userId1, string $userId2): bool
    {
        return (bool) $this->em->getConnection()->fetchOne(
            "SELECT 1 FROM friend_request
             WHERE status = 'accepted'
               AND ((requester_id = :u1 AND target_user_id = :u2)
                 OR (requester_id = :u2 AND target_user_id = :u1))
             LIMIT 1",
            ['u1' => $userId1, 'u2' => $userId2]
        );
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

    private function createDirectConversation(User $me, array $payload)
    {
        $peerUserId = strtolower(trim((string) ($payload['peerUserId'] ?? '')));
        if ($peerUserId === '') {
            return $this->json->error('peerUserId is required.', 422);
        }

        $peer = $this->em->getRepository(User::class)->find($peerUserId);
        if (!$peer instanceof User) {
            return $this->json->error('Peer not found.', 404);
        }

        if (!$this->isFriend($me->getId(), $peer->getId())) {
            return $this->json->error('You must be friends to start a conversation.', 403);
        }

        $existing = $this->em->getConnection()->fetchOne(
            'SELECT c.id
             FROM conversation c
             INNER JOIN conversation_member cm1 ON cm1.conversation_id = c.id
             INNER JOIN conversation_member cm2 ON cm2.conversation_id = c.id
             WHERE c.kind = :kind
               AND cm1.user_id = :u1
               AND cm2.user_id = :u2
               AND (SELECT COUNT(*) FROM conversation_member cm WHERE cm.conversation_id = c.id) = 2
             LIMIT 1',
            ['kind' => Conversation::KIND_DIRECT, 'u1' => $me->getId(), 'u2' => $peer->getId()]
        );

        if (is_string($existing)) {
            return $this->json->ok([
                'id' => $existing,
                'kind' => Conversation::KIND_DIRECT,
                'title' => null,
                'memberCount' => 2,
                'peerId' => $peer->getId(),
                'peerPublicKey' => $peer->getPublicKey(),
                'updatedAt' => (new \DateTimeImmutable())->format(DATE_ATOM),
            ]);
        }

        $conversation = new Conversation(self::uuid(), Conversation::KIND_DIRECT, null);
        $this->em->persist($conversation);
        $this->em->persist(new ConversationMember($conversation, $me));
        $this->em->persist(new ConversationMember($conversation, $peer));
        $this->em->flush();

        return $this->json->ok([
            'id' => $conversation->getId(),
            'kind' => Conversation::KIND_DIRECT,
            'title' => null,
            'memberCount' => 2,
            'peerId' => $peer->getId(),
            'peerPublicKey' => $peer->getPublicKey(),
            'updatedAt' => (new \DateTimeImmutable())->format(DATE_ATOM),
        ], 201);
    }

    private function createGroupConversation(User $me, array $payload)
    {
        $title = trim((string) ($payload['title'] ?? ''));
        if ($title === '') {
            return $this->json->error('title is required for group.', 422);
        }
        $title = substr($title, 0, 120);

        $memberIds = $payload['memberUserIds'] ?? [];
        if (!is_array($memberIds)) {
            return $this->json->error('memberUserIds must be an array.', 422);
        }

        $uniqueIds = [$me->getId() => true];
        foreach ($memberIds as $memberId) {
            $normalized = strtolower(trim((string) $memberId));
            if ($normalized !== '') {
                $uniqueIds[$normalized] = true;
            }
        }

        if (count($uniqueIds) < 2) {
            return $this->json->error('A group must contain at least two members.', 422);
        }
        if (count($uniqueIds) > 100) {
            return $this->json->error('Group member limit reached (max 100).', 422);
        }

        $users = $this->em->getRepository(User::class)->findBy(['id' => array_keys($uniqueIds)]);
        if (count($users) !== count($uniqueIds)) {
            return $this->json->error('One or more users were not found.', 404);
        }

        foreach ($users as $user) {
            if ($user->getId() !== $me->getId() && !$this->isFriend($me->getId(), $user->getId())) {
                return $this->json->error('You must be friends with all members.', 403);
            }
        }

        $conversation = new Conversation(self::uuid(), Conversation::KIND_GROUP, $title);
        $this->em->persist($conversation);
        foreach ($users as $user) {
            $this->em->persist(new ConversationMember($conversation, $user));
        }
        $this->em->flush();

        return $this->json->ok([
            'id' => $conversation->getId(),
            'kind' => Conversation::KIND_GROUP,
            'title' => $title,
            'memberCount' => count($uniqueIds),
            'peerId' => $title,
            'peerPublicKey' => null,
            'updatedAt' => (new \DateTimeImmutable())->format(DATE_ATOM),
        ], 201);
    }
}
