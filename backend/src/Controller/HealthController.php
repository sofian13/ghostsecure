<?php

namespace App\Controller;

use App\Service\JsonFactory;
use Symfony\Component\Routing\Attribute\Route;

class HealthController
{
    public function __construct(private readonly JsonFactory $json)
    {
    }

    #[Route('/api/health', name: 'api_health', methods: ['GET'])]
    public function __invoke()
    {
        return $this->json->ok([
            'status' => 'ok',
            'service' => 'ghost-secure-backend',
            'time' => (new \DateTimeImmutable())->format(DATE_ATOM),
        ]);
    }
}
