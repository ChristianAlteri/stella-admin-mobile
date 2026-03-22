export type Reader = { id: string; serialNumber: string; locationId?: string };
export type PaymentIntent = {
  id: string;
  status: string;
  client_secret: string;
};

export function useStripeTerminal() {
  return {
    discoverReaders: async (_opts: any) => ({ readers: [] as Reader[] }),
    connectLocalMobileReader: async (_opts: any) => ({ reader: null }),
    retrievePaymentIntent: async (_secret: string) => ({ paymentIntent: null as PaymentIntent | null }),
    collectPaymentMethod: async (_opts: any) => ({ paymentIntent: null as PaymentIntent | null }),
    confirmPaymentIntent: async (_opts: any) => ({ paymentIntent: null as PaymentIntent | null }),
    connectedReader: null as Reader | null,
  };
}
