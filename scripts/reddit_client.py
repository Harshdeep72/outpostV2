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
    proxy = None
    if use_proxy:
        proxies = get_proxies()
        if proxies:
            # We can pick a random proxy or try direct fallback
            # In our python helper, we can pick a random proxy for this request
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
        except Exception as e:
            # Non-fatal, try fetching JSON anyway but we log or keep track of it
            pass

    # 2. Perform the main fetch
    if is_json:
        headers["accept"] = "application/json"
        if visit_first:
            headers["referer"] = visit_first

    try:
        r = session.get(url, headers=headers, timeout=timeout)
        
        # Check if the output is JSON
        body_content = None
        if is_json and r.status_code == 200:
            try:
                body_content = r.json()
            except Exception:
                body_content = r.text
        else:
            body_content = r.text

        response_data = {
            "ok": r.status_code == 200,
            "status": r.status_code,
            "headers": dict(r.headers),
            "body": body_content,
            "via": "proxy" if proxy else "direct"
        }
        print(json.dumps(response_data))

    except Exception as e:
        print(json.dumps({
            "ok": False,
            "status": 0,
            "error": str(e),
            "via": "proxy" if proxy else "direct"
        }))

if __name__ == "__main__":
    main()
