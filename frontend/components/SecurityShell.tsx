"use client";

import { useEffect, useState } from 'react';
import { getSupabaseClient } from '@/lib/supabase';
import { useGhostPreferences } from '@/lib/preferences';

type Props = {
  userId: string;
  children: React.ReactNode;
};

export default function SecurityShell({ userId, children }: Props) {
  const preferences = useGhostPreferences();
  const [captureAlert, setCaptureAlert] = useState(false);
  const [incomingCall, setIncomingCall] = useState<{ inviteId: string; fromUserId: string } | null>(null);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) return;
    const geo = navigator.geolocation as Geolocation & {
      _ghost_getCurrentPosition?: Geolocation['getCurrentPosition'];
      _ghost_watchPosition?: Geolocation['watchPosition'];
    };
    if (!geo._ghost_getCurrentPosition) {
      geo._ghost_getCurrentPosition = geo.getCurrentPosition.bind(geo);
      geo._ghost_watchPosition = geo.watchPosition.bind(geo);
    }

    const deny = (error?: PositionErrorCallback | null) => {
      error?.({
        code: 1,
        message: 'Geolocation disabled by Ghost Secure policy.',
        PERMISSION_DENIED: 1,
        POSITION_UNAVAILABLE: 2,
        TIMEOUT: 3,
      } as GeolocationPositionError);
    };

    geo.getCurrentPosition = ((_success, error) => deny(error)) as Geolocation['getCurrentPosition'];
    geo.watchPosition = ((_success, error) => {
      deny(error);
      return -1;
    }) as Geolocation['watchPosition'];

    return () => {
      if (geo._ghost_getCurrentPosition) {
        geo.getCurrentPosition = geo._ghost_getCurrentPosition;
      }
      if (geo._ghost_watchPosition) {
        geo.watchPosition = geo._ghost_watchPosition;
      }
    };
  }, []);

  useEffect(() => {
    let wakeLock: { release: () => Promise<void> } | null = null;
    const nav = navigator as Navigator & { wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> } };

    const requestWakeLock = async () => {
      if (!preferences.keepScreenAwake || !nav.wakeLock || document.visibilityState !== 'visible') return;
      try {
        wakeLock = await nav.wakeLock.request('screen');
      } catch {
        wakeLock = null;
      }
    };

    const releaseWakeLock = async () => {
      if (!wakeLock) return;
      try {
        await wakeLock.release();
      } catch {
        // no-op
      }
      wakeLock = null;
    };

    const onVisibility = async () => {
      if (document.visibilityState === 'visible') {
        await requestWakeLock();
      } else {
        await releaseWakeLock();
      }
    };

    void requestWakeLock();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      void releaseWakeLock();
    };
  }, [preferences.keepScreenAwake]);

  useEffect(() => {
    const me = userId.trim().toLowerCase();
    if (!me) return;

    const lastNotified = { id: '' };
    const supabase = getSupabaseClient();

    const notifyIncomingCall = (inviteId: string, fromUserId: string) => {
      if (!inviteId || inviteId === lastNotified.id) return;
      lastNotified.id = inviteId;
      setIncomingCall({ inviteId, fromUserId });

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
          const body = preferences.hideCallerIdentity ? 'Ouvrez Ghost Secure pour répondre.' : `${fromUserId} vous appelle`;
          const n = new Notification('Ghost Secure - Appel entrant', {
            body,
            tag: `call-${inviteId}`,
            requireInteraction: true,
          });
          n.onclick = () => {
            window.focus();
            window.location.href = `/call?target=${encodeURIComponent(fromUserId)}&autocall=0&autoaccept=1&invite=${encodeURIComponent(inviteId)}`;
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
  }, [preferences.hideCallerIdentity, userId]);

  return (
    <div
      className="security-shell"
      onCopy={(e) => e.preventDefault()}
      onPaste={(e) => e.preventDefault()}
      onCut={(e) => e.preventDefault()}
      onDrop={(e) => e.preventDefault()}
      onDragStart={(e) => e.preventDefault()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {captureAlert && <div className="capture-alert">Capture détectée. Affichage masqué.</div>}
      {incomingCall && (
        <div className="incoming-popup" role="alert" aria-live="assertive">
          <div>
            <strong>Appel entrant</strong>
            <p>{preferences.hideCallerIdentity ? 'Identité masquée jusqu\'à ouverture de l\'appel' : `${incomingCall.fromUserId} vous appelle`}</p>
          </div>
          <div className="row">
            <button
              type="button"
              className="ghost-primary"
              onClick={() => {
                const { fromUserId, inviteId } = incomingCall;
                setIncomingCall(null);
                window.location.href = `/call?target=${encodeURIComponent(fromUserId)}&autocall=0&autoaccept=1&invite=${encodeURIComponent(inviteId)}`;
              }}
            >
              Répondre
            </button>
            <button type="button" className="ghost-secondary" onClick={() => setIncomingCall(null)}>
              Ignorer
            </button>
          </div>
        </div>
      )}
      <div>{children}</div>
    </div>
  );
}
