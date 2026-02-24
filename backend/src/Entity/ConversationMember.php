<?php

namespace App\Entity;

use Doctrine\ORM\Mapping as ORM;

#[ORM\Entity]
#[ORM\Table(
    name: 'conversation_member',
    uniqueConstraints: [new ORM\UniqueConstraint(name: 'uniq_conversation_member', columns: ['conversation_id', 'user_id'])]
)]
class ConversationMember
{
    #[ORM\Id]
    #[ORM\GeneratedValue]
    #[ORM\Column(type: 'integer')]
    private ?int $id = null;

    #[ORM\ManyToOne(targetEntity: Conversation::class)]
    #[ORM\JoinColumn(nullable: false, onDelete: 'CASCADE')]
    private Conversation $conversation;

    #[ORM\ManyToOne(targetEntity: User::class)]
    #[ORM\JoinColumn(nullable: false, onDelete: 'CASCADE')]
    private User $user;

    public function __construct(Conversation $conversation, User $user)
    {
        $this->conversation = $conversation;
        $this->user = $user;
    }

    public function getConversation(): Conversation
    {
        return $this->conversation;
    }

    public function getUser(): User
    {
        return $this->user;
    }
}
