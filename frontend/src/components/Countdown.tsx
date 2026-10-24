import { useEffect, useRef, useState } from 'react';
import { formatCountdown } from '../lib/format';

type Props = {
  /** expiresInSeconds from the server response. */
  seconds: number;
  /** Date.now() when that response arrived. */
  receivedAt: number;
  /** Called once when the local countdown reaches zero (to re-check with the server). */
  onElapsed: () => void;
};

/**
 * Counts down from the server's `expiresInSeconds`, measured from when the
 * response arrived, so the device clock's absolute time never matters. It is a
 * display aid only; the server decides when the reservation has expired.
 */
export function Countdown({ seconds, receivedAt, onElapsed }: Props) {
  const [now, setNow] = useState(() => Date.now());
  const firedFor = useRef<number | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  const remaining = Math.max(0, seconds - Math.floor((now - receivedAt) / 1_000));

  useEffect(() => {
    if (remaining === 0 && firedFor.current !== receivedAt) {
      firedFor.current = receivedAt;
      onElapsed();
    }
  }, [remaining, receivedAt, onElapsed]);

  return remaining > 0 ? (
    <p className="countdown">
      Reserved for <strong className="countdown__time">{formatCountdown(remaining)}</strong>
    </p>
  ) : (
    <p className="countdown">Reservation time is up – checking with the server…</p>
  );
}
