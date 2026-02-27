import './globals.css';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import GhostAmbient from '@/components/GhostAmbient';
import { Inter } from 'next/font/google';

const inter = Inter({
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

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const nonce = (await headers()).get('x-nonce') ?? '';

  return (
    <html lang="fr">
      <body className={inter.variable}>
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html:
              "try{var t=localStorage.getItem('ghost_theme');document.documentElement.dataset.theme=(t==='light'?'light':'dark')}catch(e){document.documentElement.dataset.theme='dark'}",
          }}
        />
        <GhostAmbient />
        {children}
      </body>
    </html>
  );
}
