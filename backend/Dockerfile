FROM php:8.4-cli

RUN apt-get update \
  && apt-get install -y git unzip libpq-dev \
  && docker-php-ext-install pdo_pgsql \
  && rm -rf /var/lib/apt/lists/*

COPY --from=composer:2 /usr/bin/composer /usr/bin/composer

WORKDIR /app
COPY . /app

RUN composer install --no-interaction

CMD ["php", "-S", "0.0.0.0:8000", "-t", "public"]
