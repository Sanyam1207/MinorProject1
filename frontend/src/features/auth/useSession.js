import { useSelector } from "react-redux";

/** `{ status, user, role, isAuthenticated, isModeChosen, offline }` (FRONTEND.md §6.2). */
export function useSession() {
  const status = useSelector((state) => state.session.status);
  const isModeChosen = useSelector((state) => state.session.isModeChosen);
  const offline = useSelector((state) => state.session.offline);
  const user = useSelector((state) => state.appContext.user);
  const role = useSelector((state) => state.appContext.userRole);
  return { status, user, role, isAuthenticated: status === "authenticated", isModeChosen, offline };
}
