<?php

namespace App\Service;

use Symfony\Component\HttpFoundation\JsonResponse;

class JsonFactory
{
    public function ok(array $data, int $status = 200): JsonResponse
    {
        $origin = (string) ($_SERVER['HTTP_ORIGIN'] ?? '');
        $allowedOrigin = $this->resolveAllowedOrigin($origin);

        return new JsonResponse($data, $status, [
            'Access-Control-Allow-Origin' => $allowedOrigin,
            'Access-Control-Allow-Headers' => 'Content-Type, Authorization',
            'Access-Control-Allow-Methods' => 'GET,POST,OPTIONS',
            'Vary' => 'Origin',
            'X-Content-Type-Options' => 'nosniff',
            'X-Frame-Options' => 'DENY',
            'Referrer-Policy' => 'no-referrer',
            'Permissions-Policy' => 'geolocation=(), camera=(), microphone=()',
            'Cache-Control' => 'no-store, max-age=0',
            'Pragma' => 'no-cache',
        ]);
    }

    public function error(string $message, int $status = 400): JsonResponse
    {
        return $this->ok(['error' => $message], $status);
    }

    private function resolveAllowedOrigin(string $origin): string
    {
        $raw = getenv('APP_ALLOWED_ORIGINS') ?: 'http://localhost:3000';
        $allowed = array_values(array_filter(array_map(static fn (string $item): string => trim($item), explode(',', $raw))));

        if ($origin !== '' && in_array($origin, $allowed, true)) {
            return $origin;
        }

        return $allowed[0] ?? 'http://localhost:3000';
    }
}
