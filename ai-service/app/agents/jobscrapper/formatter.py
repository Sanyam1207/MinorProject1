from typing import Any, Dict, List


def format_job_for_data(job: Dict[str, Any], role: str = "") -> Dict[str, Any]:
    """Format a job for the structured UI payload."""
    company_name = job.get("company_name") or job.get("company") or "Not mentioned"
    job_type = job.get("job_type") or job.get("employment_type") or "Not mentioned"
    salary = job.get("salary") or job.get("stipend") or "Not mentioned"
    experience = job.get("experience") or "Not mentioned"
    job_domain = job.get("job_domain") or job.get("category") or "Other"
    title = job.get("title") or "Not mentioned"
    application_url = job.get("application_url") or "Not mentioned"

    return {
        "title": title,
        "company_name": company_name,
        "job_type": job_type,
        "salary": salary,
        "experience": experience,
        "job_domain": job_domain,
        "application_url": application_url,
        "location": job.get("location") or "Not mentioned",
        "skills": job.get("skills") or [],
        "description": job.get("description") or "",
        "requirements": job.get("requirements") or "",
    }


def format_jobs_markdown(
    scraped_jobs: List[Dict[str, Any]],
    role: str = "student",
    status_header: str = "",
) -> str:
    """Create the human-readable response for the UI combining status header and job summary."""
    job_count = len(scraped_jobs)
    header_prefix = f"{status_header.strip()}\n\n" if status_header.strip() else ""

    if role == "tpo":
        if job_count > 0:
            summary = (
                f"Hello Placement Team! I have found {job_count} job listing(s) for your placement drive. "
                "You can review these openings and list them directly on your college placement portal for your students."
            )
        else:
            summary = (
                "Hello Placement Team! I am searching for job listings for your placement drive. "
                "As soon as openings are found, they will be available here."
            )
    else:
        if job_count > 0:
            summary = f"Hey there! I have found {job_count} job opportunity(ies) for you."
        else:
            summary = (
                "Hey there! I am searching for job opportunities for you. "
                "As soon as openings are found, they will be available here."
            )

    return f"{header_prefix}{summary}"
