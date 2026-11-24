import asyncio
import logging
import re
from typing import Set, List, Tuple, AsyncGenerator
from bs4 import BeautifulSoup
from urllib.parse import urlparse
import httpx

from app.utils.url_utils import normalize_url, is_safe_url, get_domain
from app.agents.jobscrapper.scraper.browser import BrowserManager

logger = logging.getLogger(__name__)

JOB_PATH_KEYWORDS = [
    "job", "jobs", "career", "careers", "opening", "openings",
    "opportunity", "opportunities", "vacancy", "vacancies",
    "position", "positions", "recruitment", "join-us", "work-with-us"
]

NON_JOB_KEYWORDS = [
    "privacy", "terms", "login", "register", "signup", "contact",
    "about", "team", "blog", "roadmap", "placements", "kits",
    "faq", "help", "support", "community", "pricing", "cookie", "cookies"
]

ATS_DOMAINS = [
    "greenhouse.io", "lever.co", "myworkdayjobs.com", "ashbyhq.com",
    "smartrecruiters.com", "icims.com", "workable.com", "bamboohr.com",
    "trakstar.com", "recruitee.com", "hitachids.com", "ycombinator.com"
]


class JobCrawler:
    """Async crawler prioritizing job listings and detail page discovery."""

    def __init__(
        self,
        max_depth: int = 2,
        max_pages: int = 15,
        timeout_seconds: float = 12.0,
        user_agent: str = "JobScraperBot/1.0 (+https://example.com/bot)",
    ):
        self.max_depth = max_depth
        self.max_pages = max_pages
        self.timeout_seconds = timeout_seconds
        self.user_agent = user_agent
        self.visited_urls: Set[str] = set()
        self.browser_manager = BrowserManager()

    def _normalize_domain(self, domain: str) -> str:
        """Strip leading www. for consistent domain comparisons."""
        if not domain:
            return ""
        domain = domain.lower()
        if domain.startswith("www."):
            return domain[4:]
        return domain

    async def crawl_stream(self, start_url: str) -> AsyncGenerator[Tuple[str, str], None]:
        """
        Stream crawl website starting from start_url.
        Yields (url, html_content) tuples real-time as each page is fetched.
        """
        base_domain = self._normalize_domain(get_domain(start_url))
        queue: List[Tuple[str, int]] = [(normalize_url(start_url), 0)]
        pages_fetched = 0

        async with httpx.AsyncClient(
            timeout=self.timeout_seconds,
            follow_redirects=True,
            headers={"User-Agent": self.user_agent},
        ) as client:
            while queue and pages_fetched < self.max_pages:
                current_url, depth = queue.pop(0)

                if current_url in self.visited_urls:
                    continue
                self.visited_urls.add(current_url)

                if not is_safe_url(current_url):
                    continue

                # Ensure domain boundary (allowing www subdomain variations)
                curr_domain = self._normalize_domain(get_domain(current_url))
                if curr_domain != base_domain:
                    continue

                is_root = (depth == 0)
                html = await self._fetch_page(client, current_url, is_root=is_root)
                if not html:
                    continue

                pages_fetched += 1
                yield (current_url, html)

                # Discover next links if within depth limit
                if depth < self.max_depth:
                    next_links = self._extract_links(html, current_url, base_domain)
                    for link in next_links:
                        if link not in self.visited_urls:
                            queue.append((link, depth + 1))

    async def crawl(self, start_url: str) -> List[Tuple[str, str]]:
        """Crawl website and return all (url, html_content) tuples."""
        results: List[Tuple[str, str]] = []
        async for item in self.crawl_stream(start_url):
            results.append(item)
        return results

    async def _fetch_page(self, client: httpx.AsyncClient, url: str, is_root: bool = False) -> str:
        """Fetch URL with httpx, falling back to Playwright only for root URL if static HTML lacks job content."""
        try:
            resp = await client.get(url)
            if resp.status_code == 200:
                html = resp.text
                if not html or len(html) < 200:
                    return ""

                # Subpages use static HTML directly for ultra-fast performance
                if not is_root:
                    return html

                soup = BeautifulSoup(html, "lxml")

                # Check if static HTML contains genuine job listing schema or cards
                has_ld = bool(soup.find("script", type="application/ld+json"))
                has_cards = bool(soup.select(".job-card, .job-item, .job-listing, .career-item, .opening, .posting, [data-job-id], [data-job-posting]"))
                
                # Check for ATS links or job detail links
                has_ats_links = any(
                    any(ats in a.get("href", "").lower() for ats in ATS_DOMAINS) or
                    re.search(r'/(job|jobs|career|careers|opening|vacancy)/[a-zA-Z0-9_\-]{3,}', a.get("href", "").lower())
                    for a in soup.find_all("a", href=True)
                )

                if has_ld or has_cards or has_ats_links:
                    return html

                # Trigger Playwright rendering only for root SPA pages
                logger.info(f"Root page {url} lacks static job cards. Attempting Playwright rendering.")
                try:
                    rendered_html = await self.browser_manager.fetch_page_html(url)
                    if rendered_html and len(rendered_html) > 500:
                        return rendered_html
                except Exception as exc:
                    logger.warning(f"Playwright rendering failed for {url}: {exc}")

                return html

            elif resp.status_code in (403, 401, 429) and is_root:
                logger.warning(f"HTTP {resp.status_code} for root {url}. Attempting Playwright fallback.")
                try:
                    return await self.browser_manager.fetch_page_html(url)
                except Exception:
                    return ""
        except Exception as e:
            if is_root:
                logger.warning(f"httpx fetch failed for root {url}: {e}. Trying Playwright.")
                try:
                    return await self.browser_manager.fetch_page_html(url)
                except Exception:
                    return ""
        return ""

    def _extract_links(self, html: str, current_url: str, base_domain: str) -> List[str]:
        """Extract prioritized candidate job/career links from page HTML."""
        soup = BeautifulSoup(html, "lxml")
        prioritized_links: List[str] = []
        regular_links: List[str] = []

        for a_tag in soup.find_all("a", href=True):
            href = a_tag["href"].strip()
            if not href or href.startswith("#") or href.startswith("javascript:") or href.startswith("mailto:"):
                continue

            full_url = normalize_url(href, current_url)
            if self._normalize_domain(get_domain(full_url)) != base_domain:
                continue

            path_lower = urlparse(full_url).path.lower()
            text_lower = a_tag.text.lower() if a_tag.text else ""

            # Filter out non-job pages
            if any(non_job_kw in path_lower for non_job_kw in NON_JOB_KEYWORDS):
                continue

            # Prioritize links matching job keywords
            is_job_link = any(kw in path_lower for kw in JOB_PATH_KEYWORDS) or any(kw in text_lower for kw in JOB_PATH_KEYWORDS)

            if is_job_link:
                prioritized_links.append(full_url)
            else:
                regular_links.append(full_url)

        # Deduplicate preserving priority
        prioritized_links = list(dict.fromkeys(prioritized_links))
        regular_links = list(dict.fromkeys(regular_links))

        return prioritized_links[:10]

    async def close(self):
        """Clean up browser resources."""
        await self.browser_manager.close()
