#!/usr/bin/env python3
"""
Daily fetcher for the chief-of-staff dashboard.

Pulls items from:
  - Hacker News (Algolia search API) — one search per competitor + AI keyword
  - Reddit via pullpush.io archive (Reddit's own API blocks GitHub Actions IPs)
  - Bluesky authenticated searchPosts (skipped if BSKY_* env vars missing)
  - RSS feeds — TechCrunch AI, Finextra, American Banker, Product Hunt AI
  - Regulatory RSS — CFPB, Federal Reserve, OCC, FDIC, NCUA, Treasury
  - Google News RSS — per-competitor queries for funding / launches / hiring

Writes:
  docs/data/feed.json   { generated_at, items: [...] }
  docs/data/meta.json   { generated_at, item_count, sources: {name: {ok, count|error}}, ... }

Design choices:
  - Each source is wrapped in safe(); a single broken endpoint never kills the run.
  - Items are deduped by sha1(source + canonical_url[:tracking-stripped]).
  - When the same URL surfaces from multiple sources we keep the richest snippet
    and merge competitor tags.
  - Anything older than ITEM_MAX_AGE_DAYS is dropped so the JSON stays small.
"""

from __future__ import annotations

import dataclasses
import datetime as dt
import hashlib
import html
import json
import logging
import os
import re
import time
from pathlib import Path
from urllib.parse import quote_plus, urlparse, urlunparse, parse_qsl, urlencode

import feedparser
import requests

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "docs" / "data"
OUT_DIR.mkdir(parents=True, exist_ok=True)

USER_AGENT = "cos-dashboard/0.1 (+https://github.com/mittalbwoy/cos-dashboard)"
HTTP_TIMEOUT = 20
POLITE_DELAY = 0.4
ITEM_MAX_AGE_DAYS = 60
SNIPPET_CAP = 320

COMPETITORS = [
    "Eltropy",
    "Kasisto",
    "Posh",
    "Glia",
    "Active.Ai",
    "Omilia",
    "Gridspace",
    "Born Digital",
]

# Patterns are narrowed where the company name collides with a common English
# word (Posh, Glia) — we'd rather miss a borderline mention than wrongly tag
# "posh hotel" as a competitor item.
COMPETITOR_PATTERNS = {
    "Eltropy":      r"\beltropy\b",
    "Kasisto":      r"\bkasisto\b",
    "Posh":         r"\bposh(\s+ai|\.ai|\s+technologies)\b",
    "Glia":         r"\bglia\b(?=.*(ai|bank|customer|conversational|contact))",
    "Active.Ai":    r"\bactive[\.\s]?ai\b",
    "Omilia":       r"\bomilia\b",
    "Gridspace":    r"\bgridspace\b",
    "Born Digital": r"\bborn[\s-]digital\b",
}

AI_KEYWORDS = [
    "conversational AI",
    "voice AI",
    "agentic AI",
    "banking AI",
    "credit union AI",
]

REDDIT_SUBS = ["MachineLearning", "singularity", "fintech", "CreditUnions"]

BLUESKY_TERMS = (
    # Competitor names — Bluesky search is broad; is_relevant() then drops
    # anything that doesn't match a competitor regex or AI keyword.
    *("Eltropy", "Kasisto", "Posh AI", "Glia", "Active.Ai", "Omilia", "Gridspace", "Born Digital"),
    "conversational AI", "voice AI", "agentic AI", "banking AI",
)

RSS_FEEDS = [
    ("TechCrunch AI",     "https://techcrunch.com/category/artificial-intelligence/feed/"),
    ("Finextra",          "https://www.finextra.com/rss/headlines.aspx"),
    ("American Banker",   "https://www.americanbanker.com/feed?rss=true"),
    ("Product Hunt — AI", "https://www.producthunt.com/feed?category=artificial-intelligence"),
]

# Banking / financial regulators — official press feeds. The script gracefully
# skips any URL that 404s, so changes upstream won't kill the run.
REGULATORY_FEEDS = [
    # Official feeds (verified URLs).
    ("CFPB",             "https://www.consumerfinance.gov/about-us/newsroom/feed/"),
    ("Federal Reserve",  "https://www.federalreserve.gov/feeds/press_all.xml"),
    ("OCC",              "https://www.occ.treas.gov/rss/occ_news.xml"),
    ("FDIC",             "https://public.govdelivery.com/topics/USFDIC_26/feed.rss"),
    # NCUA + Treasury don't expose public news RSS — use a Google News
    # exact-quote search as a proxy so we still see major policy moves.
    ("NCUA",             "https://news.google.com/rss/search?q=%22NCUA%22+(press+OR+enforcement+OR+rule+OR+chairman)&hl=en-US&gl=US&ceid=US:en"),
    ("Treasury",         "https://news.google.com/rss/search?q=%22U.S.+Treasury+Department%22+(press+OR+enforcement+OR+sanctions+OR+ruling)&hl=en-US&gl=US&ceid=US:en"),
]

