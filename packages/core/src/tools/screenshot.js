// Screenshot tools using stock OS utilities (desktop) or Chrome CLI (web pages).
// No Playwright/Puppeteer required. Desktop capture supports macOS, Linux
// (scrot / gnome-screenshot / ImageMagick import), and Windows (PowerShell).

import { execSync, exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import { agentOutputDir } from "../paths.js";

const execAsync = promisify(exec);

// Cap the long edge of captured images so base64-embedded payloads don't blow
// past the model's context limit. Retina captures can be 5+ MB PNG (~7 MB as
// base64 = ~1.8M tokens by char/4); 1536px keeps them legible while dropping
// the payload by an order of magnitude. Uses `sips` on macOS and ImageMagick
// `mogrify` on Linux; silently no-ops if neither is present.
const MAX_IMAGE_DIM = 1536;

async function downscale(filePath, maxDim = MAX_IMAGE_DIM) {
  const cmd =
    process.platform === "darwin"
      ? `sips -Z ${maxDim} "${filePath}" --out "${filePath}"`
      : process.platform === "linux"
      ? `mogrify -resize ${maxDim}x${maxDim}\\> "${filePath}"`
      : null;
  if (!cmd) return;
  try {
    await execAsync(cmd, { timeout: 10000 });
  } catch {
    // Resize tool missing or failed — leave the original file.
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

async function captureDesktopMac(outputPath, { display, selection }) {
  let args = "-x"; // no shutter sound
  if (selection) args += " -i";
  else if (display !== "all") {
    const displayNum = typeof display === "number" ? display : 1;
    args += ` -D ${displayNum}`;
  }
  // display === "all" → omit -D and screencapture grabs every display.
  await execAsync(`screencapture ${args} "${outputPath}"`, { timeout: 60000 });
}

// Try common Linux screenshot tools in order. First one that succeeds wins.
// `display` is ignored — monitor selection on Linux varies too much across
// tools / X11 / Wayland to implement reliably here.
async function captureDesktopLinux(outputPath, { selection }) {
  const attempts = [
    selection ? `scrot -s "${outputPath}"` : `scrot "${outputPath}"`,
    selection ? `gnome-screenshot -a -f "${outputPath}"` : `gnome-screenshot -f "${outputPath}"`,
    selection ? null : `import -window root "${outputPath}"`, // ImageMagick; no interactive mode
  ].filter(Boolean);

  let lastError;
  for (const cmd of attempts) {
    try {
      await execAsync(cmd, { timeout: 60000 });
      if (fs.existsSync(outputPath)) return;
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(
    `No Linux screenshot tool worked. Install scrot, gnome-screenshot, or imagemagick. ` +
      `(last error: ${lastError?.message || "none"})`,
  );
}

// PowerShell + System.Drawing captures the full virtual screen (all monitors).
// No interactive selection — the Windows Snipping Tool CLI is unreliable.
async function captureDesktopWindows(outputPath, { selection }) {
  if (selection) {
    throw new Error("Interactive selection is not supported on Windows.");
  }
  const psScript = [
    "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;",
    "$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen;",
    "$bmp = New-Object System.Drawing.Bitmap $vs.Width, $vs.Height;",
    "$g = [System.Drawing.Graphics]::FromImage($bmp);",
    "$g.CopyFromScreen($vs.Location, [System.Drawing.Point]::Empty, $bmp.Size);",
    `$bmp.Save('${outputPath.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png);`,
  ].join(" ");
  await execAsync(`powershell -NoProfile -Command "${psScript.replace(/"/g, '\\"')}"`, {
    timeout: 60000,
  });
}

async function captureDesktop(options = {}) {
  const { display = 1, selection = false, agentName = null } = options;

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outputDir = path.join(agentOutputDir(agentName), "images");

  fs.mkdirSync(outputDir, { recursive: true });

  const safeFilename = options.filename
    ? options.filename.replace(/[^a-zA-Z0-9._-]/g, "_") + ".png"
    : `screenshot-${ts}.png`;

  const outputPath = path.join(outputDir, safeFilename);

  if (process.platform === "darwin") {
    await captureDesktopMac(outputPath, { display, selection });
  } else if (process.platform === "linux") {
    await captureDesktopLinux(outputPath, { selection });
  } else if (process.platform === "win32") {
    await captureDesktopWindows(outputPath, { selection });
  } else {
    throw new Error(`capture_desktop is not supported on ${process.platform}`);
  }

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
    description: "Capture a screenshot of the user's current screen/desktop and attach it for visual analysis. Use this whenever the user asks what's on their screen, what they're looking at, wants you to see an error/window/app they have open, or mentions anything visual on their computer they want help with (e.g. 'what's on my screen', 'can you see this', 'look at this', 'what does this look like'). The image is attached automatically — describe what you see after it's returned. Works on macOS (screencapture), Linux (scrot / gnome-screenshot / imagemagick), and Windows (PowerShell).",
    parameters: {
      type: "object",
      properties: {
        display: {
          type: "number",
          description: "Display number to capture (1 = main, 2 = secondary, etc.). Omit to capture all displays. macOS only — ignored on Linux/Windows, which capture all displays.",
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

export async function captureWebpageRun(args, ctx = {}) {
  const { url, filename, width = 1280, height = 720, fullPage = false, delay = 0 } = args;

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outputDir = path.join(agentOutputDir(ctx.agentName), "images");
  
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

export async function captureDesktopRun(args = {}, ctx = {}) {
  const { display, selection = false, filename } = args;

  try {
    const outputPath = await captureDesktop({ display, selection, filename, agentName: ctx.agentName });
    const stats = fs.statSync(outputPath);
    return {
      content: `Screenshot saved: ${outputPath} (${(stats.size / 1024).toFixed(1)} KB)`,
      attachImages: [outputPath],
    };
  } catch (e) {
    return `ERROR: ${e.message}`;
  }
}

export const tools = {
  capture_webpage: {
    schema: captureWebpageSchema, run: captureWebpageRun,
    promptSnippet: "capture_webpage: screenshot a URL (headless Chrome)",
  },
  capture_desktop: {
    schema: captureDesktopSchema, run: captureDesktopRun,
    promptSnippet: "capture_desktop: screenshot the user's desktop",
  },
};
