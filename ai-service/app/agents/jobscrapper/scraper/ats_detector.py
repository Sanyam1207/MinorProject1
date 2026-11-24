from typing import Optional


def detect_ats(url: str, html_content: str = "") -> Optional[str]:
    """
    Detect common Applicant Tracking Systems (ATS) from URL structure or HTML content.
    Returns ATS name ('greenhouse', 'lever', 'workday', 'ashby', 'smartrecruiters', 'icims') or None.
    """
    url_lower = url.lower()
    html_lower = html_content.lower() if html_content else ""

    if "greenhouse.io" in url_lower or "grnhse" in html_lower or "boards.greenhouse.io" in url_lower:
        return "greenhouse"

    if "lever.co" in url_lower or "jobs.lever.co" in url_lower or "lever-job" in html_lower:
        return "lever"

    if "myworkdayjobs.com" in url_lower or "workday" in html_lower or "workdayjobs" in url_lower:
        return "workday"

    if "ashbyhq.com" in url_lower or "jobs.ashbyhq.com" in url_lower or "ashby" in html_lower:
        return "ashby"

    if "smartrecruiters.com" in url_lower or "smartrecruiters" in html_lower:
        return "smartrecruiters"

    if "icims.com" in url_lower or "icims" in html_lower:
        return "icims"

    return None