GOOGLE_NEWS_COMPETITOR_SUFFIXES = ("funding", "launches", "hiring", "partnership")
GOOGLE_NEWS_AI_QUERIES = (
    "conversational AI banking",
    "voice AI bank",
    "agentic AI bank",
    "credit union AI",
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("fetch")

session = requests.Session()
session.headers.update({"User-Agent": USER_AGENT})


@dataclasses.dataclass
class Item:
    id: str
    title: str
    url: str
    source: str
    date: str           # ISO 8601 UTC
    snippet: str
    competitors: list[str]
    category: str       # "competitor" or "ai-news"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

TRACKING_PARAMS = {
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
    "ref", "ref_src", "ref_url", "fbclid", "gclid", "mc_cid", "mc_eid",
}


def normalize_url(url: str) -> str:
    try:
        parts = urlparse(url)
        query = [(k, v) for k, v in parse_qsl(parts.query) if k.lower() not in TRACKING_PARAMS]
        return urlunparse(parts._replace(query=urlencode(query), fragment=""))
    except Exception:
        return url


def make_id(source: str, url: str) -> str:
    return hashlib.sha1(f"{source}::{normalize_url(url)}".encode("utf-8")).hexdigest()[:12]


def tag_competitors(text: str) -> list[str]:
    if not text:
        return []
    return [name for name, pat in COMPETITOR_PATTERNS.items() if re.search(pat, text, flags=re.IGNORECASE)]


def categorize(competitors: list[str], current: str | None = None) -> str:
    # Regulatory is sticky — set explicitly by fetch_regulatory_rss and must
    # survive dedup merges even if the item happens to mention a competitor.
    if current == "regulatory":
        return "regulatory"
    return "competitor" if competitors else "ai-news"


def to_iso_utc(value) -> str | None:
    if value is None:
        return None
    try:
        if isinstance(value, (int, float)):
            return dt.datetime.fromtimestamp(value, tz=dt.timezone.utc).isoformat()
        if isinstance(value, dt.datetime):
            if value.tzinfo is None:
                value = value.replace(tzinfo=dt.timezone.utc)
            return value.astimezone(dt.timezone.utc).isoformat()
        if hasattr(value, "tm_year"):
            return dt.datetime(*value[:6], tzinfo=dt.timezone.utc).isoformat()
        if isinstance(value, str):
            cleaned = value.replace("Z", "+00:00")
            return dt.datetime.fromisoformat(cleaned).astimezone(dt.timezone.utc).isoformat()
    except Exception:
        return None
    return None


def strip_html(text: str) -> str:
    if not text:
        return ""
    text = re.sub(r"<[^>]+>", " ", text)
    text = html.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def trim_snippet(text: str) -> str:
    text = strip_html(text)
    if len(text) > SNIPPET_CAP:
        return text[: SNIPPET_CAP - 1].rstrip() + "…"
    return text


def is_relevant(text: str) -> bool:
    """For noisy sources like Reddit, only keep items mentioning a
    competitor or AI keyword we care about."""
    if not text:
        return False
    lower = text.lower()
    if any(kw.lower() in lower for kw in AI_KEYWORDS):
        return True
    return any(re.search(p, text, flags=re.IGNORECASE) for p in COMPETITOR_PATTERNS.values())


def polite_sleep():
    time.sleep(POLITE_DELAY)


def build_item(*, source: str, title: str, url: str, date: str | None, snippet: str = "") -> Item | None:
    if not (title and url and date):
        return None
    url = normalize_url(url)
    haystack = f"{title} {snippet}"
    comps = tag_competitors(haystack)
    return Item(
        id=make_id(source, url),
        title=strip_html(title)[:300],
        url=url,
        source=source,
        date=date,
        snippet=trim_snippet(snippet),
        competitors=comps,
        category=categorize(comps),
    )


# ---------------------------------------------------------------------------
# Sources
# ---------------------------------------------------------------------------

def fetch_hn(query: str) -> list[Item]:
    since_epoch = int((dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=ITEM_MAX_AGE_DAYS)).timestamp())
    r = session.get(
        "https://hn.algolia.com/api/v1/search_by_date",
        params={
            "query": query,
            "tags": "story",
            "numericFilters": f"created_at_i>{since_epoch}",
            "hitsPerPage": 30,
        },
        timeout=HTTP_TIMEOUT,
    )
    r.raise_for_status()
    out: list[Item] = []
    for hit in r.json().get("hits", []):
        title = hit.get("title") or hit.get("story_title") or ""
        link = hit.get("url") or f"https://news.ycombinator.com/item?id={hit.get('objectID')}"
        item = build_item(
            source="Hacker News",
            title=title,
            url=link,
            date=to_iso_utc(hit.get("created_at")),
            snippet=hit.get("story_text") or hit.get("comment_text") or "",
        )
        if item:
            out.append(item)
    polite_sleep()
    return out


