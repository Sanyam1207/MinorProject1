// Course form sections: details, weekly timetable, attendance settings.
import { Plus, Trash2 } from "lucide-react";
import Field from "../../../ui/Field.jsx";
import { DAY_OPTIONS, SETTINGS_BOUNDS, SETTINGS_FIELDS, emptyTimetableRow } from "./courseForm.js";
import { Toggle } from "./parts.jsx";

const inputClass = "input-stark w-full text-base sm:text-xs";

export function DetailsFields({ form, setForm, errors = {}, disabled = false }) {
  const bind = (key) => ({
    value: form[key],
    disabled,
    onChange: (event) => setForm((current) => ({ ...current, [key]: event.target.value })),
    className: inputClass,
  });
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Code *" error={errors.code} hint="e.g. CS301">
        <input type="text" maxLength={20} placeholder="CS301" autoCapitalize="characters" {...bind("code")} />
      </Field>
      <Field label="Name *" error={errors.name}>
        <input type="text" maxLength={160} placeholder="Database Management Systems" {...bind("name")} />
      </Field>
      <Field label="Branch" error={errors.branch} hint="Used for auto-enrolment, e.g. CSE">
        <input type="text" maxLength={80} placeholder="CSE" {...bind("branch")} />
      </Field>
      <Field label="Department">
        <input type="text" maxLength={80} placeholder="Computer Science" {...bind("department")} />
      </Field>
      <Field label="Semester" error={errors.semester}>
        <input type="number" min={1} max={12} {...bind("semester")} />
      </Field>
      <Field label="Section" error={errors.section}>
        <input type="text" maxLength={10} placeholder="A" {...bind("section")} />
      </Field>
      <Field label="Passing year" hint="Batch, e.g. 2027">
        <input type="text" maxLength={10} placeholder="2027" {...bind("passingYear")} />
      </Field>
      <Field label="Academic year">
        <input type="text" maxLength={20} placeholder="2026-27" {...bind("academicYear")} />
      </Field>
      <Field label="Default room" className="sm:col-span-2">
        <input type="text" maxLength={60} placeholder="LT-2" {...bind("room")} />
      </Field>
    </div>
  );
}

export function TimetableEditor({ rows, onChange, errors = {}, disabled = false }) {
  const update = (index, key, value) => onChange(rows.map((row, i) => (i === index ? { ...row, [key]: value } : row)));
  const remove = (index) => onChange(rows.filter((_, i) => i !== index));
  return (
    <div className="space-y-2">
      {rows.length === 0 && (
        <p className="border-2 border-dashed border-gray-400 bg-gray-50 p-3 text-center text-[11px] font-semibold text-gray-600">
          No weekly slots. Add the days and times this course meets — classes are then created automatically and students are notified.
        </p>
      )}
      {rows.map((row, index) => (
        <div key={index} className="grid grid-cols-2 gap-2 border-2 border-black p-2 sm:grid-cols-[1.3fr_1fr_1fr_1fr_auto] sm:items-end">
          <Field label="Day">
            <select value={row.day} disabled={disabled} onChange={(event) => update(index, "day", Number(event.target.value))} className={inputClass}>
              {DAY_OPTIONS.map((day) => (
                <option key={day.value} value={day.value}>
                  {day.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Start (IST)" error={errors[`timetable.${index}.start`]}>
            <input type="time" value={row.start} disabled={disabled} onChange={(event) => update(index, "start", event.target.value)} className={inputClass} />
          </Field>
          <Field label="Minutes" error={errors[`timetable.${index}.durationMinutes`]}>
            <input
              type="number"
              min={15}
              max={300}
              step={5}
              value={row.durationMinutes}
              disabled={disabled}
              onChange={(event) => update(index, "durationMinutes", event.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="Room">
            <input type="text" maxLength={60} value={row.room} disabled={disabled} onChange={(event) => update(index, "room", event.target.value)} className={inputClass} />
          </Field>
          {!disabled && (
            <button type="button" onClick={() => remove(index)} aria-label="Remove slot" className="btn-secondary col-span-2 min-h-11 justify-center px-2 text-red-700 sm:col-span-1 sm:min-h-0 sm:py-2">
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="sm:sr-only">REMOVE</span>
            </button>
          )}
        </div>
      ))}
      {!disabled && (
        <button type="button" onClick={() => onChange([...rows, emptyTimetableRow()])} className="btn-secondary min-h-11 px-3 text-xs sm:min-h-0">
          <Plus className="h-3.5 w-3.5" aria-hidden="true" /> ADD WEEKLY SLOT
        </button>
      )}
    </div>
  );
}

export function SettingsFields({ settings, onChange, errors = {}, disabled = false }) {
  const set = (key, value) => onChange({ ...settings, [key]: value });
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {SETTINGS_FIELDS.map((field) => {
          const [min, max] = SETTINGS_BOUNDS[field.key];
          return (
            <Field key={field.key} label={field.label} hint={`${field.hint} (${min}–${max})`} error={errors[`settings.${field.key}`]}>
              <input
                type="number"
                min={min}
                max={max}
                value={settings[field.key]}
                disabled={disabled}
                onChange={(event) => set(field.key, event.target.value)}
                className={inputClass}
              />
            </Field>
          );
        })}
      </div>
      <Toggle
        checked={Boolean(settings.requireGeo)}
        disabled={disabled}
        onChange={(checked) => set("requireGeo", checked)}
        label="Check students' location"
        hint="Scans must come from within the geo radius of where you start the class (needs location on both phones)."
      />
    </div>
  );
}
