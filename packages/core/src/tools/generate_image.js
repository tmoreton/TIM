// Image generation via OpenRouter using Google's Gemini 3 Pro Image — the
// highest-quality Google image model exposed on OpenRouter. Only registered
// when OPENROUTER_API_KEY is set. Saves PNGs under $TIM_DIR/output/<agent>/
// images/ and attaches them to the tool result so downstream agents see the
// image. Aspect ratio and size are passed via OpenRouter's `image_config`
// field, which the model honors natively (no post-process crop required).

import fs from "node:fs";
import path from "node:path";
import { agentOutputDir } from "../paths.js";

export const requiredEnv = "OPENROUTER_API_KEY";

const MODEL = "google/gemini-3-pro-image-preview";
const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const mimeFor = (p) => MIME_BY_EXT[path.extname(p).toLowerCase()] || "image/png";

const slugify = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "image";

const encodeAsDataUrl = (filePath) => {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) throw new Error(`reference image not found: ${filePath}`);
  return `data:${mimeFor(abs)};base64,${fs.readFileSync(abs).toString("base64")}`;
};

// Gemini returns the image either as message.images[0].image_url.url or
// inline in message.content as an image_url part. Handle both shapes.
const extractImage = (msg) => {
  if (Array.isArray(msg?.images) && msg.images.length) {
    return msg.images[0]?.image_url?.url || msg.images[0]?.url || null;
  }
  if (Array.isArray(msg?.content)) {
    for (const part of msg.content) {
      if (part?.type === "image_url" && part.image_url?.url) return part.image_url.url;
    }
  }
  return null;
};

const writeDataUrl = (dataUrl, outPath) => {
  const m = dataUrl.match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
  if (!m) throw new Error("model returned non-data-url image");
  fs.writeFileSync(outPath, Buffer.from(m[2], "base64"));
};

export const schema = {
  type: "function",
  function: {
    name: "generate_image",
    description: "Generate an image from a text prompt using Google's Gemini 3 Pro Image (best-in-class quality) via OpenRouter. Pass reference_images for image-to-image (edits, variations, style transfer, identity transfer). Pass aspect_ratio for sized outputs — the model renders natively at that ratio.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "What to generate. Subject + setting + composition + lighting + style + palette + mood all help." },
        reference_images: {
          type: "array",
          items: { type: "string" },
          description: "Optional paths to reference images for image-to-image generation (edits, variations, style and identity transfer). Each path is inlined as a data URL.",
        },
        aspect_ratio: {
          type: "string",
          enum: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"],
          description: "Output aspect ratio (rendered natively by the model — no cropping). 16:9 for YouTube thumbnails, 9:16 for Shorts/Reels/TikTok, 1:1 for Instagram square, 4:5 for Instagram portrait, 21:9 for cinematic. Pass for any platform-bound asset.",
        },
        image_size: {
          type: "string",
          enum: ["1K", "2K", "4K"],
          description: "Output resolution tier. Defaults to 2K (plenty for social/web). Bump to 4K for print or hero assets.",
        },
        output_name: { type: "string", description: "Optional base filename (no extension). Defaults to a slug of the prompt." },
      },
      required: ["prompt"],
    },
  },
};

export async function run({ prompt, reference_images = [], aspect_ratio, image_size, output_name }, ctx = {}) {
  try {
    const content = [{ type: "text", text: prompt }];
    for (const ref of reference_images) {
      content.push({ type: "image_url", image_url: { url: encodeAsDataUrl(ref) } });
    }

    const body = {
      model: MODEL,
      modalities: ["image", "text"],
      messages: [{ role: "user", content }],
    };
    if (aspect_ratio || image_size) {
      body.image_config = { image_size: image_size || "2K" };
      if (aspect_ratio) body.image_config.aspect_ratio = aspect_ratio;
    }

    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: ctx.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return `ERROR: OpenRouter ${res.status}: ${text.slice(0, 300)}`;
    }

    const data = await res.json();
    const dataUrl = extractImage(data?.choices?.[0]?.message);
    if (!dataUrl) return `ERROR: no image in response`;

    const dir = path.join(agentOutputDir(ctx.agentName), "images");
    fs.mkdirSync(dir, { recursive: true });
    const outPath = path.join(dir, `${slugify(output_name || prompt)}-${Date.now()}.png`);
    writeDataUrl(dataUrl, outPath);

    const tags = [aspect_ratio, image_size || (aspect_ratio ? "2K" : null)].filter(Boolean).join(", ");
    return {
      content: `Image saved: ${outPath}${tags ? ` (${tags})` : ""}`,
      attachImages: [outPath],
    };
  } catch (e) {
    return `ERROR: ${e.message}`;
  }
}

export const tools = {
  generate_image: {
    schema, run, requiredEnv,
    promptSnippet: "generate_image: text-to-image via OpenRouter Gemini 3 Pro Image. aspect_ratio honored natively (16:9 thumbnails, 9:16 shorts, etc). Pass reference_images for edits/variations/identity.",
  },
};
