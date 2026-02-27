<?php

namespace App\Entity;

use Doctrine\ORM\Mapping as ORM;

#[ORM\Entity]
#[ORM\Table(name: 'message')]
class Message
{
    #[ORM\Id]
    #[ORM\Column(type: 'string', length: 36)]
    private string $id;

    #[ORM\ManyToOne(targetEntity: Conversation::class)]
    #[ORM\JoinColumn(nullable: false, onDelete: 'CASCADE')]
    private Conversation $conversation;

    #[ORM\ManyToOne(targetEntity: User::class)]
    #[ORM\JoinColumn(nullable: true, onDelete: 'SET NULL')]
    private ?User $sender;

    #[ORM\Column(type: 'text')]
    private string $ciphertext;

    #[ORM\Column(type: 'text')]
    private string $iv;

    #[ORM\Column(type: 'json')]
    private array $wrappedKeys;

    #[ORM\Column(type: 'datetime_immutable')]
    private \DateTimeImmutable $createdAt;

    #[ORM\Column(type: 'datetime_immutable', nullable: true)]
    private ?\DateTimeImmutable $expiresAt;

    #[ORM\Column(type: 'text', nullable: true)]
    private ?string $ephemeralPublicKey = null;

    #[ORM\Column(type: 'text', nullable: true)]
    private ?string $ratchetHeader = null;

    public function __construct(
        string $id,
        Conversation $conversation,
        ?User $sender,
        string $ciphertext,
        string $iv,
        array $wrappedKeys,
        ?\DateTimeImmutable $expiresAt,
        ?string $ephemeralPublicKey = null,
        ?string $ratchetHeader = null
    ) {
        $this->id = $id;
        $this->conversation = $conversation;
        $this->sender = $sender;
        $this->ciphertext = $ciphertext;
        $this->iv = $iv;
        $this->wrappedKeys = $wrappedKeys;
        $this->createdAt = new \DateTimeImmutable();
        $this->expiresAt = $expiresAt;
        $this->ephemeralPublicKey = $ephemeralPublicKey;
        $this->ratchetHeader = $ratchetHeader;
    }

    public function getId(): string
    {
        return $this->id;
    }

    public function getConversation(): Conversation
    {
        return $this->conversation;
    }

    public function getSender(): ?User
    {
        return $this->sender;
    }

    public function getCiphertext(): string
    {
        return $this->ciphertext;
    }

    public function getIv(): string
    {
        return $this->iv;
    }

    public function getWrappedKeys(): array
    {
        return $this->wrappedKeys;
    }

    public function getCreatedAt(): \DateTimeImmutable
    {
        return $this->createdAt;
    }

    public function getExpiresAt(): ?\DateTimeImmutable
    {
        return $this->expiresAt;
    }

    public function getEphemeralPublicKey(): ?string
    {
        return $this->ephemeralPublicKey;
    }

    public function getRatchetHeader(): ?string
    {
        return $this->ratchetHeader;
    }

    public function isExpired(): bool
    {
        return $this->expiresAt !== null && $this->expiresAt < new \DateTimeImmutable();
    }
}
