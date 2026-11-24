import { Building2 } from "lucide-react";
import AccountsPanel from "./AccountsPanel.jsx";

/** Recruiter (company) accounts (`tpo.recruiters`): list, invite, edit, deactivate, reset password. */
export default function RecruitersPanel() {
  return <AccountsPanel kind="recruiter" icon={Building2} />;
}
