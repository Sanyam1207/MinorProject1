import json
import re
from typing import List, Dict, Any, Optional
from bs4 import BeautifulSoup
from urllib.parse import urlparse

from app.utils.url_utils import normalize_url, get_domain
from app.utils.text_utils import clean_text, parse_salary_or_stipend, extract_skills, NOT_MENTIONED


class JobExtractor:
    """Multi-level generic and platform-aware job posting extractor."""

    def __init__(self, default_company: str = ""):
        self.default_company = default_company

    def extract_jobs(self, html: str, source_url: str, ats_type: Optional[str] = None) -> List[Dict[str, Any]]:
        """Run 5-level extraction hierarchy on HTML content."""
        if not html:
            return []

        soup = BeautifulSoup(html, "lxml")
        company = self._infer_company(soup, source_url)

        # Level 1: JSON-LD Extraction
        jobs = self._extract_json_ld(soup, source_url, company)
        if jobs:
            return jobs

        # Level 2: Embedded JSON state (__NEXT_DATA__, __NUXT__, etc.)
        jobs = self._extract_embedded_json(soup, source_url, company)
        if jobs:
            return jobs

        # Level 3: Known ATS Structure
        if ats_type:
            jobs = self._extract_ats_jobs(soup, source_url, company, ats_type)
            if jobs:
                return jobs

        # Level 4: Generic HTML DOM Extraction
        jobs = self._extract_generic_html(soup, source_url, company)
        return jobs

    def _infer_company(self, soup: BeautifulSoup, url: str) -> str:
        """Infer company name from meta tags, title, or domain."""
        if self.default_company:
            return self.default_company

        # Try og:site_name meta tag
        meta_site = soup.find("meta", property="og:site_name")
        if meta_site and meta_site.get("content"):
            return clean_text(meta_site["content"])

        # Try document title
        title_tag = soup.find("title")
        if title_tag:
            title_text = clean_text(title_tag.text)
            if "Careers" in title_text or "Jobs" in title_text:
                parts = re.split(r'[-|:;]', title_text)
                for part in parts:
                    clean_part = part.strip()
                    if clean_part and clean_part.lower() not in ("careers", "jobs", "hiring", "openings", "career"):
                        return clean_part

        # Fallback to domain name capitalizing first word
        domain = get_domain(url)
        if domain:
            domain_name = domain.split('.')[0]
            return domain_name.capitalize()

        return NOT_MENTIONED

    def _extract_json_ld(self, soup: BeautifulSoup, source_url: str, company: str) -> List[Dict[str, Any]]:
        """Level 1: Extract schema.org/JobPosting JSON-LD blocks."""
        jobs = []
        scripts = soup.find_all("script", type="application/ld+json")

        for script in scripts:
            if not script.string:
                continue
            try:
                data = json.loads(script.string)
                items = data if isinstance(data, list) else [data]

                for item in items:
                    if not isinstance(item, dict):
                        continue
                    
                    graph = item.get("@graph", [item]) if isinstance(item, dict) else [item]
                    for obj in graph:
                        if not isinstance(obj, dict):
                            continue
                        obj_type = obj.get("@type", "")
                        if obj_type == "JobPosting" or (isinstance(obj_type, list) and "JobPosting" in obj_type):
                            job = self._parse_json_ld_job(obj, source_url, company)
                            if job and job.get("title"):
                                jobs.append(job)
            except Exception:
                continue

        return jobs

    def _parse_json_ld_job(self, obj: Dict[str, Any], source_url: str, company: str) -> Dict[str, Any]:
        """Convert schema.org JobPosting dict to raw job dict."""
        title = clean_text(obj.get("title", ""))
        description = clean_text(obj.get("description", ""))
        
        # Hiring Org
        hiring_org = obj.get("hiringOrganization", {})
        comp_name = company
        if isinstance(hiring_org, dict) and hiring_org.get("name"):
            comp_name = clean_text(hiring_org["name"])

        # Location
        loc_obj = obj.get("jobLocation", {})
        location = NOT_MENTIONED
        if isinstance(loc_obj, dict):
            address = loc_obj.get("address", {})
            if isinstance(address, dict):
                loc_parts = [
                    address.get("addressLocality", ""),
                    address.get("addressRegion", ""),
                    address.get("addressCountry", "")
                ]
                loc_str = ", ".join([p for p in loc_parts if p])
                if loc_str:
                    location = loc_str
        elif isinstance(loc_obj, list) and loc_obj:
            first_loc = loc_obj[0]
            if isinstance(first_loc, dict):
                address = first_loc.get("address", {})
                if isinstance(address, dict):
                    loc_parts = [address.get("addressLocality", ""), address.get("addressCountry", "")]
                    location = ", ".join([p for p in loc_parts if p])

        # Employment Type
        emp_type = obj.get("employmentType", NOT_MENTIONED)
        if isinstance(emp_type, list):
            emp_type = ", ".join(emp_type)
        emp_type = clean_text(str(emp_type)) if emp_type else NOT_MENTIONED

        # Salary & Stipend
        base_salary = obj.get("baseSalary", {})
        salary, stipend = parse_salary_or_stipend(description)
        if isinstance(base_salary, dict) and base_salary.get("value"):
            val_obj = base_salary["value"]
            if isinstance(val_obj, dict):
                val_min = val_obj.get("minValue", "")
                val_max = val_obj.get("maxValue", "")
                currency = base_salary.get("currency", "$")
                unit = val_obj.get("unitText", "YEAR")
                salary = f"{currency}{val_min} - {currency}{val_max} per {unit.lower()}"

        # Application URL
        app_url = obj.get("directApplyUrl") or obj.get("url") or source_url

        return {
            "title": title,
            "company": comp_name,
            "location": location if location else NOT_MENTIONED,
            "employment_type": emp_type if emp_type else NOT_MENTIONED,
            "experience": NOT_MENTIONED,
            "salary": salary,
            "stipend": stipend,
            "skills": extract_skills(description),
            "description": description if description else NOT_MENTIONED,
            "requirements": NOT_MENTIONED,
            "posted_date": obj.get("datePosted", NOT_MENTIONED),
            "application_url": normalize_url(str(app_url), source_url),
            "source_url": source_url,
        }

    def _extract_embedded_json(self, soup: BeautifulSoup, source_url: str, company: str) -> List[Dict[str, Any]]:
        """Level 2: Extract jobs from __NEXT_DATA__ or window state JSON scripts."""
        jobs = []
        next_data = soup.find("script", id="__NEXT_DATA__")
        if next_data and next_data.string:
            try:
                data = json.loads(next_data.string)
                jobs.extend(self._find_jobs_in_dict(data, source_url, company))
            except Exception:
                pass

        return jobs

    def _find_jobs_in_dict(self, data: Any, source_url: str, company: str) -> List[Dict[str, Any]]:
        """Helper to recursively scan JSON objects for job items."""
        found = []
        if isinstance(data, dict):
            if "title" in data and ("id" in data or "jobId" in data or "slug" in data or "location" in data):
                title = clean_text(str(data.get("title", "")))
                if title and len(title) < 100:
                    loc = clean_text(str(data.get("location", NOT_MENTIONED)))
                    app_url = data.get("url") or data.get("absolute_url") or data.get("applyUrl") or source_url
                    found.append({
                        "title": title,
                        "company": company,
                        "location": loc if loc else NOT_MENTIONED,
                        "employment_type": clean_text(str(data.get("type", NOT_MENTIONED))),
                        "experience": NOT_MENTIONED,
                        "salary": NOT_MENTIONED,
                        "stipend": NOT_MENTIONED,
                        "skills": [],
                        "description": clean_text(str(data.get("description", NOT_MENTIONED))),
                        "requirements": NOT_MENTIONED,
                        "posted_date": NOT_MENTIONED,
                        "application_url": normalize_url(str(app_url), source_url),
                        "source_url": source_url,
                    })
            else:
                for v in data.values():
                    found.extend(self._find_jobs_in_dict(v, source_url, company))
        elif isinstance(data, list):
            for item in data:
                found.extend(self._find_jobs_in_dict(item, source_url, company))

        return found

    def _extract_ats_jobs(self, soup: BeautifulSoup, source_url: str, company: str, ats_type: str) -> List[Dict[str, Any]]:
        """Level 3: Extract jobs using ATS specific DOM patterns."""
        jobs = []
        if ats_type == "greenhouse":
            for card in soup.select(".opening, .job-post, [data-mapped='true']"):
                a_tag = card.find("a")
                if a_tag:
                    title = clean_text(a_tag.text)
                    loc_tag = card.find(class_=re.compile(r"location", re.I))
                    loc = clean_text(loc_tag.text) if loc_tag else NOT_MENTIONED
                    href = a_tag.get("href", "")
                    if title:
                        jobs.append({
                            "title": title,
                            "company": company,
                            "location": loc,
                            "employment_type": NOT_MENTIONED,
                            "experience": NOT_MENTIONED,
                            "salary": NOT_MENTIONED,
                            "stipend": NOT_MENTIONED,
                            "skills": [],
                            "description": NOT_MENTIONED,
                            "requirements": NOT_MENTIONED,
                            "posted_date": NOT_MENTIONED,
                            "application_url": normalize_url(href, source_url),
                            "source_url": source_url,
                        })

        elif ats_type == "lever":
            for posting in soup.select(".posting"):
                a_tag = posting.find("a", class_="posting-title") or posting.find("a")
                h5_tag = posting.find("h5")
                title = clean_text(h5_tag.text if h5_tag else (a_tag.text if a_tag else ""))
                loc_tag = posting.find(class_=re.compile(r"location|sort-by-location", re.I))
                loc = clean_text(loc_tag.text) if loc_tag else NOT_MENTIONED
                href = a_tag.get("href", "") if a_tag else ""
                if title:
                    jobs.append({
                        "title": title,
                        "company": company,
                        "location": loc,
                        "employment_type": NOT_MENTIONED,
                        "experience": NOT_MENTIONED,
                        "salary": NOT_MENTIONED,
                        "stipend": NOT_MENTIONED,
                        "skills": [],
                        "description": NOT_MENTIONED,
                        "requirements": NOT_MENTIONED,
                        "posted_date": NOT_MENTIONED,
                        "application_url": normalize_url(href, source_url),
                        "source_url": source_url,
                    })

        return jobs

    def _extract_generic_html(self, soup: BeautifulSoup, source_url: str, company: str) -> List[Dict[str, Any]]:
        """Level 4: Generic HTML DOM extraction looking for job card containers and listing links."""
        jobs = []

        # Strategy 1: Heading-based card extraction
        headings = soup.find_all(['h2', 'h3', 'h4'])
        job_role_pattern = re.compile(
            r'\b(engineer|developer|analyst|manager|executive|consultant|intern|internship|associate|apprentice|specialist|lead|architect|designer|scientist|support|administrator|coder|programmer)\b',
            re.I
        )

        for h in headings:
            title = clean_text(h.text)
            if not title or len(title) > 120 or len(title) < 3 or not job_role_pattern.search(title):
                continue

            card_container = h
            for _ in range(4):
                if card_container.parent:
                    card_container = card_container.parent

            comp = company
            loc = NOT_MENTIONED
            p_elem = card_container.find('p')
            if p_elem:
                raw_p = clean_text(p_elem.text)
                raw_p = re.sub(r'^(company|organization|employer)[:\-\s]+', '', raw_p, flags=re.I)
                parts = [pt.strip() for pt in re.split(r'[\u200b\ufffd\-\|]+', raw_p) if pt.strip()]
                if len(parts) >= 2:
                    comp = parts[0]
                    loc = parts[1]
                elif len(parts) == 1:
                    comp = parts[0]

            app_url = source_url
            for a in card_container.find_all('a', href=True):
                href = a['href']
                a_text = clean_text(a.text).lower()
                if "apply" in a_text or href.startswith("http"):
                    app_url = normalize_url(href, source_url)
                    break
                elif "/jobs/" in href and app_url == source_url:
                    app_url = normalize_url(href, source_url)

            card_text = clean_text(card_container.text)
            salary, stipend = parse_salary_or_stipend(card_text)

            jobs.append({
                "title": title,
                "company": comp if comp else company,
                "location": loc if loc else NOT_MENTIONED,
                "employment_type": NOT_MENTIONED,
                "experience": NOT_MENTIONED,
                "salary": salary,
                "stipend": stipend,
                "skills": extract_skills(card_text),
                "description": card_text if len(card_text) > 30 else NOT_MENTIONED,
                "requirements": NOT_MENTIONED,
                "posted_date": NOT_MENTIONED,
                "application_url": app_url,
                "source_url": source_url,
            })

        # Strategy 2: Card Selectors
        card_selectors = [
            ".job-card", ".job-item", ".job-listing", ".career-item", ".opening",
            ".position-card", "article", ".jobPost", "[data-job-id]", ".careers-list-item"
        ]
        
        cards = []
        for sel in card_selectors:
            found = soup.select(sel)
            if len(found) >= 1:
                cards.extend(found)

        cards = list(dict.fromkeys(cards))

        for card in cards:
            title_elem = card.find(["h1", "h2", "h3", "h4", "a"])
            a_elem = card.find("a") or (title_elem if title_elem and title_elem.name == "a" else None)

            if not title_elem:
                continue

            title = clean_text(title_elem.text)
            if not title or len(title) > 120 or len(title) < 3:
                continue

            if title.lower() in ("search", "careers", "view all", "apply now", "learn more", "read more"):
                continue

            href = a_elem.get("href", "") if a_elem else source_url
            app_url = normalize_url(href, source_url)

            card_text = clean_text(card.text)
            salary, stipend = parse_salary_or_stipend(card_text)

            loc = NOT_MENTIONED
            loc_match = re.search(r'\b(Remote|Hybrid|On-site|Bangalore|Bengaluru|London|New York|San Francisco|India|USA|UK|Singapore|Toronto)\b', card_text, re.I)
            if loc_match:
                loc = loc_match.group(0)

            emp_type = NOT_MENTIONED
            emp_match = re.search(r'\b(Full-time|Part-time|Contract|Internship|Temporary|Full Time|Part Time)\b', card_text, re.I)
            if emp_match:
                emp_type = emp_match.group(0)

            jobs.append({
                "title": title,
                "company": company,
                "location": loc,
                "employment_type": emp_type,
                "experience": NOT_MENTIONED,
                "salary": salary,
                "stipend": stipend,
                "skills": extract_skills(card_text),
                "description": card_text if len(card_text) > 30 else NOT_MENTIONED,
                "requirements": NOT_MENTIONED,
                "posted_date": NOT_MENTIONED,
                "application_url": app_url,
                "source_url": source_url,
            })

        # Strategy 3: Fallback anchor tags matching job keywords
        if not jobs:
            job_link_pattern = re.compile(r'/(job|careers|opening|vacancy|position)/', re.I)
            for a_tag in soup.find_all("a", href=True):
                href = a_tag["href"]
                title = clean_text(a_tag.text)
                if job_link_pattern.search(href) and title and 4 <= len(title) <= 100:
                    if title.lower() not in ("apply", "view job", "careers", "learn more"):
                        jobs.append({
                            "title": title,
                            "company": company,
                            "location": NOT_MENTIONED,
                            "employment_type": NOT_MENTIONED,
                            "experience": NOT_MENTIONED,
                            "salary": NOT_MENTIONED,
                            "stipend": NOT_MENTIONED,
                            "skills": [],
                            "description": NOT_MENTIONED,
                            "requirements": NOT_MENTIONED,
                            "posted_date": NOT_MENTIONED,
                            "application_url": normalize_url(href, source_url),
                            "source_url": source_url,
                        })

        return jobs
