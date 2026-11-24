"""Job-list payload and markdown for ``mode:jobparser:jobslist`` (JOB-FEED.md §12.5/§12.7)."""

from typing import Any, Dict, List

from app.agents.jobscrapper.search import crawl_item, is_list_item


def format_job_for_data(job: Dict[str, Any], role: str = "") -> Dict[str, Any]:
    """The JobsListItem for *job*.

    Idempotent: an item that already has the §12.5 shape is returned
    unchanged; a legacy crawler dict (``Job.model_dump()``) becomes a crawl item.
    """
    if is_list_item(job):
        return job
    return crawl_item(job if isinstance(job, dict) else {})


def _plural(count: int, singular: str, plural: str) -> str:
    return f"{count} {singular if count == 1 else plural}"


def format_jobs_markdown(
    scraped_jobs: List[Dict[str, Any]],
    role: str = "student",
    status_header: str = "",
) -> str:
    """The chat text shown next to a job list: status line(s) + a one-line summary."""
    items = [item for item in scraped_jobs if isinstance(item, dict)]
    header_prefix = f"{status_header.strip()}\n\n" if status_header.strip() else ""
    total = len(items)
    if total == 0:
        return status_header.strip()

    crawl_only = all(item.get("source") == "crawl" for item in items)
    if crawl_only:
        return f"{header_prefix}I found {total} job(s) on that careers page."

    if role in ("tpo", "admin"):
        return (
            f"{header_prefix}Hello Placement Team! I found {total} open-market listing(s) you could share "
            "with students or turn into campus drives."
        )

    campus = [item for item in items if item.get("kind") == "campus"]
    external = [item for item in items if item.get("kind") != "campus"]
    eligible = sum(1 for item in campus if item.get("isEligible") is True)
    parts: List[str] = []
    if campus:
        part = _plural(len(campus), "campus drive", "campus drives")
        if eligible:
            part += f" ({eligible} you're eligible for)"
        parts.append(part)
    if external:
        parts.append(_plural(len(external), "open-market listing", "open-market listings"))
    return (
        f"{header_prefix}Hey there! I found {total} job(s) for you: {' and '.join(parts)}, best matches first. "
        "Open the AI-matched tab to apply, or say “save job 2” to add one to your tracker."
    )
