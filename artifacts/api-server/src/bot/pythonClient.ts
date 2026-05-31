import { spawn } from "node:child_process";
import { resolve } from "node:path";
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

/**
 * Execute the python curl_cffi client to perform high-fidelity Reddit requests.
 * Impersonates a modern Chrome browser to bypass Cloudflare/TLS blocks.
 */
export async function executePythonRedditClient(opts: PythonFetchOptions): Promise<PythonFetchResult> {
  return new Promise((res, rej) => {
    // Resolve paths relative to the process working directory (workspace root).
    const pythonPath = resolve(process.cwd(), "venv/bin/python");
    const scriptPath = resolve(process.cwd(), "scripts/reddit_client.py");

    const inputData = {
      url: opts.url,
      visit_first: opts.visitFirst,
      use_proxy: opts.useProxy ?? true,
      is_json: opts.isJson ?? true,
      timeout: opts.timeout ?? 8,
    };

    logger.debug({ url: opts.url, visitFirst: opts.visitFirst, useProxy: opts.useProxy }, "Spawning python curl_cffi Reddit client");

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
