'use client';

import { useEffect, useState, ReactNode } from 'react';
import { AccessCodeModal } from '@/components/access-code-modal';
import { useSettingsStore } from '@/lib/store/settings';

export function AccessCodeGuard({ children }: { children: ReactNode }) {
  const fetchServerProviders = useSettingsStore((s) => s.fetchServerProviders);
  const [status, setStatus] = useState<{
    enabled: boolean;
    authenticated: boolean;
    loading: boolean;
  }>({ enabled: false, authenticated: false, loading: true });

  useEffect(() => {
    let cancelled = false;
    fetch('/api/access-code/status')
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) {
          setStatus({
            enabled: data.enabled,
            authenticated: data.authenticated,
            loading: false,
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          // Default to requiring auth on error — safer than silently disabling
          setStatus({ enabled: true, authenticated: false, loading: false });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const needsAuth = !status.loading && status.enabled && !status.authenticated;

  return (
    <>
      {needsAuth && (
        <AccessCodeModal
          open={true}
          onSuccess={() => {
            setStatus((s) => ({ ...s, authenticated: true }));
            // The first fetch on mount 401'd because no cookie existed. Retry now
            // that the cookie is set so the user doesn't have to hard-refresh.
            fetchServerProviders();
          }}
        />
      )}
      {children}
    </>
  );
}
