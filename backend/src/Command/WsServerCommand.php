<?php

namespace App\Command;

use Ratchet\ConnectionInterface;
use Ratchet\Http\HttpServer;
use Ratchet\MessageComponentInterface;
use Ratchet\Server\IoServer;
use Ratchet\WebSocket\WsServer;
use Symfony\Component\Console\Attribute\AsCommand;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Output\OutputInterface;
use Doctrine\DBAL\Connection;

#[AsCommand(name: 'app:ws-server', description: 'Starts Ghost Secure realtime WebSocket server.')]
class WsServerCommand extends Command implements MessageComponentInterface
{
    private \SplObjectStorage $clients;

    /** @var array<int, array{userId:string,lastAt:string}> */
    private array $meta = [];

    /** @var \SplObjectStorage<ConnectionInterface, true> Connections awaiting auth */
    private \SplObjectStorage $pending;

    public function __construct(private readonly Connection $db)
    {
        parent::__construct();
        $this->clients = new \SplObjectStorage();
        $this->pending = new \SplObjectStorage();
    }

    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        $loop = \React\EventLoop\Loop::get();

        $socket = new \React\Socket\SocketServer('0.0.0.0:8081', [], $loop);
        new IoServer(new HttpServer(new WsServer($this)), $socket, $loop);

        $loop->addPeriodicTimer(1.0, function (): void {
            $this->pollMessages();
        });

        $loop->addPeriodicTimer(300.0, function (): void {
            $this->purgeExpiredMessages();
        });

        $loop->addPeriodicTimer(300.0, function (): void {
            $this->revalidateSessions();
        });

        $loop->addPeriodicTimer(600.0, function (): void {
            $this->purgeExpiredSessions();
        });

        $output->writeln('Ghost Secure WebSocket server listening on :8081');
        $loop->run();

