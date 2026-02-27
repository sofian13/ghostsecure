<?php

namespace App\EventSubscriber;

use Symfony\Component\EventDispatcher\EventSubscriberInterface;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpKernel\Event\ExceptionEvent;
use Symfony\Component\HttpKernel\Exception\HttpExceptionInterface;
use Symfony\Component\HttpKernel\KernelEvents;

class ApiExceptionSubscriber implements EventSubscriberInterface
{
    public static function getSubscribedEvents(): array
    {
        return [
            KernelEvents::EXCEPTION => 'onKernelException',
        ];
    }

    public function onKernelException(ExceptionEvent $event): void
    {
        $request = $event->getRequest();
        if (!str_starts_with($request->getPathInfo(), '/api/')) {
            return;
        }

        $throwable = $event->getThrowable();
        $status = 500;
        if ($throwable instanceof HttpExceptionInterface) {
            $status = $throwable->getStatusCode();
        }

        $payload = ['error' => 'Internal server error.'];
        if ($status < 500) {
            $payload['error'] = $throwable->getMessage() !== '' ? $throwable->getMessage() : 'Request failed.';
        } elseif ($this->isDebugEnabled()) {
            $payload['error'] = $throwable->getMessage() !== '' ? $throwable->getMessage() : 'Internal server error.';
            $payload['exception'] = $throwable::class;
        }

        $origin = (string) $request->headers->get('Origin', '');
        $headers = [
            'X-Content-Type-Options' => 'nosniff',
            'X-Frame-Options' => 'DENY',
            'Referrer-Policy' => 'no-referrer',
            'Strict-Transport-Security' => 'max-age=31536000; includeSubDomains; preload',
            'X-Permitted-Cross-Domain-Policies' => 'none',
            'Cross-Origin-Resource-Policy' => 'same-site',
            'Permissions-Policy' => 'geolocation=(), camera=(), microphone=(self)',
            'Cache-Control' => 'no-store, max-age=0',
            'Pragma' => 'no-cache',
        ];
        if ($origin !== '' && $this->isAllowedOrigin($origin)) {
            $headers['Access-Control-Allow-Origin'] = $origin;
            $headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
            $headers['Access-Control-Allow-Methods'] = 'GET,POST,DELETE,OPTIONS';
            $headers['Access-Control-Allow-Credentials'] = 'false';
            $headers['Vary'] = 'Origin';
        }

        $event->setResponse(new JsonResponse($payload, $status, $headers));
    }

    private function isAllowedOrigin(string $origin): bool
    {
        $raw = getenv('APP_ALLOWED_ORIGINS') ?: 'http://localhost:3000';
        $allowed = array_values(array_filter(array_map(
            static fn (string $item): string => trim($item),
            explode(',', $raw)
        )));

        return in_array($origin, $allowed, true);
    }

    private function isDebugEnabled(): bool
    {
        $raw = strtolower(trim((string) (getenv('APP_API_DEBUG_ERRORS') ?: '0')));
        return in_array($raw, ['1', 'true', 'yes', 'on'], true);
    }
}