def fetch_reddit(sub: str) -> list[Item]:
    # pullpush.io mirrors Reddit and is not IP-blocked from GitHub Actions.
    r = session.get(
        "https://api.pullpush.io/reddit/search/submission/",
        params={
            "subreddit": sub,
            "size": 100,
            "sort": "desc",
            "sort_type": "created_utc",
        },
        timeout=HTTP_TIMEOUT,
    )
    r.raise_for_status()
    cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=ITEM_MAX_AGE_DAYS)
    out: list[Item] = []
    for post in r.json().get("data", []):
        created = post.get("created_utc")
        if not created:
            continue
        if dt.datetime.fromtimestamp(created, tz=dt.timezone.utc) < cutoff:
            continue
        title = post.get("title", "")
        body = post.get("selftext", "") or ""
        if not is_relevant(f"{title} {body}"):
            continue
        permalink = post.get("permalink", "")
        link = f"https://www.reddit.com{permalink}" if permalink else (post.get("url") or "")
        if not link:
            continue
        item = build_item(
            source=f"Reddit r/{sub}",
            title=title,
            url=link,
            date=to_iso_utc(created),
            snippet=body,
        )
        if item:
            out.append(item)
    polite_sleep()
    return out


_bsky_auth = {"tried": False, "token": None}


def _get_bsky_token() -> str | None:
    """Log into Bluesky once per process. Returns None if creds are not
    configured or auth failed — fetch_bluesky then no-ops."""
    if _bsky_auth["tried"]:
        return _bsky_auth["token"]
    _bsky_auth["tried"] = True
    handle = os.environ.get("BSKY_HANDLE")
    password = os.environ.get("BSKY_APP_PASSWORD")
    if not (handle and password):
        log.info("Bluesky: BSKY_HANDLE/BSKY_APP_PASSWORD not set, skipping")
        return None
    try:
        r = session.post(
            "https://bsky.social/xrpc/com.atproto.server.createSession",
            json={"identifier": handle, "password": password},
            timeout=HTTP_TIMEOUT,
        )
        r.raise_for_status()
        _bsky_auth["token"] = r.json().get("accessJwt")
        log.info("Bluesky: authenticated as %s", handle)
    except Exception as exc:
        log.warning("Bluesky auth failed: %s", exc)
        _bsky_auth["token"] = None
    return _bsky_auth["token"]


def fetch_bluesky(query: str) -> list[Item]:
    token = _get_bsky_token()
    if not token:
        return []
    r = session.get(
        "https://bsky.social/xrpc/app.bsky.feed.searchPosts",
        params={"q": query, "limit": 25, "sort": "latest"},
        headers={"Authorization": f"Bearer {token}"},
        timeout=HTTP_TIMEOUT,
    )
    r.raise_for_status()
    cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=ITEM_MAX_AGE_DAYS)
    out: list[Item] = []
    for p in r.json().get("posts", []):
        record = p.get("record", {})
        text = (record.get("text") or "").strip()
        date_iso = to_iso_utc(record.get("createdAt"))
        if not (text and date_iso):
            continue
        if dt.datetime.fromisoformat(date_iso) < cutoff:
            continue
        if not is_relevant(text):
            continue
        handle = p.get("author", {}).get("handle", "")
        uri = p.get("uri", "")
        rkey = uri.rsplit("/", 1)[-1] if uri else ""
        link = (
            f"https://bsky.app/profile/{handle}/post/{rkey}"
            if (handle and rkey)
            else (f"https://bsky.app/profile/{handle}" if handle else "")
        )
        if not link:
            continue
        title = (text[:140] + "…") if len(text) > 140 else text
        item = build_item(
            source="Bluesky",
            title=title,
            url=link,
            date=date_iso,
            snippet=text,
        )
        if item:
            out.append(item)
    polite_sleep()
    return out


def fetch_regulatory_rss(name: str, url: str) -> list[Item]:
    """Wrap fetch_rss but force category='regulatory'. Bank regulators
    publish dense, on-topic press releases — no relevance filter applied;
    show everything they post."""
    items = fetch_rss(name, url)
    for it in items:
        it.category = "regulatory"
    return items


def fetch_rss(name: str, url: str) -> list[Item]:
    parsed = feedparser.parse(url, agent=USER_AGENT)
    cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=ITEM_MAX_AGE_DAYS)
    out: list[Item] = []
    for e in parsed.entries[:60]:
        date_iso = to_iso_utc(e.get("published_parsed") or e.get("updated_parsed"))
        if not date_iso:
            continue
        if dt.datetime.fromisoformat(date_iso) < cutoff:
            continue
        item = build_item(
            source=name,
            title=e.get("title", ""),
            url=e.get("link", ""),
            date=date_iso,
            snippet=e.get("summary") or e.get("description") or "",
        )
        if item:
            out.append(item)
    polite_sleep()
    return out


