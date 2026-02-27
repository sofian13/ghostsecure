<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

final class Version20260228000100 extends AbstractMigration
{
    public function getDescription(): string
    {
        return 'Add ECDH public key to users and ephemeral public key to messages for forward secrecy';
    }

    public function up(Schema $schema): void
    {
        $this->addSql('ALTER TABLE app_user ADD COLUMN ecdh_public_key TEXT DEFAULT NULL');
        $this->addSql('ALTER TABLE message ADD COLUMN ephemeral_public_key TEXT DEFAULT NULL');
    }

    public function down(Schema $schema): void
    {
        $this->addSql('ALTER TABLE app_user DROP COLUMN ecdh_public_key');
        $this->addSql('ALTER TABLE message DROP COLUMN ephemeral_public_key');
    }
}
