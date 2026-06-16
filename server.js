import 'dotenv/config';

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import express from 'express';
import session from 'express-session';
import multer from 'multer';
import PDFDocument from 'pdfkit';
import { google } from 'googleapis';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;
const isHostedOnVercel = Boolean(process.env.VERCEL);
const writableRuntimeDir = isHostedOnVercel
  ? path.join(os.tmpdir(), 'jazz-detailing-invoices')
  : __dirname;
const uploadDir = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(writableRuntimeDir, 'uploads');
const invoiceDir = process.env.INVOICE_DIR
  ? path.resolve(process.env.INVOICE_DIR)
  : path.join(writableRuntimeDir, 'invoices');
const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(writableRuntimeDir, 'data');
const storePath = path.join(dataDir, 'app-data.json');
const invoiceLogoPath = path.join(__dirname, 'public', 'assets', 'logo-light.png');
const invoicePrefix = 'jd';
const invoiceBaseline = 100;
const tokenCookieName = 'jd_google_tokens';
const tokenCookieMaxAgeSeconds = 60 * 60 * 24 * 90;
const driveStoreFileName = process.env.GOOGLE_DRIVE_STORE_FILE_NAME || 'Jazz Detailing App Data.json';
const defaultEmailMessage = `Thank you for choosing Jazz's Detailing. Attached is your invoice for today's service.

We appreciate your business and hope you enjoy your cleaner, shinier, protected vehicle.`;

fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(invoiceDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: {
    files: 100,
    fileSize: 25 * 1024 * 1024
  },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
      return;
    }

    cb(new Error('Only image uploads are supported.'));
  }
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(
  session({
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax'
    }
  })
);

function cookieSecretKey() {
  return crypto
    .createHash('sha256')
    .update(process.env.SESSION_SECRET || 'local-development-session-secret')
    .digest();
}

function encryptJson(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', cookieSecretKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();

  return [
    iv.toString('base64url'),
    tag.toString('base64url'),
    encrypted.toString('base64url')
  ].join('.');
}

function decryptJson(value) {
  try {
    const [ivValue, tagValue, encryptedValue] = String(value || '').split('.');
    if (!ivValue || !tagValue || !encryptedValue) {
      return null;
    }

    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      cookieSecretKey(),
      Buffer.from(ivValue, 'base64url')
    );
    decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encryptedValue, 'base64url')),
      decipher.final()
    ]);

    return JSON.parse(decrypted.toString('utf8'));
  } catch {
    return null;
  }
}

function parseCookies(req) {
  return String(req.headers.cookie || '')
    .split(';')
    .map((cookie) => cookie.trim())
    .filter(Boolean)
    .reduce((cookies, cookie) => {
      const separatorIndex = cookie.indexOf('=');
      if (separatorIndex === -1) {
        return cookies;
      }

      const name = decodeURIComponent(cookie.slice(0, separatorIndex));
      const value = decodeURIComponent(cookie.slice(separatorIndex + 1));
      cookies[name] = value;
      return cookies;
    }, {});
}

function appendCookie(res, name, value, options = {}) {
  const parts = [
    `${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax'
  ];

  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${options.maxAge}`);
  }

  if (isHostedOnVercel || process.env.NODE_ENV === 'production') {
    parts.push('Secure');
  }

  if (!res.headersSent) {
    res.append('Set-Cookie', parts.join('; '));
  }
}

function readGoogleTokenCookie(req) {
  return decryptJson(parseCookies(req)[tokenCookieName]);
}

function setGoogleTokenCookie(res, tokens) {
  appendCookie(res, tokenCookieName, encryptJson(tokens), {
    maxAge: tokenCookieMaxAgeSeconds
  });
}

function clearGoogleTokenCookie(res) {
  appendCookie(res, tokenCookieName, '', {
    maxAge: 0
  });
}

function createOAuthClient() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } = process.env;

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
    throw new Error('Missing Google OAuth settings. Copy .env.example to .env and fill it in.');
  }

  return new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );
}

function getEnvironmentGoogleTokens() {
  if (!process.env.GOOGLE_REFRESH_TOKEN) {
    return null;
  }

  return {
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN
  };
}

function getRequestGoogleTokens(req) {
  return req.session.tokens
    || readGoogleTokenCookie(req)
    || getStoredGoogleTokens()
    || getEnvironmentGoogleTokens();
}

function rememberRequestGoogleTokens(req, res, tokens) {
  const mergedTokens = saveGoogleTokens(tokens);
  req.session.tokens = mergedTokens;
  setGoogleTokenCookie(res, mergedTokens);
  return mergedTokens;
}

function getGoogleAuth(req, res) {
  const tokens = getRequestGoogleTokens(req);
  if (!tokens) {
    return null;
  }

  const auth = createOAuthClient();
  auth.setCredentials(tokens);
  auth.on('tokens', (newTokens) => {
    const mergedTokens = saveGoogleTokens({
      ...tokens,
      ...newTokens
    });
    req.session.tokens = mergedTokens;
    if (res) {
      setGoogleTokenCookie(res, mergedTokens);
    }
  });
  req.session.tokens = tokens;
  return auth;
}

