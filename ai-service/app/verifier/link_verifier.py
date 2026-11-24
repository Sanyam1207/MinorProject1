import asyncio
import json
import logging
import re
from typing import Tuple
import httpx

from app.config import settings

logger = logging.getLogger(__name__)

# Known non-job domains to reject instantly without wasting API calls
REJECT_DOMAINS = [
    "youtube.com", "youtu.be", "facebook.com", "twitter.com", "x.com",
    "instagram.com", "tiktok.com", "reddit.com", "medium.com", "vimeo.com",
    "wikipedia.org", "pinterest.com", "discord.gg", "discord.com"
]

# Known ATS & genuine job portal patterns to accept instantly (zero latency)
INSTANT_ACCEPT_PATTERNS = [
    r"greenhouse\.io", r"lever\.co", r"myworkdayjobs\.com", r"ashbyhq\.com",
    r"smartrecruiters\.com", r"icims\.com", r"workable\.com", r"bamboohr\.com",
    r"hire\.trakstar\.com", r"peoplestrong\.com", r"ycombinator\.com/companies/.+/jobs",
    r"amazon\.jobs", r"jobs-ta\.pwc\.com", r"jobs\.veralto\.com", r"careers\.rtx\.com",
    r"rubrik\.com/company/careers", r"recruitee\.com", r"hitachids\.com",
    r"job-description", r"job-details", r"jid=", r"/(job|jobs|career|careers|opening|vacancy|posting|apply)/"
]


class LinkVerifier:
    """Uses domain pre-filtering and AI LLM to verify whether job application URLs
    genuinely lead to an actual job posting or application page, rejecting YouTube videos,
    social media profiles, and generic tutorials."""

    def __init__(self, api_key: str = None, model_name: str = None):
        self.api_key = api_key or settings.GEMINI_API_KEY
        self.model_name = model_name or settings.GEMINI_MODEL
        self.endpoint = f"https://generativelanguage.googleapis.com/v1beta/models/{self.model_name}:generateContent?key={self.api_key}"

    async def verify_link(self, job_title: str, company: str, application_url: str, source_url: str = "") -> Tuple[bool, str]:
        """
        Verify if application_url genuinely leads to a job posting / application page.
        Returns (is_genuine, reason).
        """
        if not application_url or application_url == "Not mentioned":
            return False, "No URL provided"

        url_lower = application_url.lower()

        # Step 1: Pre-filter known non-job domains (instant reject)
        for domain in REJECT_DOMAINS:
            if domain in url_lower:
                return False, f"Rejected non-job domain ({domain})"

        # Step 2: Pre-filter known ATS platforms & job paths (instant accept)
        for pattern in INSTANT_ACCEPT_PATTERNS:
            if re.search(pattern, url_lower):
                return True, "Instant match for verified job URL pattern"

        # Step 3: Call LLM to analyze ambiguous links
        if not self.api_key:
            # Fallback heuristic if API key is missing
            is_job_path = bool(re.search(r'/(job|jobs|career|careers|opening|apply)/', url_lower))
            return is_job_path, "Passed keyword heuristic check"

        prompt = f"""You are an automated Job Application Link Verifier.
Analyze the following candidate job listing entry:
- Job Title: "{job_title}"
- Company/Publisher: "{company}"
- Application URL: "{application_url}"
- Source Page URL: "{source_url}"

Task: Determine whether the Application URL is a GENUINE job listing or job application page.
REJECT the link if it is:
1. A YouTube video or channel link.
2. A social media profile or post (Facebook, Instagram, Twitter, etc.).
3. A general course, roadmap, tutorial, or blog article not hosting a specific job posting.
4. A generic homepage without job application functionality.

Return ONLY a valid JSON object matching this exact schema:
{{
  "is_genuine_job_link": true,
  "reason": "short explanation"
}}
"""

        payload = {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {"response_mime_type": "application/json"}
        }

        try:
            async with httpx.AsyncClient(timeout=4.0) as client:
                res = await client.post(self.endpoint, json=payload)
                if res.status_code == 200:
                    result_data = res.json()
                    text_content = result_data["candidates"][0]["content"]["parts"][0]["text"]
                    parsed = json.loads(text_content)
                    is_genuine = bool(parsed.get("is_genuine_job_link", False))
                    reason = str(parsed.get("reason", "Verified link"))
                    return is_genuine, reason
        except Exception as e:
            logger.warning(f"Link verification API fallback for {application_url}: {e}")

        # Fallback check if API is rate limited or unavailable
        is_job_path = bool(re.search(r'/(job|jobs|career|careers|opening|apply)/', url_lower))
        return is_job_path, "Heuristic fallback evaluation"
