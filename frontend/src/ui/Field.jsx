/** Label + control (+ hint / error). Wrap a single input/select/textarea. */
export default function Field({ label, hint, error, children, className = "" }) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1 block text-xs font-extrabold uppercase">{label}</span>
      {children}
      {hint && !error && <span className="mt-1 block text-[10px] font-semibold text-gray-500">{hint}</span>}
      {error && (
        <span role="alert" className="mt-1 block text-[10px] font-bold text-red-700">
          {error}
        </span>
      )}
    </label>
  );
}