function getDriveClient(req, res) {
  const auth = getGoogleAuth(req, res);
  if (!auth) {
    return null;
  }

  return google.drive({ version: 'v3', auth });
}

function getGmailClient(req, res) {
  const auth = getGoogleAuth(req, res);
  if (!auth) {
    return null;
  }

  return google.gmail({ version: 'v1', auth });
}

function escapeDriveQuery(value) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function normalizeFolderName(name) {
  return name.trim().replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-').replace(/\s+/g, ' ');
}

function normalizeVehicleName(name) {
  return normalizeFolderName(name || '');
}

function normalizeLicensePlate(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toUpperCase();
}

function buildJobFolderName(vehicleName, licensePlate = '', fallbackId = '') {
  const vehicle = normalizeVehicleName(vehicleName);
  const plate = normalizeLicensePlate(licensePlate);
  const fallback = normalizeFolderName(fallbackId || '');

  return normalizeFolderName([vehicle, plate || fallback].filter(Boolean).join(' - '));
}

function sanitizeFileName(name) {
  return normalizeFolderName(name).replace(/[. ]+$/g, '') || 'Detail Job';
}

function normalizeDriveFolderId(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }

  try {
    const url = new URL(raw);
    const folderMatch = url.pathname.match(/\/folders\/([^/?#]+)/);
    if (folderMatch) {
      return folderMatch[1];
    }

    const id = url.searchParams.get('id');
    if (id) {
      return id;
    }
  } catch {
    // Plain folder IDs are not valid URLs, so fall through and clean the value.
  }

  return raw.split(/[?#]/)[0].trim();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeHeader(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
}

function formatTitleCase(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
    .replace(/([\-'])[a-z]/g, (match) => match.toUpperCase());
}

function formatPersonName(value) {
  return formatTitleCase(value);
}

function formatServiceDescription(value) {
  return formatTitleCase(value);
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function parseMoney(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatMoney(value) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD'
  }).format(value);
}

function formatDate(value) {
  if (!value) {
    return '';
  }

  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }).format(date);
}

function todayInputValue() {
  return new Date().toISOString().slice(0, 10);
}

function emptyStore() {
  return {
    invoiceOffset: 0,
    googleTokens: null,
    jobs: [],
    invoices: []
  };
}

function normalizeStore(store = {}) {
  const nextStore = {
    ...emptyStore(),
    ...(store && typeof store === 'object' ? store : {})
  };

  nextStore.invoiceOffset = Math.max(Number.parseInt(nextStore.invoiceOffset, 10) || 0, 0);
  nextStore.jobs = Array.isArray(nextStore.jobs) ? nextStore.jobs : [];
  nextStore.invoices = Array.isArray(nextStore.invoices) ? nextStore.invoices : [];

  return nextStore;
}

function storeHasBusinessData(store) {
  const normalized = normalizeStore(store);
  return normalized.invoiceOffset > 0
    || normalized.jobs.length > 0
    || normalized.invoices.length > 0;
}

function storeForDrive(store) {
  const normalized = normalizeStore(store);

  return {
    invoiceOffset: normalized.invoiceOffset,
    jobs: normalized.jobs,
    invoices: normalized.invoices,
    updatedAt: new Date().toISOString()
  };
}

function storeDataSignature(store) {
  return JSON.stringify(storeForDrive(store));
}

function newestRecord(existing, incoming) {
  if (!existing) {
    return incoming;
  }

  const existingTime = new Date(existing.updatedAt || existing.sentAt || existing.createdAt || 0).getTime();
  const incomingTime = new Date(incoming.updatedAt || incoming.sentAt || incoming.createdAt || 0).getTime();

  return incomingTime >= existingTime ? incoming : existing;
}

function mergeStores(driveStore, localStore) {
  const drive = normalizeStore(driveStore);
  const local = normalizeStore(localStore);
  const merged = {
    ...emptyStore(),
    invoiceOffset: Math.max(drive.invoiceOffset, local.invoiceOffset),
    googleTokens: local.googleTokens || drive.googleTokens || null,
    jobs: [],
    invoices: []
  };
  const jobsByKey = new Map();
  const invoicesByKey = new Map();

  for (const job of [...drive.jobs, ...local.jobs]) {
    const key = job.key || jobKey(job.vehicleName, job.licensePlate, job.folderName);
    jobsByKey.set(key, newestRecord(jobsByKey.get(key), {
      ...job,
      key
    }));
  }

  for (const invoice of [...drive.invoices, ...local.invoices]) {
    const key = invoice.id
      || [invoice.jobKey, invoice.invoiceNumber, invoice.fileLink, invoice.sentAt].filter(Boolean).join('|');
    invoicesByKey.set(key, newestRecord(invoicesByKey.get(key), invoice));
  }

  merged.jobs = [...jobsByKey.values()].sort((a, b) => {
    return new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0);
  });
  merged.invoices = [...invoicesByKey.values()].sort((a, b) => {
    return new Date(b.sentAt || b.invoiceDate || 0) - new Date(a.sentAt || a.invoiceDate || 0);
  });

  return merged;
}

function readStore() {
  try {
    if (!fs.existsSync(storePath)) {
      return emptyStore();
    }

    return normalizeStore(JSON.parse(fs.readFileSync(storePath, 'utf8')));
  } catch {
    return emptyStore();
  }
}

function writeStore(store) {
  const normalized = normalizeStore(store);

  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(storePath, JSON.stringify(normalized, null, 2));
  } catch (error) {
    console.warn('Could not write local app data cache:', error.message);
  }

  return normalized;
}

function getStoredGoogleTokens() {
  return readStore().googleTokens;
}

function saveGoogleTokens(tokens) {
  const store = readStore();
  store.googleTokens = {
    ...(store.googleTokens || {}),
    ...tokens
  };
  writeStore(store);
  return store.googleTokens;
}

function clearGoogleTokens() {
  const store = readStore();
  store.googleTokens = null;
  writeStore(store);
}

async function streamToString(stream) {
  const chunks = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString('utf8');
}

async function findDriveStoreFile(drive) {
  if (!drive) {
    return null;
  }

  const parentFolderId = normalizeDriveFolderId(process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID);
  const queryParts = [
    `name = '${escapeDriveQuery(driveStoreFileName)}'`,
    'trashed = false'
  ];

  if (parentFolderId) {
    queryParts.push(`'${escapeDriveQuery(parentFolderId)}' in parents`);
  }

  const listOptions = {
    q: queryParts.join(' and '),
    fields: 'files(id, name, modifiedTime)',
    pageSize: 1,
    spaces: 'drive',
    supportsAllDrives: true
  };

  if (parentFolderId) {
    listOptions.corpora = 'allDrives';
    listOptions.includeItemsFromAllDrives = true;
  }

  const result = await drive.files.list(listOptions);
  return result.data.files?.[0] || null;
}

async function readDriveStore(drive) {
  const file = await findDriveStoreFile(drive);
  if (!file) {
    return null;
  }

  const result = await drive.files.get(
    {
      fileId: file.id,
      alt: 'media',
      supportsAllDrives: true
    },
    {
      responseType: 'stream'
    }
  );
  const text = await streamToString(result.data);

  return normalizeStore(JSON.parse(text));
}

async function writeDriveStore(drive, store) {
  if (!drive) {
    return null;
  }

  const parentFolderId = normalizeDriveFolderId(process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID);
  const file = await findDriveStoreFile(drive);
  const json = JSON.stringify(storeForDrive(store), null, 2);
  const media = {
    mimeType: 'application/json',
    body: Readable.from([json])
  };

  if (file) {
    const updated = await drive.files.update({
      fileId: file.id,
      media,
      supportsAllDrives: true,
      fields: 'id, name, webViewLink'
    });

    return updated.data;
  }

  const requestBody = {
    name: driveStoreFileName,
    mimeType: 'application/json',
    appProperties: {
      jazzDetailingAppData: 'true'
    }
  };

  if (parentFolderId) {
    requestBody.parents = [parentFolderId];
  }

  const created = await drive.files.create({
    requestBody,
    media,
    supportsAllDrives: true,
    fields: 'id, name, webViewLink'
  });

  return created.data;
}

async function readAppStore(drive = null) {
  const localStore = readStore();

  if (!drive) {
    return localStore;
  }

  try {
    const driveStore = await readDriveStore(drive);

    if (driveStore) {
      const mergedStore = mergeStores(driveStore, localStore);

      if (storeDataSignature(mergedStore) !== storeDataSignature(driveStore)) {
        await writeDriveStore(drive, mergedStore);
      }

      return writeStore(mergedStore);
    }

    if (storeHasBusinessData(localStore)) {
      await writeDriveStore(drive, localStore);
    } else {
      await writeDriveStore(drive, emptyStore());
    }
  } catch (error) {
    console.warn('Could not read Google Drive app data:', error.message);
  }

  return localStore;
}

async function writeAppStore(drive, store) {
  const localStore = readStore();
  const nextStore = writeStore({
    ...store,
    googleTokens: localStore.googleTokens
  });

  if (drive) {
    await writeDriveStore(drive, nextStore);
  }

  return nextStore;
}

function invoiceNumberForOffset(offset) {
  return `${invoicePrefix}-${invoiceBaseline + Math.max(Number.parseInt(offset, 10) || 0, 0)}`;
}

function currentInvoiceNumber(store = readStore()) {
  return invoiceNumberForOffset(store.invoiceOffset);
}

function resetInvoiceOffsetInStore(store, value) {
  store.invoiceOffset = Math.max(Number.parseInt(value, 10) || 0, 0);
  return store;
}

function resetInvoiceOffset(value) {
  const store = readStore();
  resetInvoiceOffsetInStore(store, value);
  writeStore(store);
  return store;
}

function nextInvoiceNumber() {
  const store = readStore();
  return currentInvoiceNumber(store);
}

function advanceInvoiceNumberInStore(store) {
  store.invoiceOffset = Math.max(Number.parseInt(store.invoiceOffset, 10) || 0, 0) + 1;
  return currentInvoiceNumber(store);
}

function advanceInvoiceNumber() {
  const store = readStore();
  advanceInvoiceNumberInStore(store);
  writeStore(store);
  return currentInvoiceNumber(store);
}

function jobKey(vehicleName, licensePlate = '', folderName = '') {
  const vehicle = normalizeVehicleName(vehicleName).toLowerCase();
  const plate = normalizeLicensePlate(licensePlate).toLowerCase();
  const fallback = normalizeFolderName(folderName || '').toLowerCase();

  return `${vehicle}|${plate || fallback}`;
}

function upsertJobInStore(store, jobUpdate) {
  const key = jobKey(jobUpdate.vehicleName, jobUpdate.licensePlate, jobUpdate.folderName);
  const now = new Date().toISOString();
  const existingIndex = store.jobs.findIndex((job) => job.key === key);
  const existing = existingIndex >= 0 ? store.jobs[existingIndex] : {};
  const nextJob = {
    ...existing,
    ...jobUpdate,
    key,
    updatedAt: now,
    createdAt: existing.createdAt || now
  };

  if (existingIndex >= 0) {
    store.jobs[existingIndex] = nextJob;
  } else {
    store.jobs.unshift(nextJob);
  }

  return nextJob;
}

function upsertJob(jobUpdate) {
  const store = readStore();
  const job = upsertJobInStore(store, jobUpdate);
  writeStore(store);
  return job;
}

function rememberInvoiceInStore(store, invoice, folder, invoiceFile) {
  const key = jobKey(invoice.vehicleName, invoice.licensePlate, invoice.folderName);
  const record = {
    id: crypto.randomUUID(),
    jobKey: key,
    invoiceNumber: invoice.invoiceNumber,
    vehicleName: invoice.vehicleName,
    licensePlate: invoice.licensePlate,
    folderName: invoice.folderName,
    customerName: invoice.customerName,
    customerEmail: invoice.customerEmail,
    customerPhone: invoice.customerPhone,
    total: invoice.total,
    invoiceDate: invoice.invoiceDate,
    sentAt: new Date().toISOString(),
    fileName: invoiceFile.name,
    fileLink: invoiceFile.webViewLink,
    downloadLink: invoiceFile.webContentLink || invoiceFile.webViewLink,
    folderLink: folder.webViewLink
  };

  store.invoices.unshift(record);
  return record;
}

function rememberInvoice(invoice, folder, invoiceFile) {
  const store = readStore();
  const invoiceRecord = rememberInvoiceInStore(store, invoice, folder, invoiceFile);
  writeStore(store);
  return invoiceRecord;
}

function jobInvoicesFromStore(store, key) {
  return store.invoices.filter((invoice) => invoice.jobKey === key).slice(0, 10);
}

function jobInvoices(key) {
  return jobInvoicesFromStore(readStore(), key);
}

async function findOrCreateFolder(drive, folderName) {
  const parentFolderId = normalizeDriveFolderId(process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID);
  const queryParts = [
    `name = '${escapeDriveQuery(folderName)}'`,
    "mimeType = 'application/vnd.google-apps.folder'",
    'trashed = false'
  ];

  if (parentFolderId) {
    queryParts.push(`'${escapeDriveQuery(parentFolderId)}' in parents`);
  }

  const query = queryParts.join(' and ');

  const listOptions = {
    q: query,
    fields: 'files(id, name, webViewLink)',
    pageSize: 1,
    spaces: 'drive',
    supportsAllDrives: true
  };

  if (parentFolderId) {
    listOptions.corpora = 'allDrives';
    listOptions.includeItemsFromAllDrives = true;
  }

  const existing = await drive.files.list(listOptions);

  if (existing.data.files?.length) {
    return existing.data.files[0];
  }

  const metadata = {
    name: folderName,
    mimeType: 'application/vnd.google-apps.folder'
  };

  if (parentFolderId) {
    metadata.parents = [parentFolderId];
  }

  const created = await drive.files.create({
    requestBody: metadata,
    supportsAllDrives: true,
    fields: 'id, name, webViewLink'
  });

  return created.data;
}

async function searchDriveFolders(drive, searchTerm) {
  if (!drive || !searchTerm) {
    return [];
  }

  const parentFolderId = normalizeDriveFolderId(process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID);
  const queryParts = [
    `name contains '${escapeDriveQuery(searchTerm)}'`,
    "mimeType = 'application/vnd.google-apps.folder'",
    'trashed = false'
  ];

  if (parentFolderId) {
    queryParts.push(`'${escapeDriveQuery(parentFolderId)}' in parents`);
  }

  const listOptions = {
    q: queryParts.join(' and '),
    fields: 'files(id, name, webViewLink)',
    pageSize: 10,
    spaces: 'drive',
    supportsAllDrives: true
  };

  if (parentFolderId) {
    listOptions.corpora = 'allDrives';
    listOptions.includeItemsFromAllDrives = true;
  }

  const result = await drive.files.list(listOptions);
  return result.data.files || [];
}

async function uploadPhoto(drive, file, folderId) {
  return uploadDriveFile(drive, {
    filePath: file.path,
    filename: file.originalname,
    mimeType: file.mimetype,
    folderId
  });
}

async function uploadDriveFile(drive, { filePath, filename, mimeType, folderId }) {
  const result = await drive.files.create({
    requestBody: {
      name: filename,
      parents: [folderId]
    },
    media: {
      mimeType,
      body: fs.createReadStream(filePath)
    },
    supportsAllDrives: true,
    fields: 'id, name, webViewLink, webContentLink'
  });

  return result.data;
}

function parseInvoiceItems(items) {
  if (Array.isArray(items)) {
    return items;
  }

  if (typeof items === 'string' && items.trim()) {
    try {
      const parsed = JSON.parse(items);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  return [];
}

function buildInvoiceData(body, store = readStore()) {
  const vehicleName = normalizeVehicleName(body.folderName || body.vehicleName || '');
  const licensePlate = normalizeLicensePlate(body.licensePlate);
  const invoiceNumber = currentInvoiceNumber(store);
  const folderName = buildJobFolderName(vehicleName, licensePlate, invoiceNumber);
  const customerName = formatPersonName(body.customerName);
  const customerEmail = String(body.customerEmail || '').trim();
  const customerPhone = String(body.customerPhone || '').trim();
  const copyEmail = String(
    body.copyEmail || process.env.INVOICE_COPY_EMAIL || process.env.BUSINESS_EMAIL || ''
  ).trim();
  const businessEmail = String(process.env.BUSINESS_EMAIL || copyEmail).trim();
  const invoiceDate = body.invoiceDate || todayInputValue();
  const rawItems = parseInvoiceItems(body.items);

  const items = rawItems
    .map((item) => {
      const description = formatServiceDescription(item.description);
      const quantity = Math.max(parseMoney(item.quantity), 0);
      const rate = Math.max(parseMoney(item.rate), 0);

      return {
        description,
        quantity,
        rate,
        amount: quantity * rate
      };
    })
    .filter((item) => item.description || item.amount > 0);

  if (!vehicleName) {
    throw new Error('Enter the vehicle for this invoice.');
  }

  if (!customerName) {
    throw new Error('Enter the customer name.');
  }

  if (customerEmail && !isEmail(customerEmail)) {
    throw new Error('Enter a valid customer email.');
  }

  if (copyEmail && !isEmail(copyEmail)) {
    throw new Error('Enter a valid copy email for yourself.');
  }

  if (customerEmail && !isEmail(businessEmail)) {
    throw new Error('Set BUSINESS_EMAIL in .env or enter a valid copy email.');
  }

  if (!items.length) {
    throw new Error('Add at least one invoice line item.');
  }

  const subtotal = items.reduce((sum, item) => sum + item.amount, 0);
  const discountType = body.discountType === 'percent' ? 'percent' : 'amount';
  const discountValue = Math.max(parseMoney(body.discount), 0);
  const discount = discountType === 'percent'
    ? subtotal * (Math.min(discountValue, 100) / 100)
    : Math.min(discountValue, subtotal);
  const taxableAmount = Math.max(subtotal - discount, 0);
  const taxRate = Math.max(parseMoney(body.taxRate), 0);
  const tax = taxableAmount * (taxRate / 100);
  const total = taxableAmount + tax;

  return {
    folderName,
    customerName,
    customerEmail,
    customerPhone,
    copyEmail,
    businessEmail,
    businessName: process.env.BUSINESS_NAME || 'Auto Detail Invoice',
    businessPhone: process.env.BUSINESS_PHONE || '',
    businessAddress: process.env.BUSINESS_ADDRESS || '',
    invoiceNumber,
    vehicleName,
    licensePlate,
    invoiceDate,
    dueDate: body.dueDate || '',
    notes: String(body.notes || '').trim(),
    emailMessage: String(body.emailMessage || defaultEmailMessage).trim(),
    items,
    subtotal,
    discountType,
    discountValue,
    discount,
    taxRate,
    tax,
    total
  };
}

async function createInvoicePdf(invoice, filePath) {
  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 50 });
    const stream = fs.createWriteStream(filePath);

    stream.on('finish', resolve);
    stream.on('error', reject);
    doc.on('error', reject);

    doc.pipe(stream);

    if (fs.existsSync(invoiceLogoPath)) {
      doc.image(invoiceLogoPath, 50, 36, { width: 74 });
    }

    doc.font('Helvetica-Bold').fontSize(28).text('Invoice', 140, 45);
    doc.font('Helvetica').fontSize(10);
    doc.text(invoice.businessName, 360, 50, { align: 'right', width: 180 });

    if (invoice.businessEmail) {
      doc.text(invoice.businessEmail, 360, doc.y + 3, { align: 'right', width: 180 });
    }

    if (invoice.businessPhone) {
      doc.text(invoice.businessPhone, 360, doc.y + 3, { align: 'right', width: 180 });
    }

    if (invoice.businessAddress) {
      doc.text(invoice.businessAddress, 360, doc.y + 3, { align: 'right', width: 180 });
    }

    doc.moveTo(50, 125).lineTo(562, 125).strokeColor('#d7dee7').stroke();
    doc.strokeColor('#000000');

    doc.font('Helvetica-Bold').fontSize(11).text('Bill To', 50, 150);
    doc.font('Helvetica').fontSize(11);
    let billToY = 168;
    doc.text(invoice.customerName, 50, billToY);

    if (invoice.customerEmail) {
      billToY += 16;
      doc.text(invoice.customerEmail, 50, billToY);
    }

    if (invoice.customerPhone) {
      billToY += 16;
      doc.text(invoice.customerPhone, 50, billToY);
    }

    doc.font('Helvetica-Bold').text('Job', 300, 150);
    doc.font('Helvetica').text(invoice.folderName, 390, 150, { width: 170 });
    doc.font('Helvetica-Bold').text(invoice.licensePlate ? 'Plate' : 'Job ID', 300, 184);
    doc.font('Helvetica').text(invoice.licensePlate || invoice.invoiceNumber, 390, 184);
    doc.font('Helvetica-Bold').text('Invoice #', 300, 202);
    doc.font('Helvetica').text(invoice.invoiceNumber, 390, 202);
    doc.font('Helvetica-Bold').text('Date', 300, 220);
    doc.font('Helvetica').text(formatDate(invoice.invoiceDate), 390, 220);

    if (invoice.dueDate) {
      doc.font('Helvetica-Bold').text('Due', 300, 238);
      doc.font('Helvetica').text(formatDate(invoice.dueDate), 390, 238);
    }

    let y = 275;
    doc.rect(50, y - 12, 512, 28).fill('#17202a');
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(10);
    doc.text('Description', 60, y - 4, { width: 260 });
    doc.text('Qty', 330, y - 4, { width: 50, align: 'right' });
    doc.text('Rate', 395, y - 4, { width: 70, align: 'right' });
    doc.text('Amount', 480, y - 4, { width: 70, align: 'right' });

    y += 28;
    doc.fillColor('#17202a').font('Helvetica').fontSize(10);

    for (const item of invoice.items) {
      const descriptionHeight = doc.heightOfString(item.description, { width: 250 });
      const rowHeight = Math.max(descriptionHeight + 14, 30);

      if (y + rowHeight > 705) {
        doc.addPage();
        y = 70;
      }

      doc.text(item.description, 60, y, { width: 250 });
      doc.text(String(item.quantity), 330, y, { width: 50, align: 'right' });
      doc.text(formatMoney(item.rate), 395, y, { width: 70, align: 'right' });
      doc.text(formatMoney(item.amount), 480, y, { width: 70, align: 'right' });
      doc.moveTo(50, y + rowHeight - 8).lineTo(562, y + rowHeight - 8).strokeColor('#e7edf3').stroke();
      doc.strokeColor('#000000');
      y += rowHeight;
    }

    y += 12;
    const totalsX = 382;
    const moneyX = 470;
    doc.font('Helvetica').fontSize(11);
    doc.text('Subtotal', totalsX, y, { width: 80 });
    doc.text(formatMoney(invoice.subtotal), moneyX, y, { width: 80, align: 'right' });

    if (invoice.discount > 0) {
      y += 20;
      const discountLabel = invoice.discountType === 'percent'
        ? `Discount (${invoice.discountValue}%)`
        : 'Discount';
      doc.text(discountLabel, totalsX - 40, y, { width: 120 });
      doc.text(`-${formatMoney(invoice.discount)}`, moneyX, y, { width: 80, align: 'right' });
    }

    if (invoice.taxRate > 0) {
      y += 20;
      doc.text(`Tax (${invoice.taxRate}%)`, totalsX, y, { width: 80 });
      doc.text(formatMoney(invoice.tax), moneyX, y, { width: 80, align: 'right' });
    }

    y += 26;
    doc.font('Helvetica-Bold').fontSize(14);
    doc.text('Total', totalsX, y, { width: 80 });
    doc.text(formatMoney(invoice.total), moneyX, y, { width: 80, align: 'right' });

    if (invoice.notes) {
      doc.font('Helvetica-Bold').fontSize(11).text('Notes', 50, 710);
      doc.font('Helvetica').fontSize(10).text(invoice.notes, 50, 728, { width: 512, height: 58 });
    }

    doc.end();
  });
}

