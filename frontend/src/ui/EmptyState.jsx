export default function EmptyState({ icon: Icon, title, text, action, className = "" }) {
  return (
    <div className={`border-2 border-dashed border-gray-400 bg-gray-50 p-8 text-center ${className}`}>
      {Icon && <Icon className="mx-auto mb-2 h-7 w-7 text-gray-400" aria-hidden="true" />}
      {title && <div className="text-xs font-black uppercase">{title}</div>}
      {text && <p className="mx-auto mt-1 max-w-md text-[11px] font-medium text-gray-500">{text}</p>}
      {action && <div className="mt-3 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}
