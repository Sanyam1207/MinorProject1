// Shared UI for provisioned accounts: faculty (/faculty) and recruiters (/recruiters).
import { useState } from "react";
import { Copy, KeyRound, LoaderCircle, Pencil, RefreshCw, UserPlus, UserRoundX, UserRoundCheck } from "lucide-react";
import { facultyApi, recruitersApi } from "../../lib/api/admin.js";
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  Modal,
  Panel,
  Tabs,
  formatDate,
  formatRelative,
  toastError,
  toastSuccess,
  useAsync,
  useNow,
} from "../../ui/index.js";
import { usePanel } from "../../workspace/index.js";
import { copyText } from "./browser.js";
import { ColorBadge, DataTable, SearchBox, Td } from "./parts.jsx";
import { useOneTimeReveal } from "./useOneTimeReveal.js";

const KINDS = {
  faculty: {
    api: facultyApi,
    panelId: "tpo.faculty",
    title: "Faculty",
    noun: "faculty member",
    revealParam: "revealId",
    idParam: "facultyId",
  },
  recruiter: {
    api: recruitersApi,
    panelId: "tpo.recruiters",
    title: "Recruiters",
    noun: "recruiter",
    revealParam: "revealInviteId",
    idParam: "recruiterId",
  },
};

const inputClass = "input-stark w-full text-base sm:text-xs";

const accountState = (user) => {
  if (!user.isActive) return { id: "inactive", color: "bg-gray-200" };
  if (user.mustChangePassword) return { id: "invited", color: "bg-yellow-100" };
  return { id: "active", color: "bg-green-200" };
};

function TemporaryPasswordModal({ info, onClose }) {
  const [copied, setCopied] = useState(false);
  if (!info) return null;
  return (
    <Modal
      open
      size="sm"
      title="ONE-TIME PASSWORD"
      onClose={onClose}
      footer={
        <button type="button" onClick={onClose} className="btn-primary min-h-11 px-3 py-1.5 text-xs sm:min-h-0">
          I HAVE SHARED IT
        </button>
      }
    >
      <div className="space-y-3 text-xs">
        <p className="font-semibold">
          Share these login details with <b>{info.name || info.email}</b> securely. The password is shown only once; they must change it at first sign-in.
        </p>
        {info.emailError && <p className="border border-black bg-yellow-100 p-2 font-bold">{info.emailError}. Share the password manually.</p>}
        <div className="border-2 border-black bg-gray-50 p-3">
          <div className="text-[9px] font-black uppercase text-gray-500">Email</div>
          <div className="break-all font-mono text-sm font-bold">{info.email}</div>
          <div className="mt-2 text-[9px] font-black uppercase text-gray-500">Temporary password</div>
          <div className="flex items-center gap-2">
            <code className="flex-1 break-all bg-white px-2 py-1 font-mono text-base font-black tracking-wider shadow-[2px_2px_0_0_#000]">{info.temporaryPassword}</code>
            <button
              type="button"
              aria-label="Copy password"
              onClick={async () => {
                const ok = await copyText(info.temporaryPassword);
                setCopied(ok);
                if (!ok) toastError("Copy failed — select the password and copy it manually.");
              }}
              className="btn-secondary px-2 py-1.5"
            >
              <Copy className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
          {copied && <div className="mt-1 text-[10px] font-bold text-green-800">Copied</div>}
        </div>
      </div>
    </Modal>
  );
}

