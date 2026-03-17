<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

final class Version20260317000100 extends AbstractMigration
{
    public function getDescription(): string
    {
        return 'Add per-conversation disappearing timer';
    }

    public function up(Schema $schema): void
    {
        $this->addSql('ALTER TABLE conversation ADD disappearing_timer_seconds INTEGER NOT NULL DEFAULT 3600');
    }

    public function down(Schema $schema): void
    {
        $this->addSql('ALTER TABLE conversation DROP disappearing_timer_seconds');
    }
}
