"use client";

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getSession } from '@/lib/session';

export default function Home() {
  const router = useRouter();

  useEffect(() => {
    const session = getSession();
    router.replace(session ? '/chat' : '/login');
  }, [router]);

  return <main className="centered">Initializing Ghost Secure...</main>;
}