def fetch_google_news(query: str, force_competitor: str | None = None) -> list[Item]:
    """Run a Google News RSS search. The displayed source label is collapsed
    to just "Google News" (we run ~30 queries; the user shouldn't see each
    one as a separate source in the dropdown). The per-query detail still
    lives in meta.json's sources status for monitoring.

    If force_competitor is set, every item returned is tagged with that
    competitor — used when the query is an exact-quoted competitor name."""
    url = f"https://news.google.com/rss/search?q={quote_plus(query)}&hl=en-US&gl=US&ceid=US:en"
    items = fetch_rss("Google News", url)
    if force_competitor:
        for it in items:
            if force_competitor not in it.competitors:
                it.competitors = sorted(it.competitors + [force_competitor])
            it.category = categorize(it.competitors)
    return items


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

def safe(name: str, fn, status: dict, *args, **kwargs) -> list[Item]:
    try:
        items = fn(*args, **kwargs)
        status[name] = {"ok": True, "count": len(items)}
        log.info("%s -> %d items", name, len(items))
        return items
    except Exception as exc:
        status[name] = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
        log.warning("%s FAILED: %s", name, exc)
        return []


def dedup(items: list[Item]) -> list[Item]:
    seen: dict[str, Item] = {}
    for it in items:
        prev = seen.get(it.id)
        if prev is None:
            seen[it.id] = it
            continue
        keep = prev
        # Prefer non-Google-News source (richer context) or longer snippet
        if prev.source.startswith("Google News") and not it.source.startswith("Google News"):
            keep = it
        elif len(it.snippet) > len(prev.snippet):
            keep = it
        merged = sorted(set(prev.competitors) | set(it.competitors))
        keep.competitors = merged
        keep.category = categorize(merged, keep.category)
        seen[it.id] = keep
    return sorted(seen.values(), key=lambda i: i.date, reverse=True)


def main():
    status: dict = {}
    items: list[Item] = []

    for comp in COMPETITORS:
        items += safe(f"HN search: {comp}",       fetch_hn,       status, comp)

    for kw in AI_KEYWORDS:
        items += safe(f"HN search: {kw}",         fetch_hn,       status, kw)

    if _get_bsky_token():
        for term in BLUESKY_TERMS:
            items += safe(f"Bluesky search: {term}", fetch_bluesky, status, term)

    for sub in REDDIT_SUBS:
        items += safe(f"Reddit r/{sub}",          fetch_reddit,   status, sub)

    for name, url in RSS_FEEDS:
        items += safe(f"RSS: {name}",             fetch_rss,      status, name, url)

    for name, url in REGULATORY_FEEDS:
        items += safe(f"Regulatory: {name}",      fetch_regulatory_rss, status, name, url)

    for comp in COMPETITORS:
        for suffix in GOOGLE_NEWS_COMPETITOR_SUFFIXES:
            q = f'"{comp}" {suffix}'
            items += safe(f"Google News: {q}", fetch_google_news, status, q, comp)

    for kw in GOOGLE_NEWS_AI_QUERIES:
        items += safe(f"Google News: {kw}", fetch_google_news, status, kw)

    deduped = dedup(items)

    generated_at = dt.datetime.now(dt.timezone.utc).isoformat()
    feed = {
        "generated_at": generated_at,
        "items": [dataclasses.asdict(i) for i in deduped],
    }
    meta = {
        "generated_at": generated_at,
        "item_count": len(deduped),
        "competitor_count": sum(1 for i in deduped if i.category == "competitor"),
        "ai_news_count":    sum(1 for i in deduped if i.category == "ai-news"),
        "regulatory_count": sum(1 for i in deduped if i.category == "regulatory"),
        "competitors": COMPETITORS,
        "sources": status,
    }

    notes_dir = ROOT / "docs" / "notes"
    note_ids = sorted(
        p.stem
        for p in notes_dir.glob("*.md")
        if p.stem != "README" and not p.stem.startswith(".")
    ) if notes_dir.exists() else []

    (OUT_DIR / "feed.json").write_text(json.dumps(feed, indent=2, ensure_ascii=False))
    (OUT_DIR / "meta.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False))
    (OUT_DIR / "notes_index.json").write_text(json.dumps(note_ids, indent=2))

    failed = [n for n, s in status.items() if not s.get("ok")]
    log.info(
        "Wrote %d items. Sources: %d ok, %d failed.",
        len(deduped),
        len(status) - len(failed),
        len(failed),
    )
    if failed:
        log.info("Failed sources: %s", ", ".join(failed))


if __name__ == "__main__":
    main()
