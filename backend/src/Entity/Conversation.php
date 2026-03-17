<?php

namespace App\Entity;

use Doctrine\ORM\Mapping as ORM;

#[ORM\Entity]
#[ORM\Table(name: 'conversation')]
class Conversation
{
    public const KIND_DIRECT = 'direct';
    public const KIND_GROUP = 'group';
    public const DEFAULT_DISAPPEARING_TIMER_SECONDS = 3600;

    #[ORM\Id]
    #[ORM\Column(type: 'string', length: 36)]
    private string $id;

    #[ORM\Column(type: 'string', length: 16)]
    private string $kind;

    #[ORM\Column(type: 'string', length: 120, nullable: true)]
    private ?string $title;

    #[ORM\Column(type: 'datetime_immutable')]
    private \DateTimeImmutable $createdAt;

    #[ORM\Column(type: 'integer', options: ['default' => self::DEFAULT_DISAPPEARING_TIMER_SECONDS])]
    private int $disappearingTimerSeconds;

    public function __construct(
        string $id,
        string $kind = self::KIND_DIRECT,
        ?string $title = null,
        int $disappearingTimerSeconds = self::DEFAULT_DISAPPEARING_TIMER_SECONDS
    )
    {
        $this->id = $id;
        $this->kind = $kind;
        $this->title = $title;
        $this->createdAt = new \DateTimeImmutable();
        $this->disappearingTimerSeconds = $disappearingTimerSeconds;
    }

    public function getId(): string
    {
        return $this->id;
    }

    public function getKind(): string
    {
        return $this->kind;
    }

    public function isGroup(): bool
    {
        return $this->kind === self::KIND_GROUP;
    }

    public function getTitle(): ?string
    {
        return $this->title;
    }

    public function getDisappearingTimerSeconds(): int
    {
        return $this->disappearingTimerSeconds;
    }

    public function setDisappearingTimerSeconds(int $disappearingTimerSeconds): void
    {
        $this->disappearingTimerSeconds = $disappearingTimerSeconds;
    }
}
