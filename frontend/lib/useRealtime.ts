"use client";

import { useEffect, useRef } from 'react';
import { getSupabaseClient } from '@/lib/supabase';
import type { Session } from '@/types';

type MessageRow = {
  id: string;
  conversation_id: string;
  sender_id: string | null;
  ciphertext: string;
  iv: string;
  wrapped_keys: Record<string, string> | null;
  created_at: string;
  expires_at: string | null;
  ephemeral_public_key: string | null;
  ratchet_header: string | null;
};

export function useRealtime(session: Session | null, onMessage: (payload: unknown) => void): void {
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  useEffect(() => {
    const userId = session?.userId.trim().toLowerCase() ?? null;
    if (!userId) return;

    const supabase = getSupabaseClient();
    const channel = supabase
      .channel(`messages:${userId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'message' },
        (payload) => {
          const row = payload.new as MessageRow;
          const wrappedKeys = row.wrapped_keys ?? {};
          const hasKey = Object.keys(wrappedKeys).some((id) => id.trim().toLowerCase() === userId);
          console.debug('[GS:supabase] INSERT on message table, id:', row.id, 'conv:', row.conversation_id, 'keys:', Object.keys(wrappedKeys), 'hasMyKey:', hasKey, 'myId:', userId);
          if (!hasKey) return;

          onMessageRef.current({
            type: 'new_message',
            conversationId: row.conversation_id,
            message: {
              id: row.id,
              senderId: row.sender_id ?? null,
              ciphertext: row.ciphertext,
              iv: row.iv,
              wrappedKeys,
              createdAt: row.created_at,
              expiresAt: row.expires_at,
              ephemeralPublicKey: row.ephemeral_public_key ?? null,
              ratchetHeader: row.ratchet_header ?? null,
            },
          });
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [session?.userId]);
}
