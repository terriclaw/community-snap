import { Hono } from "hono";
import { cors } from "hono/cors";

const MAX = 37;

type Env = {
  KV: KVNamespace;
  NEYNAR_API_KEY: string;
  SNAP_PUBLIC_BASE_URL: string;
};

// ── KV helpers ────────────────────────────────────────────────────────────────
async function getWall(kv: KVNamespace): Promise<number[]> {
  const raw = await kv.get("wall");
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

async function saveWall(kv: KVNamespace, wall: number[]): Promise<void> {
  await kv.put("wall", JSON.stringify(wall));
}

async function getUsernames(kv: KVNamespace): Promise<Record<number, string>> {
  const raw = await kv.get("usernames");
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

async function saveUsernames(kv: KVNamespace, usernames: Record<number, string>): Promise<void> {
  await kv.put("usernames", JSON.stringify(usernames));
}

async function getEverFull(kv: KVNamespace): Promise<boolean> {
  return (await kv.get("wall_full")) !== null;
}

async function setEverFull(kv: KVNamespace): Promise<void> {
  await kv.put("wall_full", new Date().toISOString());
}

// ── JFS parser ────────────────────────────────────────────────────────────────
function parseFid(body: any): number {
  try {
    const payload = JSON.parse(atob(body.payload.replace(/-/g, "+").replace(/_/g, "/")));
    return payload.fid ?? 0;
  } catch { return 0; }
}

// ── Queue ─────────────────────────────────────────────────────────────────────
async function enterFid(kv: KVNamespace, fid: number): Promise<"already_in" | "entered"> {
  const wall = await getWall(kv);
  if (wall.includes(fid)) return "already_in";
  wall.push(fid);
  if (wall.length > MAX) wall.shift();
  await saveWall(kv, wall);
  if (wall.length === MAX) await setEverFull(kv);
  return "entered";
}

// ── Neynar ────────────────────────────────────────────────────────────────────
async function resolveUsername(kv: KVNamespace, fid: number, neynarKey: string): Promise<void> {
  const usernames = await getUsernames(kv);
  if (usernames[fid]) return;
  try {
    const res = await fetch(`https://api.neynar.com/v2/farcaster/user/bulk?fids=${fid}`, {
      headers: { "x-api-key": neynarKey },
    });
    if (!res.ok) return;
    const data = await res.json() as { users: { username: string }[] };
    const username = data.users?.[0]?.username ?? `fid:${fid}`;
    usernames[fid] = username;
    await saveUsernames(kv, usernames);
  } catch { }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fidColor(fid: number): string {
  const colors = ["red", "amber", "green", "teal", "blue", "purple", "pink"];
  return colors[fid % colors.length];
}

function wallSubtitle(wall: number[], everFull: boolean): string {
  if (everFull) return "The 37 users of Farcaster";
  if (wall.length === 0) return "Be the first";
  if (wall.length === 1) return "1 person has appeared";
  return `${wall.length} people have appeared`;
}

// ── Snap builders ─────────────────────────────────────────────────────────────
function buildGate(base: string, wall: number[], everFull: boolean) {
  return {
    version: "1.0",
    theme: { accent: everFull ? "pink" : "purple" },
    ui: {
      root: "page",
      elements: {
        page: { type: "stack", props: { gap: "sm" }, children: ["title", "subtitle", "sep", "btn"] },
        title: { type: "text", props: { content: "Meet The Farcaster Community", weight: "bold" } },
        subtitle: { type: "text", props: { content: wallSubtitle(wall, everFull), size: "sm" } },
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

function buildView(
  base: string,
  wall: number[],
  usernames: Record<number, string>,
  everFull: boolean,
  viewerFid: number,
  justEntered: boolean = false
) {
  const elements: Record<string, unknown> = {};
  const pageChildren: string[] = [];
  const onWall = wall.includes(viewerFid);

  elements["title"] = {
    type: "text",
    props: { content: everFull ? "We found them." : "Meet The Farcaster Community", weight: "bold" },
  };
  elements["subtitle"] = {
    type: "text",
    props: { content: wallSubtitle(wall, everFull), size: "sm" },
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
      const name = usernames[fid] ?? `fid:${fid}`;
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

  return {
    version: "1.0",
    theme: { accent: onWall ? fidColor(viewerFid) : everFull ? "pink" : "purple" },
    ui: { root: "page", elements },
  };
}

// ── App ───────────────────────────────────────────────────────────────────────
const app = new Hono<{ Bindings: Env }>();

app.use("*", cors({
  origin: "*",
  allowMethods: ["GET", "POST", "OPTIONS"],
  allowHeaders: ["Accept", "Content-Type", "Authorization"],
}));

app.get("/", async (c) => {
  const accept = c.req.header("Accept") ?? "";
  const wall = await getWall(c.env.KV);
  const everFull = await getEverFull(c.env.KV);
  const base = c.env.SNAP_PUBLIC_BASE_URL.replace(/\/$/, "");
  if (accept.includes("application/vnd.farcaster.snap+json")) {
    return c.json(buildGate(base, wall, everFull), 200, {
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

app.post("/view", async (c) => {
  const body = await c.req.json();
  const fid = parseFid(body);
  console.log("VIEW fid:", fid);
  const base = c.env.SNAP_PUBLIC_BASE_URL.replace(/\/$/, "");
  if (fid) await resolveUsername(c.env.KV, fid, c.env.NEYNAR_API_KEY);
  const wall = await getWall(c.env.KV);
  const usernames = await getUsernames(c.env.KV);
  const everFull = await getEverFull(c.env.KV);
  return c.json(buildView(base, wall, usernames, everFull, fid), 200, {
    "Content-Type": "application/vnd.farcaster.snap+json",
  });
});

app.post("/enter", async (c) => {
  const body = await c.req.json();
  const fid = parseFid(body);
  console.log("ENTER fid:", fid);
  const base = c.env.SNAP_PUBLIC_BASE_URL.replace(/\/$/, "");
  const wallBefore = await getWall(c.env.KV);
  const wasFullBefore = wallBefore.length === MAX;
  const result = fid ? await enterFid(c.env.KV, fid) : "already_in";
  if (fid) await resolveUsername(c.env.KV, fid, c.env.NEYNAR_API_KEY);
  const wall = await getWall(c.env.KV);
  const usernames = await getUsernames(c.env.KV);
  const everFull = await getEverFull(c.env.KV);
  const snap = buildView(base, wall, usernames, everFull, fid, result === "entered") as any;
  if (!wasFullBefore && wall.length === MAX) snap.effects = ["confetti"];
  return c.json(snap, 200, {
    "Content-Type": "application/vnd.farcaster.snap+json",
  });
});

export default app;
