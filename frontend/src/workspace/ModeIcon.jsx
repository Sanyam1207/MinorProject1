import { LayoutGrid } from "lucide-react";
import { MODE_ICONS } from "./icons.js";

/** Renders the lucide icon named in MODE_DEFS[mode].icon. */
export default function ModeIcon({ name, className = "h-4 w-4" }) {
  const Icon = MODE_ICONS[name] ?? LayoutGrid;
  return <Icon className={className} aria-hidden="true" />;
}
