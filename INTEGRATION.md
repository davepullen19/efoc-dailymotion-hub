# Dailymotion Upload — Integration Overview

**For:** Daren & Jeremy

This is what you need to build an app that uploads videos to Dailymotion and
publishes them to the **Essence Virtual Events** property.

> **Credentials are sent separately** — an API **key** and **secret** (a private
> API key with `manage_videos` permission). Keep them server-side.

---

## Target property

| | Value |
|---|---|
| Property | **Essence Virtual Events** |
| Profile ID | **`x4fnf6g`** |
| API host | `https://partner.api.dailymotion.com` |

All videos are created under this profile ID (step 4).

---

## What to build

A fixed 4-call sequence over plain HTTPS — use any language.

```
1. POST /oauth/v1/token            → access_token
2. GET  /rest/file/upload          → upload_url
3. POST {upload_url}  (the file)   → hosted file url
4. POST /rest/user/x4fnf6g/videos  → video id
```

### 1. Get an access token

`client_credentials` grant — key + secret, no user login. Tokens last 1 hour
(`expires_in: 3600`); cache and refresh.

```bash
curl -X POST https://partner.api.dailymotion.com/oauth/v1/token \
  -d "grant_type=client_credentials" \
  -d "client_id=YOUR_API_KEY" \
  -d "client_secret=YOUR_API_SECRET" \
  -d "scope=manage_videos"
```

→ `{ "access_token": "…", "expires_in": 3600, "token_type": "Bearer" }`

Send `Authorization: Bearer {access_token}` on every subsequent call.

### 2. Request an upload URL

```bash
curl https://partner.api.dailymotion.com/rest/file/upload \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

→ `{ "upload_url": "…", "progress_url": "…" }`  (single-use; request one per file)

### 3. Upload the file

POST the raw video as `multipart/form-data`, field name `file`.

```bash
curl -X POST "{upload_url}" -F "file=@/path/to/video.mp4"
```

→ `{ "url": "https://upload-…dailymotion.com/files/….mp4#…" }`  (keep this `url`)

### 4. Create & publish the video

```bash
curl -X POST https://partner.api.dailymotion.com/rest/user/x4fnf6g/videos \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -d "url={hosted_file_url}" \
  -d "title=My video title" \
  -d "channel=news" \
  -d "description=Optional description" \
  -d "tags=tag1,tag2" \
  -d "published=true" \
  -d "private=false" \
  -d "is_created_for_kids=false"
```

→ `{ "id": "xNNNNNN" }` — watch at `https://www.dailymotion.com/video/{id}`

---

## Video fields

| Field | Required | Notes |
|-------|----------|-------|
| `url` | ✅ | Hosted file URL from step 3 |
| `title` | ✅ | Max 255 chars |
| `channel` | ✅ | Category (see below) |
| `published` | – | `true` = visible/embeddable |
| `private` | – | `true` = restricted access |
| `is_created_for_kids` | – | COPPA/GDPR flag (default `false`) |
| `description` | – | Max 3000 chars |
| `tags` | – | Comma-separated (max 150 chars) |

Also available: `publish_date`, `expiry_date`, `language`, `geoblocking`,
`thumbnail_url` (see reference).

**`channel` values:** `news`, `tv`, `music`, `sport`, `videogames`, `fun`,
`tech`, `auto`, `lifestyle`, `travel`, `animals`, `people`, `shortfilms`,
`creation`, `kids`.

---

## Implementation notes

- **Secret handling:** the secret may contain special characters
  (`[ ] ( ) ! } = ^ , #`). Quote it in config so it isn't truncated — a
  mismatched secret returns `401 {"reason":"invalid_token"}`.
- **File upload:** use a multipart implementation that sets `Content-Length`
  (curl, browsers, Python `requests`, Node native `FormData` + a file Blob).
  Omitting the length returns `{"error":"missing content"}`.
- **Verify destination:** read a created video back with
  `?fields=id,owner.id,owner.screenname` — `owner.id` should be `x4fnf6g`.

---

## Reference

- Upload guide: https://developers.dailymotion.com/docs/upload-videos
- Auth (client credentials): https://developers.dailymotion.com/reference/client-credentials-request-access-token
- Create a video (all fields): https://developers.dailymotion.com/reference/partner-api-create-a-video
- Get upload URL: https://developers.dailymotion.com/reference/partner-api-upload-get-upload-url
