<?php

use App\Kernel;
use Symfony\Component\HttpFoundation\Request;

require_once dirname(__DIR__).'/vendor/autoload_runtime.php';

// Trust reverse proxies (Caddy/Traefik/Docker) for X-Forwarded-* headers.
// REMOTE_ADDR is the proxy, not the client — trust it to set the real IP.
Request::setTrustedProxies(
    ['127.0.0.1', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'],
    Request::HEADER_X_FORWARDED_FOR | Request::HEADER_X_FORWARDED_PROTO
);

return function (array $context) {
    return new Kernel($context['APP_ENV'], (bool) $context['APP_DEBUG']);
};
