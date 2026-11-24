import { useState } from "react";
import { GraduationCap, KeyRound, Link2, LoaderCircle, Plus, Save, Trash2 } from "lucide-react";
import GgsipuConnect from "./GgsipuConnect.jsx";
import { updateMe } from "../lib/api/auth.js";
import Modal from "../ui/Modal.jsx";
import Tabs from "../ui/Tabs.jsx";
import { toastError, toastSuccess } from "../ui/toast.js";

const STUDENT_TABS = ["General", "Skills", "Projects", "Certifications", "Experience"];
const HEADINGS = {
  student: "EDIT STUDENT PROFILE",
  teacher: "EDIT FACULTY PROFILE",
  tpo: "EDIT TPO PROFILE",
  admin: "EDIT ADMIN PROFILE",
  company: "EDIT RECRUITER PROFILE",
  alumni: "EDIT PROFILE",
};

const inputClass = "input-stark w-full text-base font-bold sm:text-xs";
const readOnlyClass = "input-stark w-full bg-gray-100 font-mono text-base sm:text-xs";
const asText = (value) => (value === null || value === undefined ? "" : String(value));
const splitList = (value) =>
  String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

function LabeledInput({ label, children, hint }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-extrabold uppercase">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[10px] font-semibold text-gray-500">{hint}</span>}
    </label>
  );
}

function ReadOnlyField({ label, value, hint }) {
  return (
    <LabeledInput label={label} hint={hint}>
      <input type="text" readOnly value={value || "Not set"} className={readOnlyClass} />
    </LabeledInput>
  );
}

/**
 * Role-aware profile editor (FRONTEND.md §6.5, AUTH-FACULTY.md §6/§14.8).
 * Only fields the server accepts for the role are sent; academic records
 * (roll number, section, semester, employee id) are shown read-only.
 */
