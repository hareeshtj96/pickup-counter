import { useId } from 'react';

type Props = {
  productName: string;
  value: number;
  max: number;
  disabled?: boolean;
  onChange: (value: number) => void;
};

/** − [n] + control, clamped to 0..max. The backend still validates every order. */
export function QuantityStepper({ productName, value, max, disabled = false, onChange }: Props) {
  const inputId = useId();
  const set = (next: number) => onChange(Math.min(Math.max(Number.isFinite(next) ? Math.trunc(next) : 0, 0), max));

  return (
    <div className="stepper">
      <label htmlFor={inputId} className="visually-hidden">
        Quantity of {productName}
      </label>
      <button
        type="button"
        className="stepper__button"
        aria-label={`Decrease ${productName}`}
        onClick={() => set(value - 1)}
        disabled={disabled || value <= 0}
      >
        −
      </button>
      <input
        id={inputId}
        className="stepper__input"
        type="number"
        inputMode="numeric"
        min={0}
        max={max}
        step={1}
        value={value}
        disabled={disabled}
        onChange={(event) => set(event.target.value === '' ? 0 : Number(event.target.value))}
      />
      <button
        type="button"
        className="stepper__button"
        aria-label={`Increase ${productName}`}
        onClick={() => set(value + 1)}
        disabled={disabled || value >= max}
      >
        +
      </button>
    </div>
  );
}
