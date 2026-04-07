import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { registerSnapHandler } from "@farcaster/snap-hono";
import { rateLimit } from "./ratelimit.js";
import { loadWall, saveWall, loadUsernames, saveUsernames } from "./db.js";
import { writeFileSync, existsSync } from "fs";

const MAX = 37;
const wall: number[] = loadWall();
const usernameCache: Record<number, string> = loadUsernames();

const FULL_FILE = "wall_full.json";
let everFull: boolean = existsSync(FULL_FILE);

function setEverFull(): void {
  if (!everFull) {
    everFull = true;
    writeFileSync(FULL_FILE, JSON.stringify({ reached: new Date().toISOString() }));
  }
}

// FIFO: append to back, trim from front
function enterFid(fid: number): "already_in" | "entered" {
  if (wall.includes(fid)) return "already_in";
  wall.push(fid);
  if (wall.length > MAX) wall.shift();
  if (wall.length === MAX) setEverFull();
  saveWall(wall);
  return "entered";
}

async function resolveUsername(fid: number): Promise<string> {
  if (usernameCache[fid]) return usernameCache[fid];
  try {
    const res = await fetch(`https://api.neynar.com/v2/farcaster/user/bulk?fids=${fid}`, {
      headers: { "x-api-key": process.env.NEYNAR_API_KEY ?? "" },
    });
    if (!res.ok) throw new Error(`neynar ${res.status}`);
    const data = await res.json() as { users: { username: string }[] };
    const username = data.users?.[0]?.username ?? `fid:${fid}`;
    usernameCache[fid] = username;
    saveUsernames(usernameCache);
    return username;
  } catch {
    return `fid:${fid}`;
  }
}

function baseUrl(req: Request): string {
  const fromEnv = process.env.SNAP_PUBLIC_BASE_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  const fwdHost = req.headers.get("x-forwarded-host");
  const host = (fwdHost ?? req.headers.get("host") ?? "").split(",")[0].trim();
  const isLoopback = /^(localhost|127\.0\.0\.1|\[::1\]|::1)(:\d+)?$/.test(host);
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0].trim().toLowerCase()
    ?? (isLoopback ? "http" : "https");
  return host ? `${proto}://${host}` : `http://localhost:${process.env.PORT ?? "3003"}`;
}

function fidColor(fid: number): string {
  const colors = ["red", "amber", "green", "teal", "blue", "purple", "pink"];
  return colors[fid % colors.length];
}

function wallSubtitle(): string {
  if (everFull) return "The 37 users of Farcaster";
  if (wall.length === 0) return "Be the first";
  if (wall.length === 1) return "1 person has appeared";
  return `${wall.length} people have appeared`;
}

function buildGate(base: string) {
  return {
    version: "1.0",
    theme: { accent: everFull ? "pink" : "purple" },
    ui: {
      root: "page",
      elements: {
        page: { type: "stack", props: { gap: "sm" }, children: ["title", "subtitle", "sep", "btn"] },
        title: { type: "text", props: { content: "Meet The Farcaster Community", weight: "bold" } },
        subtitle: { type: "text", props: { content: wallSubtitle(), size: "sm" } },
        sep: { type: "separator", props: {} },
        btn: {
          type: "button",
          props: { label: "View", variant: "primary" },
          on: { press: { action: "submit", params: { target: `${base}/view` } } },
        },
      },
    },
  };
}

