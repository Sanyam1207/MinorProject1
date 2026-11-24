import DriveCard from "./DriveCard.jsx";

/**
 * Responsive grid of DriveCards for JobVMs (features/opportunities/jobVM.js).
 * Props: { jobs = [], highlightIds = [], renderActions?(job), onOpen?(job), empty? }
 */
export default function DriveGrid({ jobs = [], highlightIds = [], renderActions, onOpen, empty = null }) {
  if (!jobs.length) return empty;
  const highlighted = new Set((highlightIds || []).map(String));
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">
      {jobs.map((job) => (
        <DriveCard
          key={`${job.kind}:${job.id}`}
          job={job}
          highlighted={highlighted.has(job.id)}
          actions={renderActions ? renderActions(job) : null}
          onOpen={onOpen && job.hasDetail ? () => onOpen(job) : undefined}
        />
      ))}
    </div>
  );
}
