<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

final class Version20260227100100 extends AbstractMigration
{
    public function getDescription(): string
    {
        return 'Sealed sender: make message.sender_id nullable';
    }

    public function up(Schema $schema): void
    {
        $this->addSql('ALTER TABLE message ALTER COLUMN sender_id DROP NOT NULL');
    }

    public function down(Schema $schema): void
    {
        $this->addSql('ALTER TABLE message ALTER COLUMN sender_id SET NOT NULL');
    }
}
