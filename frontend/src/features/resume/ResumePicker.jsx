import { kindLabel } from "./labUtils.js";

/**
 * Stark resume <select>. `resumes` are normalized ResumeSummary objects.
 * `filter(resume)` hides options; `placeholder` adds an empty first option.
 */
export default function ResumePicker({
  resumes = [],
  value,
  onChange,
  label = "Resume",
  placeholder = "Choose a resume",
  filter,
  disabled = false,
  className = "",
}) {
  const options = filter ? resumes.filter(filter) : resumes;
  const missing = value && !options.some((resume) => resume.id === value);
  return (
    <label className={`block min-w-0 ${className}`}>
      <span className="mb-1 block text-[10px] font-black uppercase tracking-wide">{label}</span>
      <select
        value={value || ""}
        onChange={(event) => onChange?.(event.target.value || null)}
        disabled={disabled}
        className="input-stark w-full min-w-0 truncate text-base sm:text-xs disabled:opacity-50"
      >
        <option value="">{options.length ? placeholder : "No resumes yet"}</option>
        {missing && <option value={value}>Selected resume</option>}
        {options.map((resume) => (
          <option key={resume.id} value={resume.id}>
            {resume.title} · {kindLabel(resume.kind)}
            {resume.isPrimary ? " · PRIMARY" : ""}
            {resume.locked ? " · LOCKED" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}
