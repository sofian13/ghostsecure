"use client";

import { useEffect, useMemo, useState } from 'react';
import { getSupabaseClient } from '@/lib/supabase';

type Props = {
  userId: string;
  children: React.ReactNode;
};

export default function SecurityShell({ userId, children }: Props) {
  const [hidden, setHidden] = useState(false);
  const [manualLock, setManualLock] = useState(false);

  useEffect(() => {
    const lock = () => setHidden(true);
    const onVisibility = () => setHidden(document.visibilityState !== 'visible');
    const onBlur = () => setHidden(true);
    const onFocus = () => setHidden(document.visibilityState !== 'visible');
    const onPageHide = () => setHidden(true);
    const onResize = () => setHidden(true);
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const blockedCombo = (event.ctrlKey || event.metaKey) && ['c', 'v', 'x', 'p', 's'].includes(key);
      if (blockedCombo) event.preventDefault();
    };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    window.addEventListener('beforeprint', lock);
    window.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      window.removeEventListener('beforeprint', lock);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  useEffect(() => {
    const me = userId.trim().toLowerCase();
    if (!me) return;

    const lastNotified = { id: '' };
    const supabase = getSupabaseClient();

    const notifyIncomingCall = (inviteId: string, fromUserId: string) => {
      if (!inviteId || inviteId === lastNotified.id) return;
      lastNotified.id = inviteId;

      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        navigator.vibrate([200, 120, 200]);
      }

      try {
        const audioCtx = new AudioContext();
        const play = (at: number) => {
          const osc = audioCtx.createOscillator();
          const gain = audioCtx.createGain();
          osc.type = 'sine';
          osc.frequency.value = 880;
          gain.gain.value = 0.0001;
          osc.connect(gain);
          gain.connect(audioCtx.destination);
          const now = audioCtx.currentTime + at;
          gain.gain.exponentialRampToValueAtTime(0.05, now + 0.01);
          gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
          osc.start(now);
          osc.stop(now + 0.2);
        };
        play(0);
        play(0.32);
        play(0.64);
        window.setTimeout(() => void audioCtx.close(), 1300);
      } catch {
        // no-op
      }

      if (typeof Notification !== 'undefined') {
        const show = () => {
          const n = new Notification('Ghost Secure - Appel entrant', {
            body: `${fromUserId} vous appelle`,
            tag: `call-${inviteId}`,
            requireInteraction: true,
          });
          n.onclick = () => {
            window.focus();
            window.location.href = `/call?target=${encodeURIComponent(fromUserId)}&autocall=0`;
          };
        };

        if (Notification.permission === 'granted') show();
        if (Notification.permission === 'default') {
          void Notification.requestPermission().then((perm) => {
            if (perm === 'granted') show();
          });
        }
      }
    };

    const handleRow = (row: { id?: string; status?: string; from_user_id?: string; target_user_id?: string }) => {
      const target = (row.target_user_id ?? '').trim().toLowerCase();
      const from = (row.from_user_id ?? '').trim().toLowerCase();
      if (!row.id || !from || target !== me || row.status !== 'pending') return;
      notifyIncomingCall(row.id, from);
    };

    const channel = supabase
      .channel(`secure-call-alert:${me}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'call_invite' }, ({ new: row }) => {
        handleRow((row ?? {}) as { id?: string; status?: string; from_user_id?: string; target_user_id?: string });
      })
      .subscribe();

    const poll = window.setInterval(async () => {
      const { data } = await supabase
        .from('call_invite')
        .select('id,status,from_user_id,target_user_id')
        .eq('target_user_id', me)
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (data) {
        handleRow(data as { id?: string; status?: string; from_user_id?: string; target_user_id?: string });
      }
    }, 1100);

    return () => {
      window.clearInterval(poll);
      void supabase.removeChannel(channel);
    };
  }, [userId]);

  const wm = useMemo(() => `ghost:${userId.slice(0, 8)}`, [userId]);
  const isMasked = hidden || manualLock;

  return (
    <div
      className="security-shell"
      onCopy={(e) => e.preventDefault()}
      onPaste={(e) => e.preventDefault()}
      onCut={(e) => e.preventDefault()}
      onDrop={(e) => e.preventDefault()}
      onDragStart={(e) => e.preventDefault()}
    >
      <div className="watermark">{wm}</div>
      <div className="watermark-grid" aria-hidden="true">
        <span>{wm}</span>
        <span>{wm}</span>
        <span>{wm}</span>
        <span>{wm}</span>
      </div>
      {isMasked && (
        <div className="privacy-mask">
          <button
            type="button"
            className="ghost-btn"
            onClick={() => {
              setHidden(false);
              setManualLock(false);
            }}
          >
            Unlock secure view
          </button>
        </div>
      )}
      <button type="button" className="ghost-btn lock-toggle" onClick={() => setManualLock((v) => !v)}>
        {manualLock ? 'Unlock' : 'Lock'}
      </button>
      <div className={isMasked ? 'blurred' : ''}>{children}</div>
    </div>
  );
}
