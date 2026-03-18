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
  store?: { id: string; name: string; countryCode?: string; passStripeFeeToCustomer?: boolean } | null;
}

export interface CartItem extends POSProduct {
  cartQuantity: number;
  discountType?: "PERCENT" | "CUSTOM_PRICE";
  discountValue?: number;
}

interface POSState {
  cart: CartItem[];
  isCash: boolean;
  selectedStaffId: string;
  selectedStaffName: string;
  selectedUserId: string;
  countryCode: string;
  passStripeFeeToCustomer: boolean;

  // computed
  subtotal: number;
  serviceFee: number;
  total: number;

  // actions
  addToCart: (product: POSProduct) => void;
  removeFromCart: (productId: string) => void;
  updateQuantity: (productId: string, delta: number) => void;
  setItemDiscount: (productId: string, type: "PERCENT" | "CUSTOM_PRICE", value: number) => void;
  clearItemDiscount: (productId: string) => void;
  setIsCash: (v: boolean) => void;
  setStaff: (id: string, name: string) => void;
  setUser: (id: string) => void;
  setStoreConfig: (countryCode: string, passStripeFeeToCustomer: boolean) => void;
  clearCart: () => void;
}

function calcSubtotal(items: CartItem[]): number {
  return items.reduce((acc, item) => {
    const base = item.ourPrice;
    let unit = base;
    if (item.discountType === "PERCENT" && item.discountValue != null) {
      unit = base - base * (item.discountValue / 100);
    } else if (item.discountType === "CUSTOM_PRICE" && item.discountValue != null) {
      unit = Math.max(0.01, item.discountValue);
    }
    return acc + unit * item.cartQuantity;
  }, 0);
}

function recalc(state: Pick<POSState, "cart" | "isCash" | "countryCode" | "passStripeFeeToCustomer">) {
  const subtotal = Math.max(0, calcSubtotal(state.cart));
  const serviceFee =
    state.passStripeFeeToCustomer && !state.isCash && subtotal > 0
      ? calcServiceFee(subtotal, state.countryCode)
      : 0;
  const total = Math.round((subtotal + serviceFee) * 100) / 100;
  return { subtotal, serviceFee, total };
}

export const usePOS = create<POSState>((set, get) => ({
  cart: [],
  isCash: false,
  selectedStaffId: "",
  selectedStaffName: "",
  selectedUserId: "",
  countryCode: "GB",
  passStripeFeeToCustomer: true,
  subtotal: 0,
  serviceFee: 0,
  total: 0,

  addToCart: (product) => {
    const state = get();
    const exists = state.cart.find((i) => i.id === product.id);
    const cart = exists
      ? state.cart.map((i) =>
          i.id === product.id ? { ...i, cartQuantity: i.cartQuantity + 1 } : i
        )
      : [...state.cart, { ...product, cartQuantity: 1 }];
    set({ cart, ...recalc({ ...state, cart }) });
  },

  removeFromCart: (productId) => {
    const state = get();
    const cart = state.cart.filter((i) => i.id !== productId);
    set({ cart, ...recalc({ ...state, cart }) });
  },

  updateQuantity: (productId, delta) => {
    const state = get();
    const cart = state.cart
      .map((i) => {
        if (i.id !== productId) return i;
        const next = i.cartQuantity + delta;
        return next > 0 ? { ...i, cartQuantity: Math.min(next, i.quantity) } : null;
      })
      .filter(Boolean) as CartItem[];
    set({ cart, ...recalc({ ...state, cart }) });
  },

  setItemDiscount: (productId, type, value) => {
    const state = get();
    const cart = state.cart.map((i) =>
      i.id === productId ? { ...i, discountType: type, discountValue: value } : i
    );
    set({ cart, ...recalc({ ...state, cart }) });
  },

  clearItemDiscount: (productId) => {
    const state = get();
    const cart = state.cart.map((i) =>
      i.id === productId ? { ...i, discountType: undefined, discountValue: undefined } : i
    );
    set({ cart, ...recalc({ ...state, cart }) });
  },

  setIsCash: (v) => {
    const state = get();
    set({ isCash: v, ...recalc({ ...state, isCash: v }) });
  },

  setStaff: (id, name) => set({ selectedStaffId: id, selectedStaffName: name }),
  setUser: (id) => set({ selectedUserId: id }),

  setStoreConfig: (countryCode, passStripeFeeToCustomer) => {
    const state = get();
    set({
      countryCode,
      passStripeFeeToCustomer,
      ...recalc({ ...state, countryCode, passStripeFeeToCustomer }),
    });
  },

  clearCart: () =>
    set({
      cart: [],
      subtotal: 0,
      serviceFee: 0,
      total: 0,
      selectedStaffId: "",
      selectedStaffName: "",
      selectedUserId: "",
      isCash: false,
    }),
}));
