import React, { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import * as SecureStore from "expo-secure-store";
import { CLERK_PUBLISHABLE_KEY } from "./constants";

function decodeBase64(str: string): string {
  if (typeof atob === "function") return atob(str);
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
  let output = "";
  let i = 0;
  const input = str.replace(/[^A-Za-z0-9+/=]/g, "");
  while (i < input.length) {
    const a = chars.indexOf(input.charAt(i++));
    const b = chars.indexOf(input.charAt(i++));
    const c = chars.indexOf(input.charAt(i++));
    const d = chars.indexOf(input.charAt(i++));
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    output += String.fromCharCode((n >> 16) & 255);
    if (c !== 64) output += String.fromCharCode((n >> 8) & 255);
    if (d !== 64) output += String.fromCharCode(n & 255);
  }
  return output;
}

const IS_DEV_KEY = CLERK_PUBLISHABLE_KEY.startsWith("pk_test_");

const CLERK_DOMAIN = (() => {
  const raw = CLERK_PUBLISHABLE_KEY.replace(/^pk_(live|test)_/, "");
  const decoded = decodeBase64(raw).replace(/\$$/, "");
  const url = "https://" + decoded;
  console.log("[ClerkAuth] Domain:", url, IS_DEV_KEY ? "(DEV)" : "(PROD)");
  return url;
})();

const STORE_KEYS = {
  SESSION_ID: "clerk_session_id",
  DEV_BROWSER: "clerk_dev_browser",
  JWT: "clerk_jwt",
  JWT_EXPIRES: "clerk_jwt_exp",
};

let _devBrowserToken: string | null = null;

interface AuthState {
  isLoaded: boolean;
  isSignedIn: boolean;
  getToken: () => Promise<string | null>;
  signOut: () => Promise<void>;
}

interface SignInResult {
  status: "complete" | "needs_first_factor" | "needs_second_factor" | string;
  createdSessionId?: string;
  error?: string;
}

const AuthContext = createContext<AuthState>({
  isLoaded: false,
  isSignedIn: false,
  getToken: async () => null,
  signOut: async () => {},
});

function appendDevToken(url: string): string {
  if (IS_DEV_KEY && _devBrowserToken) {
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}__clerk_db_jwt=${_devBrowserToken}`;
  }
  return url;
}

async function initDevBrowser(): Promise<void> {
  if (!IS_DEV_KEY) return;

  await SecureStore.deleteItemAsync(STORE_KEYS.DEV_BROWSER);

  console.log("[ClerkAuth] Creating dev browser session...");
  const res = await fetch(`${CLERK_DOMAIN}/v1/dev_browser`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  const data = await res.json();
  console.log("[ClerkAuth] Dev browser response:", JSON.stringify(data).substring(0, 200));

  const token = data.token;
  if (!token) throw new Error("Failed to get dev browser token");

  _devBrowserToken = token;
  await SecureStore.setItemAsync(STORE_KEYS.DEV_BROWSER, token);
  console.log("[ClerkAuth] Dev browser token acquired");
}

async function clerkFetch(path: string, options: RequestInit = {}) {
  const url = `${CLERK_DOMAIN}${path}`;
  console.log(`[ClerkAuth] ${options.method || "GET"} ${url}`);

  try {
    const res = await fetch(appendDevToken(url), {
      ...options,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...(options.headers as Record<string, string>),
      },
    });
    const text = await res.text();
    console.log(`[ClerkAuth] Response ${res.status}:`, text.substring(0, 300));

    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Non-JSON response: ${text.substring(0, 100)}`);
    }

    if (data.client?.sessions?.[0]?.last_active_token?.jwt) {
      const jwt = data.client.sessions[0].last_active_token.jwt;
      console.log("[ClerkAuth] Got JWT from response body");
      await SecureStore.setItemAsync(STORE_KEYS.JWT, jwt);
      await SecureStore.setItemAsync(STORE_KEYS.JWT_EXPIRES, String(Date.now() + 50_000));
    }

    if (!res.ok) {
      const msg = data.errors?.[0]?.long_message || data.errors?.[0]?.message || `Clerk API error ${res.status}`;
      throw new Error(msg);
    }
    return data;
  } catch (err: any) {
    console.log(`[ClerkAuth] Fetch error:`, err.message);
    throw err;
  }
}