function buildView(base: string, viewerFid: number, justEntered: boolean = false) {
  const elements: Record<string, unknown> = {};
  const pageChildren: string[] = [];
  const onWall = wall.includes(viewerFid);

  elements["title"] = {
    type: "text",
    props: { content: everFull ? "We found them." : "Meet The Farcaster Community", weight: "bold" },
  };
  elements["subtitle"] = {
    type: "text",
    props: { content: wallSubtitle(), size: "sm" },
  };
  pageChildren.push("title", "subtitle");

  if (justEntered) {
    elements["feedback"] = {
      type: "text",
      props: { content: "✓ You entered", size: "sm", align: "center" },
    };
    pageChildren.push("feedback");
  }

  elements["sep1"] = { type: "separator", props: {} };
  pageChildren.push("sep1");

  if (wall.length === 0) {
    elements["empty"] = { type: "text", props: { content: "No one yet.", size: "sm", align: "center" } };
    pageChildren.push("empty");
  } else {
    for (let i = 0; i < wall.length; i++) {
      const fid = wall[i];
      const isYou = fid === viewerFid;
      const name = usernameCache[fid] ?? `fid:${fid}`;
      elements[`badge-${i}`] = {
        type: "badge",
        props: { label: `#${i + 1}`, color: fidColor(fid), variant: "outline" },
      };
      elements[`label-${i}`] = {
        type: "text",
        props: { content: isYou ? `@${name}  ←` : `@${name}`, size: "sm" },
      };
      elements[`row-${i}`] = {
        type: "stack",
        props: { direction: "horizontal", gap: "sm" },
        children: [`badge-${i}`, `label-${i}`],
      };
      pageChildren.push(`row-${i}`);
    }
  }

  elements["sep2"] = { type: "separator", props: {} };
  pageChildren.push("sep2");

  if (onWall) {
    elements["status"] = {
      type: "text",
      props: { content: "You're in the Farcaster Community!", size: "sm", align: "center" },
    };
    pageChildren.push("status");
  } else {
    elements["enter-btn"] = {
      type: "button",
      props: { label: "Tap to enter", variant: "primary" },
      on: { press: { action: "submit", params: { target: `${base}/enter` } } },
    };
    pageChildren.push("enter-btn");
  }

  elements["refresh-btn"] = {
    type: "button",
    props: { label: "Refresh", variant: "secondary", icon: "refresh-cw" },
    on: { press: { action: "submit", params: { target: `${base}/view` } } },
  };
  pageChildren.push("refresh-btn");

  elements["page"] = { type: "stack", props: { gap: "sm" }, children: pageChildren };

  const snap: Record<string, unknown> = {
    version: "1.0",
    theme: { accent: onWall ? fidColor(viewerFid) : everFull ? "pink" : "purple" },
    ui: { root: "page", elements },
  };

  return snap;
}

const app = new Hono();

app.use("*", rateLimit(20));
app.use("*", cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"], allowHeaders: ["Accept", "Content-Type", "Authorization"] }));

app.get("/", async (c) => {
  const accept = c.req.header("Accept") ?? "";
  if (accept.includes("application/vnd.farcaster.snap+json")) {
    return c.json(buildGate(baseUrl(c.req.raw)), 200, {
      "Content-Type": "application/vnd.farcaster.snap+json",
      "Vary": "Accept",
    });
  }
  return c.html(`<!DOCTYPE html><html><body style="font-family:monospace;padding:2rem">
    <h1>Meet The Farcaster Community</h1>
    <p>Wall: ${wall.length}/${MAX}</p>
    <p>${everFull ? "🔥 The 37 have been found." : "Still searching..."}</p>
    <p>Open in Farcaster to interact.</p>
  </body></html>`);
});

// VIEW — show wall, no mutation
registerSnapHandler(
  app,
  async (ctx) => {
    const fid = ctx.action.fid;
    await resolveUsername(fid);
    return buildView(baseUrl(ctx.request), fid) as any;
  },
  { path: "/view" }
);

// ENTER — add to queue if not already in
registerSnapHandler(
  app,
  async (ctx) => {
    const fid = ctx.action.fid;
    const wasFullBefore = wall.length === MAX;
    const result = enterFid(fid);
    await resolveUsername(fid);
    const snap = buildView(baseUrl(ctx.request), fid, result === "entered") as any;
    if (!wasFullBefore && wall.length === MAX) {
      snap.effects = ["confetti"];
    }
    return snap;
  },
  { path: "/enter" }
);

const port = parseInt(process.env.PORT ?? "3003");
console.log(`Community Snap → http://localhost:${port}`);
serve({ fetch: app.fetch, port });