function AccountForm({ kind, account, onClose, onDone }) {
  const config = KINDS[kind];
  const isEdit = Boolean(account?._id);
  const [form, setForm] = useState(() => ({
    name: account?.name ?? "",
    email: account?.email ?? "",
    designation: account?.designation ?? "",
    department: account?.department ?? "",
    employeeId: account?.employeeId ?? "",
    companyName: account?.company?.name ?? "",
    sendEmail: true,
  }));
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));

  const submit = async (event) => {
    event.preventDefault();
    const found = {};
    if (form.name.trim().length < 2) found.name = "Enter the full name.";
    if (!isEdit && !/^\S+@\S+\.\S+$/.test(form.email.trim())) found.email = "Enter a valid email address.";
    if (kind === "recruiter" && !form.companyName.trim()) found.companyName = "Enter the company.";
    setErrors(found);
    if (Object.keys(found).length) return;
    setSaving(true);
    try {
      const fields = kind === "faculty" ? ["name", "designation", "department", "employeeId"] : ["name", "designation", "companyName"];
      const body = {};
      for (const field of fields) {
        const value = form[field].trim();
        const before = field === "companyName" ? account?.company?.name ?? "" : account?.[field] ?? "";
        // Invite: send what is filled in. Edit: send only what changed (PATCH rejects an empty patch).
        if (isEdit ? value !== String(before) : value) body[field] = value;
      }
      if (isEdit && Object.keys(body).length === 0) {
        onClose();
        return;
      }
      if (isEdit) {
        const user = await config.api.update(account._id, body);
        toastSuccess("Account updated");
        onDone({ user });
      } else {
        const result = await config.api.invite({ ...body, email: form.email.trim(), sendEmail: form.sendEmail });
        if (result?.delivery === "email") toastSuccess(`Invited. Login details were emailed to ${form.email.trim()}.`);
        else toastSuccess("Invited. Share the one-time password shown next.");
        onDone(result);
      }
    } catch (failure) {
      const field = failure?.details?.field;
      if (field) setErrors((current) => ({ ...current, [field]: failure.message }));
      else if (failure?.code === "EMAIL_EXISTS" || failure?.code === "EMAIL_RESERVED") setErrors((current) => ({ ...current, email: failure.message }));
      toastError(failure, "Could not save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      title={isEdit ? `EDIT ${config.noun.toUpperCase()}` : `INVITE ${config.noun.toUpperCase()}`}
      onClose={saving ? undefined : onClose}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={saving} className="btn-secondary min-h-11 px-3 py-1.5 text-xs sm:min-h-0">CANCEL</button>
          <button type="submit" form="tpo-account-form" disabled={saving} className="btn-primary min-h-11 px-3 py-1.5 text-xs disabled:opacity-50 sm:min-h-0">
            {saving && <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            {isEdit ? "SAVE" : "SEND INVITE"}
          </button>
        </>
      }
    >
      <form id="tpo-account-form" onSubmit={submit} noValidate className="space-y-3">
        <Field label="Full name *" error={errors.name}>
          <input value={form.name} onChange={set("name")} maxLength={120} className={inputClass} autoComplete="off" />
        </Field>
        <Field label={isEdit ? "Email (cannot be changed)" : "Email *"} error={errors.email}>
          <input type="email" value={form.email} onChange={set("email")} disabled={isEdit} className={`${inputClass} font-mono disabled:bg-gray-100`} autoComplete="off" />
        </Field>
        {kind === "recruiter" && (
          <Field label="Company *" error={errors.companyName} hint="An existing company is matched by name; otherwise it is created.">
            <input value={form.companyName} onChange={set("companyName")} maxLength={120} className={inputClass} />
          </Field>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Designation" error={errors.designation}>
            <input value={form.designation} onChange={set("designation")} maxLength={80} className={inputClass} placeholder={kind === "faculty" ? "Assistant Professor" : "HR Manager"} />
          </Field>
          {kind === "faculty" && (
            <Field label="Department" error={errors.department}>
              <input value={form.department} onChange={set("department")} maxLength={100} className={inputClass} placeholder="CSE" />
            </Field>
          )}
          {kind === "faculty" && (
            <Field label="Employee ID" error={errors.employeeId}>
              <input value={form.employeeId} onChange={set("employeeId")} maxLength={40} className={`${inputClass} font-mono`} />
            </Field>
          )}
        </div>
        {!isEdit && (
          <label className="flex items-start gap-2 text-xs font-bold">
            <input type="checkbox" checked={form.sendEmail} onChange={(event) => setForm({ ...form, sendEmail: event.target.checked })} className="mt-0.5 h-4 w-4 accent-black" />
            <span>
              Email the login details
              <span className="block text-[10px] font-semibold text-gray-600">Untick to see a one-time password to share yourself.</span>
            </span>
          </label>
        )}
      </form>
    </Modal>
  );
}

/** Faculty / recruiter account management (`tpo.faculty` / `tpo.recruiters`). */
export default function AccountsPanel({ kind, icon }) {
  const config = KINDS[kind];
  const { params, setParams } = usePanel(config.panelId);
  const now = useNow(60000);
  const statusParam = ["active", "inactive", "invited", "all"].includes(params.status) ? params.status : "all";
  const [status, setStatus] = useState(statusParam);
  const [statusFor, setStatusFor] = useState(params.status);
  if (statusFor !== params.status) {
    setStatusFor(params.status);
    setStatus(statusParam);
  }
  const [group, setGroup] = useState(kind === "faculty" ? params.department ?? "" : "");
  const query = params.query ?? "";
  const [refreshKey, setRefreshKey] = useState(0);
  const [form, setForm] = useState(null); // { account? }
  const [confirm, setConfirm] = useState(null); // { kind, account }
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState(null);
  const [dismissedReveal, setDismissedReveal] = useState(null);

  const serverStatus = status === "invited" ? "active" : status;
  const { data, error, loading, reload, setData } = useAsync(
    () => config.api.list({ query, status: serverStatus, department: kind === "faculty" ? group : undefined, company: kind === "recruiter" ? group : undefined, limit: 100 }),
    [query, serverStatus, group, refreshKey],
  );
  const all = data?.items ?? [];
  const items = status === "invited" ? all.filter((user) => user.mustChangePassword && user.isActive) : all;
  const highlight = params.highlightId || params[config.idParam];

  const revealId = params[config.revealParam];
  const reveal = useOneTimeReveal(revealId && revealId !== dismissedReveal ? revealId : null);
  const revealInfo = reveal.result ? { ...reveal.result, name: reveal.result.email } : null;

  const openInvite = Boolean(params.invite) || form !== null;

  const patchUser = (user) => {
    if (!user?._id) return;
    setData((current) => {
      if (!current) return current;
      const exists = current.items.some((item) => item._id === user._id);
      return { ...current, items: exists ? current.items.map((item) => (item._id === user._id ? user : item)) : [user, ...current.items] };
    });
  };

  const runConfirm = async () => {
    const { action, account } = confirm;
    setBusy(true);
    try {
      if (action === "deactivate") {
        patchUser(await config.api.deactivate(account._id));
        toastSuccess(`${account.name} deactivated. Their sessions were signed out.`);
      } else if (action === "reactivate") {
        patchUser(await config.api.update(account._id, { isActive: true }));
        toastSuccess(`${account.name} reactivated`);
      } else if (action === "reset-email" || action === "reset-manual") {
        const result = await config.api.resetPassword(account._id, { sendEmail: action === "reset-email" });
        patchUser(result?.user);
        if (result?.delivery === "manual" && result.temporaryPassword) {
          setPassword({ email: account.email, name: account.name, temporaryPassword: result.temporaryPassword, emailError: result.emailError });
        } else {
          toastSuccess(`New login details emailed to ${account.email}`);
        }
      }
      setConfirm(null);
    } catch (failure) {
      toastError(failure, "Action failed");
    } finally {
      setBusy(false);
    }
  };

  const confirmCopy = confirm
    ? {
      deactivate: { title: `DEACTIVATE ${confirm.account.name}?`, body: "They are signed out everywhere and cannot sign in until reactivated.", label: "DEACTIVATE", danger: true },
      reactivate: { title: `REACTIVATE ${confirm.account.name}?`, body: "They can sign in again with their existing password.", label: "REACTIVATE" },
      "reset-email": { title: "RESET PASSWORD?", body: `A new temporary password is emailed to ${confirm.account.email}. Their current sessions are signed out.`, label: "RESET & EMAIL" },
      "reset-manual": { title: "RESET PASSWORD?", body: "A new temporary password is shown to you once. Their current sessions are signed out.", label: "RESET & SHOW" },
    }[confirm.action]
    : null;

  const Icon = icon;
  return (
    <Panel
      title={config.title}
      icon={Icon}
      badge={`${data?.total ?? 0} ACCOUNTS`}
      actions={
        <>
          <button type="button" onClick={() => setRefreshKey((key) => key + 1)} aria-label="Refresh" className="btn-secondary px-2 py-1 text-[10px]">
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button type="button" onClick={() => setForm({})} className="btn-primary px-2 py-1 text-[10px]">
            <UserPlus className="h-3.5 w-3.5" aria-hidden="true" /> INVITE
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
          <Tabs
            value={status}
            onChange={setStatus}
            label="Account status"
            tabs={[{ id: "all", label: "All" }, { id: "active", label: "Active" }, { id: "invited", label: "Invite pending" }, { id: "inactive", label: "Inactive" }]}
          />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:w-120">
            <input
              value={group}
              onChange={(event) => setGroup(event.target.value)}
              placeholder={kind === "faculty" ? "Department" : "Company"}
              aria-label={kind === "faculty" ? "Department" : "Company"}
              className="input-stark text-base sm:text-xs"
            />
            <SearchBox value={query} onSearch={(text) => setParams({ query: text || undefined })} placeholder="Name or email" />
          </div>
        </div>

        {reveal.error && revealId !== dismissedReveal && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-2 border-black bg-yellow-100 p-2 text-[11px] font-bold">
            <span>{reveal.error.message || "This password was already shown or has expired."} Use RESET PASSWORD to issue a new one.</span>
            <button type="button" onClick={() => setDismissedReveal(revealId)} className="btn-secondary px-2 py-1 text-[10px]">DISMISS</button>
          </div>
        )}

        {loading && !data ? (
          <LoadingState label="LOADING ACCOUNTS…" />
        ) : error && !data ? (
          <ErrorState error={error} title={error?.code === "NO_COLLEGE" ? "YOUR ACCOUNT IS NOT LINKED TO A COLLEGE" : undefined} onRetry={reload} />
        ) : items.length === 0 ? (
          <EmptyState
            icon={Icon}
            title={query || group || status !== "all" ? "No accounts match" : `No ${config.noun}s yet`}
            text={`Invite a ${config.noun}; they get a temporary password and choose their own at first sign-in.`}
            action={<button type="button" onClick={() => setForm({})} className="btn-primary px-3 py-1.5 text-xs"><UserPlus className="h-3.5 w-3.5" aria-hidden="true" /> INVITE</button>}
          />
        ) : (
          <DataTable head={["Name", "Email", kind === "faculty" ? "Department" : "Company", "Status", "Last sign-in", "Actions"]}>
            {items.map((user) => {
              const state = accountState(user);
              return (
                <tr key={user._id} className={highlight === user._id ? "bg-yellow-50 outline-2 -outline-offset-2 outline-black" : "hover:bg-gray-50"}>
                  <Td>
                    <div className="font-black uppercase">{user.name}</div>
                    <div className="text-[10px] font-semibold text-gray-600">
                      {user.designation || ""}{kind === "faculty" && user.employeeId ? ` · ${user.employeeId}` : ""}
                      {kind === "faculty" && Number.isFinite(user.courseCount) ? ` · ${user.courseCount} courses` : ""}
                    </div>
                  </Td>
                  <Td className="break-all font-mono text-[11px]">{user.email}</Td>
                  <Td className="font-semibold">{kind === "faculty" ? user.department || "—" : user.company?.name || "—"}</Td>
                  <Td>
                    <ColorBadge color={state.color}>{state.id === "invited" ? "invite pending" : state.id}</ColorBadge>
                    {state.id === "invited" && user.inviteExpiresAt && (
                      <div className="mt-0.5 text-[9px] font-semibold text-gray-600">expires {formatRelative(user.inviteExpiresAt, now)}</div>
                    )}
                    {state.id === "inactive" && user.deactivatedAt && <div className="mt-0.5 text-[9px] font-semibold text-gray-600">since {formatDate(user.deactivatedAt)}</div>}
                  </Td>
                  <Td className="whitespace-nowrap text-[11px]">{user.lastLoginAt ? formatRelative(user.lastLoginAt, now) : "Never"}</Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      <button type="button" onClick={() => setForm({ account: user })} aria-label={`Edit ${user.name}`} className="btn-secondary px-1.5 py-1">
                        <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                      {user.isActive ? (
                        <>
                          <button type="button" onClick={() => setConfirm({ action: "reset-email", account: user })} className="btn-secondary px-1.5 py-1 text-[10px]" title="Reset password and email it">
                            <KeyRound className="h-3.5 w-3.5" aria-hidden="true" /> {state.id === "invited" ? "RESEND" : "RESET"}
                          </button>
                          <button type="button" onClick={() => setConfirm({ action: "reset-manual", account: user })} className="btn-secondary px-1.5 py-1 text-[10px]" title="Reset password and show it once">
                            SHOW NEW
                          </button>
                          <button type="button" onClick={() => setConfirm({ action: "deactivate", account: user })} aria-label={`Deactivate ${user.name}`} className="btn-secondary px-1.5 py-1 text-red-700">
                            <UserRoundX className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                        </>
                      ) : (
                        <button type="button" onClick={() => setConfirm({ action: "reactivate", account: user })} className="btn-secondary px-1.5 py-1 text-[10px]">
                          <UserRoundCheck className="h-3.5 w-3.5" aria-hidden="true" /> REACTIVATE
                        </button>
                      )}
                    </div>
                  </Td>
                </tr>
              );
            })}
          </DataTable>
        )}
      </div>

      {openInvite && (
        <AccountForm
          key={form?.account?._id ?? "new"}
          kind={kind}
          account={form?.account}
          onClose={() => {
            setForm(null);
            if (params.invite) setParams({ ...params, invite: undefined }, { replace: true });
          }}
          onDone={(result) => {
            setForm(null);
            if (params.invite) setParams({ ...params, invite: undefined }, { replace: true });
            patchUser(result?.user);
            if (result?.delivery === "manual" && result.temporaryPassword) {
              setPassword({ email: result.user?.email, name: result.user?.name, temporaryPassword: result.temporaryPassword, emailError: result.emailError });
            }
          }}
        />
      )}
      <ConfirmDialog
        open={Boolean(confirm)}
        title={confirmCopy?.title}
        body={confirmCopy?.body}
        confirmLabel={confirmCopy?.label}
        danger={confirmCopy?.danger}
        busy={busy}
        onConfirm={runConfirm}
        onCancel={() => setConfirm(null)}
      />
      <TemporaryPasswordModal info={password} onClose={() => setPassword(null)} />
      {!password && revealInfo && (
        <TemporaryPasswordModal
          info={revealInfo}
          onClose={() => {
            setDismissedReveal(revealId);
            setParams({ ...params, [config.revealParam]: undefined }, { replace: true });
          }}
        />
      )}
    </Panel>
  );
}
