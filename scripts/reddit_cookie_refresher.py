"""
Obtain a fresh Reddit guest-session cookie string using curl_cffi.

Strategy:
  1. Visit https://www.reddit.com/ with a Chrome-impersonating TLS client.
     Reddit's CDN sets several first-party cookies on the first GET even for
     anonymous visitors (reddit_session, csv, loid, edgebucket, …).
  2. Immediately GET https://www.reddit.com/.json with those cookies to warm
     the session and confirm JSON access works.
  3. Print a JSON object:
       { "ok": true,  "cookie": "<Cookie-header string>", "count": N }
     or on failure:
       { "ok": false, "error": "<reason>" }

The caller (Node.js redditCookieManager.ts) passes the returned cookie string
as the Cookie header for all subsequent .json requests.
"""

import json
import random
import sys
import os

try:
    from curl_cffi import requests as cffi_requests
except ImportError:
    print(json.dumps({"ok": False, "error": "curl_cffi not installed"}))
    sys.exit(0)


IMPERSONATION_PROFILES = ["chrome120", "chrome110", "chrome107"]

HOME_URL  = "https://www.reddit.com/"
PROBE_URL = "https://www.reddit.com/.json?limit=1"

HEADERS_HOME = {
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "upgrade-insecure-requests": "1",
}

HEADERS_JSON = {
    "accept": "application/json",
    "accept-language": "en-US,en;q=0.9",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "referer": "https://www.reddit.com/",
}


def get_proxy() -> str | None:
    """Return a random proxy from proxies.txt, or None."""
    paths = [
        "proxies.txt",
        "../proxies.txt",
        "../../proxies.txt",
        "/opt/render/project/src/proxies.txt",
    ]
    for p in paths:
        if os.path.exists(p):
            try:
                with open(p) as f:
                    lines = [
                        l.strip() for l in f
                        if l.strip() and not l.strip().startswith("#")
                    ]
                formatted = []
                for line in lines:
                    parts = line.split(":")
                    if len(parts) == 4:
                        host, port, user, pw = parts
                        formatted.append(f"http://{user}:{pw}@{host}:{port}")
                    else:
                        formatted.append(f"http://{line}" if not line.startswith("http") else line)
                if formatted:
                    return random.choice(formatted)
            except Exception:
                pass
    return None


def cookies_to_header(jar) -> str:
    """Convert a curl_cffi CookieJar to a Cookie header string."""
    pairs = []
    for cookie in jar:
        pairs.append(f"{cookie.name}={cookie.value}")
    return "; ".join(pairs)


def try_refresh(profile: str, proxy: str | None, skip_probe: bool = False) -> dict:
    session = cffi_requests.Session(impersonate=profile)
    if proxy:
        session.proxies = {"http": proxy, "https": proxy}

    # Step 1: visit homepage to receive guest cookies
    try:
        r1 = session.get(HOME_URL, headers=HEADERS_HOME, timeout=12, allow_redirects=True)
        if r1.status_code not in (200, 301, 302):
            return {"ok": False, "error": f"homepage returned HTTP {r1.status_code}"}
    except Exception as e:
        return {"ok": False, "error": f"homepage fetch failed: {e}"}

    # Step 2: probe .json to confirm cookies grant API access
    try:
        r2 = session.get(PROBE_URL, headers=HEADERS_JSON, timeout=10)
        if r2.status_code == 200:
            try:
                body = r2.json()
                if not isinstance(body, dict):
                    return {"ok": False, "error": "probe returned non-dict JSON"}
            except Exception:
                return {"ok": False, "error": "probe returned non-JSON body"}
        elif r2.status_code == 429:
            return {"ok": False, "error": "rate-limited (429) on probe"}
        else:
            return {"ok": False, "error": f"probe returned HTTP {r2.status_code}"}
    except Exception as e:
        return {"ok": False, "error": f"probe fetch failed: {e}"}

    cookie_header = cookies_to_header(session.cookies)
    count = len(list(session.cookies))

    if not cookie_header:
        return {"ok": False, "error": "no cookies received from Reddit"}

    return {"ok": True, "cookie": cookie_header, "count": count}


def get_all_proxies() -> list:
    """Return all proxies from proxies.txt (shuffled), or empty list."""
    paths = [
        "proxies.txt",
        "../proxies.txt",
        "../../proxies.txt",
        "/opt/render/project/src/proxies.txt",
    ]
    for p in paths:
        if os.path.exists(p):
            try:
                with open(p) as f:
                    lines = [l.strip() for l in f if l.strip() and not l.strip().startswith("#")]
                formatted = []
                for line in lines:
                    parts = line.split(":")
                    if len(parts) == 4:
                        host, port, user, pw = parts
                        formatted.append(f"http://{user}:{pw}@{host}:{port}")
                    else:
                        formatted.append(f"http://{line}" if not line.startswith("http") else line)
                random.shuffle(formatted)
                return formatted
            except Exception:
                pass
    return []


def main():
    profiles = IMPERSONATION_PROFILES.copy()
    random.shuffle(profiles)

    all_proxies = get_all_proxies()

    last_error = "no profiles tried"

    # ── Round 1: try a few proxies first (datacenter IPs are blocked by Reddit) ──
    for proxy in all_proxies[:5]:
        for profile in profiles:
            result = try_refresh(profile, proxy)
            if result["ok"]:
                print(json.dumps(result))
                return
            last_error = result.get("error", "unknown")

    # ── Round 2: direct attempt (works on residential IPs / local dev) ──────────
    for profile in profiles:
        result = try_refresh(profile, None)
        if result["ok"]:
            print(json.dumps(result))
            return
        last_error = result.get("error", "unknown")

    print(json.dumps({"ok": False, "error": last_error}))


if __name__ == "__main__":
    main()
