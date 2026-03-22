import React, { createContext, useContext, useState, type ReactNode } from "react";

interface DevAuthState {
  isLoaded: boolean;
  isSignedIn: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => void;
  getToken: () => Promise<string | null>;
}

const DevAuthContext = createContext<DevAuthState>({
  isLoaded: true,
  isSignedIn: false,
  signIn: async () => {},
  signOut: () => {},
  getToken: async () => null,
});

export function DevAuthProvider({ children }: { children: ReactNode }) {
  const [isSignedIn, setIsSignedIn] = useState(false);

  const value: DevAuthState = {
    isLoaded: true,
    isSignedIn,
    signIn: async (_email: string, _password: string) => {
      setIsSignedIn(true);
    },
    signOut: () => setIsSignedIn(false),
    getToken: async () => "dev-token-bypass",
  };

  return (
    <DevAuthContext.Provider value={value}>
      {children}
    </DevAuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(DevAuthContext);
}

export function useSignIn() {
  const { signIn } = useContext(DevAuthContext);
  return {
    signIn: {
      create: async ({ identifier, password }: { identifier: string; password: string }) => {
        await signIn(identifier, password);
        return { status: "complete" as const, createdSessionId: "dev-session" };
      },
    },
    setActive: async (_opts: { session: string }) => {},
    isLoaded: true,
  };
}
