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

    #[ORM\Column(type: 'text', nullable: true)]
    private ?string $ecdhPublicKey = null;

    #[ORM\Column(type: 'text', nullable: true)]
    private ?string $identityKey = null;

    #[ORM\Column(type: 'text', nullable: true)]
    private ?string $signedPrekey = null;

    #[ORM\Column(type: 'text', nullable: true)]
    private ?string $signedPrekeySignature = null;

    #[ORM\Column(type: 'integer', nullable: true)]
    private ?int $registrationId = null;

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

    public function getEcdhPublicKey(): ?string
    {
        return $this->ecdhPublicKey;
    }

    public function setEcdhPublicKey(?string $ecdhPublicKey): void
    {
        $this->ecdhPublicKey = $ecdhPublicKey;
    }

    public function getIdentityKey(): ?string
    {
        return $this->identityKey;
    }

    public function setIdentityKey(?string $identityKey): void
    {
        $this->identityKey = $identityKey;
    }

    public function getSignedPrekey(): ?string
    {
        return $this->signedPrekey;
    }

    public function setSignedPrekey(?string $signedPrekey): void
    {
        $this->signedPrekey = $signedPrekey;
    }

    public function getSignedPrekeySignature(): ?string
    {
        return $this->signedPrekeySignature;
    }

    public function setSignedPrekeySignature(?string $signedPrekeySignature): void
    {
        $this->signedPrekeySignature = $signedPrekeySignature;
    }

    public function getRegistrationId(): ?int
    {
        return $this->registrationId;
    }

    public function setRegistrationId(?int $registrationId): void
    {
        $this->registrationId = $registrationId;
    }
}
