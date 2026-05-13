# Hosting The App

This app needs a Node host, not GitHub Pages. GitHub Pages cannot run `server.js`, store secrets, upload files, generate PDFs, or call Google APIs from a backend.

## Vercel

The app is prepared for Vercel with:

- `api/index.js` for the Vercel Node function
- `vercel.json` to send all routes to the Express app
- temporary local upload/PDF files
- invoice/job recall synced to `Jazz Detailing App Data.json` in Google Drive after Google is connected

Vercel can reset local files, so do not rely on `data/app-data.json` there. After you click **Connect Google**, the app creates or updates a small JSON file in the configured Drive parent folder. Do not delete that file unless you want to reset invoice recall/history.

## Environment Variables

Add these in Vercel project settings under **Settings > Environment Variables**:

```text
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=https://your-vercel-app.vercel.app/oauth2callback
SESSION_SECRET=use-a-long-random-string
GOOGLE_DRIVE_PARENT_FOLDER_ID=...
GOOGLE_DRIVE_STORE_FILE_NAME=Jazz Detailing App Data.json
BUSINESS_NAME=Jazz Detailing
BUSINESS_EMAIL=invoices@jazzdetailing.com
BUSINESS_PHONE=(929) 724-0454
BUSINESS_ADDRESS=
INVOICE_COPY_EMAIL=jazim@jazzdetailing.com
```

Do not add `.env` to GitHub. Vercel gets these values from the dashboard.

## Google OAuth Redirect URI

After Vercel gives you a live app URL, add this redirect URI in Google Cloud Console:

```text
https://your-vercel-app.vercel.app/oauth2callback
```

Keep the local redirect too if you still want to run it on your laptop:

```text
http://localhost:3000/oauth2callback
```

## First Login

Open the hosted app on your phone or computer and click **Connect Google** once.

The app stores your Google login in an encrypted, HTTP-only browser cookie and stores invoice/job recall in Google Drive. If the browser cookie expires or you clear cookies, click **Connect Google** again. Your Drive folders and saved invoice recall will still be there.

## Normal Node Hosts

For Render, Railway, Koyeb, or another normal Node web service:

- Start command: `npm start`
- Health check path: `/health`
- Runtime port: uses the host-provided `PORT`
- Optional persistent app data path: set `DATA_DIR` to a persistent disk/volume path
