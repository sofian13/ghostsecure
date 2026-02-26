"use client";

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';

type TabItem = {
  key: 'chats' | 'calls' | 'settings';
  label: string;
  href: '/chat' | '/call' | '/settings';
  icon: 'chat' | 'call' | 'settings';
};

const tabs: TabItem[] = [
  { key: 'chats', label: 'Chats', href: '/chat', icon: 'chat' },
  { key: 'calls', label: 'Appels', href: '/call', icon: 'call' },
  { key: 'settings', label: 'Parametres', href: '/settings', icon: 'settings' },
];

function isActive(pathname: string, item: TabItem): boolean {
  if (item.key === 'chats') return pathname === '/chat' || pathname.startsWith('/chat/');
  return pathname === item.href;
}

function TabIcon({ kind }: { kind: TabItem['icon'] }) {
  if (kind === 'chat') {
    return (
      <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v7A2.5 2.5 0 0 1 17.5 15H9l-4.2 3.4c-.33.27-.8.03-.8-.39V5.5Z" />
      </svg>
    );
  }
  if (kind === 'call') {
    return (
      <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M7.1 2.6a1.5 1.5 0 0 1 1.7.9l1.2 2.9a1.5 1.5 0 0 1-.3 1.6L8.3 9.4a13.4 13.4 0 0 0 6.3 6.3l1.4-1.4a1.5 1.5 0 0 1 1.6-.3l2.9 1.2a1.5 1.5 0 0 1 .9 1.7l-.4 2.3a1.5 1.5 0 0 1-1.5 1.3c-9.6 0-17.4-7.8-17.4-17.4a1.5 1.5 0 0 1 1.3-1.5l2.3-.4Z" />
      </svg>
    );
  }
  return (
    <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
      <path d="m12 2 2.2 1.2 2.5-.3 1.3 2.1 2.3 1 .1 2.5 1.6 2-1 2.3 1 2.3-1.6 2-.1 2.5-2.3 1-1.3 2.1-2.5-.3L12 22l-2.2-1.2-2.5.3-1.3-2.1-2.3-1-.1-2.5-1.6-2 1-2.3-1-2.3 1.6-2 .1-2.5 2.3-1 1.3-2.1 2.5.3L12 2Zm0 6a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z" />
    </svg>
  );
}

export default function MobileTabs() {
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    for (const item of tabs) {
      router.prefetch(item.href);
    }
  }, [router]);

  return (
    <nav className="mobile-tabs" aria-label="Navigation principale">
      {tabs.map((item) => {
        const active = isActive(pathname, item);
        return (
          <Link
            key={item.key}
            href={item.href}
            prefetch
            className={`mobile-tab ${active ? 'active' : ''}`}
            aria-current={active ? 'page' : undefined}
          >
            <TabIcon kind={item.icon} />
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
