<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

final class Version20260226000200 extends AbstractMigration
{
    public function getDescription(): string
    {
        return 'Add conversation kind/title to support group chats';
    }

    public function up(Schema $schema): void
    {
        $this->addSql("ALTER TABLE conversation ADD kind VARCHAR(16) DEFAULT 'direct' NOT NULL");
        $this->addSql('ALTER TABLE conversation ADD title VARCHAR(120) DEFAULT NULL');
        $this->addSql("UPDATE conversation SET kind = 'direct' WHERE kind IS NULL OR kind = ''");
    }

    public function down(Schema $schema): void
    {
        $this->addSql('ALTER TABLE conversation DROP kind');
        $this->addSql('ALTER TABLE conversation DROP title');
    }
}
