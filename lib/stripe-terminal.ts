import { fetchConnectionToken } from "./api";

let _currentStoreId: string | null = null;

export function setCurrentStoreId(storeId: string) {
  _currentStoreId = storeId;
}

export async function tokenProvider(): Promise<string> {
  if (!_currentStoreId) {
    throw new Error("Store ID not set for connection token");
  }
  return fetchConnectionToken(_currentStoreId);
}
