<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

final class Version20260301000100 extends AbstractMigration
{
    public function getDescription(): string
    {
        return 'Add Signal Protocol pre-key columns to app_user, ratchet_header to message, and one_time_prekey table';
    }

    public function up(Schema $schema): void
    {
        $this->addSql('ALTER TABLE app_user ADD COLUMN identity_key TEXT DEFAULT NULL');
        $this->addSql('ALTER TABLE app_user ADD COLUMN signed_prekey TEXT DEFAULT NULL');
        $this->addSql('ALTER TABLE app_user ADD COLUMN signed_prekey_signature TEXT DEFAULT NULL');
        $this->addSql('ALTER TABLE app_user ADD COLUMN registration_id INTEGER DEFAULT NULL');

        $this->addSql('ALTER TABLE message ADD COLUMN ratchet_header TEXT DEFAULT NULL');

        $this->addSql(<<<'SQL'
            CREATE TABLE one_time_prekey (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id VARCHAR(36) NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
                key_id INTEGER NOT NULL,
                public_key TEXT NOT NULL,
                created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
                UNIQUE(user_id, key_id)
            )
            SQL
        );
        $this->addSql('CREATE INDEX idx_otpk_user ON one_time_prekey(user_id)');
    }

    public function down(Schema $schema): void
    {
        $this->addSql('DROP TABLE IF EXISTS one_time_prekey');
        $this->addSql('ALTER TABLE message DROP COLUMN ratchet_header');
        $this->addSql('ALTER TABLE app_user DROP COLUMN identity_key');
        $this->addSql('ALTER TABLE app_user DROP COLUMN signed_prekey');
        $this->addSql('ALTER TABLE app_user DROP COLUMN signed_prekey_signature');
        $this->addSql('ALTER TABLE app_user DROP COLUMN registration_id');
    }
}
