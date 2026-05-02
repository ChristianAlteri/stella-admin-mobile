import axios from "axios";
import { API_BASE_URL } from "./constants";

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: { "ngrok-skip-browser-warning": "1" },
});

let _getToken: (() => Promise<string | null>) | null = null;

export function setTokenGetter(fn: () => Promise<string | null>) {
  _getToken = fn;
}

api.interceptors.request.use(async (config) => {
  if (_getToken) {
    const token = await _getToken();
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
  }
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response) {
      console.log(`[API ERROR] ${err.response.status} ${err.config?.url}`, JSON.stringify(err.response.data).substring(0, 300));
    }
    return Promise.reject(err);
  }
);

// ---- Stores ----

export async function fetchUserStores(): Promise<any[]> {
  const { data } = await api.get("/api/stores");
  return data;
}

// ---- POS Tiles ----

export interface PosTile {
  id: string;
  type: "designer" | "category" | "seller" | "productGroup";
  referenceId: string;
  label: string;
  position: number;
  imageUrl: string | null;
}

export async function fetchPosTiles(storeId: string): Promise<PosTile[]> {
  try {
    const { data } = await api.get(`/api/${storeId}/pos-tiles`);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

// ---- Products ----

export interface ProductSearchParams {
  q?: string;
  sellerId?: string;
  designerId?: string;
  categoryId?: string;
  productGroupId?: string;
  cursor?: string;
  limit?: number;
}

export async function searchProducts(storeId: string, params: ProductSearchParams) {
  const { data } = await api.get(`/api/${storeId}/products/point-of-sale`, { params });
  return {
    products: (data.products ?? []) as any[],
    nextCursor: (data.nextCursor ?? null) as string | null,
  };
}

export async function fetchProduct(storeId: string, productId: string) {
  const { data } = await api.get(`/api/${storeId}/products/${productId}`);
  return data;
}

export async function quickAddProduct(storeId: string, payload: {
  name: string;
  ourPrice: number;
  sellerId?: string;
}) {
  const { data } = await api.post(`/api/${storeId}/products/quick-add`, {
    ...payload,
    isMasterAdmin: false,
  });
  return data;
}

export async function patchProductDiscount(storeId: string, productId: string, payload: {
  discountType: "PERCENT" | "CUSTOM_PRICE";
  discountValue: number;
}) {
  const { data } = await api.patch(`/api/${storeId}/products/${productId}/discounts`, payload);
  return data;
}

// ---- Sellers / Staff / Designers / Categories / Customers ----

export async function fetchSellers(storeId: string) {
  const { data } = await api.get(`/api/${storeId}/sellers`);
  return data as any[];
}

export async function fetchStaff(storeId: string) {
  const { data } = await api.get(`/api/${storeId}/staff`);
  return data as any[];
}

export async function fetchDesigners(storeId: string) {
  const { data } = await api.get(`/api/${storeId}/designers`);
  return data as any[];
}

export async function fetchCategories(storeId: string) {
  const { data } = await api.get(`/api/${storeId}/categories`);
  return data as any[];
}

export async function fetchUsers(storeId: string) {
  const { data } = await api.get(`/api/master-admin/users`, {
    params: { storeId },
  });
  return data as any[];
}

export async function createUser(payload: { name: string; email: string; storeId: string }) {
  const { data } = await api.post(`/api/master-admin/users`, payload);
  return data;
}

// ---- Stripe / Payments ----

export async function fetchConnectionToken(storeId: string): Promise<string> {
  const { data } = await api.get(`/api/${storeId}/stripe/connection_token`);
  return data.secret;
}

export async function createPaymentIntent(storeId: string, payload: {
  amount: number;
  products: { id: string; quantity: number }[];
  soldByStaffId?: string;
  userId?: string;
  isCash?: boolean;
}) {
  const { data } = await api.post(`/api/${storeId}/stripe/create_payment_intent`, {
    ...payload,
    storeId,
  });
  return data;
}

export async function verifyInStorePayment(metadata: Record<string, string>, paymentIntentId?: string) {
  const { data } = await api.post(`/api/master-admin/payments/verify-in-store-payment`, {
    metadata,
    paymentIntentId,
  });
  return data;
}

// ---- QR Checkout (alternative to Tap to Pay) ----

export async function createQrCheckout(storeId: string, payload: {
  products: { id: string; quantity: number }[];
  soldByStaffId: string;
  userId?: string;
  serviceFee?: number;
}) {
  const { data } = await api.post(`/api/${storeId}/stripe/create_checkout_qr`, {
    ...payload,
    storeId,
  });
  return data as { checkoutUrl: string; sessionId: string };
}

export async function fetchQrCheckoutStatus(storeId: string, sessionId: string) {
  const { data } = await api.get(`/api/${storeId}/stripe/checkout_qr_status`, {
    params: { sessionId },
  });
  return data as { status?: string; paymentStatus?: string };
}

export default api;
