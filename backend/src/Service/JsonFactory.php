<?php

namespace App\Service;

use Symfony\Component\HttpFoundation\JsonResponse;

class JsonFactory
{
    public function ok(array $data, int $status = 200): JsonResponse
    {
        return new JsonResponse($data, $status, [
            'X-Content-Type-Options' => 'nosniff',
            'X-Frame-Options' => 'DENY',
            'Referrer-Policy' => 'no-referrer',
            'Strict-Transport-Security' => 'max-age=31536000; includeSubDomains; preload',
            'X-Permitted-Cross-Domain-Policies' => 'none',
            'Cross-Origin-Resource-Policy' => 'same-site',
            'Permissions-Policy' => 'geolocation=(), camera=(), microphone=(self)',
            'Cache-Control' => 'no-store, max-age=0',
            'Pragma' => 'no-cache',
        ]);
    }

    public function error(string $message, int $status = 400): JsonResponse
    {
        return $this->ok(['error' => $message], $status);
    }
}