function chunkBase64(value) {
  return value.match(/.{1,76}/g)?.join('\r\n') || '';
}

function toBase64Url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function formatEmailAddress(email, name = '') {
  const cleanEmail = sanitizeHeader(email);
  const cleanName = sanitizeHeader(name);

  if (!cleanName) {
    return cleanEmail;
  }

  return `"${cleanName.replace(/(["\\])/g, '\\$1')}" <${cleanEmail}>`;
}

async function sendInvoiceEmail(gmail, invoice, filePath, filename, driveLink) {
  const boundary = `invoice_${crypto.randomBytes(12).toString('hex')}`;
  const subject = sanitizeHeader(`Invoice - ${invoice.folderName}`);
  const body = [
    `Hi ${invoice.customerName},`,
    '',
    invoice.emailMessage || defaultEmailMessage,
    '',
    `Vehicle: ${invoice.vehicleName}`,
    invoice.licensePlate ? `License plate: ${invoice.licensePlate}` : `Job ID: ${invoice.invoiceNumber}`,
    `Invoice: ${invoice.invoiceNumber}`,
    `Total: ${formatMoney(invoice.total)}`,
    invoice.dueDate ? `Due: ${formatDate(invoice.dueDate)}` : '',
    '',
    driveLink ? `Drive copy: ${driveLink}` : '',
    '',
    'Thank you.'
  ].filter((line) => line !== '').join('\n');
  const attachment = await fs.promises.readFile(filePath);
  const headers = [
    `From: ${formatEmailAddress(invoice.businessEmail, invoice.businessName)}`,
    `To: ${formatEmailAddress(invoice.customerEmail, invoice.customerName)}`,
    `Reply-To: ${formatEmailAddress(invoice.businessEmail, invoice.businessName)}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`
  ];

  if (invoice.copyEmail) {
    headers.splice(2, 0, `Bcc: ${formatEmailAddress(invoice.copyEmail)}`);
  }

  const message = [
    ...headers,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    chunkBase64(Buffer.from(body, 'utf8').toString('base64')),
    '',
    `--${boundary}`,
    `Content-Type: application/pdf; name="${sanitizeHeader(filename)}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${sanitizeHeader(filename)}"`,
    '',
    chunkBase64(attachment.toString('base64')),
    '',
    `--${boundary}--`
  ].join('\r\n');

  const sent = await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw: toBase64Url(message)
    }
  });

  return sent.data;
}

