import fs from 'fs';
import { fetch as undiciFetch, ProxyAgent } from 'undici';

async function main() {
  console.log("Loading proxies from proxies.txt...");
  let raw = "";
  try {
    raw = fs.readFileSync("../../proxies.txt", "utf-8");
  } catch {
    raw = fs.readFileSync("proxies.txt", "utf-8");
  }
  const proxyList = raw.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith("#"));
  console.log(`Loaded ${proxyList.length} proxies.`);

  if (proxyList.length === 0) {
    console.log("No proxies found.");
    process.exit(1);
  }

  const url = "https://www.reddit.com/user/BellyBear001/about.json?raw_json=1";
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

  // Try 5 random proxies
  const shuffled = [...proxyList].sort(() => 0.5 - Math.random());
  for (let i = 0; i < Math.min(5, shuffled.length); i++) {
    const rawProxy = shuffled[i];
    const parts = rawProxy.split(":");
    let proxyUrl = "";
    if (parts.length === 4) {
      const [host, port, user, pass] = parts;
      proxyUrl = `http://${user}:${pass}@${host}:${port}`;
    } else {
      proxyUrl = `http://${rawProxy}`;
    }

    console.log(`\n--- Proxy ${i+1}: ${parts[0]}:${parts[1]} ---`);
    try {
      const agent = new ProxyAgent({
        uri: proxyUrl,
        connectTimeout: 5000,
        bodyTimeout: 8000,
        headersTimeout: 8000,
      });

      const headers = {
        "User-Agent": UA,
        "Accept": "application/json",
        "referer": "https://www.reddit.com/",
      };

      console.log(`Fetching ${url}...`);
      const res = await undiciFetch(url, {
        dispatcher: agent,
        headers,
      });

      console.log(`Status: ${res.status}`);
      const text = await res.text();
      console.log(`Snippet: ${text.slice(0, 300)}`);
    } catch (err) {
      console.error(`Error: ${err.message}`);
    }
  }

  process.exit(0);
}

main();
