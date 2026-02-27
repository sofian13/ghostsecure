<?php

namespace App\Command;

use Doctrine\DBAL\Connection;
use Symfony\Component\Console\Attribute\AsCommand;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Output\OutputInterface;

#[AsCommand(name: 'app:purge-expired', description: 'Delete expired ephemeral messages from the database.')]
class PurgeExpiredMessagesCommand extends Command
{
    public function __construct(private readonly Connection $db)
    {
        parent::__construct();
    }

    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        $deleted = $this->db->executeStatement(
            'DELETE FROM message WHERE expires_at IS NOT NULL AND expires_at < NOW()'
        );

        $output->writeln(sprintf('Purged %d expired message(s).', $deleted));

        return Command::SUCCESS;
    }
}
