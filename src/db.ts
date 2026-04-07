import { readFileSync, writeFileSync, existsSync } from "fs";

const WALL_FILE = "wall.json";
const USERNAMES_FILE = "usernames.json";

export function loadWall(): number[] {
  if (!existsSync(WALL_FILE)) return [];
  try { return JSON.parse(readFileSync(WALL_FILE, "utf8")); } catch { return []; }
}

export function saveWall(wall: number[]): void {
  writeFileSync(WALL_FILE, JSON.stringify(wall));
}

export function loadUsernames(): Record<number, string> {
  if (!existsSync(USERNAMES_FILE)) return {};
  try { return JSON.parse(readFileSync(USERNAMES_FILE, "utf8")); } catch { return {}; }
}

export function saveUsernames(usernames: Record<number, string>): void {
  writeFileSync(USERNAMES_FILE, JSON.stringify(usernames));
}
