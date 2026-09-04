import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  beginSignIn,
  beginSignOut,
  hasAuthenticatedSession,
  isAuthenticationEnabled,
  subscribeToAuthChanges
} from "./authClient";

interface AuthContextValue {
  enabled: boolean;
  authenticated: boolean;
  loading: boolean;
  signIn: () => Promise<void>;
  signOut: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const enabled = isAuthenticationEnabled();
  const [authenticated, setAuthenticated] = useState(!enabled);
  const [loading, setLoading] = useState(enabled);

  useEffect(() => {
    let active = true;

    async function refreshState(): Promise<void> {
      const nextAuthenticated = await hasAuthenticatedSession();
      if (active) {
        setAuthenticated(nextAuthenticated);
        setLoading(false);
      }
    }

    void refreshState();
    const unsubscribe = subscribeToAuthChanges(() => {
      void refreshState();
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      enabled,
      authenticated,
      loading,
      signIn: beginSignIn,
      signOut: beginSignOut
    }),
    [authenticated, enabled, loading]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used inside AuthProvider.");
  }

  return context;
}
