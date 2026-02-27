<?php

namespace App\Service;

use App\Entity\Message;

class MessageSerializer
{
    public function serialize(Message $message): array
    {
        return [
            'id' => $message->getId(),
            'senderId' => null,
            'ciphertext' => $message->getCiphertext(),
            'iv' => $message->getIv(),
            'wrappedKeys' => $message->getWrappedKeys(),
            'createdAt' => $message->getCreatedAt()->format(DATE_ATOM),
            'expiresAt' => $message->getExpiresAt()?->format(DATE_ATOM),
            'ephemeralPublicKey' => $message->getEphemeralPublicKey(),
            'ratchetHeader' => $message->getRatchetHeader(),
        ];
    }
}
