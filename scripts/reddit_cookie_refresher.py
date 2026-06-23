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
import re

try:
    from curl_cffi import requests as cffi_requests
except ImportError:
    print(json.dumps({"ok": False, "error": "curl_cffi not installed"}))
    sys.exit(0)


IMPRESSION_PROFILES = ["chrome131", "firefox", "safari"]

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


def get_all_proxies() -> list:
    """Return all proxies from environment and proxies.txt."""
    out = []
    
    # 1. Check PROXY_STRING or PROXY_URL from environment
    env_proxy = os.environ.get("PROXY_STRING") or os.environ.get("PROXY_URL")
    if env_proxy:
        env_proxy = env_proxy.strip()
        if "dataimpulse" in env_proxy.lower():
            # Handle DataImpulse ports expansion
            stripped = env_proxy
            for pfx in ("socks5h://", "socks5://", "http://", "https://"):
                if stripped.lower().startswith(pfx):
                    stripped = stripped[len(pfx):]
                    break
            stripped = re.sub(r':\d+$', '', stripped)
            if "@" in stripped:
                creds, host = stripped.rsplit("@", 1)
            else:
                creds, host = "", stripped
            
            # Add port 824 socks5h and port 823 http
            if creds:
                out.append(f"socks5h://{creds}@{host}:824")
                out.append(f"http://{creds}@{host}:823")
            else:
                out.append(f"socks5h://{host}:824")
                out.append(f"http://{host}:823")
        else:
            out.append(env_proxy)

    # 2. Check standard paths for proxies.txt
    paths = [
        "proxies.txt",
        "../proxies.txt",
        "../../proxies.txt",
        "/opt/render/project/src/proxies.txt",
    ]
    for p in paths:
        if os.path.exists(p):
            try:
                with open(p, "r", encoding="utf-8") as f:
                    for line in f:
                        stripped = line.strip()
                        if not stripped or stripped.startswith("#"):
                            continue
                        if "dataimpulse" in stripped.lower():
                            # Expand DataImpulse
                            base = stripped
                            for pfx in ("socks5h://", "socks5://", "http://", "https://"):
                                if base.lower().startswith(pfx):
                                    base = base[len(pfx):]
                                    break
                            base = re.sub(r':\d+$', '', base)
                            if "@" in base:
                                creds, host = base.rsplit("@", 1)
                            else:
                                creds, host = "", base
                            if creds:
                                out.append(f"socks5h://{creds}@{host}:824")
                                out.append(f"http://{creds}@{host}:823")
                            else:
                                out.append(f"socks5h://{host}:824")
                                out.append(f"http://{host}:823")
                        else:
                            parts = stripped.split(":")
                            if len(parts) == 4:
                                host, port, user, pw = parts
                                out.append(f"http://{user}:{pw}@{host}:{port}")
                            else:
                                out.append(f"http://{stripped}" if not stripped.startswith("http") else stripped)
            except Exception:
                pass
                
    # Deduplicate while preserving order
    seen = set()
    return [x for x in out if not (x in seen or seen.add(x))]


def cookies_to_header(jar) -> str:
    """Convert a curl_cffi CookieJar to a Cookie header string."""
    pairs = []
    for cookie in jar:
        pairs.append(f"{cookie.name}={cookie.value}")
    # Always ensure csv=1 and over18=1 are included for safety
    if "csv" not in [c.name for c in jar]:
        pairs.append("csv=1")
    if "over18" not in [c.name for c in jar]:
        pairs.append("over18=1")
    return "; ".join(pairs)


def try_refresh(profile: str, proxy: str | None) -> dict:
    session = cffi_requests.Session(impersonate=profile)
    if proxy:
        session.proxies = {"http": proxy, "https": proxy}

    # Step 1: visit homepage to receive guest cookies
    try:
        headers = HEADERS_HOME.copy()
        if profile == "chrome131":
            headers.update({
                "sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
                "sec-ch-ua-mobile": "?0",
                "sec-ch-ua-platform": '"Windows"',
                "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
            })
        r1 = session.get(HOME_URL, headers=headers, timeout=20, allow_redirects=True)
        if r1.status_code not in (200, 301, 302):
            return {"ok": False, "error": f"homepage returned HTTP {r1.status_code}"}
    except Exception as e:
        return {"ok": False, "error": f"homepage fetch failed: {e}"}

    # Step 2: probe .json to confirm cookies grant API access
    try:
        headers_json = HEADERS_JSON.copy()
        if profile == "chrome131":
            headers_json.update({
                "sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
                "sec-ch-ua-mobile": "?0",
                "sec-ch-ua-platform": '"Windows"',
                "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
            })
        r2 = session.get(PROBE_URL, headers=headers_json, timeout=20)
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


def main():
    profiles = IMPRESSION_PROFILES.copy()
    all_proxies = get_all_proxies()

    last_error = "no profiles tried"

    # ── Round 1: try proxies first (datacenter IPs are blocked by Reddit) ──
    if all_proxies:
        # Try up to 5 proxies, rotating profiles
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
