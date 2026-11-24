import urllib.robotparser
from typing import Tuple
from urllib.parse import urlparse
import httpx

from app.agents.jobscrapper.models.job import ScrapingStatus
from app.utils.url_utils import is_safe_url, validate_url

DEFAULT_USER_AGENT = "JobScraperBot/1.0 (+https://example.com/bot)"


async def check_robots_permission(
    url: str, user_agent: str = DEFAULT_USER_AGENT
) -> Tuple[bool, ScrapingStatus, str]:
    """
    Check target URL against website's robots.txt rules.
    Returns (is_allowed, ScrapingStatus, message).
    """
    if not validate_url(url):
        return (
            False,
            ScrapingStatus.INVALID_URL,
            "Invalid URL format. Please provide a valid HTTP or HTTPS URL.",
        )

    if not is_safe_url(url):
        return (
            False,
            ScrapingStatus.ACCESS_DENIED,
            "Access denied: Private, loopback, or local network IP addresses are disallowed.",
        )

    parsed = urlparse(url)
    robots_url = f"{parsed.scheme}://{parsed.netloc}/robots.txt"

    rp = urllib.robotparser.RobotFileParser()

    try:
        async with httpx.AsyncClient(
            timeout=10.0,
            follow_redirects=True,
            headers={"User-Agent": user_agent},
        ) as client:
            resp = await client.get(robots_url)

            if resp.status_code == 404:
                # No robots.txt found -> allowed by default
                return (True, ScrapingStatus.SUCCESS, "No robots.txt found. Scraping permitted.")
            elif resp.status_code == 403 or resp.status_code == 401:
                return (
                    False,
                    ScrapingStatus.ACCESS_DENIED,
                    f"Access denied by server when fetching robots.txt (HTTP {resp.status_code}).",
                )
            elif resp.status_code >= 500:
                # Server error when fetching robots.txt -> allow cautiously
                return (True, ScrapingStatus.SUCCESS, "Robots.txt unavailable due to server error. Proceeding cautiously.")

            robots_content = resp.text
            rp.parse(robots_content.splitlines())

    except httpx.TimeoutException:
        return (True, ScrapingStatus.SUCCESS, "Timeout reading robots.txt. Proceeding cautiously.")
    except Exception as e:
        return (
            True,
            ScrapingStatus.SUCCESS,
            f"Could not retrieve robots.txt ({str(e)}). Proceeding with standard crawl.",
        )

    # Check rule for our user-agent and standard '*'
    is_allowed_bot = rp.can_fetch(user_agent, url)
    is_allowed_wildcard = rp.can_fetch("*", url)

    if not is_allowed_bot or not is_allowed_wildcard:
        return (
            False,
            ScrapingStatus.SCRAPING_DISALLOWED,
            "Scraping cannot be performed because the website's robots.txt rules disallow automated access to this path.",
        )

    return (True, ScrapingStatus.SUCCESS, "Scraping permitted by robots.txt rules.")
