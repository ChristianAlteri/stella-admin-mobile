import { useEffect, useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  ActivityIndicator,
} from "react-native";
import { useRouter } from "expo-router";
import { useAuth } from "@/lib/clerk-auth";
import { fetchUserStores, setTokenGetter } from "@/lib/api";

export default function StorePickerScreen() {
  const [stores, setStores] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const { signOut, getToken, isSignedIn } = useAuth();

  useEffect(() => {
    if (!isSignedIn) return;
    setTokenGetter(() => getToken());
    loadStores();
  }, [isSignedIn]);

  const loadStores = async () => {
    try {
      const data = await fetchUserStores();
      setStores(data);
    } catch (err) {
      console.error("Failed to load stores:", err);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#6366f1" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Select Store</Text>
        <TouchableOpacity onPress={() => signOut()}>
          <Text style={styles.signOut}>Sign Out</Text>
        </TouchableOpacity>
      </View>

      {stores.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyText}>No stores found for your account.</Text>
        </View>
      ) : (
        <FlatList
          data={stores}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.storeCard}
              onPress={() => router.push(`/(main)/pos/${item.id}`)}
            >
              <Text style={styles.storeName}>{item.name}</Text>
              <View style={styles.storeMeta}>
                <Text style={styles.storeDetail}>
                  {item.currency || "GBP"} · {item.countryCode || "GB"}
                </Text>
                {item.storeType && (
                  <View style={styles.badge}>
                    <Text style={styles.badgeText}>{item.storeType}</Text>
                  </View>
                )}
              </View>
            </TouchableOpacity>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000" },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingTop: 60,
    paddingBottom: 16,
  },
  title: { fontSize: 28, fontWeight: "800", color: "#fff" },
  signOut: { fontSize: 14, color: "#6366f1", fontWeight: "600" },
  list: { paddingHorizontal: 20 },
  storeCard: {
    backgroundColor: "#1e293b",
    borderRadius: 16,
    padding: 20,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#334155",
  },
  storeName: { fontSize: 20, fontWeight: "700", color: "#fff", marginBottom: 8 },
  storeMeta: { flexDirection: "row", alignItems: "center", gap: 8 },
  storeDetail: { fontSize: 14, color: "#94a3b8" },
  badge: {
    backgroundColor: "#312e81",
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
  },
  badgeText: { fontSize: 11, color: "#a5b4fc", fontWeight: "600" },
  emptyText: { fontSize: 16, color: "#64748b" },
});
