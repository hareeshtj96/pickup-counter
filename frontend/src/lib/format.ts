const rupeeGrouping = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

/**
 * Formats integer paise as Indian rupees, e.g. 123456 -> "₹1,234.56".
 * Uses integer arithmetic only; money is never turned into a float.
 */
export function formatPaise(paise: number): string {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  const fraction = abs % 100;
  const rupees = (abs - fraction) / 100;
  return `${sign}₹${rupeeGrouping.format(rupees)}.${String(fraction).padStart(2, '0')}`;
}

/** 125 -> "2:05". */
export function formatCountdown(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}
