"use client";

import { usePathname, useRouter } from 'next/navigation';

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
    return <span className="mobile-tab-glyph" aria-hidden="true">C</span>;
  }
  if (kind === 'call') {
    return <span className="mobile-tab-glyph" aria-hidden="true">A</span>;
  }
  return <span className="mobile-tab-glyph" aria-hidden="true">P</span>;
}

export default function MobileTabs() {
  const pathname = usePathname();
  const router = useRouter();

  return (
    <nav className="mobile-tabs" aria-label="Navigation principale">
      {tabs.map((item) => {
        const active = isActive(pathname, item);
        return (
          <button
            key={item.key}
            type="button"
            className={`mobile-tab ${active ? 'active' : ''}`}
            onClick={() => router.push(item.href)}
            aria-current={active ? 'page' : undefined}
          >
            <TabIcon kind={item.icon} />
            <span>{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
