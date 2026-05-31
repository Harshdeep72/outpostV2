import os
import sys
import json
import random
from curl_cffi import requests

def get_proxies():
    try:
        # Check standard paths for proxies.txt
        paths = [
            "proxies.txt",
            "../proxies.txt",
            "../../proxies.txt",
            "/opt/render/project/src/proxies.txt"
        ]
        for p in paths:
            if os.path.exists(p):
                with open(p, "r") as f:
                    lines = [l.strip() for l in f if l.strip() and not l.strip().startswith("#")]
                out = []
                for line in lines:
                    parts = line.split(":")
                    if len(parts) == 4:
                        host, port, user, pass_ = parts
                        out.append(f"http://{user}:{pass_}@{host}:{port}")
                    else:
                        out.append(f"http://{line}")
                return out
    except Exception:
        pass
    return []

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
    timeout = input_data.get("timeout", 8)

    if not url:
        print(json.dumps({"ok": False, "status": 0, "error": "Missing url parameter"}))
        return

    # Load session cookie
    cookie = os.environ.get("REDDIT_SESSION_COOKIE", "")
    if not cookie and os.path.exists(".env"):
        try:
            with open(".env", "r") as f:
                for line in f:
                    if line.strip().startswith("REDDIT_SESSION_COOKIE="):
                        val = line.strip().split("REDDIT_SESSION_COOKIE=", 1)[1]
                        if (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
                            val = val[1:-1]
                        cookie = val
                        break
        except Exception:
            pass

    # Select proxy if requested
    proxies = get_proxies() if use_proxy else []
    max_attempts = 4 if use_proxy and proxies else 1

    for attempt in range(max_attempts):
        proxy = None
        if use_proxy and proxies:
            proxy = random.choice(proxies)

        session = requests.Session(impersonate="chrome120")
        if proxy:
            session.proxies = {"http": proxy, "https": proxy}

        headers = {
            "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
            "referer": "https://www.reddit.com/",
        }
        if cookie:
            headers["cookie"] = cookie

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
                    if "blocked by network security" in body_content or "CAPTCHA" in body_content:
                        is_blocked = True
            else:
                body_content = r.text
                is_blocked = True

            if is_blocked:
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
            if attempt < max_attempts - 1:
                continue
            print(json.dumps({
                "ok": False,
                "status": 0,
                "error": str(e),
                "via": "proxy" if proxy else "direct"
            }))
            return

if __name__ == "__main__":
    main()