        return Command::SUCCESS;
    }

    public function onOpen(ConnectionInterface $conn): void
    {
        $this->wsLog(sprintf('OPEN id=%s', (string) $conn->resourceId));

        $origin = $this->readOrigin($conn);
        if (!$this->isAllowedOrigin($origin)) {
            $this->wsLog(sprintf('CLOSE id=%s reason=origin_not_allowed origin=%s', (string) $conn->resourceId, $origin !== '' ? $origin : '<empty>'));
            $conn->close();
            return;
        }

        $this->pending->attach($conn);
    }

    public function onMessage(ConnectionInterface $from, $msg): void
    {
        if (strlen((string) $msg) > 204800) {
            $this->wsLog(sprintf('CLOSE id=%s reason=message_too_large', (string) $from->resourceId));
            $from->close();
            return;
        }

        $payload = json_decode((string) $msg, true);
        if (!is_array($payload)) {
            return;
        }

        if ($this->pending->contains($from)) {
            $this->handleAuth($from, $payload);
            return;
        }

        if (($payload['type'] ?? '') === 'call_signal') {
            $this->relayCallSignal($from, $payload);
            return;
        }

        if (($payload['type'] ?? '') === 'ping') {
            $from->send(json_encode(['type' => 'pong']));
        }
    }

    public function onClose(ConnectionInterface $conn): void
    {
        $this->wsLog(sprintf('CLOSE id=%s', (string) $conn->resourceId));
        $this->clients->detach($conn);
        $this->pending->detach($conn);
        unset($this->meta[$conn->resourceId]);
    }

    public function onError(ConnectionInterface $conn, \Exception $e): void
    {
        $this->wsLog(sprintf('ERROR id=%s message=%s', (string) $conn->resourceId, $e->getMessage()));
        $conn->close();
        $this->onClose($conn);
    }

    private function handleAuth(ConnectionInterface $conn, array $payload): void
    {
        if (($payload['type'] ?? '') !== 'auth' || empty($payload['token'])) {
            $conn->send(json_encode(['type' => 'error', 'message' => 'First message must be {"type":"auth","token":"..."}']));
            $conn->close();
            $this->pending->detach($conn);
            return;
        }

        $token = trim((string) $payload['token']);
        $row = $this->db->fetchAssociative(
            'SELECT s.id, u.id as user_id
             FROM user_session s
             INNER JOIN app_user u ON u.id = s.user_id
             WHERE s.token_hash = :hash AND s.expires_at > NOW()
             LIMIT 1',
            ['hash' => hash('sha256', $token)]
        );

        if (!$row || !isset($row['user_id'])) {
            $this->wsLog(sprintf('CLOSE id=%s reason=invalid_or_expired_token', (string) $conn->resourceId));
            $conn->send(json_encode(['type' => 'error', 'message' => 'Invalid or expired token']));
            $conn->close();
            $this->pending->detach($conn);
            return;
        }

        $this->pending->detach($conn);
        $this->clients->attach($conn);
        $this->meta[$conn->resourceId] = [
            'userId' => (string) $row['user_id'],
            'lastAt' => (new \DateTimeImmutable('-10 seconds'))->format('Y-m-d H:i:sP'),
        ];

        $this->enforceConnectionLimit((string) $row['user_id'], $conn);

        $conn->send(json_encode(['type' => 'authenticated']));
        $this->wsLog(sprintf('AUTH id=%s user=%s', (string) $conn->resourceId, $row['user_id']));
    }

    private function wsLog(string $message): void
    {
        fwrite(STDOUT, sprintf("[WS] %s\n", $message));
    }

    private function readOrigin(ConnectionInterface $conn): string
    {
        $headers = $conn->httpRequest->getHeader('Origin');
        if (!is_array($headers) || count($headers) === 0) {
            return '';
        }

        return trim((string) $headers[0]);
    }

    private function isAllowedOrigin(string $origin): bool
    {
        if ($origin === '') {
            $appEnv = strtolower((string) (getenv('APP_ENV') ?: 'dev'));
            $allowEmpty = (string) (getenv('APP_WS_ALLOW_EMPTY_ORIGIN') ?: '0');

            return $appEnv !== 'prod' || $allowEmpty === '1';
        }

        $raw = (string) (getenv('APP_ALLOWED_ORIGINS') ?: '');
        $allowed = array_values(array_filter(array_map(static fn (string $item): string => trim($item), explode(',', $raw))));

        return in_array($origin, $allowed, true);
    }

    private function pollMessages(): void
    {
        foreach ($this->clients as $client) {
            $meta = $this->meta[$client->resourceId] ?? null;
            if (!$meta) {
                continue;
            }

            $rows = $this->db->fetchAllAssociative(
                'SELECT m.id, m.conversation_id, m.ciphertext, m.iv, m.wrapped_keys, m.created_at, m.expires_at, m.sender_id
                 FROM message m
                 INNER JOIN conversation_member cm ON cm.conversation_id = m.conversation_id
                 WHERE cm.user_id = :uid AND m.created_at > :last_at
                 ORDER BY m.created_at ASC
                 LIMIT 40',
                ['uid' => $meta['userId'], 'last_at' => $meta['lastAt']]
            );

            foreach ($rows as $row) {
                if ($row['expires_at'] !== null && strtotime((string) $row['expires_at']) < time()) {
                    continue;
                }

                $wrapped = $row['wrapped_keys'];
                if (is_string($wrapped)) {
                    $wrapped = json_decode($wrapped, true);
                }
                if (!is_array($wrapped)) {
                    $wrapped = [];
                }

                $frame = [
                    'type' => 'new_message',
                    'conversationId' => $row['conversation_id'],
                    'message' => [
                        'id' => $row['id'],
                        'senderId' => $row['sender_id'],
                        'ciphertext' => $row['ciphertext'],
                        'iv' => $row['iv'],
                        'wrappedKeys' => $wrapped,
                        'createdAt' => (new \DateTimeImmutable((string) $row['created_at']))->format(DATE_ATOM),
                        'expiresAt' => $row['expires_at'] ? (new \DateTimeImmutable((string) $row['expires_at']))->format(DATE_ATOM) : null,
                    ],
                ];

                $client->send((string) json_encode($frame));
                $this->meta[$client->resourceId]['lastAt'] = (string) $row['created_at'];
            }
        }
    }

    private function purgeExpiredMessages(): void
    {
        try {
            $deleted = $this->db->executeStatement('DELETE FROM message WHERE expires_at IS NOT NULL AND expires_at < NOW()');
            if ($deleted > 0) {
                $this->wsLog(sprintf('PURGE deleted=%d expired messages', $deleted));
            }
        } catch (\Throwable $e) {
            $this->wsLog(sprintf('PURGE error=%s', $e->getMessage()));
        }
    }

    private function relayCallSignal(ConnectionInterface $from, array $payload): void
    {
        $targetUserId = trim((string) ($payload['targetUserId'] ?? ''));
        if ($targetUserId === '') {
            return;
        }

        $fromMeta = $this->meta[$from->resourceId] ?? null;
        if (!$fromMeta) {
            return;
        }

        $shareConversation = $this->db->fetchOne(
            'SELECT 1 FROM conversation_member cm1
             INNER JOIN conversation_member cm2 ON cm2.conversation_id = cm1.conversation_id
             WHERE cm1.user_id = :sender AND cm2.user_id = :target LIMIT 1',
            ['sender' => $fromMeta['userId'], 'target' => $targetUserId]
        );
        if (!$shareConversation) {
            $this->wsLog(sprintf('CALL_SIGNAL_BLOCKED sender=%s target=%s reason=no_shared_conversation', $fromMeta['userId'], $targetUserId));
            return;
        }

        foreach ($this->clients as $client) {
            $meta = $this->meta[$client->resourceId] ?? null;
            if (!$meta || $meta['userId'] !== $targetUserId) {
                continue;
            }

            $client->send((string) json_encode([
                'type' => 'call_signal',
                'fromUserId' => $fromMeta['userId'],
                'payload' => $payload['payload'] ?? null,
            ]));
        }
    }

    private function enforceConnectionLimit(string $userId, ConnectionInterface $current): void
    {
        $maxConnections = 5;
        $userConnections = [];

        foreach ($this->clients as $client) {
            $meta = $this->meta[$client->resourceId] ?? null;
            if ($meta && $meta['userId'] === $userId && $client !== $current) {
                $userConnections[] = $client;
            }
        }

        while (count($userConnections) >= $maxConnections) {
            $oldest = array_shift($userConnections);
            if ($oldest) {
                $this->wsLog(sprintf('CLOSE id=%s reason=connection_limit user=%s', (string) $oldest->resourceId, $userId));
                $oldest->close();
                $this->clients->detach($oldest);
                unset($this->meta[$oldest->resourceId]);
            }
        }
    }

    private function revalidateSessions(): void
    {
        foreach ($this->clients as $client) {
            $meta = $this->meta[$client->resourceId] ?? null;
            if (!$meta) {
                continue;
            }

            $valid = $this->db->fetchOne(
                'SELECT 1 FROM user_session WHERE user_id = :uid AND expires_at > NOW() LIMIT 1',
                ['uid' => $meta['userId']]
            );
            if (!$valid) {
                $this->wsLog(sprintf('CLOSE id=%s reason=session_expired user=%s', (string) $client->resourceId, $meta['userId']));
                $client->send((string) json_encode(['type' => 'error', 'message' => 'Session expired']));
                $client->close();
                $this->clients->detach($client);
                unset($this->meta[$client->resourceId]);
            }
        }
    }

    private function purgeExpiredSessions(): void
    {
        try {
            $deleted = $this->db->executeStatement('DELETE FROM user_session WHERE expires_at < NOW()');
            if ($deleted > 0) {
                $this->wsLog(sprintf('SESSION_PURGE deleted=%d expired sessions', $deleted));
            }
        } catch (\Throwable $e) {
            $this->wsLog(sprintf('SESSION_PURGE error=%s', $e->getMessage()));
        }
    }
}
