import { useEffect } from "react";
import { Slot, useRouter, useSegments } from "expo-router";
import { ClerkProvider, ClerkLoaded, useAuth } from "@clerk/clerk-expo";
import { StripeTerminalProvider } from "@stripe/stripe-terminal-react-native";
import { tokenProvider } from "@/lib/stripe-terminal";
import { setTokenGetter } from "@/lib/api";
import { CLERK_PUBLISHABLE_KEY } from "@/lib/constants";
import * as SecureStore from "expo-secure-store";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { StatusBar } from "expo-status-bar";

const tokenCache = {
  async getToken(key: string) {
    return SecureStore.getItemAsync(key);
  },
  async saveToken(key: string, value: string) {
    return SecureStore.setItemAsync(key, value);
  },
};

function AuthGate() {
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (!isLoaded) return;
    const inAuth = segments[0] === "(auth)";

    if (!isSignedIn && !inAuth) {
      router.replace("/(auth)/sign-in");
    } else if (isSignedIn && inAuth) {
      router.replace("/(main)");
    }
  }, [isLoaded, isSignedIn, segments]);

  useEffect(() => {
    if (isSignedIn) {
      setTokenGetter(() => getToken());
    }
  }, [isSignedIn]);

  return <Slot />;
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY} tokenCache={tokenCache}>
        <ClerkLoaded>
          <StripeTerminalProvider tokenProvider={tokenProvider}>
            <StatusBar style="auto" />
            <AuthGate />
          </StripeTerminalProvider>
        </ClerkLoaded>
      </ClerkProvider>
    </GestureHandlerRootView>
  );
}
