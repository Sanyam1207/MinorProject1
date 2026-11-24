import { useState } from "react";
import { LoaderCircle, Save } from "lucide-react";
import { createCourseWithMeta } from "../../../lib/api/attendance.js";
import { toastSuccess } from "../../../ui/toast.js";
import { courseToForm, formToPayload, validateCourseForm } from "./courseForm.js";
import { DetailsFields, SettingsFields, TimetableEditor } from "./CourseFormFields.jsx";
import { teacherError } from "./errors.js";
import { Toggle } from "./parts.jsx";

function Section({ title, children, hint }) {
  return (
    <section className="space-y-2">
      <div className="border-b-2 border-black pb-1">
        <h4 className="text-xs font-black uppercase">{title}</h4>
        {hint && <p className="text-[10px] font-semibold text-gray-500">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

/** CREATE COURSE form → POST /courses (+ auto-enrol, timetable materialised server-side). */
export default function CourseCreate({ onCreated, onCancel }) {
  const [form, setForm] = useState(() => courseToForm());
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState(null);

  const submit = async (event) => {
    event.preventDefault();
    const found = validateCourseForm(form);
    setErrors(found);
    setServerError(null);
    if (Object.keys(found).length) return;
    setBusy(true);
    try {
      const result = await createCourseWithMeta(formToPayload(form, { create: true }));
      const parts = [`${result.course?.code ?? "Course"} created`];
      if (form.autoEnroll) parts.push(`${result.added} student${result.added === 1 ? "" : "s"} enrolled`);
      if (result.generated) parts.push(`${result.generated} class${result.generated === 1 ? "" : "es"} scheduled`);
      toastSuccess(parts.join(" · "));
      onCreated(result.course);
    } catch (error) {
      setServerError(error);
      const field = error?.details?.field;
      if (field) setErrors((current) => ({ ...current, [field.startsWith("timetable") ? "timetable" : field]: teacherError(error) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-5" noValidate>
      <Section title="Course details">
        <DetailsFields form={form} setForm={setForm} errors={errors} />
      </Section>
      <Section title="Weekly timetable" hint="Optional. Classes are generated for the next days and students get one digest notification.">
        <TimetableEditor rows={form.timetable} onChange={(timetable) => setForm((current) => ({ ...current, timetable }))} errors={errors} />
        {errors.timetable && <p className="text-[10px] font-bold text-red-700">{errors.timetable}</p>}
      </Section>
      <Section title="Attendance settings">
        <SettingsFields settings={form.settings} onChange={(settings) => setForm((current) => ({ ...current, settings }))} errors={errors} />
      </Section>
      <Section title="Students" hint="You can also add students by email or share the join code after creating the course.">
        <Toggle
          checked={form.autoEnroll}
          onChange={(autoEnroll) => setForm((current) => ({ ...current, autoEnroll }))}
          label="Auto-enroll matching students"
          hint="Adds every student whose branch (and section / passing year / semester, when set) matches this course."
        />
      </Section>
      {serverError && (
        <p role="alert" className="border-2 border-black bg-red-50 p-2 text-xs font-bold text-red-800">
          {teacherError(serverError, "Couldn't create the course")}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2 border-t-2 border-black pt-3">
        <button type="button" onClick={onCancel} disabled={busy} className="btn-secondary min-h-11 px-3 text-xs sm:min-h-0">
          CANCEL
        </button>
        <button type="submit" disabled={busy} className="btn-primary min-h-11 px-3 text-xs disabled:opacity-60 sm:min-h-0">
          {busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Save className="h-3.5 w-3.5" aria-hidden="true" />}
          CREATE COURSE
        </button>
      </div>
    </form>
  );
}
