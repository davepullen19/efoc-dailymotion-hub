# Dailymotion Uploader

A very simple web app that uploads videos to Dailymotion using the
[Partner (private) API](https://developers.dailymotion.com/docs/upload-videos).

Authentication is just your **API key + secret** — no username, no password,
no login page. It uses the `client_credentials` grant.

## How it works

1. **Get a token** — `POST /oauth/v1/token` with `grant_type=client_credentials`.
2. **Find your profile id** — `GET /rest/auth` (done automatically).
3. **Request an upload URL** — `GET /rest/file/upload`.
4. **Upload the file** — `POST` the video to the upload URL.
5. **Create & publish** — `POST /rest/user/{profile_id}/videos` with your fields,
   where `{profile_id}` is the profile you picked in the dropdown.

## Choosing which profile to upload to

If your account is an organization with multiple profiles (channels), you pick
the destination from a dropdown. Dailymotion restricts the API that would list
them automatically, so the profiles come from a **`profiles.json`** file:

```json
[
  { "label": "Refinery29", "id": "x522r5y" },
  { "label": "Afropunk",   "id": "x2fqgxs" }
]
```

To get a profile's id: in Dailymotion Studio, click the profile in the left
sidebar. The URL becomes `dailymotion.com/partner/{ID}/media/video` — copy the
`{ID}`. Add one entry per profile you upload to. Your main/authenticated profile
is always included automatically.

Copy the starter file to begin:

```bash
cp profiles.example.json profiles.json
```

## Fields supported

| Field | Required | Notes |
|-------|----------|-------|
| `title` | ✅ | Video title |
| `channel` | ✅ | Category (e.g. `news`, `music`, `tech`) |
| `published` | – | Whether the video is visible/embeddable |
| `is_created_for_kids` | – | COPPA/GDPR compliance flag |
| `description` | – | Free text (max 3000 chars) |
| `tags` | – | Comma-separated |
| `private` | – | Restrict access |

## Setup

1. Get your **private** API key + secret from Dailymotion Studio, with the
   **Manage Videos** permission enabled.

2. Install dependencies (Node.js 18+):

   ```bash
   npm install
   ```

3. Add your credentials:

   ```bash
   cp .env.example .env      # then paste in DM_API_KEY and DM_API_SECRET
   ```

4. Start the app:

   ```bash
   npm start
   ```

5. Open <http://localhost:3000>, pick a file, fill in the fields, and upload.

## Notes

- Private API keys are only available to Pro Advanced / Enterprise accounts.
- All requests go to `partner.api.dailymotion.com`.
- Uploaded files are stored briefly in `uploads/` and deleted after each request.
- Never commit your `.env` — it's already in `.gitignore`.
