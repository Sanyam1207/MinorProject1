import { Presentation } from "lucide-react";
import AccountsPanel from "./AccountsPanel.jsx";

/** Faculty accounts (`tpo.faculty`): list, invite, edit, deactivate, reset password, one-time password reveal. */
export default function FacultyPanel() {
  return <AccountsPanel kind="faculty" icon={Presentation} />;
}
