import { useEffect, useState, useCallback, useRef, useMemo } from "react";
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
  Modal,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { useLocalSearchParams, Stack } from "expo-router";
import { useStripeTerminal } from "@/lib/dev-stripe-terminal";
import {
  searchProducts,
  fetchSellers,
  fetchStaff,
  fetchUsers,
  fetchPosTiles,
  fetchProduct,
  quickAddProduct,
  patchProductDiscount,
  createPaymentIntent,
  verifyInStorePayment,
  createQrCheckout,
  fetchQrCheckoutStatus,
  createUser,
  type PosTile,
} from "@/lib/api";
import { setCurrentStoreId } from "@/lib/stripe-terminal";
import { usePOS, type POSProduct, type CartItem, type DiscountType } from "@/hooks/use-pos";
import { currencySymbol } from "@/lib/constants";

type Phase = "browse" | "checkout" | "processing" | "qr" | "success";

// ─────────────────────────────────────────────────────────────────
// Main screen
// ─────────────────────────────────────────────────────────────────
export default function POSScreen() {
  const { storeId } = useLocalSearchParams<{ storeId: string }>();
  const pos = usePOS();
  const sym = currencySymbol(pos.countryCode);

  // -- phase --
  const [phase, setPhase] = useState<Phase>("browse");

  // -- products / tiles / search --
  const [tiles, setTiles] = useState<PosTile[]>([]);
  const [products, setProducts] = useState<POSProduct[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [activeTile, setActiveTile] = useState<PosTile | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [loadingProducts, setLoadingProducts] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // -- people --
  const [staff, setStaff] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [sellers, setSellers] = useState<any[]>([]);

  // -- modals --
  const [discountModal, setDiscountModal] = useState<
    { kind: "item"; product: CartItem } | { kind: "order" } | null
  >(null);
  const [customerModalOpen, setCustomerModalOpen] = useState(false);
  const [staffModalOpen, setStaffModalOpen] = useState(false);
  const [quickSaleOpen, setQuickSaleOpen] = useState(false);

  // -- payment state --
  const [paymentDeclined, setPaymentDeclined] = useState<{ message?: string; code?: string } | null>(null);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [qrSessionId, setQrSessionId] = useState<string | null>(null);
  const qrPollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // -- stripe terminal (Tap to Pay) --
  const {
    discoverReaders,
    connectLocalMobileReader,
    retrievePaymentIntent,
    collectPaymentMethod,
    confirmPaymentIntent,
  } = useStripeTerminal();
  const [terminalReady, setTerminalReady] = useState(false);
  const [connectingTerminal, setConnectingTerminal] = useState(false);

  // ── init ──
  useEffect(() => {
    if (!storeId) return;
    setCurrentStoreId(storeId);
    loadInitialData();
    connectToLocalReader();
  }, [storeId]);

  const loadInitialData = async () => {
    setLoadingProducts(true);
    try {
      const [tileRes, productRes, sellerRes, staffRes, userRes] = await Promise.all([
        fetchPosTiles(storeId!),
        searchProducts(storeId!, { limit: 30 }),
        fetchSellers(storeId!).catch(() => []),
        fetchStaff(storeId!).catch(() => []),
        fetchUsers(storeId!).catch(() => []),
      ]);
      setTiles(tileRes);
      setProducts(productRes.products);
      setNextCursor(productRes.nextCursor);
      setSellers(sellerRes);
      setStaff(staffRes);
      setUsers(userRes);

      // Auto-select first staff
      if (staffRes.length > 0 && !pos.selectedStaffId) {
        pos.setStaff(staffRes[0].id, staffRes[0].name);
      }

      // Pull store config from first product
      const store = productRes.products[0]?.store;
      if (store) {
        pos.setStoreConfig(
          store.countryCode || "GB",
          store.passStripeFeeToCustomer ?? true
        );
      }
    } catch (err) {
      console.error("Failed to load POS data:", err);
      Alert.alert("Error", "Could not load store data");
    } finally {
      setLoadingProducts(false);
    }
  };

  const connectToLocalReader = async () => {
    setConnectingTerminal(true);
    try {
      const { readers } = await discoverReaders({ discoveryMethod: "localMobile" });
      if (readers && readers.length > 0) {
        const { reader } = await connectLocalMobileReader({
          reader: readers[0],
          locationId: readers[0].locationId || undefined,
        });
        if (reader) setTerminalReady(true);
      }
    } catch (err) {
      console.log("Terminal not ready (expected in Expo Go):", err);
    } finally {
      setConnectingTerminal(false);
    }
  };

  // ── search / filter ──
  const refetchProducts = useCallback(
    async (params: { q?: string; tile?: PosTile | null }) => {
      setLoadingProducts(true);
      try {
        const queryParams: any = { limit: 30 };
        if (params.q?.trim()) queryParams.q = params.q.trim();
        if (params.tile) {
          if (params.tile.type === "designer") queryParams.designerId = params.tile.referenceId;
          else if (params.tile.type === "category") queryParams.categoryId = params.tile.referenceId;
          else if (params.tile.type === "seller") queryParams.sellerId = params.tile.referenceId;
          else if (params.tile.type === "productGroup") queryParams.productGroupId = params.tile.referenceId;
        }
        const res = await searchProducts(storeId!, queryParams);
        setProducts(res.products);
        setNextCursor(res.nextCursor);
      } catch (err) {
        console.error("Search failed:", err);
        setProducts([]);
        setNextCursor(null);
      } finally {
        setLoadingProducts(false);
      }
    },
    [storeId]
  );

  const handleSearchChange = (text: string) => {
    setSearchQuery(text);
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => {
      refetchProducts({ q: text, tile: activeTile });
    }, 300);
  };

  const handleTilePress = (tile: PosTile) => {
    setActiveTile(tile);
    setSearchQuery("");
    refetchProducts({ tile });
  };

  const clearTile = () => {
    setActiveTile(null);
    setSearchQuery("");
    refetchProducts({});
  };

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const queryParams: any = { limit: 30, cursor: nextCursor };
      if (searchQuery.trim()) queryParams.q = searchQuery.trim();
      if (activeTile) {
        if (activeTile.type === "designer") queryParams.designerId = activeTile.referenceId;
        else if (activeTile.type === "category") queryParams.categoryId = activeTile.referenceId;
        else if (activeTile.type === "seller") queryParams.sellerId = activeTile.referenceId;
        else if (activeTile.type === "productGroup") queryParams.productGroupId = activeTile.referenceId;
      }
      const res = await searchProducts(storeId!, queryParams);
      setProducts((prev) => [...prev, ...res.products]);
      setNextCursor(res.nextCursor);
    } catch {
      setNextCursor(null);
    } finally {
      setLoadingMore(false);
    }
  };

  // ── discounts ──
  const applyItemDiscountAndPersist = async (
    product: CartItem,
    type: DiscountType,
    value: number
  ) => {
    pos.setItemDiscount(product.id, type, value);
    try {
      await patchProductDiscount(storeId!, product.id, { discountType: type, discountValue: value });
      pos.markDiscountsApplied();
    } catch (err) {
      console.error("Failed to persist item discount:", err);
      Alert.alert("Error", "Could not save discount on the server");
    }
  };

  const applyOrderDiscountAndPersist = async (type: DiscountType, value: number) => {
    pos.setOrderDiscount({ type, value });
    try {
      await Promise.all(
        pos.cart.map((item) =>
          patchProductDiscount(storeId!, item.id, { discountType: type, discountValue: value })
        )
      );
      pos.markDiscountsApplied();
    } catch (err) {
      console.error("Failed to persist order discount:", err);
      Alert.alert("Error", "Could not save order discount on the server");
    }
  };

  // ── quick sale ──
  const handleQuickSaleAdd = async (name: string, price: number, sellerId?: string) => {
    try {
      const product = await quickAddProduct(storeId!, { name, ourPrice: price, sellerId });
      pos.addToCart(product);
      setQuickSaleOpen(false);
    } catch (err: any) {
      console.error("Quick add failed:", err);
      Alert.alert("Error", err?.response?.data ?? "Could not create product");
    }
  };

  // ── checkout actions ──
  const handleCharge = async () => {
    if (pos.cart.length === 0) {
      Alert.alert("Cart empty", "Add some products first.");
      return;
    }
    if (!pos.selectedStaffId) {
      Alert.alert("Staff required", "Select who's making this sale.");
      return;
    }

    if (pos.isCash) await handleCashSale();
    else if (pos.isQr) await handleQrSale();
    else await handleCardSale();
  };

  const handleCashSale = async () => {
    setPhase("processing");
    try {
      const metadata = buildSaleMetadata();
      const result = await verifyInStorePayment(metadata);
      if (result?.success) setPhase("success");
      else {
        Alert.alert("Failed", result?.message || "Could not record cash sale");
        setPhase("checkout");
      }
    } catch (err) {
      console.error("Cash sale error:", err);
      Alert.alert("Error", "Failed to record cash sale");
      setPhase("checkout");
    }
  };

  const handleCardSale = async () => {
    if (!terminalReady) {
      Alert.alert(
        "Tap to Pay not ready",
        "Tap to Pay requires a development build (not Expo Go). Switch to Cash or QR for now.",
        [{ text: "OK" }]
      );
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
      if (!clientSecret) throw new Error("No client secret");

      const { paymentIntent: retrieved } = await retrievePaymentIntent(clientSecret);
      const { paymentIntent: collected } = await collectPaymentMethod({ paymentIntent: retrieved! });
      const { paymentIntent: confirmed } = await confirmPaymentIntent({ paymentIntent: collected! });

      if (confirmed?.status === "succeeded" || confirmed?.status === "requires_capture") {
        await verifyInStorePayment(buildSaleMetadata(), confirmed?.id);
        setPhase("success");
      } else {
        setPaymentDeclined({ message: "Payment was not completed" });
        setPhase("checkout");
      }
    } catch (err: any) {
      console.error("Card payment error:", err);
      setPaymentDeclined({ message: err.message || "Payment failed" });
      setPhase("checkout");
    }
  };

  const handleQrSale = async () => {
    try {
      const res = await createQrCheckout(storeId!, {
        products: pos.cart.map((p) => ({ id: p.id, quantity: p.cartQuantity })),
        soldByStaffId: pos.selectedStaffId,
        userId: pos.selectedUserId || undefined,
        serviceFee: pos.serviceFee > 0 ? pos.serviceFee : undefined,
      });
      setQrUrl(res.checkoutUrl);
      setQrSessionId(res.sessionId);
      setPhase("qr");
    } catch (err: any) {
      console.error("QR checkout error:", err);
      Alert.alert("Error", err?.response?.data?.error || "Could not generate QR");
    }
  };

  const cancelQrCheckout = () => {
    if (qrPollingRef.current) {
      clearInterval(qrPollingRef.current);
      qrPollingRef.current = null;
    }
    setQrUrl(null);
    setQrSessionId(null);
    setPhase("checkout");
  };

  // poll QR status
  useEffect(() => {
    if (!qrSessionId || phase !== "qr") {
      if (qrPollingRef.current) clearInterval(qrPollingRef.current);
      qrPollingRef.current = null;
      return;
    }
    qrPollingRef.current = setInterval(async () => {
      try {
        const data = await fetchQrCheckoutStatus(storeId!, qrSessionId);
        if (data.paymentStatus === "paid" || data.status === "complete") {
          if (qrPollingRef.current) clearInterval(qrPollingRef.current);
          qrPollingRef.current = null;
          setQrUrl(null);
          setQrSessionId(null);
          setPhase("success");
        } else if (data.status === "expired") {
          if (qrPollingRef.current) clearInterval(qrPollingRef.current);
          qrPollingRef.current = null;
          setQrUrl(null);
          setQrSessionId(null);
          Alert.alert("Expired", "Payment link expired. Try again.");
          setPhase("checkout");
        }
      } catch (e) {
        console.error("QR poll:", e);
      }
    }, 3000);
    return () => {
      if (qrPollingRef.current) clearInterval(qrPollingRef.current);
      qrPollingRef.current = null;
    };
  }, [qrSessionId, phase, storeId]);

  const buildSaleMetadata = (): Record<string, string> => {
    const m: Record<string, string> = {
      storeId: storeId!,
      isCash: pos.isCash ? "true" : "false",
      soldByStaffId: pos.selectedStaffId,
      userId: pos.selectedUserId || "",
    };
    pos.cart.forEach((item, idx) => {
      m[`productId_${idx + 1}`] = item.id;
      m[`productQty_${idx + 1}`] = String(item.cartQuantity);
    });
    return m;
  };

  const handleNewSale = () => {
    pos.clearCart();
    setPhase("browse");
    setActiveTile(null);
    setSearchQuery("");
    setPaymentDeclined(null);
    refetchProducts({});
  };

  /** Leave checkout, return to product browser with tile grid (clears tile filter + search). */
  const handleBackToTilesFromCheckout = () => {
    setPhase("browse");
    setActiveTile(null);
    setSearchQuery("");
    refetchProducts({});
  };

  // ── derived ──
  const cartCount = pos.cart.reduce((acc, p) => acc + p.cartQuantity, 0);
  const showTiles = !activeTile && !searchQuery.trim() && tiles.length > 0;

  // ─────────────────────────────────────────────────────────
  // Render: Success
  // ─────────────────────────────────────────────────────────
  if (phase === "success") {
    return (
      <View style={s.successContainer}>
        <Stack.Screen options={{ title: "Sale Complete", headerBackVisible: false }} />
        <View style={s.successCheck}>
          <Text style={s.successCheckIcon}>✓</Text>
        </View>
        <Text style={s.successTitle}>Payment Approved</Text>
        <Text style={s.successAmount}>
          {sym}
          {pos.total.toFixed(2)}
        </Text>
        <View style={s.successMetaRow}>
          <View style={s.successMetaPill}>
            <Text style={s.successMetaText}>
              {pos.isCash ? "Cash" : pos.isQr ? "QR Payment" : "Card"}
            </Text>
          </View>
          {pos.selectedStaffName ? (
            <View style={s.successMetaPill}>
              <Text style={s.successMetaText}>{pos.selectedStaffName}</Text>
            </View>
          ) : null}
        </View>
        <Text style={s.successSubtext}>Order recorded · inventory updated</Text>
        <TouchableOpacity style={s.primaryBtn} onPress={handleNewSale}>
          <Text style={s.primaryBtnText}>↻  New Sale</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ─────────────────────────────────────────────────────────
  // Render: Processing
  // ─────────────────────────────────────────────────────────
  if (phase === "processing") {
    return (
      <View style={s.successContainer}>
        <Stack.Screen options={{ title: "Processing…" }} />
        <ActivityIndicator size="large" color="#6366f1" />
        <Text style={s.processingTitle}>
          {pos.isCash ? "Recording sale…" : "Waiting for tap…"}
        </Text>
        <Text style={s.processingSubtext}>
          {pos.isCash
            ? "Verifying with the server"
            : "Hold the customer's card near the back of your phone"}
        </Text>
      </View>
    );
  }

  // ─────────────────────────────────────────────────────────
  // Render: QR
  // ─────────────────────────────────────────────────────────
  if (phase === "qr" && qrUrl) {
    return (
      <View style={s.successContainer}>
        <Stack.Screen options={{ title: "Customer Pays" }} />
        <Text style={s.qrTitle}>Customer scans to pay</Text>
        <View style={s.qrFrame}>
          <Image
            source={{
              uri: `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(qrUrl)}&margin=10`,
            }}
            style={s.qrImage}
          />
        </View>
        <Text style={s.qrAmount}>
          {sym}
          {pos.total.toFixed(2)}
        </Text>
        <View style={s.qrPollingRow}>
          <ActivityIndicator size="small" color="#a78bfa" />
          <Text style={s.qrPollingText}>Waiting for payment…</Text>
        </View>
        <TouchableOpacity style={s.secondaryBtn} onPress={cancelQrCheckout}>
          <Text style={s.secondaryBtnText}>Cancel</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ─────────────────────────────────────────────────────────
  // Render: Checkout
  // ─────────────────────────────────────────────────────────
  if (phase === "checkout") {
    const subtotalGrossWithoutDiscount = pos.cart.reduce(
      (a, i) => a + Number(i.ourPrice) * i.cartQuantity,
      0
    );
    const showDiscountSavings = pos.discountSavings > 0;
    const hasMultiQty = pos.cart.some((p) => p.cartQuantity > 1);

    return (
      <View style={s.checkoutContainer}>
        <Stack.Screen options={{ title: "Checkout" }} />

        {/* Scrollable content area */}
        <ScrollView style={s.checkoutScroll} contentContainerStyle={s.checkoutScrollContent}>
          {/* Header summary card */}

          {/* Sale details section */}
          <View style={s.checkoutSection}>
            <Text style={s.checkoutSectionTitle}>Sale details</Text>

            {/* Staff picker */}
            <TouchableOpacity style={s.checkoutDetailRow} onPress={() => setStaffModalOpen(true)}>
              <View>
                <Text style={s.checkoutDetailLabel}>Staff member</Text>
                <Text style={s.checkoutDetailValue}>
                  {pos.selectedStaffName || "Select staff…"}
                </Text>
              </View>
              <Text style={s.checkoutDetailCaret}>›</Text>
            </TouchableOpacity>

            {/* Customer picker */}
            <TouchableOpacity style={s.checkoutDetailRow} onPress={() => setCustomerModalOpen(true)}>
              <View>
                <Text style={s.checkoutDetailLabel}>Customer</Text>
                <Text style={[s.checkoutDetailValue, !pos.selectedUserLabel && s.checkoutDetailValueMuted]}>
                  {pos.selectedUserLabel || "Optional — tap to add"}
                </Text>
              </View>
              <Text style={s.checkoutDetailCaret}>›</Text>
            </TouchableOpacity>
          </View>

          {/* Payment method */}
          <View style={s.checkoutSection}>
            <Text style={s.checkoutSectionTitle}>Payment method</Text>
            <View style={s.checkoutMethodGrid}>
              <PaymentMethodBtn
                label="Card"
                sublabel="Tap to Pay"
                icon="💳"
                active={!pos.isCash && !pos.isQr}
                color="#6366f1"
                onPress={() => {
                  pos.setIsCash(false);
                  pos.setIsQr(false);
                }}
              />
              <PaymentMethodBtn
                label="Cash"
                sublabel="No fee"
                icon="💵"
                active={pos.isCash}
                color="#059669"
                onPress={() => pos.setIsCash(true)}
              />
              <PaymentMethodBtn
                label="QR Code"
                sublabel="Customer scans"
                icon="📱"
                active={pos.isQr}
                color="#7c3aed"
                onPress={() => pos.setIsQr(true)}
              />
            </View>

            {!pos.isCash && !pos.isQr && !terminalReady && (
              <View style={s.checkoutWarnPill}>
                <Text style={s.checkoutWarnText}>
                  Tap to Pay not available in Expo Go
                </Text>
              </View>
            )}

            {paymentDeclined && (
              <View style={s.checkoutErrorBox}>
                <Text style={s.checkoutErrorTitle}>Payment Declined</Text>
                {paymentDeclined.message && (
                  <Text style={s.checkoutErrorMsg}>{paymentDeclined.message}</Text>
                )}
              </View>
            )}
          </View>

          {/* Cart items */}
          <View style={[s.checkoutSection, s.checkoutSectionLast]}>
            <Text style={s.checkoutSectionTitle}>Order</Text>
            {pos.cart.map((item) => (
              <CartLineItem
                key={item.id}
                item={item}
                currencySymbol={sym}
                onIncrement={() => pos.updateQuantity(item.id, +1)}
                onDecrement={() => pos.updateQuantity(item.id, -1)}
                onRemove={() => pos.removeFromCart(item.id)}
                onDiscount={() => setDiscountModal({ kind: "item", product: item })}
              />
            ))}

            {/* Discount actions */}
            {!pos.hasAppliedDiscounts && pos.cart.length > 0 && (
              <TouchableOpacity
                style={[s.checkoutDiscountBtn, hasMultiQty && s.checkoutDiscountBtnDisabled]}
                disabled={hasMultiQty}
                onPress={() => setDiscountModal({ kind: "order" })}
              >
                <Text style={s.checkoutDiscountBtnText}>Apply order discount</Text>
                {hasMultiQty && (
                  <Text style={s.checkoutDiscountHint}>Set quantities to 1 first</Text>
                )}
              </TouchableOpacity>
            )}
          </View>

          {/* Spacer for footer */}
          <View style={{ height: 100 }} />
        </ScrollView>

        {/* Sticky footer with payment controls */}
        <View style={s.checkoutFooter}>
          <TouchableOpacity
            style={[
              s.checkoutChargeBtn,
              (!pos.selectedStaffId || pos.cart.length === 0) && s.checkoutChargeBtnDisabled,
              pos.isCash && s.checkoutChargeBtnCash,
              pos.isQr && s.checkoutChargeBtnQr,
            ]}
            onPress={handleCharge}
            disabled={!pos.selectedStaffId || pos.cart.length === 0}
            activeOpacity={0.9}
          >
            <Text style={s.checkoutChargeBtnText}>
              {pos.isCash
                ? `Record ${sym}${pos.total.toFixed(2)}`
                : pos.isQr
                ? `Generate QR · ${sym}${pos.total.toFixed(2)}`
                : `Charge ${sym}${pos.total.toFixed(2)}`}
            </Text>
          </TouchableOpacity>

          <View style={s.checkoutFooterLinks}>
            <TouchableOpacity onPress={handleBackToTilesFromCheckout}>
              <Text style={s.checkoutFooterLink}>← Back to tiles</Text>
            </TouchableOpacity>
            <Text style={s.checkoutFooterDivider}>·</Text>
            <TouchableOpacity onPress={() => setPhase("browse")}>
              <Text style={s.checkoutFooterLink}>Keep filters</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* ── Modals ── */}
        <DiscountModal
          modal={discountModal}
          onClose={() => setDiscountModal(null)}
          onApplyItem={async (product, type, value) => {
            await applyItemDiscountAndPersist(product, type, value);
            setDiscountModal(null);
          }}
          onClearItem={(product) => {
            pos.clearItemDiscount(product.id);
            setDiscountModal(null);
          }}
          onApplyOrder={async (type, value) => {
            await applyOrderDiscountAndPersist(type, value);
            setDiscountModal(null);
          }}
          onClearOrder={() => {
            pos.clearOrderDiscount();
            setDiscountModal(null);
          }}
          currencySymbol={sym}
        />
        <PickerModal
          visible={staffModalOpen}
          onClose={() => setStaffModalOpen(false)}
          title="Select staff member"
          items={staff.map((m) => ({ id: m.id, label: m.name }))}
          selectedId={pos.selectedStaffId}
          onSelect={(item) => {
            pos.setStaff(item.id, item.label);
            setStaffModalOpen(false);
          }}
        />
        <CustomerModal
          visible={customerModalOpen}
          users={users}
          selectedId={pos.selectedUserId}
          storeId={storeId!}
          onClose={() => setCustomerModalOpen(false)}
          onSelect={(user) => {
            pos.setUser(user.id, user.email || user.name || "Customer");
            setCustomerModalOpen(false);
          }}
          onClear={() => {
            pos.setUser("", "");
            setCustomerModalOpen(false);
          }}
          onCreated={(user) => {
            setUsers((prev) => [...prev, user]);
            pos.setUser(user.id, user.email || user.name || "Customer");
            setCustomerModalOpen(false);
          }}
        />
      </View>
    );
  }

  // ─────────────────────────────────────────────────────────
  // Render: Browse (default)
  // ─────────────────────────────────────────────────────────
  return (
    <View style={s.container}>
      <Stack.Screen options={{ title: "Point of Sale", headerBackTitle: "Stores" }} />

      {/* Search + Quick Sale */}
      <View style={s.searchRow}>
        <TextInput
          style={s.searchInput}
          placeholder={
            activeTile ? `Search in ${activeTile.label}…` : "Search products…"
          }
          placeholderTextColor="#64748b"
          value={searchQuery}
          onChangeText={handleSearchChange}
          autoCorrect={false}
          autoCapitalize="none"
        />
        <TouchableOpacity style={s.quickSaleBtn} onPress={() => setQuickSaleOpen(true)}>
          <Text style={s.quickSaleBtnText}>+ Quick</Text>
        </TouchableOpacity>
      </View>

      {/* Tile breadcrumb */}
      {activeTile && (
        <TouchableOpacity style={s.breadcrumb} onPress={clearTile}>
          <Text style={s.breadcrumbText}>← Back to tiles · {activeTile.label}</Text>
        </TouchableOpacity>
      )}

      {/* Grid */}
      {loadingProducts ? (
        <View style={s.centerContainer}>
          <ActivityIndicator size="large" color="#6366f1" />
        </View>
      ) : (
        <FlatList
          data={[
            ...(showTiles
              ? tiles.map((t) => ({ kind: "tile" as const, tile: t }))
              : []),
            ...products.map((p) => ({ kind: "product" as const, product: p })),
          ]}
          keyExtractor={(item) =>
            item.kind === "tile" ? `tile-${item.tile.id}` : `product-${item.product.id}`
          }
          numColumns={2}
          columnWrapperStyle={s.gridRow}
          contentContainerStyle={s.gridContainer}
          renderItem={({ item }) => {
            if (item.kind === "tile") {
              return <TileCard tile={item.tile} onPress={() => handleTilePress(item.tile)} />;
            }
            const p = item.product;
            const inCart = pos.cart.find((c) => c.id === p.id);
            const noStripe = !p.store?.stripe_connect_unique_id;
            return (
              <ProductCard
                product={p}
                inCart={inCart?.cartQuantity}
                disabled={noStripe}
                currencySymbol={sym}
                onPress={() => pos.addToCart(p)}
              />
            );
          }}
          onEndReached={loadMore}
          onEndReachedThreshold={0.5}
          ListFooterComponent={
            loadingMore ? (
              <View style={{ padding: 16 }}>
                <ActivityIndicator color="#6366f1" />
              </View>
            ) : null
          }
          ListEmptyComponent={
            <View style={s.centerContainer}>
              <Text style={s.emptyText}>No products found</Text>
            </View>
          }
        />
      )}

      {/* Cart bar */}
      {pos.cart.length > 0 && (
        <TouchableOpacity style={s.cartBar} onPress={() => setPhase("checkout")}>
          <View>
            <Text style={s.cartBarLabel}>{cartCount} items</Text>
            <Text style={s.cartBarSubLabel}>
              {sym}
              {pos.subtotal.toFixed(2)}
              {pos.discountSavings > 0 && (
                <Text style={s.cartBarSavings}>
                  {"  "}saved {sym}
                  {pos.discountSavings.toFixed(2)}
                </Text>
              )}
            </Text>
          </View>
          <Text style={s.cartBarAction}>Checkout →</Text>
        </TouchableOpacity>
      )}

      {/* Quick Sale Modal */}
      <QuickSaleModal
        visible={quickSaleOpen}
        sellers={sellers}
        currencySymbol={sym}
        onClose={() => setQuickSaleOpen(false)}
        onAdd={handleQuickSaleAdd}
      />
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────

function TileCard({ tile, onPress }: { tile: PosTile; onPress: () => void }) {
  return (
    <TouchableOpacity style={s.tileCard} onPress={onPress}>
      {tile.imageUrl ? (
        <Image source={{ uri: tile.imageUrl }} style={s.tileImage} />
      ) : (
        <View style={[s.tileImage, s.tileImagePlaceholder]}>
          <Text style={s.tilePlaceholderText}>{tile.label[0]?.toUpperCase()}</Text>
        </View>
      )}
      <View style={s.tileOverlay}>
        <Text style={s.tileLabel} numberOfLines={2}>
          {tile.label}
        </Text>
      </View>
      <View style={[s.tileBadge, { backgroundColor: tileColor(tile.type) }]}>
        <Text style={s.tileBadgeText}>{tileLabel(tile.type)}</Text>
      </View>
    </TouchableOpacity>
  );
}

function tileColor(type: string) {
  switch (type) {
    case "designer": return "#8b5cf6";
    case "category": return "#0ea5e9";
    case "productGroup": return "#f59e0b";
    case "seller": return "#10b981";
    default: return "#64748b";
  }
}

function tileLabel(type: string) {
  switch (type) {
    case "designer": return "Designer";
    case "category": return "Category";
    case "productGroup": return "Group";
    case "seller": return "Seller";
    default: return "Tile";
  }
}

function ProductCard({
  product,
  inCart,
  disabled,
  currencySymbol: sym,
  onPress,
}: {
  product: POSProduct;
  inCart?: number;
  disabled?: boolean;
  currencySymbol: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[
        s.productCard,
        inCart != null && s.productCardSelected,
        disabled && s.productCardDisabled,
      ]}
      onPress={onPress}
      disabled={disabled}
    >
      {product.images?.[0]?.url ? (
        <Image source={{ uri: product.images[0].url }} style={s.productImage} />
      ) : (
        <View style={[s.productImage, s.productImagePlaceholder]}>
          <Text style={s.productPlaceholderText}>
            {product.name[0]?.toUpperCase()}
          </Text>
        </View>
      )}
      <Text style={s.productName} numberOfLines={2}>
        {product.name}
      </Text>
      <Text style={s.productPrice}>
        {sym}
        {Number(product.ourPrice).toFixed(2)}
      </Text>
      {(product.size?.name || product.color?.name) && (
        <Text style={s.productMeta} numberOfLines={1}>
          {[product.size?.name, product.color?.name].filter(Boolean).join(" · ")}
        </Text>
      )}
      {inCart != null && (
        <View style={s.cartBadge}>
          <Text style={s.cartBadgeText}>{inCart}</Text>
        </View>
      )}
      {disabled && (
        <View style={s.noStripeBadge}>
          <Text style={s.noStripeText}>No Stripe</Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

function CartLineItem({
  item,
  currencySymbol: sym,
  onIncrement,
  onDecrement,
  onRemove,
  onDiscount,
}: {
  item: CartItem;
  currencySymbol: string;
  onIncrement: () => void;
  onDecrement: () => void;
  onRemove: () => void;
  onDiscount: () => void;
}) {
  const base = Number(item.ourPrice) || 0;
  const v = item.discountValue ?? 0;
  const effective =
    item.discountType === "PERCENT"
      ? base - base * (v / 100)
      : item.discountType === "CUSTOM_PRICE"
      ? Math.max(0.01, v)
      : base;
  const lineTotal = effective * item.cartQuantity;
  const grossTotal = base * item.cartQuantity;

  return (
    <View style={s.cartItem}>
      <View style={{ flex: 1 }}>
        <Text style={s.cartItemName} numberOfLines={2}>
          {item.name}
        </Text>
        {(item.size?.name || item.color?.name) && (
          <Text style={s.cartItemMeta}>
            {[item.size?.name, item.color?.name].filter(Boolean).join(" · ")}
          </Text>
        )}
        <View style={s.qtyRow}>
          <TouchableOpacity style={s.qtyBtn} onPress={onDecrement}>
            <Text style={s.qtyBtnText}>−</Text>
          </TouchableOpacity>
          <Text style={s.qtyText}>{item.cartQuantity}</Text>
          <TouchableOpacity style={s.qtyBtn} onPress={onIncrement}>
            <Text style={s.qtyBtnText}>+</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              s.qtyDiscountBtn,
              item.discountType ? s.qtyDiscountBtnActive : null,
              item.cartQuantity > 1 && s.qtyDiscountBtnDisabled,
            ]}
            disabled={item.cartQuantity > 1}
            onPress={onDiscount}
          >
            <Text
              style={[
                s.qtyDiscountText,
                item.discountType ? s.qtyDiscountTextActive : null,
              ]}
            >
              %
            </Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.qtyRemoveBtn} onPress={onRemove}>
            <Text style={s.qtyRemoveText}>×</Text>
          </TouchableOpacity>
        </View>
      </View>
      <View style={s.cartItemPriceCol}>
        <Text style={s.cartItemPrice}>
          {sym}
          {lineTotal.toFixed(2)}
        </Text>
        {effective !== base && (
          <Text style={s.cartItemPriceStrike}>
            {sym}
            {grossTotal.toFixed(2)}
          </Text>
        )}
      </View>
    </View>
  );
}

function PaymentMethodBtn({
  label,
  sublabel,
  icon,
  active,
  color,
  onPress,
}: {
  label: string;
  sublabel?: string;
  icon: string;
  active: boolean;
  color: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[s.checkoutMethodBtn, active && { backgroundColor: color, borderColor: color }]}
      onPress={onPress}
      activeOpacity={0.85}
    >
      <Text style={s.checkoutMethodIcon}>{icon}</Text>
      <Text style={[s.checkoutMethodLabel, active && s.checkoutMethodLabelActive]}>
        {label}
      </Text>
      {sublabel && (
        <Text style={[s.checkoutMethodSublabel, active && s.checkoutMethodSublabelActive]}>
          {sublabel}
        </Text>
      )}
    </TouchableOpacity>
  );
}

// ── Picker (generic select-from-list modal) ──
function PickerModal({
  visible,
  title,
  items,
  selectedId,
  onClose,
  onSelect,
}: {
  visible: boolean;
  title: string;
  items: { id: string; label: string }[];
  selectedId: string;
  onClose: () => void;
  onSelect: (item: { id: string; label: string }) => void;
}) {
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={s.modalBackdrop}>
        <View style={s.modalSheet}>
          <View style={s.modalHandle} />
          <Text style={s.modalTitle}>{title}</Text>
          <ScrollView style={{ maxHeight: 400 }}>
            {items.map((item, index) => (
              <TouchableOpacity
                key={`picker-${item.id || "empty"}-${index}`}
                style={[s.modalItem, item.id === selectedId && s.modalItemSelected]}
                onPress={() => onSelect(item)}
              >
                <Text
                  style={[
                    s.modalItemLabel,
                    item.id === selectedId && s.modalItemLabelSelected,
                  ]}
                >
                  {item.label}
                </Text>
                {item.id === selectedId && <Text style={s.modalItemCheck}>✓</Text>}
              </TouchableOpacity>
            ))}
          </ScrollView>
          <TouchableOpacity style={s.modalCloseBtn} onPress={onClose}>
            <Text style={s.modalCloseText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

// ── Customer Modal (with search + create) ──
function CustomerModal({
  visible,
  users,
  selectedId,
  storeId,
  onClose,
  onSelect,
  onClear,
  onCreated,
}: {
  visible: boolean;
  users: any[];
  selectedId: string;
  storeId: string;
  onClose: () => void;
  onSelect: (user: any) => void;
  onClear: () => void;
  onCreated: (user: any) => void;
}) {
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users.slice(0, 50);
    return users
      .filter(
        (u) =>
          u.email?.toLowerCase().includes(q) ||
          u.name?.toLowerCase().includes(q)
      )
      .slice(0, 50);
  }, [users, query]);

  const handleCreate = async () => {
    if (!newEmail.trim()) {
      Alert.alert("Missing", "Email is required");
      return;
    }
    setSubmitting(true);
    try {
      const user = await createUser({
        name: newName.trim(),
        email: newEmail.trim(),
        storeId,
      });
      onCreated(user);
      setCreating(false);
      setNewName("");
      setNewEmail("");
    } catch (err: any) {
      console.error("Create user failed:", err);
      Alert.alert("Error", err?.response?.data ?? "Could not create customer");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={s.modalBackdrop}
      >
        <View style={s.modalSheet}>
          <View style={s.modalHandle} />
          <Text style={s.modalTitle}>Customer</Text>

          {!creating ? (
            <>
              <TextInput
                style={s.modalSearchInput}
                placeholder="Search by name or email…"
                placeholderTextColor="#64748b"
                value={query}
                onChangeText={setQuery}
                autoCapitalize="none"
              />
              <ScrollView style={{ maxHeight: 280 }}>
                {filtered.map((u, index) => (
                  <TouchableOpacity
                    key={`customer-${u.id ?? "noid"}-${u.email ?? ""}-${index}`}
                    style={[s.modalItem, u.id === selectedId && s.modalItemSelected]}
                    onPress={() => onSelect(u)}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={s.modalItemLabel}>{u.name || u.email || "Unknown"}</Text>
                      {u.name && u.email && (
                        <Text style={s.modalItemSub}>{u.email}</Text>
                      )}
                    </View>
                    {u.id === selectedId && <Text style={s.modalItemCheck}>✓</Text>}
                  </TouchableOpacity>
                ))}
                {filtered.length === 0 ? (
                  <Text key="customer-list-empty" style={s.modalEmpty}>
                    No customers match.
                  </Text>
                ) : null}
              </ScrollView>

              <View style={s.modalActionRow}>
                <TouchableOpacity style={s.modalSecondaryBtn} onPress={() => setCreating(true)}>
                  <Text style={s.modalSecondaryBtnText}>+ New customer</Text>
                </TouchableOpacity>
                {selectedId ? (
                  <TouchableOpacity style={s.modalSecondaryBtn} onPress={onClear}>
                    <Text style={s.modalSecondaryBtnText}>Clear</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            </>
          ) : (
            <>
              <TextInput
                style={s.modalSearchInput}
                placeholder="Customer name (optional)"
                placeholderTextColor="#64748b"
                value={newName}
                onChangeText={setNewName}
              />
              <TextInput
                style={s.modalSearchInput}
                placeholder="Email (required)"
                placeholderTextColor="#64748b"
                value={newEmail}
                onChangeText={setNewEmail}
                keyboardType="email-address"
                autoCapitalize="none"
              />
              <View style={s.modalActionRow}>
                <TouchableOpacity
                  style={s.modalPrimaryBtn}
                  onPress={handleCreate}
                  disabled={submitting}
                >
                  {submitting ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={s.modalPrimaryBtnText}>Create & select</Text>
                  )}
                </TouchableOpacity>
                <TouchableOpacity style={s.modalSecondaryBtn} onPress={() => setCreating(false)}>
                  <Text style={s.modalSecondaryBtnText}>Back</Text>
                </TouchableOpacity>
              </View>
            </>
          )}

          <TouchableOpacity style={s.modalCloseBtn} onPress={onClose}>
            <Text style={s.modalCloseText}>Close</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ── Discount Modal (item or order) ──
function DiscountModal({
  modal,
  onClose,
  onApplyItem,
  onClearItem,
  onApplyOrder,
  onClearOrder,
  currencySymbol: sym,
}: {
  modal: { kind: "item"; product: CartItem } | { kind: "order" } | null;
  onClose: () => void;
  onApplyItem: (product: CartItem, type: DiscountType, value: number) => Promise<void>;
  onClearItem: (product: CartItem) => void;
  onApplyOrder: (type: DiscountType, value: number) => Promise<void>;
  onClearOrder: () => void;
  currencySymbol: string;
}) {
  const [type, setType] = useState<DiscountType>("PERCENT");
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (modal?.kind === "item") {
      setType(modal.product.discountType ?? "PERCENT");
      setValue(modal.product.discountValue?.toString() ?? "");
    } else {
      setType("PERCENT");
      setValue("");
    }
  }, [modal]);

  if (!modal) return null;

  const apply = async () => {
    const num = Number(value);
    if (Number.isNaN(num) || num <= 0) {
      Alert.alert("Invalid", "Enter a valid amount");
      return;
    }
    if (type === "PERCENT" && num > 100) {
      Alert.alert("Invalid", "Percent cannot exceed 100");
      return;
    }
    if (type === "CUSTOM_PRICE" && num < 1) {
      Alert.alert("Invalid", "Price must be at least 1");
      return;
    }
    setSubmitting(true);
    try {
      if (modal.kind === "item") await onApplyItem(modal.product, type, num);
      else await onApplyOrder(type, num);
    } finally {
      setSubmitting(false);
    }
  };

  const isItem = modal.kind === "item";

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={s.modalBackdrop}
      >
        <View style={s.modalSheet}>
          <View style={s.modalHandle} />
          <Text style={s.modalTitle}>
            {isItem ? `Discount: ${modal.product.name}` : "Order-wide Discount"}
          </Text>
          {!isItem && (
            <Text style={s.modalSubtext}>
              Applied to every item in the order. Requires all quantities to be 1.
            </Text>
          )}

          <Text style={s.modalSectionLabel}>Type</Text>
          <View style={s.discountTypeRow}>
            <TouchableOpacity
              style={[s.discountTypeBtn, type === "PERCENT" && s.discountTypeBtnActive]}
              onPress={() => setType("PERCENT")}
            >
              <Text style={[s.discountTypeText, type === "PERCENT" && s.discountTypeTextActive]}>
                % off
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.discountTypeBtn, type === "CUSTOM_PRICE" && s.discountTypeBtnActive]}
              onPress={() => setType("CUSTOM_PRICE")}
            >
              <Text style={[s.discountTypeText, type === "CUSTOM_PRICE" && s.discountTypeTextActive]}>
                Set price
              </Text>
            </TouchableOpacity>
          </View>

          <Text style={s.modalSectionLabel}>
            {type === "PERCENT" ? "Percent off" : `Final ${isItem ? "price" : "total"} (${sym})`}
          </Text>
          <TextInput
            style={s.modalSearchInput}
            placeholder={type === "PERCENT" ? "10" : "50.00"}
            placeholderTextColor="#64748b"
            value={value}
            onChangeText={setValue}
            keyboardType="decimal-pad"
          />

          <View style={s.modalActionRow}>
            <TouchableOpacity style={s.modalPrimaryBtn} onPress={apply} disabled={submitting}>
              {submitting ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={s.modalPrimaryBtnText}>Apply</Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              style={s.modalSecondaryBtn}
              onPress={() => {
                if (modal.kind === "item") onClearItem(modal.product);
                else onClearOrder();
              }}
            >
              <Text style={s.modalSecondaryBtnText}>Clear</Text>
            </TouchableOpacity>
          </View>

          <TouchableOpacity style={s.modalCloseBtn} onPress={onClose}>
            <Text style={s.modalCloseText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ── Quick Sale Modal ──
function QuickSaleModal({
  visible,
  sellers,
  currencySymbol: sym,
  onClose,
  onAdd,
}: {
  visible: boolean;
  sellers: any[];
  currencySymbol: string;
  onClose: () => void;
  onAdd: (name: string, price: number, sellerId?: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [sellerId, setSellerId] = useState<string | undefined>();
  const [showSellerPicker, setShowSellerPicker] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (visible) {
      setName("");
      setPrice("");
      setSellerId(undefined);
    }
  }, [visible]);

  const handleAdd = async () => {
    const num = Number(price);
    if (!name.trim() || Number.isNaN(num) || num <= 0) {
      Alert.alert("Invalid", "Name and a positive price are required");
      return;
    }
    setSubmitting(true);
    try {
      await onAdd(name.trim(), num, sellerId);
    } finally {
      setSubmitting(false);
    }
  };

  const selectedSeller = sellers.find((s) => s.id === sellerId);

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={s.modalBackdrop}
      >
        <View style={s.modalSheet}>
          <View style={s.modalHandle} />
          <Text style={s.modalTitle}>Quick Sale</Text>
          <Text style={s.modalSubtext}>Create a one-off product and add to order</Text>

          <Text style={s.modalSectionLabel}>Name</Text>
          <TextInput
            style={s.modalSearchInput}
            placeholder="Vintage McQueen dress"
            placeholderTextColor="#64748b"
            value={name}
            onChangeText={setName}
          />

          <Text style={s.modalSectionLabel}>Price ({sym})</Text>
          <TextInput
            style={s.modalSearchInput}
            placeholder="0.00"
            placeholderTextColor="#64748b"
            value={price}
            onChangeText={(v) => /^\d*\.?\d*$/.test(v) && setPrice(v)}
            keyboardType="decimal-pad"
          />

          <Text style={s.modalSectionLabel}>Seller (optional)</Text>
          <TouchableOpacity style={s.pickerRow} onPress={() => setShowSellerPicker(true)}>
            <Text style={s.pickerLabel}>
              {selectedSeller
                ? selectedSeller.storeName || selectedSeller.firstName || "Seller"
                : "No seller (default)"}
            </Text>
            <Text style={s.pickerCaret}>›</Text>
          </TouchableOpacity>

          <View style={s.modalActionRow}>
            <TouchableOpacity style={s.modalPrimaryBtn} onPress={handleAdd} disabled={submitting}>
              {submitting ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={s.modalPrimaryBtnText}>Add to order</Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity style={s.modalSecondaryBtn} onPress={onClose}>
              <Text style={s.modalSecondaryBtnText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>

        <PickerModal
          visible={showSellerPicker}
          onClose={() => setShowSellerPicker(false)}
          title="Select seller"
          items={[
            { id: "", label: "No seller" },
            ...sellers.map((s: any) => ({
              id: s.id,
              label: s.storeName || s.firstName || s.email || "Unknown",
            })),
          ]}
          selectedId={sellerId ?? ""}
          onSelect={(item) => {
            setSellerId(item.id || undefined);
            setShowSellerPicker(false);
          }}
        />
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  centerContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#fff",
    padding: 32,
  },
  emptyText: { fontSize: 16, color: "#64748b" },

  // search row
  searchRow: { flexDirection: "row", paddingHorizontal: 12, paddingTop: 8, gap: 8 },
  searchInput: {
    flex: 1,
    backgroundColor: "#fff",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: "#0f172a",
    borderWidth: 1,
    borderColor: "#e2e8f0",
  },
  quickSaleBtn: {
    paddingHorizontal: 14,
    backgroundColor: "#2563eb",
    borderRadius: 12,
    justifyContent: "center",
  },
  quickSaleBtnText: { color: "#fff", fontWeight: "700", fontSize: 14 },

  // breadcrumb
  breadcrumb: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginHorizontal: 12,
    marginTop: 8,
    backgroundColor: "#eff6ff",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#dbeafe",
  },
  breadcrumbText: { color: "#2563eb", fontSize: 13, fontWeight: "600" },

  // grid
  gridContainer: { padding: 8, paddingBottom: 100 },
  gridRow: { gap: 8, paddingHorizontal: 4 },

  // tile card
  tileCard: {
    flex: 1,
    aspectRatio: 1,
    backgroundColor: "#fff",
    borderRadius: 14,
    overflow: "hidden",
    marginBottom: 8,
    borderWidth: 2,
    borderColor: "#e2e8f0",
    borderStyle: "dashed",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 2,
  },
  tileImage: { width: "100%", height: "100%" },
  tileImagePlaceholder: {
    backgroundColor: "#f1f5f9",
    justifyContent: "center",
    alignItems: "center",
  },
  tilePlaceholderText: { fontSize: 48, fontWeight: "800", color: "#94a3b8" },
  tileOverlay: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.5)",
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  tileLabel: { color: "#fff", fontSize: 14, fontWeight: "700", textAlign: "center" },
  tileBadge: {
    position: "absolute",
    top: 8,
    left: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  tileBadgeText: { color: "#fff", fontSize: 10, fontWeight: "800", letterSpacing: 0.3 },

  // product card
  productCard: {
    flex: 1,
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 10,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 1,
  },
  productCardSelected: { borderColor: "#2563eb", borderWidth: 2 },
  productCardDisabled: { opacity: 0.5 },
  productImage: { width: "100%", aspectRatio: 1, borderRadius: 8, marginBottom: 8 },
  productImagePlaceholder: {
    backgroundColor: "#f1f5f9",
    justifyContent: "center",
    alignItems: "center",
  },
  productPlaceholderText: { fontSize: 32, fontWeight: "700", color: "#94a3b8" },
  productName: { fontSize: 13, fontWeight: "600", color: "#0f172a", marginBottom: 4 },
  productPrice: { fontSize: 15, fontWeight: "800", color: "#2563eb" },
  productMeta: { fontSize: 11, color: "#64748b", marginTop: 2 },
  cartBadge: {
    position: "absolute",
    top: 6,
    right: 6,
    backgroundColor: "#2563eb",
    borderRadius: 10,
    minWidth: 22,
    height: 22,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 6,
  },
  cartBadgeText: { color: "#fff", fontSize: 11, fontWeight: "800" },
  noStripeBadge: {
    position: "absolute",
    top: 6,
    left: 6,
    backgroundColor: "#dc2626",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  noStripeText: { color: "#fff", fontSize: 9, fontWeight: "700" },

  // cart bar
  cartBar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: "#2563eb",
    padding: 18,
    paddingBottom: 34,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
  },
  cartBarLabel: { color: "#dbeafe", fontSize: 13, fontWeight: "600" },
  cartBarSubLabel: { color: "#fff", fontSize: 16, fontWeight: "800" },
  cartBarSavings: { fontSize: 12, color: "#bbf7d0", fontWeight: "700" },
  cartBarAction: { color: "#fff", fontSize: 16, fontWeight: "800" },

  // checkout - cart items
  sectionLabel: {
    fontSize: 12,
    fontWeight: "700",
    color: "#64748b",
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 8,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  cartItem: {
    flexDirection: "row",
    backgroundColor: "#fff",
    borderRadius: 14,
    padding: 14,
    marginHorizontal: 16,
    marginBottom: 8,
    gap: 12,
    borderWidth: 1,
    borderColor: "#e2e8f0",
  },
  cartItemName: { fontSize: 15, fontWeight: "700", color: "#0f172a" },
  cartItemMeta: { fontSize: 12, color: "#64748b", marginTop: 2 },
  cartItemPriceCol: { alignItems: "flex-end", justifyContent: "center" },
  cartItemPrice: { fontSize: 16, fontWeight: "800", color: "#2563eb" },
  cartItemPriceStrike: {
    fontSize: 12,
    color: "#94a3b8",
    textDecorationLine: "line-through",
    marginTop: 2,
  },

  // qty row
  qtyRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 10 },
  qtyBtn: {
    width: 28,
    height: 28,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    backgroundColor: "#fff",
    justifyContent: "center",
    alignItems: "center",
  },
  qtyBtnText: { color: "#0f172a", fontSize: 16, fontWeight: "700" },
  qtyText: { color: "#0f172a", fontSize: 14, fontWeight: "700", minWidth: 20, textAlign: "center" },
  qtyDiscountBtn: {
    width: 28,
    height: 28,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    backgroundColor: "#fff",
    justifyContent: "center",
    alignItems: "center",
    marginLeft: 4,
  },
  qtyDiscountBtnActive: { backgroundColor: "#f59e0b", borderColor: "#f59e0b" },
  qtyDiscountBtnDisabled: { opacity: 0.3 },
  qtyDiscountText: { color: "#f59e0b", fontSize: 14, fontWeight: "800" },
  qtyDiscountTextActive: { color: "#fff" },
  qtyRemoveBtn: {
    width: 28,
    height: 28,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    backgroundColor: "#fff",
    justifyContent: "center",
    alignItems: "center",
    marginLeft: "auto",
  },
  qtyRemoveText: { color: "#dc2626", fontSize: 16, fontWeight: "800" },

  // full-width helper buttons
  fullWidthBtn: {
    backgroundColor: "#fff",
    marginHorizontal: 16,
    marginTop: 4,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    alignItems: "center",
  },
  fullWidthBtnDisabled: { opacity: 0.4 },
  fullWidthBtnText: { color: "#f59e0b", fontSize: 13, fontWeight: "700" },
  helperText: { color: "#94a3b8", fontSize: 11, marginTop: 4 },

  // totals
  totalsBlock: { paddingHorizontal: 20, paddingTop: 18 },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  totalLabel: { fontSize: 14, color: "#64748b" },
  totalValue: { fontSize: 14, color: "#64748b" },
  totalValueGreen: { fontSize: 14, color: "#16a34a", fontWeight: "700" },
  grandTotalLabel: { fontSize: 22, fontWeight: "800", color: "#0f172a" },
  grandTotalValue: { fontSize: 22, fontWeight: "800", color: "#0f172a" },

  // picker rows
  pickerRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff",
    marginHorizontal: 16,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    marginBottom: 4,
  },
  pickerLabel: { color: "#0f172a", fontSize: 15, flex: 1 },
  pickerCaret: { color: "#94a3b8", fontSize: 22, marginLeft: 8 },

  // payment method
  methodRow: { flexDirection: "row", paddingHorizontal: 16, gap: 8 },
  methodBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: "#e2e8f0",
    backgroundColor: "#fff",
    alignItems: "center",
  },
  methodIcon: { fontSize: 22, marginBottom: 4 },
  methodLabel: { color: "#64748b", fontWeight: "700", fontSize: 13 },
  methodLabelActive: { color: "#fff" },

  // warn / error boxes
  warnBox: {
    backgroundColor: "#fef3c7",
    marginHorizontal: 16,
    marginTop: 12,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#fbbf24",
  },
  warnText: { color: "#92400e", fontSize: 13, textAlign: "center" },
  errorBox: {
    backgroundColor: "#fef2f2",
    marginHorizontal: 16,
    marginTop: 12,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#fca5a5",
  },
  errorTitle: { color: "#dc2626", fontSize: 14, fontWeight: "800", textAlign: "center" },
  errorMsg: { color: "#ef4444", fontSize: 12, textAlign: "center", marginTop: 4 },

  // charge bar
  chargeBar: { padding: 20, paddingBottom: 36, backgroundColor: "#f8fafc" },
  chargeButton: {
    backgroundColor: "#2563eb",
    borderRadius: 14,
    padding: 18,
    alignItems: "center",
    marginBottom: 10,
  },
  chargeButtonCash: { backgroundColor: "#16a34a" },
  chargeButtonQr: { backgroundColor: "#7c3aed" },
  chargeButtonDisabled: { opacity: 0.4 },
  chargeButtonText: { color: "#fff", fontSize: 17, fontWeight: "800" },
  backToTilesBtn: {
    borderWidth: 1,
    borderColor: "#e2e8f0",
    backgroundColor: "#fff",
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    marginBottom: 10,
  },
  backToTilesBtnText: { color: "#0f172a", fontSize: 15, fontWeight: "700" },
  backLink: { color: "#64748b", fontSize: 13, textAlign: "center", marginBottom: 4 },

  // success
  successContainer: {
    flex: 1,
    backgroundColor: "#fff",
    justifyContent: "center",
    alignItems: "center",
    padding: 32,
  },
  successCheck: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: "#dcfce7",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 16,
  },
  successCheckIcon: { fontSize: 56, color: "#16a34a", fontWeight: "900" },
  successTitle: { fontSize: 22, fontWeight: "800", color: "#0f172a", marginBottom: 4 },
  successAmount: { fontSize: 40, fontWeight: "900", color: "#16a34a", marginBottom: 14 },
  successMetaRow: { flexDirection: "row", gap: 8, marginBottom: 12 },
  successMetaPill: {
    backgroundColor: "#eff6ff",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#dbeafe",
  },
  successMetaText: { color: "#2563eb", fontSize: 12, fontWeight: "700" },
  successSubtext: { color: "#64748b", fontSize: 12, marginBottom: 28 },

  primaryBtn: {
    backgroundColor: "#2563eb",
    borderRadius: 14,
    paddingVertical: 16,
    paddingHorizontal: 48,
  },
  primaryBtnText: { color: "#fff", fontSize: 16, fontWeight: "800" },
  secondaryBtn: {
    borderWidth: 1,
    borderColor: "#fca5a5",
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 32,
    marginTop: 16,
    backgroundColor: "#fef2f2",
  },
  secondaryBtnText: { color: "#dc2626", fontSize: 14, fontWeight: "700" },

  processingTitle: { fontSize: 18, fontWeight: "800", color: "#0f172a", marginTop: 20 },
  processingSubtext: {
    fontSize: 13,
    color: "#64748b",
    marginTop: 8,
    textAlign: "center",
    maxWidth: 280,
  },

  // qr
  qrTitle: { fontSize: 18, fontWeight: "700", color: "#0f172a", marginBottom: 24 },
  qrFrame: {
    backgroundColor: "#fff",
    padding: 12,
    borderRadius: 16,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: "#e2e8f0",
  },
  qrImage: { width: 240, height: 240 },
  qrAmount: { fontSize: 32, fontWeight: "900", color: "#2563eb", marginBottom: 16 },
  qrPollingRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  qrPollingText: { color: "#2563eb", fontSize: 13, fontWeight: "600" },

  // Checkout — cleaner layout
  checkoutContainer: { flex: 1, backgroundColor: "#f8fafc" },
  checkoutScroll: { flex: 1 },
  checkoutScrollContent: { paddingHorizontal: 12, paddingTop: 10 },

  checkoutSummaryCard: {
    backgroundColor: "#fff",
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#e2e8f0",
  },
  checkoutSummaryRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  checkoutItemCount: { fontSize: 15, color: "#64748b", fontWeight: "600" },
  checkoutTotalDisplay: { fontSize: 32, fontWeight: "800", color: "#0f172a" },
  checkoutSavings: { fontSize: 14, color: "#16a34a", marginTop: 6, fontWeight: "600" },
  checkoutFeeNote: { fontSize: 13, color: "#94a3b8", marginTop: 4 },

  checkoutSection: {
    backgroundColor: "#fff",
    borderRadius: 14,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: "#e2e8f0",
  },
  checkoutSectionLast: { marginBottom: 0 },
  checkoutSectionTitle: {
    fontSize: 12,
    fontWeight: "700",
    color: "#64748b",
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginBottom: 10,
  },

  checkoutDetailRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#f1f5f9",
  },
  checkoutDetailLabel: { fontSize: 13, color: "#64748b", marginBottom: 2 },
  checkoutDetailValue: { fontSize: 16, color: "#0f172a", fontWeight: "600" },
  checkoutDetailValueMuted: { color: "#94a3b8" },
  checkoutDetailCaret: { fontSize: 20, color: "#94a3b8", fontWeight: "400" },

  checkoutDiscountBtn: {
    marginTop: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    backgroundColor: "#f8fafc",
    alignItems: "center",
  },
  checkoutDiscountBtnDisabled: { opacity: 0.4 },
  checkoutDiscountBtnText: { color: "#0f172a", fontSize: 15, fontWeight: "600" },
  checkoutDiscountHint: { color: "#94a3b8", fontSize: 12, marginTop: 4 },

  checkoutMethodGrid: { flexDirection: "row", gap: 8 },
  checkoutMethodBtn: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: "#e2e8f0",
    backgroundColor: "#f8fafc",
  },
  checkoutMethodIcon: { fontSize: 24, marginBottom: 6 },
  checkoutMethodLabel: { fontSize: 14, fontWeight: "700", color: "#64748b" },
  checkoutMethodLabelActive: { color: "#fff" },
  checkoutMethodSublabel: { fontSize: 11, color: "#94a3b8", marginTop: 2 },
  checkoutMethodSublabelActive: { color: "rgba(255,255,255,0.9)" },

  checkoutWarnPill: {
    marginTop: 12,
    backgroundColor: "#fef3c7",
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    alignSelf: "flex-start",
    borderWidth: 1,
    borderColor: "#fbbf24",
  },
  checkoutWarnText: { color: "#92400e", fontSize: 13 },
  checkoutErrorBox: {
    marginTop: 12,
    backgroundColor: "#fef2f2",
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: "#fca5a5",
  },
  checkoutErrorTitle: { color: "#dc2626", fontSize: 15, fontWeight: "700" },
  checkoutErrorMsg: { color: "#ef4444", fontSize: 13, marginTop: 4 },

  // Sticky footer
  checkoutFooter: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "#fff",
    borderTopWidth: 1,
    borderTopColor: "#e2e8f0",
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 28,
  },
  checkoutChargeBtn: {
    backgroundColor: "#2563eb",
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: "center",
    marginBottom: 10,
  },
  checkoutChargeBtnDisabled: { opacity: 0.4 },
  checkoutChargeBtnCash: { backgroundColor: "#16a34a" },
  checkoutChargeBtnQr: { backgroundColor: "#7c3aed" },
  checkoutChargeBtnText: { color: "#fff", fontSize: 18, fontWeight: "800" },

  checkoutFooterLinks: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 12,
  },
  checkoutFooterLink: { color: "#64748b", fontSize: 14, fontWeight: "500" },
  checkoutFooterDivider: { color: "#cbd5e1", fontSize: 14 },

  // modals
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    justifyContent: "flex-end",
  },
  modalSheet: {
    backgroundColor: "#fff",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 32,
  },
  modalHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: "#cbd5e1",
    alignSelf: "center",
    marginBottom: 16,
  },
  modalTitle: { fontSize: 20, fontWeight: "800", color: "#0f172a", marginBottom: 4 },
  modalSubtext: { fontSize: 12, color: "#64748b", marginBottom: 12 },
  modalSectionLabel: {
    fontSize: 12,
    fontWeight: "700",
    color: "#64748b",
    marginTop: 12,
    marginBottom: 8,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  modalSearchInput: {
    backgroundColor: "#f8fafc",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: "#0f172a",
    borderWidth: 1,
    borderColor: "#e2e8f0",
    marginBottom: 8,
  },
  modalItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: "#f1f5f9",
  },
  modalItemSelected: { backgroundColor: "#eff6ff" },
  modalItemLabel: { fontSize: 15, color: "#0f172a", flex: 1 },
  modalItemLabelSelected: { color: "#2563eb", fontWeight: "700" },
  modalItemSub: { fontSize: 12, color: "#64748b", marginTop: 2 },
  modalItemCheck: { fontSize: 18, color: "#2563eb", fontWeight: "800" },
  modalEmpty: { color: "#94a3b8", textAlign: "center", paddingVertical: 24 },

  modalActionRow: { flexDirection: "row", gap: 8, marginTop: 16 },
  modalPrimaryBtn: {
    flex: 1,
    backgroundColor: "#2563eb",
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
  },
  modalPrimaryBtnText: { color: "#fff", fontSize: 15, fontWeight: "800" },
  modalSecondaryBtn: {
    flex: 1,
    backgroundColor: "#f8fafc",
    borderWidth: 1,
    borderColor: "#e2e8f0",
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
  },
  modalSecondaryBtnText: { color: "#64748b", fontSize: 14, fontWeight: "700" },
  modalCloseBtn: { paddingVertical: 12, alignItems: "center", marginTop: 8 },
  modalCloseText: { color: "#94a3b8", fontSize: 13, fontWeight: "600" },

  // discount type toggle
  discountTypeRow: { flexDirection: "row", gap: 8 },
  discountTypeBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: "#e2e8f0",
    backgroundColor: "#f8fafc",
    alignItems: "center",
  },
  discountTypeBtnActive: { borderColor: "#2563eb", backgroundColor: "#eff6ff" },
  discountTypeText: { color: "#64748b", fontWeight: "700" },
  discountTypeTextActive: { color: "#2563eb" },
});
