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

  // `now` only advances on the 1 s tick, so right after a fresh response it can
  // be slightly older than `receivedAt`; clamp so the display never adds time.
  const elapsedSeconds = Math.floor(Math.max(0, now - receivedAt) / 1_000);
  const remaining = Math.max(0, seconds - elapsedSeconds);

  // Re-check only when this countdown actually ran down from a positive value.
  // If the server itself reports 0 seconds (its last instant before marking the
  // order expired), re-fetching at once would just repeat; the regular status
  // poll picks up the authoritative result instead.
  useEffect(() => {
    if (seconds > 0 && remaining === 0 && firedFor.current !== receivedAt) {
      firedFor.current = receivedAt;
      onElapsed();
    }
  }, [seconds, remaining, receivedAt, onElapsed]);

  return remaining > 0 ? (
    <p className="countdown">
      Reserved for <strong className="countdown__time">{formatCountdown(remaining)}</strong>
    </p>
  ) : (
    <p className="countdown">Reservation time is up – checking with the server…</p>
  );
}
