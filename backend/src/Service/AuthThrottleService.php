<?php

namespace App\Service;

class AuthThrottleService
{
    private string $dir;

    public function __construct()
    {
        $this->dir = rtrim(sys_get_temp_dir(), DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR . 'ghostsecure-auth-throttle';
        if (!is_dir($this->dir)) {
            @mkdir($this->dir, 0700, true);
        }
    }

    private const SCOPE_DEFAULTS = [
        'prekey_fetch' => ['max' => 10, 'window' => 300],
    ];

    public function isAllowed(string $scope, string $key): bool
    {
        $defaults = self::SCOPE_DEFAULTS[$scope] ?? ['max' => 20, 'window' => 300];
        $limit = $this->readIntEnv(strtoupper(sprintf('APP_AUTH_RATE_LIMIT_%s_MAX', $scope)), $defaults['max']);
        $windowSeconds = $this->readIntEnv(strtoupper(sprintf('APP_AUTH_RATE_LIMIT_%s_WINDOW', $scope)), $defaults['window']);
        $now = time();
        $file = $this->filePath($scope, $key);

        $fp = @fopen($file, 'c+');
        if ($fp === false) {
            return false;
        }

        try {
            if (!flock($fp, LOCK_EX)) {
                return false;
            }

            $raw = stream_get_contents($fp);
            $events = json_decode($raw !== false ? $raw : '[]', true);
            if (!is_array($events)) {
                $events = [];
            }

            $cutoff = $now - $windowSeconds;
            $events = array_values(array_filter($events, static fn ($ts): bool => is_int($ts) && $ts >= $cutoff));

            if (count($events) >= $limit) {
                return false;
            }

            $events[] = $now;
            ftruncate($fp, 0);
            rewind($fp);
            fwrite($fp, (string) json_encode($events));
            fflush($fp);
        } finally {
            flock($fp, LOCK_UN);
            fclose($fp);
        }

        return true;
    }

    public function reset(string $scope, string $key): void
    {
        $file = $this->filePath($scope, $key);
        if (is_file($file)) {
            @unlink($file);
        }
    }

    private function filePath(string $scope, string $key): string
    {
        return $this->dir . DIRECTORY_SEPARATOR . $scope . '_' . hash('sha256', strtolower(trim($key))) . '.json';
    }

    private function readIntEnv(string $name, int $default): int
    {
        $raw = getenv($name);
        if ($raw === false || $raw === '') {
            return $default;
        }

        $value = (int) $raw;
        return $value > 0 ? $value : $default;
    }
}

