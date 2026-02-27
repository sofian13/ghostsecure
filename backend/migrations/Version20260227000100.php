<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

final class Version20260227000100 extends AbstractMigration
{
    public function getDescription(): string
    {
        return 'Add composite index on user_session (user_id, expires_at) for faster lookups';
    }

    public function up(Schema $schema): void
    {
        $this->addSql('CREATE INDEX IDX_SESSION_USER_EXPIRES ON user_session (user_id, expires_at)');
    }

    public function down(Schema $schema): void
    {
        $this->addSql('DROP INDEX IDX_SESSION_USER_EXPIRES');
    }
}
