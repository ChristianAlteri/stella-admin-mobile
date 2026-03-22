import { useEffect, useState } from "react";
import { Slot, useRouter, useSegments } from "expo-router";
import { ClerkAuthProvider, useAuth } from "@/lib/clerk-auth";
import { setTokenGetter } from "@/lib/api";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { StatusBar } from "expo-status-bar";

function AuthGate() {
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const segments = useSegments();
  const router = useRouter();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!isLoaded || !mounted) return;
    const inAuth = segments[0] === "(auth)";

    if (!isSignedIn && !inAuth) {
      router.replace("/(auth)/sign-in");
    } else if (isSignedIn && inAuth) {
      router.replace("/(main)");
    }
  }, [isLoaded, isSignedIn, segments, mounted]);

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
      <ClerkAuthProvider>
        <StatusBar style="auto" />
        <AuthGate />
      </ClerkAuthProvider>
    </GestureHandlerRootView>
  );
}
