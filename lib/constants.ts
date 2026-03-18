export const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL || "https://stella-admin.vercel.app";

export const CLERK_PUBLISHABLE_KEY = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY || "";

// Worst-case Stripe Terminal card-present rates (non-domestic card + Tap to Pay surcharge).
// Source: stripe.com/{country}/pricing — verified Mar 2026.
// Must stay in sync with TERMINAL_FEE_RATES in stella-admin stripe-terminal-v4.tsx
export const TERMINAL_FEE_RATES: Record<string, { percent: number; fixed: number }> = {
  GB: { percent: 0.029, fixed: 0.20 },
  AU: { percent: 0.017, fixed: 0.25 },
  US: { percent: 0.027, fixed: 0.10 },
  IE: { percent: 0.029, fixed: 0.20 },
  ES: { percent: 0.029, fixed: 0.20 },
  FR: { percent: 0.029, fixed: 0.20 },
  DE: { percent: 0.029, fixed: 0.20 },
  IT: { percent: 0.029, fixed: 0.20 },
  BE: { percent: 0.029, fixed: 0.20 },
  NL: { percent: 0.029, fixed: 0.20 },
  SE: { percent: 0.029, fixed: 0.20 },
  GR: { percent: 0.029, fixed: 0.20 },
  CA: { percent: 0.027, fixed: 0.10 },
  CH: { percent: 0.029, fixed: 0.20 },
};

export function calcServiceFee(subtotal: number, countryCode: string): number {
  const rate = TERMINAL_FEE_RATES[countryCode] ?? TERMINAL_FEE_RATES.GB;
  const chargeAmount = (subtotal + rate.fixed) / (1 - rate.percent);
  return Math.round((chargeAmount - subtotal) * 100) / 100;
}

export function currencySymbol(countryCode: string): string {
  switch (countryCode) {
    case "AU": return "A$";
    case "US": return "$";
    case "CA": return "C$";
    case "CH": return "CHF ";
    case "SE": return "kr ";
    default: return "£";
  }
}
