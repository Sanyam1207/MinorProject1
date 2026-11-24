export default function Panel({ title, icon: Icon, badge, actions, children, className = "" }) {
  return (
    <section className={`card-stark bg-white ${className}`}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b-2 border-black pb-3">
        <div className="flex min-w-0 items-center gap-2">
          {Icon && <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />}
          <h3 className="truncate text-sm font-black uppercase">{title}</h3>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {actions}
          {badge && <span className="badge-stark text-[10px] uppercase">{badge}</span>}
        </div>
      </div>
      {children}
    </section>
  );
}
