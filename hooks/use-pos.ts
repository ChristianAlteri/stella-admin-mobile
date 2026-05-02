import { create } from "zustand";
import { calcServiceFee } from "@/lib/constants";

export interface POSProduct {
  id: string;
  name: string;
  ourPrice: number;
  retailPrice?: number | null;
  quantity: number;
  images: { url: string }[];
  seller?: { id: string; storeName?: string; stripe_connect_unique_id?: string } | null;
  designer?: { id: string; name: string } | null;
  category?: { id: string; name: string } | null;
  size?: { name: string } | null;
  color?: { name: string } | null;
  store?: { id: string; name: string; countryCode?: string; passStripeFeeToCustomer?: boolean; stripe_connect_unique_id?: string } | null;
}

export interface CartItem extends POSProduct {
  cartQuantity: number;
  discountType?: "PERCENT" | "CUSTOM_PRICE";
  discountValue?: number;
}

export type DiscountType = "PERCENT" | "CUSTOM_PRICE";

export interface OrderDiscount {
  type?: DiscountType;
  value?: number;
}

interface POSState {
  cart: CartItem[];
  isCash: boolean;
  isQr: boolean;
  selectedStaffId: string;
  selectedStaffName: string;
  selectedUserId: string;
  selectedUserLabel: string;
  countryCode: string;
  passStripeFeeToCustomer: boolean;
  orderDiscount: OrderDiscount;
  hasAppliedDiscounts: boolean;

  subtotal: number;
  discountSavings: number;
  serviceFee: number;
  total: number;

  addToCart: (product: POSProduct) => void;
  removeFromCart: (productId: string) => void;
  updateQuantity: (productId: string, delta: number) => void;
  setItemDiscount: (productId: string, type: DiscountType, value: number) => void;
  clearItemDiscount: (productId: string) => void;
  setOrderDiscount: (discount: OrderDiscount) => void;
  clearOrderDiscount: () => void;
  markDiscountsApplied: () => void;
  replaceCart: (items: CartItem[]) => void;
  setIsCash: (v: boolean) => void;
  setIsQr: (v: boolean) => void;
  setStaff: (id: string, name: string) => void;
  setUser: (id: string, label: string) => void;
  setStoreConfig: (countryCode: string, passStripeFeeToCustomer: boolean) => void;
  clearCart: () => void;
}

function unitPriceFor(item: CartItem, orderDiscount: OrderDiscount): number {
  const base = Number(item.ourPrice) || 0;
  let unit = base;
  if (item.discountType === "PERCENT" && item.discountValue != null) {
    unit = base - base * (item.discountValue / 100);
  } else if (item.discountType === "CUSTOM_PRICE" && item.discountValue != null) {
    unit = Math.max(0.01, item.discountValue);
  }
  return unit;
}

function calcTotals(state: Pick<POSState, "cart" | "isCash" | "isQr" | "countryCode" | "passStripeFeeToCustomer" | "orderDiscount">) {
  const lineTotals = state.cart.reduce(
    (acc, item) => {
      const unit = unitPriceFor(item, state.orderDiscount);
      const qty = item.cartQuantity;
      const base = (Number(item.ourPrice) || 0) * qty;
      const lineNet = unit * qty;
      acc.gross += base;
      acc.net += lineNet;
      return acc;
    },
    { gross: 0, net: 0 }
  );

  let subtotalAfterOrderDiscount = lineTotals.net;
  const od = state.orderDiscount;
  if (od?.type === "PERCENT" && od.value != null) {
    subtotalAfterOrderDiscount = lineTotals.net - lineTotals.net * (od.value / 100);
  } else if (od?.type === "CUSTOM_PRICE" && od.value != null) {
    subtotalAfterOrderDiscount = Math.max(0.01, od.value);
  }

  const subtotal = Math.max(0, subtotalAfterOrderDiscount);
  const discountSavings = Math.max(0, lineTotals.gross - subtotal);

  const isCardPayment = !state.isCash;
  const serviceFee =
    state.passStripeFeeToCustomer && isCardPayment && subtotal > 0
      ? calcServiceFee(subtotal, state.countryCode)
      : 0;

  const total = Math.round((subtotal + serviceFee) * 100) / 100;
  return { subtotal, discountSavings, serviceFee, total };
}

function commit(set: any, get: any, patch: Partial<POSState>) {
  const next = { ...get(), ...patch };
  set({ ...patch, ...calcTotals(next) });
}

export const usePOS = create<POSState>((set, get) => ({
  cart: [],
  isCash: false,
  isQr: false,
  selectedStaffId: "",
  selectedStaffName: "",
  selectedUserId: "",
  selectedUserLabel: "",
  countryCode: "GB",
  passStripeFeeToCustomer: true,
  orderDiscount: {},
  hasAppliedDiscounts: false,
  subtotal: 0,
  discountSavings: 0,
  serviceFee: 0,
  total: 0,

  addToCart: (product) => {
    const state = get();
    const exists = state.cart.find((i) => i.id === product.id);
    const cart = exists
      ? state.cart.map((i) =>
          i.id === product.id
            ? { ...i, cartQuantity: Math.min(i.cartQuantity + 1, i.quantity || 999) }
            : i
        )
      : [...state.cart, { ...product, cartQuantity: 1 }];
    commit(set, get, { cart });
  },

  removeFromCart: (productId) => {
    const cart = get().cart.filter((i) => i.id !== productId);
    commit(set, get, { cart });
  },

  updateQuantity: (productId, delta) => {
    const cart = get()
      .cart.map((i) => {
        if (i.id !== productId) return i;
        const next = i.cartQuantity + delta;
        if (next <= 0) return null;
        const max = i.quantity || 999;
        return { ...i, cartQuantity: Math.min(next, max) };
      })
      .filter(Boolean) as CartItem[];
    commit(set, get, { cart });
  },

  setItemDiscount: (productId, type, value) => {
    const cart = get().cart.map((i) =>
      i.id === productId ? { ...i, discountType: type, discountValue: value } : i
    );
    commit(set, get, { cart });
  },

  clearItemDiscount: (productId) => {
    const cart = get().cart.map((i) =>
      i.id === productId ? { ...i, discountType: undefined, discountValue: undefined } : i
    );
    commit(set, get, { cart });
  },

  setOrderDiscount: (discount) => {
    commit(set, get, { orderDiscount: discount });
  },

  clearOrderDiscount: () => {
    commit(set, get, { orderDiscount: {} });
  },

  markDiscountsApplied: () => set({ hasAppliedDiscounts: true }),

  replaceCart: (items) => {
    commit(set, get, { cart: items });
  },

  setIsCash: (v) => {
    commit(set, get, { isCash: v, isQr: v ? false : get().isQr });
  },

  setIsQr: (v) => {
    commit(set, get, { isQr: v, isCash: v ? false : get().isCash });
  },

  setStaff: (id, name) => set({ selectedStaffId: id, selectedStaffName: name }),
  setUser: (id, label) => set({ selectedUserId: id, selectedUserLabel: label }),

  setStoreConfig: (countryCode, passStripeFeeToCustomer) => {
    commit(set, get, { countryCode, passStripeFeeToCustomer });
  },

  clearCart: () =>
    set({
      cart: [],
      subtotal: 0,
      discountSavings: 0,
      serviceFee: 0,
      total: 0,
      selectedStaffId: "",
      selectedStaffName: "",
      selectedUserId: "",
      selectedUserLabel: "",
      isCash: false,
      isQr: false,
      orderDiscount: {},
      hasAppliedDiscounts: false,
    }),
}));
