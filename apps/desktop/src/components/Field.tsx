import { useId, useState } from "react";

interface FieldProps {
  autoComplete?: string;
  label: string;
  name?: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  onFocus?: () => void;
  placeholder?: string;
  revealable?: boolean;
  spellCheck?: boolean;
  type?: string;
  value: string;
}

export function Field({
  autoComplete,
  label,
  name,
  onChange,
  onBlur,
  onFocus,
  placeholder,
  revealable,
  spellCheck,
  type = "text",
  value,
}: FieldProps) {
  const id = useId();
  const fieldName = name || label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const resolvedAutoComplete = autoComplete || "off";
  const [revealed, setRevealed] = useState(false);
  const isMaskable = Boolean(revealable) && type === "password";
  const effectiveType = isMaskable && revealed ? "text" : type;
  const resolvedSpellCheck = spellCheck ?? (effectiveType === "password" ? false : undefined);
  const input = (
    <input
      autoComplete={resolvedAutoComplete}
      id={id}
      name={fieldName}
      spellCheck={resolvedSpellCheck}
      type={effectiveType}
      value={value}
      onBlur={onBlur}
      onChange={(event) => onChange(event.target.value)}
      onFocus={onFocus}
      placeholder={placeholder}
    />
  );
  return (
    <label className="field" htmlFor={id}>
      <span>{label}</span>
      {isMaskable ? (
        <div className="field-input-row">
          {input}
          <button
            type="button"
            className="field-reveal-btn"
            onClick={() => setRevealed((current) => !current)}
            aria-label={revealed ? "Hide value" : "Show value"}
          >
            {revealed ? "Hide" : "Show"}
          </button>
        </div>
      ) : (
        input
      )}
    </label>
  );
}
