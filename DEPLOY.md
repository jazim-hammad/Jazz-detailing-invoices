# Hosting The App

This app needs a Node host, not GitHub Pages. GitHub Pages cannot run `server.js`, store secrets, upload files, generate PDFs, or call Google APIs from a backend.

## Recommended Simple Host

Use a Node web service host such as Render or Railway.

The app is already prepared for hosting:

- Start command: `npm start`
- Health check path: `/health`
- Runtime port: uses the host-provided `PORT`
- Persistent app data path: set `DATA_DIR` to a persistent disk/volume path

## Environment Variables

Add these to the host's environment settings:

```text
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=https://your-hosted-app-url/oauth2callback
SESSION_SECRET=use-a-long-random-string
DATA_DIR=/var/data
GOOGLE_DRIVE_PARENT_FOLDER_ID=...
BUSINESS_NAME=Jazz Detailing
BUSINESS_EMAIL=invoices@jazzdetailing.com
BUSINESS_PHONE=(929) 724-0454
BUSINESS_ADDRESS=
INVOICE_COPY_EMAIL=jazim@jazzdetailing.com
```

Use the persistent disk/volume mount path from your hosting provider for `DATA_DIR`.

## Google OAuth Redirect URI

After the host gives you a live app URL, add this redirect URI in Google Cloud Console:

```text
https://your-hosted-app-url/oauth2callback
```

Keep the local redirect too if you still want to run it on your laptop:

```text
http://localhost:3000/oauth2callback
```

## First Login

Open the hosted app on your phone or computer and click **Connect Google** once.

The app stores Google refresh tokens in `DATA_DIR/app-data.json`, so it can stay connected across restarts as long as `DATA_DIR` is on persistent storage.
