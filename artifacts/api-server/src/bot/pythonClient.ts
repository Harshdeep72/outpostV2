import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { logger } from "../lib/logger.js";

export interface PythonFetchOptions {
  url: string;
  visitFirst?: string;
  useProxy?: boolean;
  isJson?: boolean;
  timeout?: number;
}

export interface PythonFetchResult {
  ok: boolean;
  status: number;
  headers?: Record<string, string>;
  body: any;
  error?: string;
  via: string;
}

function findWorkspaceFile(relativePath: string): string {
  // 1. Try relative to process.cwd()
  let candidate = resolve(process.cwd(), relativePath);
  if (existsSync(candidate)) return candidate;

  // 2. Try going up from process.cwd()
  let currentDir = process.cwd();
  for (let i = 0; i < 4; i++) {
    candidate = resolve(currentDir, relativePath);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(currentDir);
    if (parent === currentDir) break;
    currentDir = parent;
  }

  // 3. Try relative to the current module file (import.meta.url)
  try {
    let moduleDir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 5; i++) {
      candidate = resolve(moduleDir, relativePath);
      if (existsSync(candidate)) return candidate;
      const parent = dirname(moduleDir);
      if (parent === moduleDir) break;
      moduleDir = parent;
    }
  } catch {}

  // Fallback to process.cwd() resolved path
  return resolve(process.cwd(), relativePath);
}

/**
 * Execute the python curl_cffi client to perform high-fidelity Reddit requests.
 * Impersonates a modern Chrome browser to bypass Cloudflare/TLS blocks.
 */
export async function executePythonRedditClient(opts: PythonFetchOptions): Promise<PythonFetchResult> {
  return new Promise((res, rej) => {
    // Allow explicit override via PYTHON_PATH env var (useful for Docker / Render).
    // Fall back to venv/bin/python (workspace-relative), then system python3.
    let pythonPath: string;
    if (process.env.PYTHON_PATH) {
      pythonPath = process.env.PYTHON_PATH;
    } else {
      const venvPython = findWorkspaceFile("venv/bin/python");
      pythonPath = existsSync(venvPython) ? venvPython : "python3";
    }
    const scriptPath = findWorkspaceFile("scripts/reddit_client.py");

    // If neither the script nor the interpreter is available, skip cleanly.
    if (!existsSync(scriptPath)) {
      logger.warn({ scriptPath }, "Python Reddit client script not found — skipping");
      return res({ ok: false, status: 0, error: `Script not found: ${scriptPath}`, via: "direct", body: null });
    }

    const inputData = {
      url: opts.url,
      visit_first: opts.visitFirst,
      use_proxy: opts.useProxy ?? true,
      is_json: opts.isJson ?? true,
      timeout: opts.timeout ?? 8,
    };

    logger.debug({ url: opts.url, visitFirst: opts.visitFirst, useProxy: opts.useProxy, pythonPath, scriptPath }, "Spawning python curl_cffi Reddit client");

    const child = spawn(pythonPath, [scriptPath]);

    let stdoutData = "";
    let stderrData = "";

    child.stdout.on("data", (chunk) => {
      stdoutData += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderrData += chunk.toString();
    });

    child.on("close", (code) => {
      if (code !== 0) {
        logger.warn({ code, stderr: stderrData.trim() }, "Python Reddit client exited with non-zero code");
        return res({
          ok: false,
          status: 0,
          error: `Python process exited with code ${code}. Error: ${stderrData.trim()}`,
          via: "direct",
          body: null,
        });
      }

      try {
        const result: PythonFetchResult = JSON.parse(stdoutData.trim());
        res(result);
      } catch (err) {
        logger.error({ err, stdout: stdoutData.trim() }, "Failed to parse Python stdout as JSON");
        res({
          ok: false,
          status: 0,
          error: `Failed to parse Python stdout as JSON. Raw: ${stdoutData.trim()}`,
          via: "direct",
          body: null,
        });
      }
    });

    child.on("error", (err) => {
      logger.error({ err }, "Failed to spawn Python process");
      res({
        ok: false,
        status: 0,
        error: `Failed to spawn Python process: ${err.message}`,
        via: "direct",
        body: null,
      });
    });

    // Write input JSON to stdin and close it
    child.stdin.write(JSON.stringify(inputData));
    child.stdin.end();
  });
}
