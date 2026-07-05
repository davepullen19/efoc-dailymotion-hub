import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import { openAsBlob } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Trim in case the values were pasted into .env with stray spaces/quotes.
const DM_API_KEY = (process.env.DM_API_KEY || '').trim().replace(/^["']|["']$/g, '');
const DM_API_SECRET = (process.env.DM_API_SECRET || '').trim().replace(/^["']|["']$/g, '');
const PORT = process.env.PORT || 3000;

// Dailymotion PRIVATE (Partner) API endpoints
const BASE = 'https://partner.api.dailymotion.com';
const TOKEN_URL = `${BASE}/oauth/v1/token`;
const AUTH_URL = `${BASE}/rest/auth`;
const UPLOAD_URL_ENDPOINT = `${BASE}/rest/file/upload`;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
// Write temp uploads to the OS temp dir — the project dir is read-only on Vercel.
const upload = multer({ dest: os.tmpdir() });

// Pull a human-readable message out of whatever shape Dailymotion returned.
function describe(data) {
  return (
    data?.error_description ||
    data?.error?.message ||
    (typeof data?.error === 'string' ? data.error : null) ||
    data?.message ||
    JSON.stringify(data)
  );
}

// Cache the token + org identity so we don't re-authenticate on every request.
let cache = null; // { token, expiresAt, org: {id, username, screenname} }

/**
 * Get an access token using the client_credentials grant — just the API key
 * and secret, no user login. Also looks up the org profile the token belongs to.
 * Result is cached until shortly before the token expires.
 */
async function authenticate() {
  if (cache && cache.expiresAt > Date.now() + 30_000) return cache;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: DM_API_KEY,
      client_secret: DM_API_SECRET,
      scope: 'manage_videos',
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error(
      `    token endpoint HTTP ${res.status}; ` +
      `key length=${DM_API_KEY.length}, secret length=${DM_API_SECRET.length}`
    );
    throw new Error(`Auth failed: ${describe(data)}`);
  }
  const token = data.access_token;

  // Which org does this token act as? Its children are the profiles we can
  // upload to.
  const authRes = await fetch(
    `${AUTH_URL}?fields=id,username,screenname`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const auth = await authRes.json();
  if (!authRes.ok || !auth.id) {
    throw new Error(`Could not determine profile id: ${describe(auth)}`);
  }

  cache = {
    token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    org: { id: auth.id, username: auth.username, screenname: auth.screenname },
  };
  return cache;
}

/**
 * The profiles you can upload to. Dailymotion restricts the API connection
 * that would list an organization's profiles, so we read them from
 * profiles.json (label + id) instead. The authenticated profile is always
 * included. Get each id from Studio: click a profile and copy the id from the
 * URL — dailymotion.com/partner/{ID}/media/video.
 */
function listProfiles(org) {
  let configured = [];
  const file = path.join(__dirname, 'profiles.json');
  if (fs.existsSync(file)) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      configured = (Array.isArray(raw) ? raw : []).map((p) => ({
        id: p.id,
        screenname: p.label || p.screenname || p.id,
        username: p.label || p.username || p.id,
      }));
    } catch (err) {
      console.error(`⚠ Could not parse profiles.json: ${err.message}`);
    }
  }

  const byId = new Map();
  for (const p of [org, ...configured]) if (p.id) byId.set(p.id, p);
  return [...byId.values()].sort((a, b) =>
    (a.screenname || '').localeCompare(b.screenname || '')
  );
}

/** Ask for a one-time upload URL. */
async function getUploadUrl(token) {
  const res = await fetch(UPLOAD_URL_ENDPOINT, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (!res.ok || !data.upload_url) {
    throw new Error(`Could not get upload URL: ${describe(data)}`);
  }
  return data.upload_url;
}

/** POST the raw file to the upload URL; returns the hosted file `url`. */
async function uploadFile(uploadUrl, file) {
  // Use the native FormData + a file-backed Blob so fetch sets the multipart
  // boundary and Content-Length correctly (the form-data package does not).
  const blob = await openAsBlob(file.path, { type: file.mimetype });
  const form = new FormData();
  form.append('file', blob, file.originalname);
  const res = await fetch(uploadUrl, { method: 'POST', body: form });
  const data = await res.json();
  if (!res.ok || !data.url) {
    throw new Error(`File upload failed: ${describe(data)}`);
  }
  return data.url;
}

/** Create & publish the video with the chosen fields. */
async function createVideo(token, profileId, fileUrl, fields) {
  const body = new URLSearchParams({ url: fileUrl });
  body.set('title', fields.title);
  body.set('channel', fields.channel);
  body.set('published', fields.published ? 'true' : 'false');
  body.set('is_created_for_kids', fields.is_created_for_kids ? 'true' : 'false');
  body.set('private', fields.private ? 'true' : 'false');
  if (fields.description) body.set('description', fields.description);
  if (fields.tags) body.set('tags', fields.tags);

  const res = await fetch(`${BASE}/rest/user/${profileId}/videos`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Video creation failed: ${describe(data)}`);
  }
  return data;
}

/** Make a video public on Dailymotion: published + not private. */
async function publishVideo(token, id) {
  const body = new URLSearchParams({ published: 'true', private: 'false' });
  const res = await fetch(`${BASE}/rest/video/${id}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Publish failed: ${describe(data)}`);
  return data;
}

/**
 * Update editable metadata on an existing video. Only fields present in
 * `fields` are sent, so a caller updating just the description never touches
 * the title or tags. Empty descriptions are allowed (clears the field).
 */
async function updateVideoFields(token, id, fields) {
  const body = new URLSearchParams();
  if (fields.title != null) body.set('title', fields.title);
  if (fields.description != null) body.set('description', fields.description);
  if (fields.tags != null) body.set('tags', fields.tags);
  if ([...body.keys()].length === 0) {
    throw new Error('Nothing to update — provide at least one field.');
  }

  const res = await fetch(`${BASE}/rest/video/${id}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Update failed: ${describe(data)}`);
  return data;
}

/** Permanently delete a video from Dailymotion. */
async function deleteVideo(token, id) {
  const res = await fetch(`${BASE}/rest/video/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  // A successful delete may come back as 204 No Content or an empty body.
  if (res.status === 204) return {};
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`Delete failed: ${describe(data)}`);
  return data;
}

// The video fields we pull back for the browse/table view.
const VIDEO_FIELDS = [
  'id', 'title', 'description', 'tags', 'channel', 'duration', 'created_time',
  'views_total', 'private', 'published', 'is_created_for_kids', 'status',
  'url', 'embed_url', 'thumbnail_240_url', 'owner.id', 'owner.screenname',
].join(',');

/**
 * Page through every video owned by a profile (100 per page). Dailymotion
 * returns `{ list, has_more, … }`; we follow `has_more` up to a safety cap.
 */
async function fetchVideosForProfile(token, profileId, pageCap = 20) {
  const all = [];
  for (let page = 1; page <= pageCap; page++) {
    const params = new URLSearchParams({
      fields: VIDEO_FIELDS,
      limit: '100',
      page: String(page),
      sort: 'recent',
    });
    const res = await fetch(`${BASE}/rest/user/${profileId}/videos?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`List videos failed: ${describe(data)}`);
    all.push(...(data.list || []));
    if (!data.has_more) return all;
  }
  console.warn(`⚠ hit page cap (${pageCap}) listing videos for ${profileId}; results may be truncated.`);
  return all;
}

/** Re-read a single video's table fields (used after a publish). */
async function fetchVideoById(token, id) {
  const res = await fetch(
    `${BASE}/rest/video/${id}?fields=${encodeURIComponent(VIDEO_FIELDS)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(`Fetch video failed: ${describe(data)}`);
  return data;
}

/** True if the video carries `tag` (case-insensitive, ignoring a leading #). */
function hasTag(video, tag) {
  const want = tag.replace(/^#/, '').toLowerCase();
  return (video.tags || []).some(
    (t) => String(t).replace(/^#/, '').toLowerCase() === want
  );
}

/**
 * Pull the stage name out of a `stage:<name>` tag, if present (case-insensitive).
 * Returns null when the video isn't tagged with a stage.
 */
function extractStage(video) {
  const t = (video.tags || []).find((x) => /^stage:/i.test(String(x)));
  return t ? String(t).replace(/^stage:/i, '').trim() || null : null;
}

/**
 * Hit the Dailymotion API: list every video carrying `tag` across all
 * profiles, dedupe, attach the parsed stage, and return newest-first.
 */
async function collectVideosByTag(tag) {
  const { token, org } = await authenticate();
  const profiles = listProfiles(org);

  // Query each profile in parallel; a failure on one shouldn't sink the rest.
  const perProfile = await Promise.all(
    profiles.map((p) =>
      fetchVideosForProfile(token, p.id).catch((err) => {
        console.error(`⚠ could not list videos for ${p.id}: ${err.message}`);
        return [];
      })
    )
  );

  const byId = new Map();
  for (const v of perProfile.flat()) {
    if (hasTag(v, tag) && !byId.has(v.id)) {
      v.stage = extractStage(v);
      byId.set(v.id, v);
    }
  }
  return [...byId.values()].sort(
    (a, b) => (b.created_time || 0) - (a.created_time || 0)
  );
}

// Where the pulled videos live. When KV is configured (Vercel), every video is
// stored as its OWN record (`video:<id>`), with a per-tag index set of ids
// (`tag:<tag>:ids`) and a small meta record for the "last updated" time. This
// makes the DB the shared, durable source of truth: reads on any serverless
// instance see the same records, and each video can be read/updated on its own.
// Done marks stay a separate set (`done:videos`) — unchanged. Locally (no KV)
// we fall back to an in-memory Map + best-effort disk file so `npm start` works.
const CACHE_FILE = path.join(__dirname, 'videos-cache.json');
const memCache = new Map(); // key -> { tag, cachedAt, videos }
const videoRecKey = (id) => `video:${id}`;
const tagSetKey = (key) => `tag:${key}:ids`;
const tagMetaKey = (key) => `tag:${key}:meta`;

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeCache(cache) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch {
    // Read-only filesystem (e.g. Vercel without KV) — nothing we can do.
  }
}

/** Read a tag's videos from the DB (per-video records) or local fallback. */
async function readEntry(key) {
  if (KV_ENABLED) {
    const client = await kvClient();
    const ids = await client.smembers(tagSetKey(key));
    if (!ids || !ids.length) return null;
    const recs = await client.mget(...ids.map(videoRecKey));
    const videos = recs
      .filter(Boolean)
      .sort((a, b) => (b.created_time || 0) - (a.created_time || 0));
    const meta = await client.get(tagMetaKey(key));
    return { tag: key, cachedAt: meta?.cachedAt || null, videos };
  }
  if (memCache.has(key)) return memCache.get(key);
  const disk = readCache()[key];
  if (disk) memCache.set(key, disk);
  return disk || null;
}

/** Pull fresh from Dailymotion, upsert each video as its own DB record, and
 *  reconcile the tag's id index (drop ids no longer returned). */
async function refreshTag(tag) {
  const key = tag.replace(/^#/, '').toLowerCase();
  const videos = await collectVideosByTag(tag);
  const cachedAt = new Date().toISOString();

  if (KV_ENABLED) {
    const client = await kvClient();
    const newIds = videos.map((v) => String(v.id));
    // Upsert every video record.
    await Promise.all(videos.map((v) => client.set(videoRecKey(v.id), v)));
    // Reconcile the tag index without ever emptying it (so concurrent reads
    // never see a gap): add the current ids, then remove any that vanished.
    const existing = (await client.smembers(tagSetKey(key))) || [];
    const stale = existing.filter((id) => !newIds.includes(id));
    if (newIds.length) await client.sadd(tagSetKey(key), ...newIds);
    if (stale.length) await client.srem(tagSetKey(key), ...stale);
    await client.set(tagMetaKey(key), { cachedAt });
  } else {
    const entry = { tag: key, cachedAt, videos };
    memCache.set(key, entry);
    const cache = readCache();
    cache[key] = entry;
    writeCache(cache);
  }
  return { tag: key, cachedAt, videos };
}

/** Patch the stored copy of a single video (KV record + local caches) so the
 *  table reflects a change without a full re-pull. */
async function updateStoredVideo(id, patch) {
  const sid = String(id);
  if (KV_ENABLED) {
    const client = await kvClient();
    const existing = await client.get(videoRecKey(sid));
    await client.set(videoRecKey(sid), { ...(existing || { id: sid }), ...patch });
    return;
  }
  // Local fallback: patch the video inside every cached tag entry that holds it.
  for (const entry of memCache.values()) {
    const v = entry.videos.find((x) => String(x.id) === sid);
    if (v) Object.assign(v, patch);
  }
  const cache = readCache();
  let touched = false;
  for (const key of Object.keys(cache)) {
    const v = (cache[key].videos || []).find((x) => String(x.id) === sid);
    if (v) { Object.assign(v, patch); touched = true; }
  }
  if (touched) writeCache(cache);
}

/** Remove a video from our stored copy after it's deleted on Dailymotion. */
async function deleteStoredVideo(id) {
  const sid = String(id);
  if (KV_ENABLED) {
    const client = await kvClient();
    // Drop the record and any done mark. The per-tag index sets are reconciled
    // on the next refresh; until then reads filter out the missing record.
    await client.del(videoRecKey(sid));
    await client.srem(DONE_KEY, sid);
    return;
  }
  for (const entry of memCache.values()) {
    entry.videos = (entry.videos || []).filter((x) => String(x.id) !== sid);
  }
  const cache = readCache();
  let touched = false;
  for (const key of Object.keys(cache)) {
    const before = (cache[key].videos || []).length;
    cache[key].videos = (cache[key].videos || []).filter((x) => String(x.id) !== sid);
    if (cache[key].videos.length !== before) touched = true;
  }
  if (touched) writeCache(cache);
  const ids = await getDoneIds();
  if (ids.delete(sid)) {
    try { fs.writeFileSync(DONE_FILE, JSON.stringify([...ids], null, 2)); } catch { /* read-only fs */ }
  }
}

// GET = serve from cache; only fetch from Dailymotion the first time a tag is
// requested (or after a cold start on Vercel, when memory is empty).
app.get('/api/videos', async (req, res) => {
  const tag = (req.query.tag || 'EFOC26').toString().trim();
  const key = tag.replace(/^#/, '').toLowerCase();
  try {
    let entry = await readEntry(key);
    let cached = true;
    if (!entry) {
      entry = await refreshTag(tag);
      cached = false;
    }
    res.json({ tag: key, cached, cachedAt: entry.cachedAt, count: entry.videos.length, videos: entry.videos });
  } catch (err) {
    console.error('✗ Could not list videos:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST = force a fresh fetch from Dailymotion and update the cache.
app.post('/api/videos/refresh', async (req, res) => {
  const tag = (req.query.tag || 'EFOC26').toString().trim();
  const key = tag.replace(/^#/, '').toLowerCase();
  try {
    const entry = await refreshTag(tag);
    res.json({ tag: key, cached: false, cachedAt: entry.cachedAt, count: entry.videos.length, videos: entry.videos });
  } catch (err) {
    console.error('✗ Could not refresh videos:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---- "Done" marks ---------------------------------------------------------
// Persist which videos have been marked done, keyed by video id, so the flag
// survives re-pulls from Dailymotion. On Vercel we use Vercel KV (Redis);
// locally (no KV env vars) we fall back to a JSON file so `npm start` works.
// Accept either the classic Vercel KV names or the Upstash Marketplace names,
// so it works however the integration injects the credentials.
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const KV_ENABLED = !!(KV_URL && KV_TOKEN);
const DONE_KEY = 'done:videos';
const DONE_FILE = path.join(__dirname, 'done.json');
const HIDDEN_KEY = 'hidden:videos';
const HIDDEN_FILE = path.join(__dirname, 'hidden.json');

let _kv = null;
async function kvClient() {
  if (!_kv) {
    const { createClient } = await import('@vercel/kv');
    _kv = createClient({ url: KV_URL, token: KV_TOKEN });
  }
  return _kv;
}

/** The set of video ids currently marked done. */
async function getDoneIds() {
  if (KV_ENABLED) {
    const ids = await (await kvClient()).smembers(DONE_KEY);
    return new Set(ids || []);
  }
  try {
    return new Set(JSON.parse(fs.readFileSync(DONE_FILE, 'utf8')));
  } catch {
    return new Set();
  }
}

/** Mark a video done (true) or not-done (false). */
async function setDone(id, done) {
  if (KV_ENABLED) {
    const client = await kvClient();
    if (done) await client.sadd(DONE_KEY, id);
    else await client.srem(DONE_KEY, id);
    return;
  }
  const ids = await getDoneIds();
  if (done) ids.add(id);
  else ids.delete(id);
  try {
    fs.writeFileSync(DONE_FILE, JSON.stringify([...ids], null, 2));
  } catch {
    // Read-only filesystem (e.g. Vercel without KV) — nothing we can do.
  }
}

app.get('/api/done', async (req, res) => {
  try {
    res.json({ done: [...(await getDoneIds())] });
  } catch (err) {
    console.error('✗ Could not read done marks:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/done', async (req, res) => {
  const id = req.body?.id != null ? String(req.body.id) : '';
  const done = req.body?.done === true || req.body?.done === 'true';
  if (!id) return res.status(400).json({ error: 'Missing video id.' });
  try {
    await setDone(id, done);
    res.json({ success: true, id, done });
  } catch (err) {
    console.error('✗ Could not update done mark:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Hidden marks work exactly like done marks (separate set), so hiding a video
// only tucks it away in the UI — it stays on Dailymotion and keeps its done
// status, which is restored when it's unhidden.
async function getHiddenIds() {
  if (KV_ENABLED) {
    const ids = await (await kvClient()).smembers(HIDDEN_KEY);
    return new Set(ids || []);
  }
  try {
    return new Set(JSON.parse(fs.readFileSync(HIDDEN_FILE, 'utf8')));
  } catch {
    return new Set();
  }
}

async function setHidden(id, hidden) {
  if (KV_ENABLED) {
    const client = await kvClient();
    if (hidden) await client.sadd(HIDDEN_KEY, id);
    else await client.srem(HIDDEN_KEY, id);
    return;
  }
  const ids = await getHiddenIds();
  if (hidden) ids.add(id);
  else ids.delete(id);
  try {
    fs.writeFileSync(HIDDEN_FILE, JSON.stringify([...ids], null, 2));
  } catch {
    // Read-only filesystem (e.g. Vercel without KV) — nothing we can do.
  }
}

app.get('/api/hidden', async (req, res) => {
  try {
    res.json({ hidden: [...(await getHiddenIds())] });
  } catch (err) {
    console.error('✗ Could not read hidden marks:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/hidden', async (req, res) => {
  const id = req.body?.id != null ? String(req.body.id) : '';
  const hidden = req.body?.hidden === true || req.body?.hidden === 'true';
  if (!id) return res.status(400).json({ error: 'Missing video id.' });
  try {
    await setHidden(id, hidden);
    res.json({ success: true, id, hidden });
  } catch (err) {
    console.error('✗ Could not update hidden mark:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Make a video public on Dailymotion (published + not private), then update
// our stored copy so the table reflects the new visibility.
app.post('/api/publish', async (req, res) => {
  const id = req.body?.id != null ? String(req.body.id) : '';
  if (!id) return res.status(400).json({ error: 'Missing video id.' });
  try {
    if (!DM_API_KEY || !DM_API_SECRET) {
      throw new Error('Set DM_API_KEY and DM_API_SECRET in your .env file.');
    }
    const { token } = await authenticate();
    await publishVideo(token, id);

    // Re-read the fresh state and patch our stored copy. If the follow-up read
    // fails, the publish still succeeded — patch the visibility fields anyway.
    let video = null;
    try {
      video = await fetchVideoById(token, id);
      video.stage = extractStage(video);
      await updateStoredVideo(id, video);
    } catch (readErr) {
      console.error(`⚠ published ${id} but could not re-read it: ${readErr.message}`);
      await updateStoredVideo(id, { private: false, published: true });
    }
    res.json({ success: true, id, video });
  } catch (err) {
    console.error('✗ Publish failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Update editable metadata (description, and optionally title/tags) on a video,
// then re-read the fresh state and patch our stored copy so the table reflects
// the change without a full re-pull. The Descriptions page uses this to push
// CSV-sourced descriptions to the matched Dailymotion video.
app.post('/api/update-video', async (req, res) => {
  const id = req.body?.id != null ? String(req.body.id) : '';
  if (!id) return res.status(400).json({ error: 'Missing video id.' });

  // Only forward fields the caller actually sent, so an unset field is never
  // blanked. (`description: ""` is a real value — clearing the description.)
  const fields = {};
  if ('title' in req.body) fields.title = String(req.body.title ?? '');
  if ('description' in req.body) fields.description = String(req.body.description ?? '');
  if ('tags' in req.body) fields.tags = String(req.body.tags ?? '');
  if (Object.keys(fields).length === 0) {
    return res.status(400).json({ error: 'No fields to update.' });
  }

  try {
    if (!DM_API_KEY || !DM_API_SECRET) {
      throw new Error('Set DM_API_KEY and DM_API_SECRET in your .env file.');
    }
    const { token } = await authenticate();
    await updateVideoFields(token, id, fields);

    // Re-read the fresh state and patch our stored copy. If the follow-up read
    // fails, the update still succeeded — patch the fields we sent anyway.
    let video = null;
    try {
      video = await fetchVideoById(token, id);
      video.stage = extractStage(video);
      await updateStoredVideo(id, video);
    } catch (readErr) {
      console.error(`⚠ updated ${id} but could not re-read it: ${readErr.message}`);
      await updateStoredVideo(id, fields);
    }
    res.json({ success: true, id, video });
  } catch (err) {
    console.error('✗ Update failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Permanently delete a video from Dailymotion, then drop our stored copy.
app.delete('/api/videos/:id', async (req, res) => {
  const id = String(req.params.id || '');
  if (!id) return res.status(400).json({ error: 'Missing video id.' });
  try {
    if (!DM_API_KEY || !DM_API_SECRET) {
      throw new Error('Set DM_API_KEY and DM_API_SECRET in your .env file.');
    }
    const { token } = await authenticate();
    await deleteVideo(token, id);
    await deleteStoredVideo(id);
    res.json({ success: true, id });
  } catch (err) {
    console.error('✗ Delete failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---- Description source (bundled tracker CSVs) ----------------------------
// The three EFOC trackers in trackers/*.csv are the source of truth for video
// descriptions. We parse them once (cached in memory) and expose only the
// fields the UI needs — media id, title, description — so the analytics/talent
// columns never leave the server.
const TRACKERS_DIR = path.join(__dirname, 'trackers');

/** Minimal RFC-4180-ish CSV parser: handles quoted fields with embedded
 *  commas, newlines, and doubled quotes. Returns an array of row arrays. */
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') { /* skip */ }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** A friendly label for a tracker file, e.g. day2.csv → "Day 2". */
function trackerLabel(file) {
  const m = file.match(/day\s*(\d+)/i);
  return m ? `Day ${m[1]}` : file.replace(/\.csv$/i, '');
}

/**
 * Normalize a CSV Tags cell into Dailymotion's comma-separated form:
 * split on commas, drop a leading "#", trim, dedupe (case-insensitive), rejoin.
 */
function normalizeTags(raw) {
  if (!raw) return '';
  const seen = new Set();
  const out = [];
  for (const part of String(raw).split(',')) {
    const tag = part.trim().replace(/^#+/, '').trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out.join(', ');
}

let descCache = null; // { rows, files, loadedAt }

/** Parse every trackers/*.csv into description rows (cached). */
function loadDescriptionRows() {
  if (descCache) return descCache;
  const rows = [];
  const files = [];
  let names = [];
  try {
    names = fs.readdirSync(TRACKERS_DIR).filter((f) => /\.csv$/i.test(f)).sort();
  } catch {
    names = [];
  }
  for (const name of names) {
    let parsed;
    try {
      parsed = parseCSV(fs.readFileSync(path.join(TRACKERS_DIR, name), 'utf8'));
    } catch (err) {
      console.error(`⚠ could not read tracker ${name}: ${err.message}`);
      continue;
    }
    if (!parsed.length) continue;
    const header = parsed[0].map((h) => h.trim().toLowerCase());
    const iMedia = header.findIndex((h) => h.includes('media id'));
    const iTitle = header.findIndex((h) => h === 'title');
    const iDesc = header.findIndex((h) => h === 'description');
    const iTags = header.findIndex((h) => h === 'tags');
    if (iTitle < 0 || iDesc < 0) {
      console.error(`⚠ tracker ${name} missing Title/Description columns`);
      continue;
    }
    const day = trackerLabel(name);
    let kept = 0;
    for (let r = 1; r < parsed.length; r++) {
      const line = parsed[r];
      const title = (line[iTitle] || '').trim();
      const description = (line[iDesc] || '').trim();
      const mediaId = iMedia >= 0 ? (line[iMedia] || '').trim() : '';
      const tags = iTags >= 0 ? normalizeTags(line[iTags]) : '';
      if (title && (description || mediaId || tags)) {
        rows.push({ mediaId, title, description, tags, day });
        kept++;
      }
    }
    files.push({ day, name, rows: kept });
  }
  descCache = { rows, files, loadedAt: new Date().toISOString() };
  return descCache;
}

// Serve the bundled tracker descriptions (source of truth for the modal).
app.get('/api/descriptions', (req, res) => {
  try {
    const { rows, files, loadedAt } = loadDescriptionRows();
    res.json({ count: rows.length, files, loadedAt, rows });
  } catch (err) {
    console.error('✗ Could not load descriptions:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// List the profiles the current token can upload to (for the dropdown).
app.get('/api/profiles', async (req, res) => {
  try {
    const { org } = await authenticate();
    const profiles = listProfiles(org);
    res.json({ profiles, orgId: org.id });
  } catch (err) {
    console.error('✗ Could not list profiles:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Hand the browser a one-time upload URL so it can POST the file straight to
// Dailymotion (with progress), instead of routing the bytes through us.
app.get('/api/upload-url', async (req, res) => {
  try {
    if (!DM_API_KEY || !DM_API_SECRET) {
      throw new Error('Set DM_API_KEY and DM_API_SECRET in your .env file.');
    }
    const { token } = await authenticate();
    const uploadUrl = await getUploadUrl(token);
    res.json({ uploadUrl });
  } catch (err) {
    console.error('✗ Could not get upload URL:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Create the video from a file URL the browser already uploaded to Dailymotion.
app.post('/api/create-video', async (req, res) => {
  const { fileUrl, profileId } = req.body || {};
  const fields = {
    title: req.body.title,
    channel: req.body.channel,
    description: req.body.description,
    tags: req.body.tags,
    published: req.body.published === true || req.body.published === 'true',
    private: req.body.private === true || req.body.private === 'true',
    is_created_for_kids:
      req.body.is_created_for_kids === true || req.body.is_created_for_kids === 'true',
  };

  try {
    if (!DM_API_KEY || !DM_API_SECRET) {
      throw new Error('Set DM_API_KEY and DM_API_SECRET in your .env file.');
    }
    if (!fileUrl) throw new Error('Missing uploaded file URL.');
    if (!fields.title || !fields.channel) {
      throw new Error('Title and channel are required.');
    }

    const { token, org } = await authenticate();

    // Validate the chosen destination against the configured profiles.
    const profiles = listProfiles(org);
    const target =
      profiles.find((p) => p.id === profileId) || (profileId ? null : org);
    if (!target) throw new Error('Please choose a valid profile to upload to.');
    const label = target.screenname || target.username;
    console.log(`Creating video for: ${label} (${target.id})`);

    const video = await createVideo(token, target.id, fileUrl, fields);
    console.log(`    ✓ created video ${video.id}`);

    res.json({
      success: true,
      id: video.id,
      watch: `https://www.dailymotion.com/video/${video.id}`,
      owner: { id: target.id, username: target.username, screenname: target.screenname },
    });
  } catch (err) {
    console.error('✗ Video creation failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Legacy path: browser uploads the file to us and we forward it to Dailymotion.
// Kept as a fallback; the primary flow now uploads directly from the browser.
app.post('/api/upload', upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No video file provided.' });

  const fields = {
    title: req.body.title,
    channel: req.body.channel,
    description: req.body.description,
    tags: req.body.tags,
    published: req.body.published === 'on' || req.body.published === 'true',
    private: req.body.private === 'on' || req.body.private === 'true',
    is_created_for_kids:
      req.body.is_created_for_kids === 'on' || req.body.is_created_for_kids === 'true',
  };

  try {
    if (!DM_API_KEY || !DM_API_SECRET) {
      throw new Error('Set DM_API_KEY and DM_API_SECRET in your .env file.');
    }
    if (!fields.title || !fields.channel) {
      throw new Error('Title and channel are required.');
    }

    console.log('1/4 Authenticating…');
    const { token, org } = await authenticate();

    // Validate the chosen destination against the configured profiles,
    // so a video can never land somewhere unexpected.
    const profiles = listProfiles(org);
    const target =
      profiles.find((p) => p.id === req.body.profileId) ||
      (req.body.profileId ? null : org);
    if (!target) {
      throw new Error('Please choose a valid profile to upload to.');
    }
    const label = target.screenname || target.username;
    console.log(`    ✓ uploading to: ${label} (${target.id})`);

    console.log('2/4 Requesting upload URL…');
    const uploadUrl = await getUploadUrl(token);
    console.log('    ✓ got upload URL');

    console.log('3/4 Uploading file…');
    const fileUrl = await uploadFile(uploadUrl, req.file);
    console.log(`    ✓ uploaded: ${fileUrl}`);

    console.log('4/4 Creating video…');
    const video = await createVideo(token, target.id, fileUrl, fields);
    console.log(`    ✓ created video ${video.id}`);

    res.json({
      success: true,
      id: video.id,
      watch: `https://www.dailymotion.com/video/${video.id}`,
      owner: { id: target.id, username: target.username, screenname: target.screenname },
    });
  } catch (err) {
    console.error('✗ Upload failed:', err);
    res.status(500).json({ error: err.message });
  } finally {
    fs.unlink(req.file.path, () => {});
  }
});

// On Vercel the app runs as a serverless function (see api/index.js), so we
// export it and skip listen(). Locally, `npm start` runs this file directly
// and we bind the port as usual.
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Dailymotion uploader running at http://localhost:${PORT}`);
  });
}

export default app;
