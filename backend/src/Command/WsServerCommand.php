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

    public function __construct(private readonly Connection $db)
    {
        parent::__construct();
        $this->clients = new \SplObjectStorage();
    }

    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        $loop = \React\EventLoop\Loop::get();

        $socket = new \React\Socket\SocketServer('0.0.0.0:8081', [], $loop);
        new IoServer(new HttpServer(new WsServer($this)), $socket, $loop);

        $loop->addPeriodicTimer(1.0, function (): void {
            $this->pollMessages();
        });

        $output->writeln('Ghost Secure WebSocket server listening on :8081');
        $loop->run();

        return Command::SUCCESS;
    }

    public function onOpen(ConnectionInterface $conn): void
    {
        $query = [];
        parse_str($conn->httpRequest->getUri()->getQuery(), $query);
        $token = (string) ($query['token'] ?? '');

        if ($token === '') {
            $conn->close();
            return;
        }

        $row = $this->db->fetchAssociative(
            'SELECT s.id, u.id as user_id
             FROM user_session s
             INNER JOIN app_user u ON u.id = s.user_id
             WHERE s.token_hash = :hash AND s.expires_at > NOW()
             LIMIT 1',
            ['hash' => hash('sha256', $token)]
        );

        if (!$row || !isset($row['user_id'])) {
            $conn->close();
            return;
        }

        $this->clients->attach($conn);
        $this->meta[$conn->resourceId] = [
            'userId' => (string) $row['user_id'],
            'lastAt' => (new \DateTimeImmutable('-10 seconds'))->format('Y-m-d H:i:sP'),
        ];
    }

    public function onMessage(ConnectionInterface $from, $msg): void
    {
        $payload = json_decode((string) $msg, true);
        if (!is_array($payload)) {
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
        $this->clients->detach($conn);
        unset($this->meta[$conn->resourceId]);
    }

    public function onError(ConnectionInterface $conn, \Exception $e): void
    {
        $conn->close();
        $this->onClose($conn);
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
}
