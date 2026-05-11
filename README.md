# Detail Job Drive Manager

A small local web app for uploading car-detail photos into Google Drive folders and creating emailed invoice PDFs.

Example: enter `2013 Infiniti G37x`, choose photos, and the app will create or reuse a Drive folder with that name, then upload the images into it.

Invoices use the same job name and are saved to the matching Drive folder with a name like:

```text
Invoice - 2013 Infiniti G37x.pdf
```

## Setup

1. Install dependencies:

   ```powershell
   npm install
   ```

2. Create a Google Cloud OAuth client:

   - Go to Google Cloud Console.
   - Create or select a project.
   - Enable the Google Drive API.
   - Enable the Gmail API.
   - Configure the OAuth consent screen.
   - Create an OAuth client ID for a web application.
   - Add this authorized redirect URI:

     ```text
     http://localhost:3000/oauth2callback
     ```

3. Copy `.env.example` to `.env` and fill in:

   ```text
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   GOOGLE_REDIRECT_URI=http://localhost:3000/oauth2callback
   SESSION_SECRET=any-long-random-string
   BUSINESS_NAME=Your Detailing Business
   BUSINESS_EMAIL=you@yourbusiness.com
   INVOICE_COPY_EMAIL=you@yourbusiness.com
   ```

   Use the same email for `BUSINESS_EMAIL` as the Google account you connect, or a Gmail send-as alias that account is allowed to use.

4. Optional: to store every job folder inside one existing Drive folder, set:

   ```text
   GOOGLE_DRIVE_PARENT_FOLDER_ID=...
   ```

   The folder ID is the long ID in a Google Drive folder URL.

5. Start the app:

   ```powershell
   npm run dev
   ```

6. Open:

   ```text
   http://localhost:3000
   ```

## Connecting a business Google Drive

Use your business Google account when creating the Google Cloud project and when clicking **Connect Drive** in the app.

If your business uses Google Workspace:

- Set the OAuth audience to your organization if this is only for employees.
- If Google shows an "app blocked" or "access blocked" message, your Workspace admin needs to trust/allow the OAuth client ID in the Google Admin console.
- To upload into a Shared Drive, create or choose a parent folder in that Shared Drive, copy the folder ID from its URL, and set `GOOGLE_DRIVE_PARENT_FOLDER_ID` in `.env`.
- If you already connected before invoices were added, click **Google connected** and approve access again so Gmail send permission is included.

For a Drive folder URL like:

```text
https://drive.google.com/drive/folders/1AbCDefG...
```

the folder ID is:

```text
1AbCDefG...
```

## Invoice workflow

1. Open the Invoice tab.
2. Enter the same vehicle/job name used for photos.
3. Enter the customer name and email.
4. Enter your copy email.
5. Add line items, discount, tax, dates, and notes.
6. Click **Create and email invoice**.

The app will:

- Create/reuse the matching Drive folder.
- Generate the invoice PDF.
- Save the PDF into Drive.
- Email the customer with the PDF attached.
- Bcc a copy to your copy email.

Discounts can be entered as either a dollar amount or a percentage. The selected discount type is used in the on-screen total and the generated invoice PDF.

The app includes light and dark themes using the Jazz's Detailing logo assets in `public/assets`.

## When to send invoices

For one-off detailing jobs, send the invoice immediately after the job is complete and the customer has seen the finished vehicle. Same day is best. For larger jobs, fleets, or recurring commercial clients, use clear terms like due on receipt, Net 7, or Net 15, and send the invoice as soon as the work is completed.

## Notes

- This app requests Drive access so it can find existing folders by name and create new folders/files.
- This app requests Gmail send access so it can email invoices from your connected Google account.
- It deletes temporary upload files from the local `uploads/` folder after each Drive upload finishes.
- It deletes temporary invoice PDFs from the local `invoices/` folder after each Drive upload and email finishes.
- If you publish this beyond your own local machine, add production-grade auth, HTTPS, persistent session storage, and stricter upload limits.
