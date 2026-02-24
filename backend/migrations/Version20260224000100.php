<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

final class Version20260224000100 extends AbstractMigration
{
    public function getDescription(): string
    {
        return 'Add secret_hash to app_user for login credentials';
    }

    public function up(Schema $schema): void
    {
        $this->addSql('ALTER TABLE app_user ADD secret_hash VARCHAR(255) DEFAULT NULL');
    }

    public function down(Schema $schema): void
    {
        $this->addSql('ALTER TABLE app_user DROP secret_hash');
    }
}
