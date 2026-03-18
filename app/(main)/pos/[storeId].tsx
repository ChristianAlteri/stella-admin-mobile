import { useEffect, useState, useCallback, useRef } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  Alert,
  ScrollView,
  Image,
} from "react-native";
import { useLocalSearchParams, Stack } from "expo-router";
import {
  useStripeTerminal,
  Reader,
  PaymentIntent,
} from "@stripe/stripe-terminal-react-native";
import {
  searchProducts,
  fetchSellers,
  fetchStaff,
  createPaymentIntent,
  verifyInStorePayment,
} from "@/lib/api";
import { setCurrentStoreId } from "@/lib/stripe-terminal";
import { usePOS, type POSProduct } from "@/hooks/use-pos";
import { currencySymbol } from "@/lib/constants";

type Phase = "browse" | "checkout" | "processing" | "success";

export default function POSScreen() {
  const { storeId } = useLocalSearchParams<{ storeId: string }>();
  const pos = usePOS();
  const sym = currencySymbol(pos.countryCode);

  // -- data --
  const [products, setProducts] = useState<POSProduct[]>([]);
  const [sellers, setSellers] = useState<any[]>([]);
  const [staff, setStaff] = useState<any[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [phase, setPhase] = useState<Phase>("browse");
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // -- stripe terminal --
  const {
    discoverReaders,
    connectLocalMobileReader,
    retrievePaymentIntent,
    collectPaymentMethod,
    confirmPaymentIntent,
    connectedReader,
  } = useStripeTerminal();

  const [terminalReady, setTerminalReady] = useState(false);
  const [connectingTerminal, setConnectingTerminal] = useState(false);

  // -- init --
  useEffect(() => {
    if (!storeId) return;
    setCurrentStoreId(storeId);
    loadInitialData();
    connectToLocalReader();
  }, [storeId]);

  const loadInitialData = async () => {
    setLoading(true);
    try {
      const [prods, sellersData, staffData] = await Promise.all([
        searchProducts(storeId!, { limit: 20 }),
        fetchSellers(storeId!),
        fetchStaff(storeId!),
      ]);
      setProducts(prods);
      setSellers(sellersData);
      setStaff(staffData);

      const store = prods[0]?.store;
      if (store) {
        pos.setStoreConfig(
          store.countryCode || "GB",
          store.passStripeFeeToCustomer ?? true
        );
      }
    } catch (err) {
      console.error("Failed to load POS data:", err);
    } finally {
      setLoading(false);
    }
  };

  const connectToLocalReader = async () => {
    setConnectingTerminal(true);
    try {
      const { readers } = await discoverReaders({
        discoveryMethod: "localMobile",
      });
      if (readers && readers.length > 0) {
        const { reader } = await connectLocalMobileReader({
          reader: readers[0],
          locationId: readers[0].locationId || undefined,
        });
        if (reader) setTerminalReady(true);
      }
    } catch (err) {
      console.error("Terminal connect error:", err);
    } finally {
      setConnectingTerminal(false);
    }
  };

  // -- search --
  const handleSearch = useCallback(
    (text: string) => {
      setSearchQuery(text);
      if (searchTimeout.current) clearTimeout(searchTimeout.current);
      searchTimeout.current = setTimeout(async () => {
        try {
          const results = await searchProducts(storeId!, { q: text, limit: 20 });
          setProducts(results);
        } catch (err) {
          console.error("Search failed:", err);
        }
      }, 300);
    },
    [storeId]
  );

  // -- payment --
  const handleCharge = async () => {
    if (pos.cart.length === 0 || !pos.selectedStaffId) {
      Alert.alert("Missing info", "Select products and a staff member.");
      return;
    }

    if (pos.isCash) {
      await handleCashSale();
    } else {
      await handleCardPayment();
    }
  };

  const handleCashSale = async () => {
    setPhase("processing");
    try {
      const metadata: Record<string, string> = {
        storeId: storeId!,
        isCash: "true",
        soldByStaffId: pos.selectedStaffId,
        userId: pos.selectedUserId || "",
      };
      pos.cart.forEach((item, idx) => {
        metadata[`productId_${idx + 1}`] = item.id;
        metadata[`productQty_${idx + 1}`] = String(item.cartQuantity);
      });

      const result = await verifyInStorePayment(metadata);
      if (result.success) {
        setPhase("success");
      } else {
        Alert.alert("Error", result.message || "Cash sale failed");
        setPhase("checkout");
      }
    } catch (err) {
      console.error("Cash sale error:", err);
      Alert.alert("Error", "Failed to record cash sale");
      setPhase("checkout");
    }
  };

  const handleCardPayment = async () => {
    if (!terminalReady) {
      Alert.alert("Terminal not ready", "Connecting to Tap to Pay...");
      connectToLocalReader();
      return;
    }

    setPhase("processing");
    try {
      const amountInCents = Math.round(pos.total * 100);
      const piResponse = await createPaymentIntent(storeId!, {
        amount: amountInCents,
        products: pos.cart.map((p) => ({ id: p.id, quantity: p.cartQuantity })),
        soldByStaffId: pos.selectedStaffId,
        userId: pos.selectedUserId || undefined,
        isCash: false,
      });

      const clientSecret = piResponse.paymentIntent?.client_secret;
      if (!clientSecret) throw new Error("No client secret returned");

      const { paymentIntent: retrievedPI } = await retrievePaymentIntent(clientSecret);
      const { paymentIntent: collected } = await collectPaymentMethod({ paymentIntent: retrievedPI! });
      const { paymentIntent: confirmed } = await confirmPaymentIntent({ paymentIntent: collected! });

      if (confirmed?.status === "succeeded" || confirmed?.status === "requires_capture") {
        const metadata: Record<string, string> = {
          storeId: storeId!,
          isCash: "false",
          soldByStaffId: pos.selectedStaffId,
          userId: pos.selectedUserId || "",
        };
        pos.cart.forEach((item, idx) => {
          metadata[`productId_${idx + 1}`] = item.id;
          metadata[`productQty_${idx + 1}`] = String(item.cartQuantity);
        });

        await verifyInStorePayment(metadata, confirmed?.id);
        setPhase("success");
      } else {
        Alert.alert("Payment failed", "The payment was not completed.");
        setPhase("checkout");
      }
    } catch (err: any) {
      console.error("Card payment error:", err);
      Alert.alert("Payment error", err.message || "Something went wrong");
      setPhase("checkout");
    }
  };

  const handleNewSale = () => {
    pos.clearCart();
    setPhase("browse");
    loadInitialData();
  };

  // -- render --
  if (phase === "success") {
    return (
      <View style={styles.centerContainer}>
        <Stack.Screen options={{ title: "Sale Complete" }} />
        <Text style={styles.successIcon}>✓</Text>
        <Text style={styles.successTitle}>Sale Complete</Text>
        <Text style={styles.successAmount}>
          {sym}{pos.total.toFixed(2)}
        </Text>
        <TouchableOpacity style={styles.primaryButton} onPress={handleNewSale}>
          <Text style={styles.primaryButtonText}>New Sale</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (phase === "processing") {
    return (
      <View style={styles.centerContainer}>
        <Stack.Screen options={{ title: "Processing..." }} />
        <ActivityIndicator size="large" color="#6366f1" />
        <Text style={styles.processingText}>
          {pos.isCash ? "Recording sale..." : "Waiting for tap..."}
        </Text>
        <Text style={styles.processingSubtext}>
          {pos.isCash ? "" : "Hold the customer's card near the phone"}
        </Text>
      </View>
    );
  }

  if (phase === "checkout") {
    return (
      <View style={styles.container}>
        <Stack.Screen options={{ title: "Checkout" }} />
        <ScrollView style={styles.checkoutScroll}>
          {/* Cart summary */}
          {pos.cart.map((item) => (
            <View key={item.id} style={styles.checkoutItem}>
              <View style={{ flex: 1 }}>
                <Text style={styles.checkoutItemName}>{item.name}</Text>
                <Text style={styles.checkoutItemMeta}>
                  {sym}{item.ourPrice.toFixed(2)} × {item.cartQuantity}
                </Text>
              </View>
              <Text style={styles.checkoutItemTotal}>
                {sym}{(item.ourPrice * item.cartQuantity).toFixed(2)}
              </Text>
            </View>
          ))}

          {/* Totals */}
          <View style={styles.totalsSection}>
            {pos.serviceFee > 0 && (
              <>
                <View style={styles.totalRow}>
                  <Text style={styles.totalLabel}>Subtotal</Text>
                  <Text style={styles.totalValue}>{sym}{pos.subtotal.toFixed(2)}</Text>
                </View>
                <View style={styles.totalRow}>
                  <Text style={styles.totalLabel}>Card processing fee</Text>
                  <Text style={styles.totalValue}>{sym}{pos.serviceFee.toFixed(2)}</Text>
                </View>
              </>
            )}
            <View style={styles.totalRow}>
              <Text style={styles.grandTotalLabel}>Total</Text>
              <Text style={styles.grandTotalValue}>{sym}{pos.total.toFixed(2)}</Text>
            </View>
          </View>

          {/* Payment method */}
          <View style={styles.paymentMethodRow}>
            <TouchableOpacity
              style={[styles.methodBtn, !pos.isCash && styles.methodBtnActive]}
              onPress={() => pos.setIsCash(false)}
            >
              <Text style={[styles.methodText, !pos.isCash && styles.methodTextActive]}>
                Card (Tap)
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.methodBtn, pos.isCash && styles.methodBtnCashActive]}
              onPress={() => pos.setIsCash(true)}
            >
              <Text style={[styles.methodText, pos.isCash && styles.methodTextActive]}>
                Cash
              </Text>
            </TouchableOpacity>
          </View>

          {/* Staff picker */}
          <Text style={styles.sectionTitle}>Sold by</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipScroll}>
            {staff.map((s) => (
              <TouchableOpacity
                key={s.id}
                style={[styles.chip, pos.selectedStaffId === s.id && styles.chipActive]}
                onPress={() => pos.setStaff(s.id, s.name)}
              >
                <Text
                  style={[styles.chipText, pos.selectedStaffId === s.id && styles.chipTextActive]}
                >
                  {s.name}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          {!pos.isCash && !terminalReady && (
            <View style={styles.warningBox}>
              <Text style={styles.warningText}>
                Tap to Pay not connected. {connectingTerminal ? "Connecting..." : "Tap 'Charge' to retry."}
              </Text>
            </View>
          )}
        </ScrollView>

        {/* Charge button */}
        <View style={styles.chargeBar}>
          <TouchableOpacity
            style={[styles.chargeButton, !pos.selectedStaffId && styles.chargeButtonDisabled]}
            onPress={handleCharge}
            disabled={!pos.selectedStaffId}
          >
            <Text style={styles.chargeButtonText}>
              {pos.isCash ? "Record Cash Sale" : "Charge"} {sym}{pos.total.toFixed(2)}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.backButton} onPress={() => setPhase("browse")}>
            <Text style={styles.backButtonText}>Back to products</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // -- browse phase (default) --
  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: "Point of Sale", headerBackTitle: "Stores" }} />

      {/* Search */}
      <View style={styles.searchBar}>
        <TextInput
          style={styles.searchInput}
          placeholder="Search products..."
          placeholderTextColor="#64748b"
          value={searchQuery}
          onChangeText={handleSearch}
          autoCorrect={false}
        />
      </View>

      {/* Product grid */}
      {loading ? (
        <View style={styles.centerContainer}>
          <ActivityIndicator size="large" color="#6366f1" />
        </View>
      ) : (
        <FlatList
          data={products}
          keyExtractor={(item) => item.id}
          numColumns={2}
          contentContainerStyle={styles.productGrid}
          columnWrapperStyle={styles.productRow}
          renderItem={({ item }) => {
            const inCart = pos.cart.find((c) => c.id === item.id);
            return (
              <TouchableOpacity
                style={[styles.productCard, inCart && styles.productCardSelected]}
                onPress={() => pos.addToCart(item)}
              >
                {item.images?.[0]?.url ? (
                  <Image source={{ uri: item.images[0].url }} style={styles.productImage} />
                ) : (
                  <View style={[styles.productImage, styles.productImagePlaceholder]}>
                    <Text style={styles.placeholderText}>No img</Text>
                  </View>
                )}
                <Text style={styles.productName} numberOfLines={2}>{item.name}</Text>
                <Text style={styles.productPrice}>{sym}{item.ourPrice?.toFixed(2)}</Text>
                {item.designer?.name && (
                  <Text style={styles.productDesigner} numberOfLines={1}>{item.designer.name}</Text>
                )}
                {inCart && (
                  <View style={styles.cartBadge}>
                    <Text style={styles.cartBadgeText}>{inCart.cartQuantity}</Text>
                  </View>
                )}
              </TouchableOpacity>
            );
          }}
          ListEmptyComponent={
            <View style={styles.centerContainer}>
              <Text style={styles.emptyText}>No products found</Text>
            </View>
          }
        />
      )}

      {/* Cart bar */}
      {pos.cart.length > 0 && (
        <TouchableOpacity style={styles.cartBar} onPress={() => setPhase("checkout")}>
          <Text style={styles.cartBarText}>
            {pos.cart.reduce((a, i) => a + i.cartQuantity, 0)} items
          </Text>
          <Text style={styles.cartBarTotal}>
            Checkout · {sym}{pos.subtotal.toFixed(2)}
          </Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000" },
  centerContainer: { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "#000", padding: 32 },

  // search
  searchBar: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 },
  searchInput: {
    backgroundColor: "#1e293b",
    borderRadius: 12,
    padding: 14,
    fontSize: 16,
    color: "#fff",
    borderWidth: 1,
    borderColor: "#334155",
  },

  // product grid
  productGrid: { padding: 8 },
  productRow: { gap: 8, paddingHorizontal: 8 },
  productCard: {
    flex: 1,
    backgroundColor: "#1e293b",
    borderRadius: 12,
    padding: 10,
    marginBottom: 8,
    borderWidth: 1.5,
    borderColor: "#334155",
  },
  productCardSelected: { borderColor: "#6366f1" },
  productImage: { width: "100%", aspectRatio: 1, borderRadius: 8, marginBottom: 8 },
  productImagePlaceholder: { backgroundColor: "#334155", justifyContent: "center", alignItems: "center" },
  placeholderText: { color: "#64748b", fontSize: 12 },
  productName: { fontSize: 14, fontWeight: "600", color: "#fff", marginBottom: 4 },
  productPrice: { fontSize: 16, fontWeight: "700", color: "#a5b4fc" },
  productDesigner: { fontSize: 12, color: "#64748b", marginTop: 2 },
  cartBadge: {
    position: "absolute",
    top: 6,
    right: 6,
    backgroundColor: "#6366f1",
    borderRadius: 10,
    width: 20,
    height: 20,
    justifyContent: "center",
    alignItems: "center",
  },
  cartBadgeText: { color: "#fff", fontSize: 11, fontWeight: "700" },

  // cart bar
  cartBar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: "#6366f1",
    padding: 18,
    paddingBottom: 34,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
  },
  cartBarText: { color: "#c7d2fe", fontSize: 14, fontWeight: "600" },
  cartBarTotal: { color: "#fff", fontSize: 16, fontWeight: "800" },

  // checkout
  checkoutScroll: { flex: 1, padding: 20 },
  checkoutItem: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#1e293b",
    borderRadius: 12,
    padding: 16,
    marginBottom: 8,
  },
  checkoutItemName: { fontSize: 15, fontWeight: "600", color: "#fff" },
  checkoutItemMeta: { fontSize: 13, color: "#94a3b8", marginTop: 2 },
  checkoutItemTotal: { fontSize: 16, fontWeight: "700", color: "#a5b4fc" },

  // totals
  totalsSection: { marginTop: 16, marginBottom: 20 },
  totalRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: 8 },
  totalLabel: { fontSize: 14, color: "#94a3b8" },
  totalValue: { fontSize: 14, color: "#94a3b8" },
  grandTotalLabel: { fontSize: 20, fontWeight: "800", color: "#fff" },
  grandTotalValue: { fontSize: 20, fontWeight: "800", color: "#fff" },

  // payment method
  paymentMethodRow: { flexDirection: "row", gap: 8, marginBottom: 20 },
  methodBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: "#334155",
    alignItems: "center",
  },
  methodBtnActive: { borderColor: "#6366f1", backgroundColor: "#312e81" },
  methodBtnCashActive: { borderColor: "#059669", backgroundColor: "#064e3b" },
  methodText: { fontSize: 15, fontWeight: "600", color: "#64748b" },
  methodTextActive: { color: "#fff" },

  // staff / chips
  sectionTitle: { fontSize: 14, fontWeight: "600", color: "#94a3b8", marginBottom: 8 },
  chipScroll: { marginBottom: 16 },
  chip: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 20,
    backgroundColor: "#1e293b",
    marginRight: 8,
    borderWidth: 1.5,
    borderColor: "#334155",
  },
  chipActive: { borderColor: "#6366f1", backgroundColor: "#312e81" },
  chipText: { fontSize: 14, color: "#94a3b8", fontWeight: "500" },
  chipTextActive: { color: "#fff" },

  // warning
  warningBox: {
    backgroundColor: "#422006",
    borderRadius: 12,
    padding: 14,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: "#854d0e",
  },
  warningText: { color: "#fbbf24", fontSize: 13, textAlign: "center" },

  // charge bar
  chargeBar: { padding: 20, paddingBottom: 36, backgroundColor: "#0f172a" },
  chargeButton: {
    backgroundColor: "#6366f1",
    borderRadius: 14,
    padding: 18,
    alignItems: "center",
    marginBottom: 10,
  },
  chargeButtonDisabled: { opacity: 0.4 },
  chargeButtonText: { color: "#fff", fontSize: 18, fontWeight: "800" },
  backButton: { alignItems: "center", padding: 8 },
  backButtonText: { color: "#6366f1", fontSize: 14, fontWeight: "600" },

  // success
  successIcon: { fontSize: 64, color: "#22c55e", marginBottom: 16 },
  successTitle: { fontSize: 24, fontWeight: "800", color: "#fff", marginBottom: 8 },
  successAmount: { fontSize: 32, fontWeight: "800", color: "#a5b4fc", marginBottom: 32 },
  primaryButton: {
    backgroundColor: "#6366f1",
    borderRadius: 14,
    paddingVertical: 16,
    paddingHorizontal: 48,
  },
  primaryButtonText: { color: "#fff", fontSize: 16, fontWeight: "700" },

  // processing
  processingText: { fontSize: 18, fontWeight: "700", color: "#fff", marginTop: 20 },
  processingSubtext: { fontSize: 14, color: "#94a3b8", marginTop: 8 },

  emptyText: { fontSize: 16, color: "#64748b" },
});