export function ClerkAuthProvider({ children }: { children: ReactNode }) {
  const [isLoaded, setIsLoaded] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        await initDevBrowser();
      } catch (e: any) {
        console.log("[ClerkAuth] Dev browser init failed:", e.message);
      }

      const stored = await SecureStore.getItemAsync(STORE_KEYS.SESSION_ID);
      if (stored) {
        try {
          await refreshToken(stored);
          sessionIdRef.current = stored;
          setSessionId(stored);
        } catch {
          await clearSession();
        }
      }
      setIsLoaded(true);
    })();
  }, []);

  const clearSession = async () => {
    sessionIdRef.current = null;
    setSessionId(null);
    await SecureStore.deleteItemAsync(STORE_KEYS.SESSION_ID);
    await SecureStore.deleteItemAsync(STORE_KEYS.JWT);
    await SecureStore.deleteItemAsync(STORE_KEYS.JWT_EXPIRES);
  };

  async function refreshToken(sid: string): Promise<string> {
    const data = await clerkFetch(`/v1/client/sessions/${sid}/tokens`, {
      method: "POST",
    });

    const jwt = data.jwt || data.client?.sessions?.[0]?.last_active_token?.jwt;
    if (!jwt) throw new Error("No JWT returned from token refresh");

    await SecureStore.setItemAsync(STORE_KEYS.JWT, jwt);
    await SecureStore.setItemAsync(STORE_KEYS.JWT_EXPIRES, String(Date.now() + 50_000));
    return jwt;
  }

  const getToken = useCallback(async (): Promise<string | null> => {
    const sid = sessionIdRef.current;
    if (!sid) return null;
    const exp = await SecureStore.getItemAsync(STORE_KEYS.JWT_EXPIRES);
    if (exp && Date.now() < Number(exp)) {
      return SecureStore.getItemAsync(STORE_KEYS.JWT);
    }
    try {
      return await refreshToken(sid);
    } catch {
      await clearSession();
      return null;
    }
  }, []);

  const signOut = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (sid) {
      try {
        await clerkFetch(`/v1/client/sessions/${sid}/revoke`, { method: "POST" });
      } catch {}
    }
    await clearSession();
  }, []);

  const handleSignInComplete = useCallback(async (newSessionId: string) => {
    await SecureStore.setItemAsync(STORE_KEYS.SESSION_ID, newSessionId);
    try {
      await refreshToken(newSessionId);
    } catch (e) {
      console.log("[ClerkAuth] Token refresh after sign-in failed, using JWT from response");
    }
    sessionIdRef.current = newSessionId;
    setSessionId(newSessionId);
  }, []);

  const value: AuthState = {
    isLoaded,
    isSignedIn: !!sessionId,
    getToken,
    signOut,
  };

  return (
    <AuthContext.Provider value={value}>
      <SignInContext.Provider value={handleSignInComplete}>
        {children}
      </SignInContext.Provider>
    </AuthContext.Provider>
  );
}

const SignInContext = createContext<(sessionId: string) => Promise<void>>(async () => {});

export function useAuth() {
  return useContext(AuthContext);
}

export function useSignIn() {
  const onComplete = useContext(SignInContext);

  const signIn = useCallback(async (identifier: string, password: string): Promise<SignInResult> => {
    const body = new URLSearchParams({
      identifier,
      password,
      strategy: "password",
    }).toString();

    const data = await clerkFetch("/v1/client/sign_ins", {
      method: "POST",
      body,
    });

    const response = data.response || data;
    const status = response.status;
    const createdSessionId = response.created_session_id;

    if (status === "complete" && createdSessionId) {
      await onComplete(createdSessionId);
      return { status: "complete", createdSessionId };
    }

    return { status, error: `Sign-in status: ${status}` };
  }, [onComplete]);

  return { signIn };
}
