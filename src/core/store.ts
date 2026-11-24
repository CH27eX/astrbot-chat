import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type {
  AttachmentRecord,
  ChatMessage,
  Profile,
  ProfileInput,
  Session,
  Sticker,
} from "./types";
import { normalizeBaseUrl, uid } from "./utils";

interface ChatDB extends DBSchema {
  profiles: {
    key: string;
    value: Profile;
  };
  sessions: {
    key: string;
    value: Session;
    indexes: {
      "by-profile": string;
      "by-updated": number;
    };
  };
  messages: {
    key: string;
    value: ChatMessage;
    indexes: {
      "by-session": string;
      "by-created": number;
    };
  };
  attachments: {
    key: string;
    value: AttachmentRecord;
  };
  stickers: {
    key: string;
    value: Sticker;
  };
  settings: {
    key: string;
    value: { key: string; value: unknown };
  };
}

let dbPromise: Promise<IDBPDatabase<ChatDB>> | null = null;

function getDB(): Promise<IDBPDatabase<ChatDB>> {
  if (!dbPromise) {
    dbPromise = openDB<ChatDB>("astrbot-chat", 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains("profiles")) {
          db.createObjectStore("profiles", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("sessions")) {
          const store = db.createObjectStore("sessions", { keyPath: "id" });
          store.createIndex("by-profile", "profileId");
          store.createIndex("by-updated", "updatedAt");
        }
        if (!db.objectStoreNames.contains("messages")) {
          const store = db.createObjectStore("messages", { keyPath: "id" });
          store.createIndex("by-session", "sessionId");
          store.createIndex("by-created", "createdAt");
        }
        if (!db.objectStoreNames.contains("attachments")) {
          db.createObjectStore("attachments", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("stickers")) {
          db.createObjectStore("stickers", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("settings")) {
          db.createObjectStore("settings", { keyPath: "key" });
        }
      },
    });
  }
  return dbPromise;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getSetting<T>(key: string): Promise<T | null> {
  const db = await getDB();
  const row = await db.get("settings", key);
  return (row?.value as T | undefined) ?? null;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  const db = await getDB();
  await db.put("settings", { key, value });
}

export async function getActiveProfileId(): Promise<string | null> {
  return getSetting<string>("activeProfileId");
}

export async function setActiveProfileId(id: string | null): Promise<void> {
  await setSetting("activeProfileId", id);
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

export async function listProfiles(): Promise<Profile[]> {
  const db = await getDB();
  const profiles = await db.getAll("profiles");
  return profiles.sort((a, b) => a.createdAt - b.createdAt);
}

export async function getProfile(id: string): Promise<Profile | null> {
  const db = await getDB();
  return (await db.get("profiles", id)) ?? null;
}

export async function upsertProfile(input: ProfileInput): Promise<Profile> {
  const db = await getDB();
  const now = Date.now();
  const existing = input.id ? await db.get("profiles", input.id) : undefined;
  const profile: Profile = {
    id: existing?.id ?? input.id ?? uid(),
    name: input.name.trim() || "AstrBot",
    baseUrl: normalizeBaseUrl(input.baseUrl),
    username: input.username.trim() || "astrbot",
    apiKey: input.apiKey.trim(),
    kind: input.kind,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await db.put("profiles", profile);
  await setActiveProfileId(profile.id);
  return profile;
}

export async function deleteProfile(id: string): Promise<void> {
  const db = await getDB();
  const sessionIds = (await db.getAllFromIndex("sessions", "by-profile", id)).map(
    (session) => session.id,
  );
  for (const sessionId of sessionIds) {
    await deleteSession(sessionId);
  }
  await db.delete("profiles", id);
  const active = await getActiveProfileId();
  if (active === id) {
    await setActiveProfileId(null);
  }
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export async function getSession(id: string): Promise<Session | null> {
  const db = await getDB();
  return (await db.get("sessions", id)) ?? null;
}

export async function listSessions(profileId: string): Promise<Session[]> {
  const db = await getDB();
  const sessions = await db.getAllFromIndex("sessions", "by-profile", profileId);
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getActiveSessionId(profileId: string): Promise<string | null> {
  return getSetting<string>(`activeSession:${profileId}`);
}

export async function setActiveSessionId(
  profileId: string,
  sessionId: string,
): Promise<void> {
  await setSetting(`activeSession:${profileId}`, sessionId);
}

export async function createSession(
  profileId: string,
  title = "新对话",
): Promise<Session> {
  const db = await getDB();
  const now = Date.now();
  const session: Session = {
    id: uid(),
    profileId,
    title,
    createdAt: now,
    updatedAt: now,
  };
  await db.put("sessions", session);
  await setActiveSessionId(profileId, session.id);
  return session;
}

export async function ensureSession(profileId: string): Promise<Session> {
  const activeId = await getActiveSessionId(profileId);
  if (activeId) {
    const existing = await getSession(activeId);
    if (existing && existing.profileId === profileId) return existing;
  }
  return createSession(profileId);
}

export async function touchSession(
  sessionId: string,
  options: { title?: string } = {},
): Promise<void> {
  const db = await getDB();
  const session = await db.get("sessions", sessionId);
  if (!session) return;
  session.updatedAt = Date.now();
  if (options.title) session.title = options.title;
  await db.put("sessions", session);
}

export async function deleteSession(sessionId: string): Promise<void> {
  const db = await getDB();
  const messageKeys = await db.getAllKeysFromIndex(
    "messages",
    "by-session",
    sessionId,
  );
  const tx = db.transaction(["messages", "sessions"], "readwrite");
  for (const key of messageKeys) {
    await tx.objectStore("messages").delete(key);
  }
  await tx.objectStore("sessions").delete(sessionId);
  await tx.done;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export async function listMessages(sessionId: string): Promise<ChatMessage[]> {
  const db = await getDB();
  const messages = await db.getAllFromIndex("messages", "by-session", sessionId);
  return messages.sort((a, b) => a.createdAt - b.createdAt);
}

export async function putMessage(message: ChatMessage): Promise<void> {
  const db = await getDB();
  await db.put("messages", message);
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

export function attachmentKey(profileId: string, attachmentId: string): string {
  return `${profileId}:${attachmentId}`;
}

export async function putAttachment(
  id: string,
  blob: Blob,
  mime: string,
  filename: string,
): Promise<void> {
  const db = await getDB();
  const record: AttachmentRecord = {
    id,
    blob,
    mime,
    filename,
    createdAt: Date.now(),
  };
  await db.put("attachments", record);
}

export async function getAttachment(
  id: string,
): Promise<AttachmentRecord | null> {
  const db = await getDB();
  return (await db.get("attachments", id)) ?? null;
}

// ---------------------------------------------------------------------------
// Stickers
// ---------------------------------------------------------------------------

export async function listStickers(): Promise<Sticker[]> {
  const db = await getDB();
  const stickers = await db.getAll("stickers");
  return stickers.sort((a, b) => a.createdAt - b.createdAt);
}

export async function addSticker(
  name: string,
  blob: Blob,
  mime: string,
): Promise<Sticker> {
  const db = await getDB();
  const sticker: Sticker = {
    id: uid(),
    name,
    mime,
    createdAt: Date.now(),
  };
  await db.put("stickers", sticker);
  await putAttachment(`sticker:${sticker.id}`, blob, mime, `${name}.png`);
  return sticker;
}

export async function getStickerBlob(stickerId: string): Promise<Blob | null> {
  const record = await getAttachment(`sticker:${stickerId}`);
  return record?.blob ?? null;
}

export async function deleteSticker(stickerId: string): Promise<void> {
  const db = await getDB();
  await db.delete("stickers", stickerId);
  await db.delete("attachments", `sticker:${stickerId}`);
}

// ---------------------------------------------------------------------------
// Seed stickers (original, generated at runtime; no third-party assets)
// ---------------------------------------------------------------------------

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

async function makeSticker(
  label: string,
  from: string,
  to: string,
  accent: string,
): Promise<{ name: string; blob: Blob } | null> {
  const canvas = document.createElement("canvas");
  canvas.width = 360;
  canvas.height = 360;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const gradient = ctx.createLinearGradient(0, 0, 360, 360);
  gradient.addColorStop(0, from);
  gradient.addColorStop(1, to);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 360, 360);

  ctx.globalAlpha = 0.18;
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(292, 62, 108, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(54, 310, 76, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.fillStyle = "rgba(15, 17, 21, 0.22)";
  roundRect(ctx, 34, 42, 292, 276, 44);
  ctx.fill();

  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = 3;
  roundRect(ctx, 34, 42, 292, 276, 44);
  ctx.stroke();

  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.arc(112, 132, 12, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(248, 132, 12, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = accent;
  ctx.lineWidth = 7;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(180, 168, 48, 0.18 * Math.PI, 0.82 * Math.PI);
  ctx.stroke();

  ctx.fillStyle = "#ffffff";
  ctx.font =
    '800 74px "Microsoft YaHei", "PingFang SC", "Segoe UI Emoji", sans-serif';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, 180, 286);

  const blob = await canvasToPng(canvas);
  if (!blob) return null;
  return { name: label, blob };
}

let seedPromise: Promise<void> | null = null;

export function seedStickers(): Promise<void> {
  if (!seedPromise) {
    seedPromise = doSeedStickers().catch((error) => {
      seedPromise = null;
      throw error;
    });
  }
  return seedPromise;
}

async function doSeedStickers(): Promise<void> {
  const seeded = await getSetting<boolean>("stickersSeeded");
  if (seeded) return;
  const existing = await listStickers();
  if (existing.length > 0) {
    await setSetting("stickersSeeded", true);
    return;
  }

  const samples: Array<[string, string, string, string]> = [
    ["好耶", "#ff7a59", "#ffb86b", "#3b1d16"],
    ["在的", "#4f8cff", "#6ee7ff", "#0b2447"],
    ["笑死", "#f7b955", "#ffdf7e", "#4a2c00"],
    ["？", "#8b5cf6", "#d8b4fe", "#2a105e"],
    ["冲", "#22c55e", "#86efac", "#06351a"],
    ["晚安", "#334155", "#64748b", "#0b1220"],
  ];

  for (const [label, from, to, accent] of samples) {
    const sticker = await makeSticker(label, from, to, accent);
    if (sticker) {
      await addSticker(sticker.name, sticker.blob, "image/png");
    }
  }
  await setSetting("stickersSeeded", true);
}
