import './globals.css';
import type { Metadata } from 'next';
import GhostAmbient from '@/components/GhostAmbient';
import { Orbitron, Space_Grotesk } from 'next/font/google';

const displayFont = Orbitron({
  subsets: ['latin'],
  variable: '--font-display',
});

const bodyFont = Space_Grotesk({
  subsets: ['latin'],
  variable: '--font-body',
});

export const metadata: Metadata = {
  title: 'Ghost Secure',
  description: 'Messagerie chiffree de bout en bout, anonyme et minimaliste.',
  robots: {
    index: false,
    follow: false,
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body className={`${displayFont.variable} ${bodyFont.variable}`}>
        <GhostAmbient />
        {children}
      </body>
    </html>
  );
}
