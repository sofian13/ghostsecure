<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

final class Version20260222000100 extends AbstractMigration
{
    public function getDescription(): string
    {
        return 'Initial schema for Ghost Secure encrypted messaging';
    }

    public function up(Schema $schema): void
    {
        $this->addSql('CREATE TABLE app_user (id VARCHAR(36) NOT NULL, public_key TEXT NOT NULL, created_at TIMESTAMP(0) WITHOUT TIME ZONE NOT NULL, PRIMARY KEY(id))');
        $this->addSql('CREATE TABLE conversation (id VARCHAR(36) NOT NULL, created_at TIMESTAMP(0) WITHOUT TIME ZONE NOT NULL, PRIMARY KEY(id))');
        $this->addSql('CREATE TABLE user_session (id SERIAL NOT NULL, user_id VARCHAR(36) NOT NULL, token_hash VARCHAR(128) NOT NULL, created_at TIMESTAMP(0) WITHOUT TIME ZONE NOT NULL, expires_at TIMESTAMP(0) WITHOUT TIME ZONE NOT NULL, PRIMARY KEY(id))');
        $this->addSql('CREATE UNIQUE INDEX UNIQ_SESSION_TOKEN ON user_session (token_hash)');
        $this->addSql('CREATE INDEX IDX_SESSION_USER ON user_session (user_id)');
        $this->addSql('CREATE TABLE conversation_member (id SERIAL NOT NULL, conversation_id VARCHAR(36) NOT NULL, user_id VARCHAR(36) NOT NULL, PRIMARY KEY(id))');
        $this->addSql('CREATE UNIQUE INDEX uniq_conversation_member ON conversation_member (conversation_id, user_id)');
        $this->addSql('CREATE INDEX IDX_CM_CONVERSATION ON conversation_member (conversation_id)');
        $this->addSql('CREATE INDEX IDX_CM_USER ON conversation_member (user_id)');
        $this->addSql('CREATE TABLE message (id VARCHAR(36) NOT NULL, conversation_id VARCHAR(36) NOT NULL, sender_id VARCHAR(36) NOT NULL, ciphertext TEXT NOT NULL, iv TEXT NOT NULL, wrapped_keys JSON NOT NULL, created_at TIMESTAMP(0) WITHOUT TIME ZONE NOT NULL, expires_at TIMESTAMP(0) WITHOUT TIME ZONE DEFAULT NULL, PRIMARY KEY(id))');
        $this->addSql('CREATE INDEX IDX_MSG_CONV_CREATED ON message (conversation_id, created_at)');
        $this->addSql('CREATE INDEX IDX_MSG_SENDER ON message (sender_id)');

        $this->addSql('ALTER TABLE user_session ADD CONSTRAINT FK_SESSION_USER FOREIGN KEY (user_id) REFERENCES app_user (id) ON DELETE CASCADE NOT DEFERRABLE INITIALLY IMMEDIATE');
        $this->addSql('ALTER TABLE conversation_member ADD CONSTRAINT FK_CM_CONV FOREIGN KEY (conversation_id) REFERENCES conversation (id) ON DELETE CASCADE NOT DEFERRABLE INITIALLY IMMEDIATE');
        $this->addSql('ALTER TABLE conversation_member ADD CONSTRAINT FK_CM_USER FOREIGN KEY (user_id) REFERENCES app_user (id) ON DELETE CASCADE NOT DEFERRABLE INITIALLY IMMEDIATE');
        $this->addSql('ALTER TABLE message ADD CONSTRAINT FK_MSG_CONV FOREIGN KEY (conversation_id) REFERENCES conversation (id) ON DELETE CASCADE NOT DEFERRABLE INITIALLY IMMEDIATE');
        $this->addSql('ALTER TABLE message ADD CONSTRAINT FK_MSG_SENDER FOREIGN KEY (sender_id) REFERENCES app_user (id) ON DELETE CASCADE NOT DEFERRABLE INITIALLY IMMEDIATE');
    }

    public function down(Schema $schema): void
    {
        $this->addSql('DROP TABLE message');
        $this->addSql('DROP TABLE conversation_member');
        $this->addSql('DROP TABLE user_session');
        $this->addSql('DROP TABLE conversation');
        $this->addSql('DROP TABLE app_user');
    }
}
