import express from "express";
import type { Request, Response } from "express";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { createFallbackRouter } from "./backend/fallback_engine.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const PYTHON_PORT = Number(process.env.PYTHON_API_PORT || 5001);

let pythonProc: ChildProcess | null = null;
let pythonAvailable = false;
let isShuttingDown = false;

function hasPython3(): boolean {
  try {
    const res = spawnSync("python3", ["--version"], {
      stdio: "ignore",
      timeout: 1500,
    });
    return res.status === 0;
  } catch {
    return false;
  }
}

function startPythonBackend(): boolean {
  if (!hasPython3()) {
    console.warn("python3 binary not found in runtime; using Node fallback engine.");
    return false;
  }

  const scriptPath = path.join(__dirname, "backend", "api_server.py");
  if (!fs.existsSync(scriptPath)) {
    console.warn("backend/api_server.py missing; using Node fallback engine.");
    return false;
  }

  try {
    pythonProc = spawn("python3", [scriptPath], {
      cwd: __dirname,
      env: { ...process.env, PYTHON_API_PORT: String(PYTHON_PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    pythonProc.on("error", (err) => {
      console.error("Failed to start python3 process:", err.message);
      pythonAvailable = false;
    });

    pythonProc.stdout?.on("data", (chunk: Buffer) => {
      process.stdout.write(`[python] ${chunk.toString()}`);
    });

    pythonProc.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[python-err] ${chunk.toString()}`);
    });

    pythonProc.on("exit", (code) => {
      pythonAvailable = false;
      if (!isShuttingDown && code !== 0) {
        console.error(`Python backend exited with code ${code}; fallback engine active.`);
      }
    });

    return true;
  } catch (err) {
    console.error("Error spawning python3:", err);
    return false;
  }
}

async function waitForPythonReady(retries = 20): Promise<boolean> {
  for (let i = 0; i < retries; i++) {
    try {
      const ok = await new Promise<boolean>((resolve) => {
        const req = http.get(`http://127.0.0.1:${PYTHON_PORT}/api/health`, (res) => {
          res.resume();
          resolve(res.statusCode === 200);
        });
        req.on("error", () => resolve(false));
        req.setTimeout(250, () => {
          req.destroy();
          resolve(false);
        });
      });
      if (ok) return true;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

function readSourceFile(relPath: string): string {
  const fullPath = path.join(__dirname, relPath);
  if (fs.existsSync(fullPath)) {
    return fs.readFileSync(fullPath, "utf-8");
  }
  return "";
}

function proxyToPython(req: Request, res: Response, next: express.NextFunction): void {
  if (!pythonAvailable) {
    next();
    return;
  }

  const targetUrl = req.originalUrl;
  const headers: Record<string, string | string[] | undefined> = {
    ...req.headers,
    host: `127.0.0.1:${PYTHON_PORT}`,
  };

  const proxyReq = http.request(
    {
      hostname: "127.0.0.1",
      port: PYTHON_PORT,
      path: targetUrl,
      method: req.method,
      headers,
    },
    (proxyRes) => {
      res.status(proxyRes.statusCode || 500);
      for (const [key, value] of Object.entries(proxyRes.headers)) {
        if (value !== undefined) {
          res.setHeader(key, value);
        }
      }
      proxyRes.pipe(res);
    }
  );

  proxyReq.on("error", (err) => {
    console.error("Proxy error to Python backend:", err.message);
    if (!res.headersSent) {
      res.status(502).json({ error: "Python backend unavailable" });
    }
  });

  req.pipe(proxyReq);
}

async function createServer(): Promise<void> {
  const started = startPythonBackend();
  if (started) {
    pythonAvailable = await waitForPythonReady();
  }

  const app = express();
  const fallbackRouter = createFallbackRouter(__dirname);

  // Serve real Python/Flask/HTML/CSS project files for the college presentation viewer
  app.get("/api/project-files", (_req: Request, res: Response) => {
    const files = [
      {
        id: "expense_engine.py",
        title: "backend/expense_engine.py",
        language: "python",
        description: "Core Python & SQLite3 engine with all 8 required functions.",
        content: readSourceFile("backend/expense_engine.py"),
      },
      {
        id: "app.py",
        title: "flask_project/app.py",
        language: "python",
        description: "Complete Flask application with REST routes and Matplotlib chart image endpoints.",
        content: readSourceFile("flask_project/app.py"),
      },
      {
        id: "index.html",
        title: "flask_project/templates/index.html",
        language: "html",
        description: "Clean semantic HTML template connecting forms, tables, and Matplotlib charts.",
        content: readSourceFile("flask_project/templates/index.html"),
      },
      {
        id: "style.css",
        title: "flask_project/static/style.css",
        language: "css",
        description: "Responsive dark blue, white, and light purple stylesheet for the Flask template.",
        content: readSourceFile("flask_project/static/style.css"),
      },
      {
        id: "requirements.txt",
        title: "flask_project/requirements.txt",
        language: "text",
        description: "Python package dependencies for local Flask + Matplotlib execution.",
        content: readSourceFile("flask_project/requirements.txt"),
      },
      {
        id: "README.md",
        title: "flask_project/README.md",
        language: "markdown",
        description: "Step-by-step installation and local run instructions.",
        content: readSourceFile("flask_project/README.md"),
      },
    ];
    res.json({ files });
  });

  // Forward /api/* to Python 3.11 + SQLite3 when running, or seamless fallback otherwise
  app.use("/api", proxyToPython, fallbackRouter);

  const distPath = path.join(__dirname, "dist");
  const hasDist = fs.existsSync(path.join(distPath, "index.html"));
  const isProd = process.env.NODE_ENV === "production" || Boolean(process.env.K_SERVICE);

  if (!isProd || !hasDist) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(distPath));
    app.get("*", (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(
      `Personal Expense Tracker listening on http://0.0.0.0:${PORT} (python3=${pythonAvailable})`
    );
  });

  const cleanup = () => {
    isShuttingDown = true;
    if (pythonProc && !pythonProc.killed) {
      pythonProc.kill("SIGTERM");
    }
    server.close(() => process.exit(0));
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

createServer();
