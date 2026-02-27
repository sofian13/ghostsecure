<?php

namespace App\Entity;

use Doctrine\ORM\Mapping as ORM;

#[ORM\Entity]
#[ORM\Table(name: 'app_user')]
class User
{
    #[ORM\Id]
    #[ORM\Column(type: 'string', length: 36)]
    private string $id;

    #[ORM\Column(type: 'text')]
    private string $publicKey;

    #[ORM\Column(type: 'string', length: 255, nullable: true)]
    private ?string $secretHash = null;

    #[ORM\Column(type: 'datetime_immutable')]
    private \DateTimeImmutable $createdAt;

    public function __construct(string $id, string $publicKey)
    {
        $this->id = $id;
        $this->publicKey = $publicKey;
        $this->createdAt = new \DateTimeImmutable();
    }

    public function getId(): string
    {
        return $this->id;
    }

    public function getPublicKey(): string
    {
        return $this->publicKey;
    }

    public function getSecretHash(): ?string
    {
        return $this->secretHash;
    }

    public function setSecretHash(string $secretHash): void
    {
        $this->secretHash = $secretHash;
    }
}