export default function ProfileModal({ user, onClose, onProfileUpdated, initialTab, onChangePassword }) {
  const role = user?.role || "student";
  const isStudent = role === "student";
  const isTeacher = role === "teacher";
  const showDesignation = ["teacher", "tpo", "admin", "company"].includes(role);
  const academicLocked = isStudent && Boolean(user?.ggsipuLinked);

  const [activeTab, setActiveTab] = useState(
    isStudent ? STUDENT_TABS.find((tab) => tab.toLowerCase() === String(initialTab || "").toLowerCase()) ?? "General" : "General",
  );
  const [name, setName] = useState(asText(user?.name));
  const [designation, setDesignation] = useState(asText(user?.designation));
  const [department, setDepartment] = useState(asText(user?.department));
  const [branch, setBranch] = useState(asText(user?.branch));
  const [collegeName, setCollegeName] = useState(asText(user?.collegeName));
  const [passingYear, setPassingYear] = useState(asText(user?.passingYear));
  const [cgpa, setCgpa] = useState(asText(user?.cgpa));
  const [skills, setSkills] = useState((user?.skills || []).join(", "));
  const [projects, setProjects] = useState(() =>
    (user?.projects || []).map((project) => ({
      ...project,
      skills: Array.isArray(project.skills) ? project.skills.join(", ") : project.skills || "",
    })),
  );
  const [certifications, setCertifications] = useState(() => (user?.certifications || []).map((item) => ({ ...item })));
  const [experience, setExperience] = useState(() => (user?.experience || []).map((item) => ({ ...item })));
  const [socialLinks, setSocialLinks] = useState({
    github: user?.socialLinks?.github || "",
    linkedin: user?.socialLinks?.linkedin || "",
  });
  const [ggsipuLinked, setGgsipuLinked] = useState(Boolean(user?.ggsipuLinked));
  const [showGgsipu, setShowGgsipu] = useState(false);
  const [saving, setSaving] = useState(false);

  const updateItem = (setter, index, field, value) =>
    setter((items) => items.map((item, itemIndex) => (itemIndex === index ? { ...item, [field]: value } : item)));
  const removeItem = (setter, index) => setter((items) => items.filter((_, itemIndex) => itemIndex !== index));

  const buildPatch = () => {
    const patch = {};
    if (name.trim() && !academicLocked) patch.name = name.trim();
    if (showDesignation && designation.trim() !== asText(user?.designation).trim()) patch.designation = designation.trim();
    if (isTeacher && department.trim() !== asText(user?.department).trim()) patch.department = department.trim();
    if (isStudent) {
      Object.assign(patch, {
        collegeName: collegeName.trim(),
        skills: splitList(skills),
        projects: projects
          .filter((project) => project.title?.trim())
          .map((project) => ({
            title: project.title.trim(),
            description: project.description || "",
            link: project.link || "",
            skills: splitList(project.skills),
          })),
        certifications: certifications
          .filter((item) => item.name?.trim())
          .map((item) => ({
            name: item.name.trim(),
            issuer: item.issuer || "",
            date: item.date || "",
            credentialUrl: item.credentialUrl || "",
          })),
        experience: experience
          .filter((item) => item.title?.trim())
          .map((item) => ({
            title: item.title.trim(),
            company: item.company || "",
            duration: item.duration || "",
            description: item.description || "",
          })),
        socialLinks: { ...(user?.socialLinks || {}), github: socialLinks.github.trim(), linkedin: socialLinks.linkedin.trim() },
      });
      if (/^20\d{2}$/.test(passingYear.trim())) patch.passingYear = passingYear.trim();
      // Synced from GGSIPU when linked: never sent (the server would ignore them anyway).
      if (!academicLocked) {
        if (branch.trim()) patch.branch = branch.trim();
        if (cgpa !== "" && Number.isFinite(Number(cgpa))) patch.cgpa = Math.min(10, Math.max(0, Number(cgpa)));
      }
    }
    return patch;
  };

  const handleSave = async (event) => {
    event.preventDefault();
    setSaving(true);
    try {
      const updated = await updateMe(buildPatch());
      onProfileUpdated?.(updated);
      toastSuccess("Profile saved");
      onClose?.();
    } catch (error) {
      toastError(error, "Couldn't save your profile");
      setSaving(false);
    }
  };

  const general = (
    <div className="space-y-4">
      {isStudent && (
        <div className="border-2 border-black bg-gray-50 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <GraduationCap className="h-4 w-4 shrink-0" aria-hidden="true" />
              <div className="min-w-0">
                <div className="text-xs font-black uppercase">GGSIPU academic profile</div>
                <div className="text-[10px] font-semibold text-gray-600">Optional sync for branch, CGPA and academic records</div>
              </div>
            </div>
            <button type="button" onClick={() => setShowGgsipu((value) => !value)} className="btn-secondary shrink-0 px-2 py-1 text-[10px]">
              <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
              {showGgsipu ? "CLOSE" : ggsipuLinked ? "RE-SYNC" : "CONNECT IPU"}
            </button>
          </div>
          {ggsipuLinked && !showGgsipu && <div className="mt-2 text-[10px] font-bold text-green-800">ACADEMIC PROFILE CONNECTED</div>}
          {showGgsipu && (
            <div className="mt-3 border-t border-black pt-3">
              <GgsipuConnect
                onConnected={(updatedUser) => {
                  setGgsipuLinked(true);
                  setBranch(asText(updatedUser?.branch));
                  setCgpa(asText(updatedUser?.cgpa));
                  if (updatedUser) onProfileUpdated?.(updatedUser);
                }}
              />
            </div>
          )}
        </div>
      )}

      <LabeledInput label="Name" hint={academicLocked ? "Synced from GGSIPU" : undefined}>
        <input
          type="text"
          value={name}
          disabled={academicLocked}
          required
          minLength={2}
          maxLength={80}
          onChange={(event) => setName(event.target.value)}
          className={`${inputClass} ${academicLocked ? "bg-gray-100" : ""}`}
        />
      </LabeledInput>
      <ReadOnlyField label="Email" value={user?.email} />

      {isTeacher && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <LabeledInput label="Department">
            <input type="text" value={department} maxLength={60} onChange={(event) => setDepartment(event.target.value)} placeholder="e.g. CSE" className={inputClass} />
          </LabeledInput>
          <ReadOnlyField label="Employee ID" value={user?.employeeId} hint="Set by your placement office" />
        </div>
      )}
      {showDesignation && (
        <LabeledInput label="Designation">
          <input type="text" value={designation} maxLength={80} onChange={(event) => setDesignation(event.target.value)} placeholder={isTeacher ? "e.g. Assistant Professor" : "e.g. Placement Officer"} className={inputClass} />
        </LabeledInput>
      )}
      {role === "company" && <ReadOnlyField label="Company" value={user?.company?.name || user?.companyName} />}

      {isStudent && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <LabeledInput label="College name">
              <input type="text" value={collegeName} maxLength={120} onChange={(event) => setCollegeName(event.target.value)} placeholder="e.g. MSIT" className={inputClass} />
            </LabeledInput>
            <LabeledInput label="Passing year">
              <input type="text" inputMode="numeric" value={passingYear} onChange={(event) => setPassingYear(event.target.value)} placeholder="e.g. 2026" className={inputClass} />
            </LabeledInput>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <LabeledInput label="Branch" hint={academicLocked ? "Synced from GGSIPU; re-sync to update" : undefined}>
              <input type="text" value={branch} disabled={academicLocked} onChange={(event) => setBranch(event.target.value)} placeholder="e.g. CSE" className={`${inputClass} ${academicLocked ? "bg-gray-100" : ""}`} />
            </LabeledInput>
            <LabeledInput label="CGPA" hint={academicLocked ? "Synced from GGSIPU; re-sync to update" : undefined}>
              <input type="number" min="0" max="10" step="0.01" value={cgpa} disabled={academicLocked} onChange={(event) => setCgpa(event.target.value)} placeholder="0.00 – 10.00" className={`${inputClass} ${academicLocked ? "bg-gray-100" : ""}`} />
            </LabeledInput>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <ReadOnlyField label="Roll number" value={user?.rollNumber} />
            <ReadOnlyField label="Section" value={user?.section ? String(user.section).toUpperCase() : ""} />
            <ReadOnlyField label="Semester" value={user?.semester ? String(user.semester) : ""} />
          </div>
          <p className="text-[10px] font-semibold text-gray-500">Roll number, section and semester come from your college records and decide which courses you are enrolled in.</p>
          <div className="space-y-3 pt-1">
            <div className="text-xs font-extrabold uppercase">Socials</div>
            <LabeledInput label="GitHub">
              <input type="url" value={socialLinks.github} onChange={(event) => setSocialLinks((links) => ({ ...links, github: event.target.value }))} placeholder="https://github.com/username" className={inputClass} />
            </LabeledInput>
            <LabeledInput label="LinkedIn">
              <input type="url" value={socialLinks.linkedin} onChange={(event) => setSocialLinks((links) => ({ ...links, linkedin: event.target.value }))} placeholder="https://www.linkedin.com/in/username" className={inputClass} />
            </LabeledInput>
          </div>
        </>
      )}

      {onChangePassword && (
        <button type="button" onClick={onChangePassword} className="btn-secondary min-h-11 px-3 py-1.5 text-xs sm:min-h-0">
          <KeyRound className="h-3.5 w-3.5" aria-hidden="true" /> CHANGE PASSWORD
        </button>
      )}
    </div>
  );

  return (
    <Modal
      open
      size="md"
      title={HEADINGS[role] ?? "EDIT PROFILE"}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className="btn-secondary min-h-11 px-3 py-1.5 text-xs sm:min-h-0">
            CANCEL
          </button>
          <button type="submit" form="profile-form" disabled={saving} className="btn-primary min-h-11 px-3 py-1.5 text-xs disabled:opacity-60 sm:min-h-0">
            {saving ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Save className="h-3.5 w-3.5" aria-hidden="true" />}
            {saving ? "SAVING…" : "SAVE PROFILE"}
          </button>
        </>
      }
    >
      {isStudent && (
        <div className="mb-4 border-b-2 border-black pb-2">
          <Tabs tabs={STUDENT_TABS.map((tab) => ({ id: tab, label: tab }))} value={activeTab} onChange={setActiveTab} label="Profile sections" />
        </div>
      )}

      <form id="profile-form" onSubmit={handleSave} className="space-y-4">
        {(!isStudent || activeTab === "General") && general}

        {isStudent && activeTab === "Skills" && (
          <LabeledInput label="Skills (comma-separated)">
            <textarea value={skills} onChange={(event) => setSkills(event.target.value)} rows={5} className="input-stark w-full text-base font-medium sm:text-xs" placeholder="React, TypeScript, Node.js, Python, SQL…" />
          </LabeledInput>
        )}

        {isStudent && activeTab === "Projects" && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-extrabold uppercase">Projects</span>
              <button type="button" onClick={() => setProjects((items) => [...items, { title: "", description: "", skills: "", link: "" }])} className="btn-secondary px-2 py-1 text-[10px]">
                <Plus className="h-3 w-3" aria-hidden="true" /> ADD PROJECT
              </button>
            </div>
            {projects.length === 0 && <p className="text-[11px] font-semibold text-gray-500">No projects yet.</p>}
            {projects.map((project, index) => (
              <div key={index} className="space-y-2 border-2 border-black bg-gray-50 p-2.5">
                <div className="flex gap-2">
                  <input value={project.title || ""} onChange={(event) => updateItem(setProjects, index, "title", event.target.value)} placeholder="Project title" className="input-stark min-w-0 flex-1 text-base sm:text-xs" />
                  <button type="button" onClick={() => removeItem(setProjects, index)} className="btn-secondary p-1.5" aria-label="Remove project">
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
                <textarea value={project.description || ""} onChange={(event) => updateItem(setProjects, index, "description", event.target.value)} placeholder="What did you build?" rows={2} className="input-stark w-full text-base sm:text-xs" />
                <input value={project.skills || ""} onChange={(event) => updateItem(setProjects, index, "skills", event.target.value)} placeholder="Skills: React, Python, SQL" className="input-stark w-full text-base sm:text-xs" />
                <input type="url" value={project.link || ""} onChange={(event) => updateItem(setProjects, index, "link", event.target.value)} placeholder="Link (optional)" className="input-stark w-full text-base sm:text-xs" />
              </div>
            ))}
          </div>
        )}

        {isStudent && activeTab === "Certifications" && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-extrabold uppercase">Certifications</span>
              <button type="button" onClick={() => setCertifications((items) => [...items, { name: "", issuer: "", date: "", credentialUrl: "" }])} className="btn-secondary px-2 py-1 text-[10px]">
                <Plus className="h-3 w-3" aria-hidden="true" /> ADD CERTIFICATION
              </button>
            </div>
            {certifications.length === 0 && <p className="text-[11px] font-semibold text-gray-500">No certifications yet.</p>}
            {certifications.map((item, index) => (
              <div key={index} className="space-y-2 border-2 border-black bg-gray-50 p-2.5">
                <div className="flex gap-2">
                  <input value={item.name || ""} onChange={(event) => updateItem(setCertifications, index, "name", event.target.value)} placeholder="Certificate" className="input-stark min-w-0 flex-1 text-base sm:text-xs" />
                  <button type="button" onClick={() => removeItem(setCertifications, index)} className="btn-secondary p-1.5" aria-label="Remove certification">
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <input value={item.issuer || ""} onChange={(event) => updateItem(setCertifications, index, "issuer", event.target.value)} placeholder="Issuer" className="input-stark min-w-0 text-base sm:text-xs" />
                  <input type="month" value={item.date || ""} onChange={(event) => updateItem(setCertifications, index, "date", event.target.value)} aria-label="Date" className="input-stark min-w-0 text-base sm:text-xs" />
                </div>
                <input type="url" value={item.credentialUrl || ""} onChange={(event) => updateItem(setCertifications, index, "credentialUrl", event.target.value)} placeholder="Credential URL (optional)" className="input-stark w-full text-base sm:text-xs" />
              </div>
            ))}
          </div>
        )}

        {isStudent && activeTab === "Experience" && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-extrabold uppercase">Experience</span>
              <button type="button" onClick={() => setExperience((items) => [...items, { title: "", company: "", duration: "", description: "" }])} className="btn-secondary px-2 py-1 text-[10px]">
                <Plus className="h-3 w-3" aria-hidden="true" /> ADD EXPERIENCE
              </button>
            </div>
            {experience.length === 0 && <p className="text-[11px] font-semibold text-gray-500">No experience yet.</p>}
            {experience.map((item, index) => (
              <div key={index} className="space-y-2 border-2 border-black bg-gray-50 p-2.5">
                <div className="flex gap-2">
                  <input value={item.title || ""} onChange={(event) => updateItem(setExperience, index, "title", event.target.value)} placeholder="Role" className="input-stark min-w-0 flex-1 text-base sm:text-xs" />
                  <button type="button" onClick={() => removeItem(setExperience, index)} className="btn-secondary p-1.5" aria-label="Remove experience">
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
                <input value={item.company || ""} onChange={(event) => updateItem(setExperience, index, "company", event.target.value)} placeholder="Company" className="input-stark w-full text-base sm:text-xs" />
                <input value={item.duration || ""} onChange={(event) => updateItem(setExperience, index, "duration", event.target.value)} placeholder="Duration, e.g. Jun 2025 – Aug 2025" className="input-stark w-full text-base sm:text-xs" />
                <textarea value={item.description || ""} onChange={(event) => updateItem(setExperience, index, "description", event.target.value)} placeholder="Responsibilities and impact" rows={2} className="input-stark w-full text-base sm:text-xs" />
              </div>
            ))}
          </div>
        )}
      </form>
    </Modal>
  );
}
