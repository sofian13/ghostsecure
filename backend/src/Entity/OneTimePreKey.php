<?php

namespace App\Entity;

use Doctrine\ORM\Mapping as ORM;

#[ORM\Entity]
#[ORM\Table(name: 'one_time_prekey')]
class OneTimePreKey
{
    #[ORM\Id]
    #[ORM\Column(type: 'string', length: 36)]
    private string $id;

    #[ORM\Column(type: 'string', length: 36)]
    private string $userId;

    #[ORM\Column(type: 'integer')]
    private int $keyId;

    #[ORM\Column(type: 'text')]
    private string $publicKey;

    #[ORM\Column(type: 'datetime_immutable')]
    private \DateTimeImmutable $createdAt;

    public function __construct(string $id, string $userId, int $keyId, string $publicKey)
    {
        $this->id = $id;
        $this->userId = $userId;
        $this->keyId = $keyId;
        $this->publicKey = $publicKey;
        $this->createdAt = new \DateTimeImmutable();
    }

    public function getId(): string
    {
        return $this->id;
    }

    public function getUserId(): string
    {
        return $this->userId;
    }

    public function getKeyId(): int
    {
        return $this->keyId;
    }

    public function getPublicKey(): string
    {
        return $this->publicKey;
    }

    public function getCreatedAt(): \DateTimeImmutable
    {
        return $this->createdAt;
    }
}
