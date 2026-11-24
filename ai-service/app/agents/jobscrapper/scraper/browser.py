import asyncio
import logging
import sys
from typing import Optional

# Ensure Windows ProactorEventLoopPolicy is set for Playwright subprocesses
if sys.platform == "win32":
    try:
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
    except Exception:
        pass

try:
    from playwright.async_api import async_playwright, Playwright, Browser
    PLAYWRIGHT_AVAILABLE = True
except ImportError:
    PLAYWRIGHT_AVAILABLE = False
    Playwright = Any = object
    Browser = Any = object

logger = logging.getLogger(__name__)


class BrowserManager:
    """Lazy-loaded async Playwright browser manager for JS-rendered job boards."""

    def __init__(self):
        self._playwright: Optional[Playwright] = None
        self._browser: Optional[Browser] = None
        self._lock = asyncio.Lock()

    async def get_browser(self) -> Optional[Browser]:
        if not PLAYWRIGHT_AVAILABLE:
            logger.warning("Playwright package is not available.")
            return None

        async with self._lock:
            if not self._browser or not self._browser.is_connected():
                try:
                    self._playwright = await async_playwright().start()
                    self._browser = await self._playwright.chromium.launch(
                        headless=True,
                        args=["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
                    )
                except Exception as e:
                    logger.warning(f"Failed to launch Playwright browser: {e}")
                    return None
            return self._browser

    async def fetch_page_html(self, url: str, wait_selector: Optional[str] = None, timeout_ms: int = 15000) -> str:
        """Render target URL using headless browser and return HTML content."""
        try:
            browser = await self.get_browser()
            if not browser:
                return ""

            context = await browser.new_context(
                user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 JobScraperBot/1.0"
            )
            page = await context.new_page()

            try:
                # Block heavy images and fonts for speed
                await page.route("**/*.{png,jpg,jpeg,gif,svg,woff,woff2}", lambda route: route.abort())

                await page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)

                if wait_selector:
                    try:
                        await page.wait_for_selector(wait_selector, timeout=5000)
                    except Exception:
                        pass
                else:
                    await asyncio.sleep(1.5)

                # Trigger scroll for lazy-loaded content
                for _ in range(2):
                    try:
                        await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                        await asyncio.sleep(1.0)
                    except Exception:
                        break

                content = await page.content()
                return content
            except Exception as e:
                logger.error(f"Playwright rendering failed for {url}: {e}")
                return ""
            finally:
                await page.close()
                await context.close()
        except Exception as exc:
            logger.warning(f"BrowserManager fetch_page_html exception: {exc}")
            return ""

    async def close(self):
        """Close browser instance."""
        async with self._lock:
            if self._browser:
                try:
                    await self._browser.close()
                except Exception:
                    pass
                self._browser = None
            if self._playwright:
                try:
                    await self._playwright.stop()
                except Exception:
                    pass
                self._playwright = None
