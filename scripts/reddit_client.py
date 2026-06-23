import os
import sys
import json
import random
import re
from curl_cffi import requests

def get_proxies():
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
        "/opt/render/project/src/proxies.txt"
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
                                host, port, user, pass_ = parts
                                out.append(f"http://{user}:{pass_}@{host}:{port}")
                            else:
                                out.append(f"http://{stripped}" if not stripped.startswith("http") else stripped)
            except Exception:
                pass
            
    # Deduplicate while preserving order
    seen = set()
    return [x for x in out if not (x in seen or seen.add(x))]

def main():
    try:
        input_data = json.loads(sys.stdin.read())
    except Exception as e:
        print(json.dumps({"ok": False, "status": 0, "error": f"Invalid input JSON: {str(e)}"}))
        return

    url = input_data.get("url")
    visit_first = input_data.get("visit_first")
    use_proxy = input_data.get("use_proxy", True)
    is_json = input_data.get("is_json", True)
    # Default to 25s timeout for Slow residential proxies
    timeout = input_data.get("timeout", 25)

    if not url:
        print(json.dumps({"ok": False, "status": 0, "error": "Missing url parameter"}))
        return

    # Load session cookie
    cookie = os.environ.get("REDDIT_SESSION_COOKIE", "") or os.environ.get("REDDIT_SESSION", "")
    if not cookie and os.path.exists(".env"):
        try:
            with open(".env", "r") as f:
                for line in f:
                    line_strip = line.strip()
                    if line_strip.startswith("REDDIT_SESSION_COOKIE=") or line_strip.startswith("REDDIT_SESSION="):
                        val = line_strip.split("=", 1)[1]
                        if (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
                            val = val[1:-1]
                        cookie = val
                        break
        except Exception:
            pass

    # Ensure format: reddit_session=value; over18=1; csv=1
    cookie_str = ""
    if cookie:
        if "reddit_session=" in cookie:
            cookie_str = cookie
        else:
            cookie_str = f"reddit_session={cookie}; over18=1; csv=1"
    else:
        cookie_str = "csv=1; over18=1"

    # Select proxy if requested
    proxies = get_proxies() if use_proxy else []
    max_attempts = max(len(proxies), 3) if use_proxy and proxies else 3

    last_err = "No attempts made"
    
    for attempt in range(max_attempts):
        proxy = None
        if use_proxy and proxies:
            proxy = proxies[attempt % len(proxies)]

        impersonate_target = ["chrome131", "firefox", "safari"][attempt % 3]
        session = requests.Session(impersonate=impersonate_target)
        if proxy:
            session.proxies = {"http": proxy, "https": proxy}

        headers = {
            "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
            "referer": "https://www.reddit.com/",
            "cookie": cookie_str
        }
        
        if impersonate_target == "chrome131":
            headers.update({
                "sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
                "sec-ch-ua-mobile": "?0",
                "sec-ch-ua-platform": '"Windows"',
                "sec-fetch-dest": "empty",
                "sec-fetch-mode": "cors",
                "sec-fetch-site": "same-origin",
                "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            })

        # 1. Visit HTML first if it is a JSON request and a visit URL is specified
        if visit_first:
            try:
                session.get(visit_first, headers=headers, timeout=timeout)
            except Exception:
                pass

        # 2. Perform the main fetch
        if is_json:
            headers["accept"] = "application/json"
            if visit_first:
                headers["referer"] = visit_first

        try:
            r = session.get(url, headers=headers, timeout=timeout)
            
            body_content = None
            is_blocked = False
            
            body_lower = r.text[:2000].lower() if r.text else ""
            if r.status_code == 200:
                if is_json:
                    try:
                        body_content = r.json()
                        if not isinstance(body_content, (dict, list)):
                            is_blocked = True
                    except Exception:
                        body_content = r.text
                        is_blocked = True
                else:
                    body_content = r.text
                    if "blocked by network security" in body_content or "captcha" in body_lower or "just a moment" in body_lower:
                        is_blocked = True
            else:
                body_content = r.text
                is_blocked = True

            if is_blocked:
                last_err = f"Blocked (HTTP {r.status_code}) via {'proxy' if proxy else 'direct'}"
                if attempt < max_attempts - 1:
                    continue

            response_data = {
                "ok": not is_blocked,
                "status": r.status_code,
                "headers": dict(r.headers),
                "body": body_content,
                "via": "proxy" if proxy else "direct"
            }
            print(json.dumps(response_data))
            return

        except Exception as e:
            last_err = str(e)
            if attempt < max_attempts - 1:
                continue
            print(json.dumps({
                "ok": False,
                "status": 0,
                "error": last_err,
                "via": "proxy" if proxy else "direct"
            }))
            return

    # If loop exited without printing (e.g. max_attempts were exhausted and all failed)
    print(json.dumps({
        "ok": False,
        "status": 0,
        "error": f"All attempts failed. Last error: {last_err}",
        "via": "proxy" if (use_proxy and proxies) else "direct"
    }))
