FROM php:8.4-fpm

RUN apt-get update \
  && apt-get install -y git unzip libpq-dev \
  && docker-php-ext-install pdo_pgsql opcache \
  && rm -rf /var/lib/apt/lists/*

COPY --from=composer:2 /usr/bin/composer /usr/bin/composer
COPY --from=caddy:2 /usr/bin/caddy /usr/bin/caddy

WORKDIR /app
COPY . /app

RUN composer install --no-interaction --optimize-autoloader

EXPOSE 8000

CMD ["sh", "-c", "php-fpm -D && caddy run --config /app/docker/Caddyfile --adapter caddyfile"]
