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
    console.log(`[API] ${config.method?.toUpperCase()} ${config.url} | token: ${token ? token.substring(0, 20) + "..." : "NONE"}`);
  } else {
    console.log(`[API] ${config.method?.toUpperCase()} ${config.url} | NO TOKEN GETTER SET`);
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

// ---- Store endpoints ----

export async function fetchUserStores(): Promise<any[]> {
  const { data } = await api.get("/api/stores");
  return data;
}

// ---- POS endpoints ----

export async function searchProducts(storeId: string, params: {
  q?: string;
  sellerId?: string;
  designerId?: string;
  categoryId?: string;
  limit?: number;
}) {
  const { data } = await api.get(`/api/${storeId}/products/point-of-sale`, { params });
  return data.products as any[];
}

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

// ---- Stripe endpoints ----

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

export default api;