function removeTempFiles(files = []) {
  for (const file of files) {
    fs.promises.unlink(file.path).catch(() => {});
  }
}

app.get('/api/status', async (req, res, next) => {
  try {
    const drive = getDriveClient(req, res);
    const store = await readAppStore(drive);

    res.json({
      signedIn: Boolean(drive),
      parentFolderConfigured: Boolean(process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID?.trim()),
      invoiceDefaults: {
        businessEmail: process.env.BUSINESS_EMAIL || '',
        copyEmail: process.env.INVOICE_COPY_EMAIL || process.env.BUSINESS_EMAIL || '',
        today: todayInputValue(),
        nextInvoiceNumber: currentInvoiceNumber(store),
        emailMessage: defaultEmailMessage
      }
    });
  } catch (error) {
    next(error);
  }
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/invoice-sequence', async (req, res, next) => {
  try {
    const drive = getDriveClient(req, res);
    const store = await readAppStore(drive);
    res.json({
      offset: store.invoiceOffset,
      nextInvoiceNumber: currentInvoiceNumber(store)
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/invoice-sequence', async (req, res, next) => {
  try {
    const drive = getDriveClient(req, res);
    const store = await readAppStore(drive);
    resetInvoiceOffsetInStore(store, req.body.offset);
    await writeAppStore(drive, store);
    res.json({
      offset: store.invoiceOffset,
      nextInvoiceNumber: currentInvoiceNumber(store)
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/jobs', async (req, res, next) => {
  try {
    const searchTerm = String(req.query.q || '').trim();
    const drive = getDriveClient(req, res);
    const store = await readAppStore(drive);
    const localJobs = store.jobs
      .filter((job) => {
        if (!searchTerm) {
          return true;
        }

        const haystack = [
          job.vehicleName,
          job.licensePlate,
          job.folderName,
          job.customerName,
          job.customerEmail,
          job.customerPhone
        ].join(' ').toLowerCase();
        return haystack.includes(searchTerm.toLowerCase());
      })
      .slice(0, 10)
      .map((job) => ({
        ...job,
        source: 'local',
        invoices: jobInvoicesFromStore(store, job.key)
      }));

    const driveFolders = await searchDriveFolders(drive, searchTerm);
    const knownFolderNames = new Set(localJobs.map((job) => job.folderName.toLowerCase()));
    const driveJobs = driveFolders
      .filter((folder) => !knownFolderNames.has(folder.name.toLowerCase()))
      .map((folder) => ({
        id: folder.id,
        source: 'drive',
        vehicleName: folder.name,
        licensePlate: '',
        folderName: folder.name,
        folderLink: folder.webViewLink,
        invoices: []
      }));

    res.json({
      jobs: [...localJobs, ...driveJobs].slice(0, 12)
    });
  } catch (error) {
    next(error);
  }
});

app.get('/auth/google', (req, res, next) => {
  try {
    const auth = createOAuthClient();
    const url = auth.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: [
        'https://www.googleapis.com/auth/drive',
        'https://www.googleapis.com/auth/gmail.send'
      ]
    });

    res.redirect(url);
  } catch (error) {
    next(error);
  }
});

app.get('/oauth2callback', async (req, res, next) => {
  try {
    const auth = createOAuthClient();
    const { tokens } = await auth.getToken(req.query.code);
    const mergedTokens = rememberRequestGoogleTokens(req, res, tokens);
    auth.setCredentials(mergedTokens);
    await readAppStore(google.drive({ version: 'v3', auth }));
    res.redirect('/');
  } catch (error) {
    next(error);
  }
});

app.post('/logout', (req, res) => {
  clearGoogleTokens();
  clearGoogleTokenCookie(res);
  req.session.destroy(() => {
    res.redirect('/');
  });
});

app.post('/api/upload', upload.array('photos', 100), async (req, res, next) => {
  try {
    const drive = getDriveClient(req, res);
    if (!drive) {
      removeTempFiles(req.files);
      res.status(401).json({ error: 'Please connect Google Drive first.' });
      return;
    }

    const vehicleName = normalizeVehicleName(req.body.folderName || req.body.vehicleName || '');
    const licensePlate = normalizeLicensePlate(req.body.licensePlate);
    const folderName = buildJobFolderName(vehicleName, licensePlate);

    if (!vehicleName) {
      removeTempFiles(req.files);
      res.status(400).json({ error: 'Enter a vehicle for this detail job.' });
      return;
    }

    if (!req.files?.length) {
      res.status(400).json({ error: 'Choose at least one photo.' });
      return;
    }

    const folder = await findOrCreateFolder(drive, folderName);
    const store = await readAppStore(drive);
    upsertJobInStore(store, {
      vehicleName,
      licensePlate,
      folderName,
      folderId: folder.id,
      folderLink: folder.webViewLink
    });
    await writeAppStore(drive, store);

    const uploaded = [];

    for (const file of req.files) {
      uploaded.push(await uploadPhoto(drive, file, folder.id));
    }

    removeTempFiles(req.files);

    res.json({
      folder,
      uploaded
    });
  } catch (error) {
    removeTempFiles(req.files);
    next(error);
  }
});

app.post('/api/invoice', upload.array('photos', 100), async (req, res, next) => {
  let tempPdfPath = '';

  try {
    const drive = getDriveClient(req, res);

    if (!drive) {
      res.status(401).json({ error: 'Please connect Google Drive first.' });
      return;
    }

    const store = await readAppStore(drive);
    const invoice = buildInvoiceData(req.body, store);
    const gmail = invoice.customerEmail ? getGmailClient(req, res) : null;

    if (invoice.customerEmail && !gmail) {
      res.status(401).json({ error: 'Please connect Google before emailing invoices.' });
      return;
    }

    const folder = await findOrCreateFolder(drive, invoice.folderName);
    const filename = `Invoice - ${sanitizeFileName(invoice.folderName)}.pdf`;
    tempPdfPath = path.join(invoiceDir, `${crypto.randomUUID()}-${filename}`);

    await createInvoicePdf(invoice, tempPdfPath);

    const invoiceFile = await uploadDriveFile(drive, {
      filePath: tempPdfPath,
      filename,
      mimeType: 'application/pdf',
      folderId: folder.id
    });

    const uploadedPhotos = [];

    for (const file of req.files || []) {
      uploadedPhotos.push(await uploadPhoto(drive, file, folder.id));
    }

    const sentMessage = invoice.customerEmail
      ? await sendInvoiceEmail(
        gmail,
        invoice,
        tempPdfPath,
        filename,
        invoiceFile.webViewLink
      )
      : null;
    const job = upsertJobInStore(store, {
      vehicleName: invoice.vehicleName,
      licensePlate: invoice.licensePlate,
      folderName: invoice.folderName,
      folderId: folder.id,
      folderLink: folder.webViewLink,
      customerName: invoice.customerName,
      customerEmail: invoice.customerEmail,
      customerPhone: invoice.customerPhone,
      copyEmail: invoice.copyEmail,
      items: invoice.items.map((item) => ({
        description: item.description,
        quantity: item.quantity,
        rate: item.rate
      })),
      discountType: invoice.discountType,
      discount: invoice.discountValue,
      taxRate: invoice.taxRate,
      notes: invoice.notes,
      emailMessage: invoice.emailMessage
    });
    const invoiceRecord = rememberInvoiceInStore(store, invoice, folder, invoiceFile);
    const nextNumber = advanceInvoiceNumberInStore(store);
    await writeAppStore(drive, store);

    res.json({
      folder,
      job,
      history: jobInvoicesFromStore(store, job.key),
      invoiceRecord,
      invoiceFile,
      uploadedPhotos,
      emailed: Boolean(sentMessage),
      email: sentMessage ? {
        id: sentMessage.id
      } : null,
      filename,
      invoiceNumber: invoice.invoiceNumber,
      nextInvoiceNumber: nextNumber,
      total: invoice.total
    });
  } catch (error) {
    next(error);
  } finally {
    removeTempFiles(req.files);
    if (tempPdfPath) {
      fs.promises.unlink(tempPdfPath).catch(() => {});
    }
  }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  const googleError = error.response?.data?.error;
  const details = googleError?.errors?.map((item) => item.message).filter(Boolean).join('; ');
  const message = details || googleError?.message || error.message || 'Something went wrong.';

  res.status(500).json({
    error: message
  });
});

if (!isHostedOnVercel) {
  app.listen(port, () => {
    console.log(`Drive photo uploader running at http://localhost:${port}`);
  });
}

export default app;
