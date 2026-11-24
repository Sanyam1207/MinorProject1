// Redeems a one-time temporary-password `revealId` (copilot faculty/recruiter
// invites, AUTH-FACULTY.md §7.5) exactly once per id, even under StrictMode's
// double-run effects: the request promise is shared per id at module scope.
import { useEffect, useState } from "react";
import { revealTemporaryPassword } from "../../lib/api/admin.js";

const requests = new Map();

const redeem = (revealId) => {
  if (!requests.has(revealId)) requests.set(revealId, revealTemporaryPassword(revealId));
  return requests.get(revealId);
};

/** → `{ result: {email, temporaryPassword} | null, error, revealId }` for the latest `revealId`. */
export function useOneTimeReveal(revealId) {
  const [state, setState] = useState({ revealId: null, result: null, error: null });
  useEffect(() => {
    if (!revealId) return undefined;
    let active = true;
    redeem(revealId).then(
      (result) => {
        if (active) setState({ revealId, result, error: null });
      },
      (error) => {
        if (active) setState({ revealId, result: null, error });
      },
    );
    return () => {
      active = false;
    };
  }, [revealId]);
  return state.revealId === revealId ? state : { revealId, result: null, error: null };
}
