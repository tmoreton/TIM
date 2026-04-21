// Screenshot tools using native macOS screencapture (desktop) or Chrome CLI (web pages)
// No Playwright/Puppeteer required — works with built-in system tools.

import { execSync, exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";

const execAsync = promisify(exec);

// Cap the long edge of captured images so base64-embedded payloads don't blow
// past the model's context limit. Retina desktop captures can be 5+ MB PNG
// (~7 MB as base64 = ~1.8M tokens by char/4); 1536px keeps them legible while
// dropping the payload by an order of magnitude. Uses stock-macOS `sips`.
const MAX_IMAGE_DIM = 1536;

async function downscale(filePath, maxDim = MAX_IMAGE_DIM) {
  try {
    await execAsync(`sips -Z ${maxDim} "${filePath}" --out "${filePath}"`, { timeout: 10000 });
  } catch {
    // sips missing or failed — leave the original file, caller can still use it.
  }
}

// Find Chrome/Chromium executable
function findChrome() {
  const macPaths = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Arc.app/Contents/MacOS/Arc",
    "/Users/tmoreton/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  
  for (const p of macPaths) {
    if (fs.existsSync(p)) return p;
  }
  
  // Try which
  try {
    execSync("which google-chrome", { stdio: "ignore" });
    return "google-chrome";
  } catch {}
  
  try {
    execSync("which chromium", { stdio: "ignore" });
    return "chromium";
  } catch {}
  
  try {
    execSync("which chrome", { stdio: "ignore" });
    return "chrome";
  } catch {}
  
  return null;
}

async function captureWebpage(url, outputPath, options = {}) {
  const chrome = findChrome();
  if (!chrome) {
    throw new Error("Chrome/Chromium not found. Install Chrome or use capture_desktop instead.");
  }
  
  const { width = 1280, height = 720, fullPage = false, delay = 0 } = options;
  
  // Chrome headless screenshot command
  const args = [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--hide-scrollbars",
    `--window-size=${width},${height}`,
    `--screenshot=${outputPath}`,
    url,
  ];
  
  if (fullPage) {
    args.push("--full-page");
  }
  
  if (delay > 0) {
    args.push(`--virtual-time-budget=${delay * 1000}`);
  }
  
  const cmd = `"${chrome}" ${args.map(a => a.includes(" ") ? `"${a}"` : a).join(" ")}`;
  
  await execAsync(cmd, { timeout: 30000 });

  if (!fs.existsSync(outputPath)) {
    throw new Error("Screenshot failed - no output file created");
  }

  await downscale(outputPath);
  return outputPath;
}

async function captureDesktop(options = {}) {
  const { display = 1, selection = false } = options;
  
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outputDir = process.env.TIM_DIR 
    ? path.join(process.env.TIM_DIR, "images")
    : path.join(os.homedir(), ".tim", "images");
  
  fs.mkdirSync(outputDir, { recursive: true });
  
  // Use filename if provided, otherwise generate one
  const safeFilename = options.filename 
    ? options.filename.replace(/[^a-zA-Z0-9._-]/g, "_") + ".png"
    : `screenshot-${ts}.png`;
  
  const outputPath = path.join(outputDir, safeFilename);
  
  let args = "-x"; // no sound
  
  if (selection) {
    args += " -i"; // interactive selection
  } else if (display === "all") {
    // -D all not valid, use without -D flag for all displays
    args += "";
  } else {
    // Display number (1 for main, 2 for secondary, etc.)
    const displayNum = typeof display === "number" ? display : 1;
    args += ` -D ${displayNum}`;
  }
  
  args += ` "${outputPath}"`;
  
  await execAsync(`screencapture ${args}`, { timeout: 60000 });

  if (!fs.existsSync(outputPath)) {
    throw new Error("Screenshot failed - no output file created");
  }

  await downscale(outputPath);
  return outputPath;
}

// Tool schemas
export const captureWebpageSchema = {
  type: "function",
  function: {
    name: "capture_webpage",
    description: "Capture a screenshot of a web page (via headless Chrome) and attach it to the conversation for visual inspection. Use this whenever the user asks you to look at a website, check how a page renders, verify a visual change, or compare designs. The image is attached automatically — you can describe what you see after it's returned.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "URL to screenshot",
        },
        filename: {
          type: "string",
          description: "Optional filename (without extension). Auto-generated if not provided.",
        },
        width: {
          type: "number",
          description: "Viewport width in pixels (default: 1280)",
          default: 1280,
        },
        height: {
          type: "number",
          description: "Viewport height in pixels (default: 720)",
          default: 720,
        },
        fullPage: {
          type: "boolean",
          description: "Capture full scrollable page (default: false)",
          default: false,
        },
        delay: {
          type: "number",
          description: "Seconds to wait for page to settle (default: 0)",
          default: 0,
        },
      },
      required: ["url"],
    },
  },
};

export const captureDesktopSchema = {
  type: "function",
  function: {
    name: "capture_desktop",
    description: "Capture a screenshot of the user's current screen/desktop and attach it for visual analysis. Use this whenever the user asks what's on their screen, what they're looking at, wants you to see an error/window/app they have open, or mentions anything visual on their computer they want help with (e.g. 'what's on my screen', 'can you see this', 'look at this', 'what does this look like'). The image is attached automatically — describe what you see after it's returned. On macOS only; uses the native screencapture command.",
    parameters: {
      type: "object",
      properties: {
        display: {
          type: "number",
          description: "Display number to capture (1 = main display, 2 = secondary, etc.). Omit to capture all displays.",
        },
        selection: {
          type: "boolean",
          description: "Interactive mode - user selects area with mouse (default: false)",
          default: false,
        },
        filename: {
          type: "string",
          description: "Optional filename (without extension). Auto-generated if not provided.",
        },
      },
    },
  },
};

export async function captureWebpageRun(args) {
  const { url, filename, width = 1280, height = 720, fullPage = false, delay = 0 } = args;
  
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outputDir = process.env.TIM_DIR 
    ? path.join(process.env.TIM_DIR, "images")
    : path.join(os.homedir(), ".tim", "images");
  
  fs.mkdirSync(outputDir, { recursive: true });
  
  const safeFilename = filename 
    ? filename.replace(/[^a-zA-Z0-9._-]/g, "_")
    : `webpage-${ts}`;
  
  const outputPath = path.join(outputDir, `${safeFilename}.png`);
  
  try {
    await captureWebpage(url, outputPath, { width, height, fullPage, delay });
    const stats = fs.statSync(outputPath);
    return {
      content: `Screenshot saved: ${outputPath} (${(stats.size / 1024).toFixed(1)} KB)`,
      attachImages: [outputPath],
    };
  } catch (e) {
    return `ERROR: ${e.message}`;
  }
}

export async function captureDesktopRun(args = {}) {
  const { display, selection = false, filename } = args;
  
  try {
    const outputPath = await captureDesktop({ display, selection, filename });
    const stats = fs.statSync(outputPath);
    return {
      content: `Screenshot saved: ${outputPath} (${(stats.size / 1024).toFixed(1)} KB)`,
      attachImages: [outputPath],
    };
  } catch (e) {
    return `ERROR: ${e.message}`;
  }
}
