import 'dotenv/config';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
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
const uploadDir = path.join(__dirname, 'uploads');
const invoiceDir = path.join(__dirname, 'invoices');
const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data');
const storePath = path.join(dataDir, 'app-data.json');
const invoiceLogoPath = path.join(__dirname, 'public', 'assets', 'logo-light.png');
const invoicePrefix = 'jd';
const invoiceBaseline = 100;
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

function getGoogleAuth(req) {
  const tokens = req.session.tokens || getStoredGoogleTokens();
  if (!tokens) {
    return null;
  }

  const auth = createOAuthClient();
  auth.setCredentials(tokens);
  auth.on('tokens', (newTokens) => {
    const mergedTokens = saveGoogleTokens(newTokens);
    req.session.tokens = mergedTokens;
  });
  req.session.tokens = tokens;
  return auth;
}

function getDriveClient(req) {
  const auth = getGoogleAuth(req);
  if (!auth) {
    return null;
  }

  return google.drive({ version: 'v3', auth });
}

function getGmailClient(req) {
  const auth = getGoogleAuth(req);
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

function buildJobFolderName(vehicleName, licensePlate = '') {
  const vehicle = normalizeVehicleName(vehicleName);
  const plate = normalizeLicensePlate(licensePlate);

  return normalizeFolderName([vehicle, plate].filter(Boolean).join(' - '));
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

function readStore() {
  try {
    if (!fs.existsSync(storePath)) {
      return emptyStore();
    }

    return {
      ...emptyStore(),
      ...JSON.parse(fs.readFileSync(storePath, 'utf8'))
    };
  } catch {
    return emptyStore();
  }
}

function writeStore(store) {
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
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

function invoiceNumberForOffset(offset) {
  return `${invoicePrefix}-${invoiceBaseline + Math.max(Number.parseInt(offset, 10) || 0, 0)}`;
}

function currentInvoiceNumber(store = readStore()) {
  return invoiceNumberForOffset(store.invoiceOffset);
}

function resetInvoiceOffset(value) {
  const store = readStore();
  store.invoiceOffset = Math.max(Number.parseInt(value, 10) || 0, 0);
  writeStore(store);
  return store;
}

function nextInvoiceNumber() {
  const store = readStore();
  return currentInvoiceNumber(store);
}

function advanceInvoiceNumber() {
  const store = readStore();
  store.invoiceOffset = Math.max(Number.parseInt(store.invoiceOffset, 10) || 0, 0) + 1;
  writeStore(store);
  return currentInvoiceNumber(store);
}

function jobKey(vehicleName, licensePlate = '') {
  return `${normalizeVehicleName(vehicleName).toLowerCase()}|${normalizeLicensePlate(licensePlate).toLowerCase()}`;
}

function upsertJob(jobUpdate) {
  const store = readStore();
  const key = jobKey(jobUpdate.vehicleName, jobUpdate.licensePlate);
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

  writeStore(store);
  return nextJob;
}

function rememberInvoice(invoice, folder, invoiceFile) {
  const store = readStore();
  const key = jobKey(invoice.vehicleName, invoice.licensePlate);
  const record = {
    id: crypto.randomUUID(),
    jobKey: key,
    invoiceNumber: invoice.invoiceNumber,
    vehicleName: invoice.vehicleName,
    licensePlate: invoice.licensePlate,
    folderName: invoice.folderName,
    customerName: invoice.customerName,
    customerEmail: invoice.customerEmail,
    total: invoice.total,
    invoiceDate: invoice.invoiceDate,
    sentAt: new Date().toISOString(),
    fileName: invoiceFile.name,
    fileLink: invoiceFile.webViewLink,
    folderLink: folder.webViewLink
  };

  store.invoices.unshift(record);
  writeStore(store);
  return record;
}

function jobInvoices(key) {
  const store = readStore();
  return store.invoices.filter((invoice) => invoice.jobKey === key).slice(0, 10);
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
    fields: 'id, name, webViewLink'
  });

  return result.data;
}

function buildInvoiceData(body) {
  const vehicleName = normalizeVehicleName(body.folderName || body.vehicleName || '');
  const licensePlate = normalizeLicensePlate(body.licensePlate);
  const folderName = buildJobFolderName(vehicleName, licensePlate);
  const customerName = formatPersonName(body.customerName);
  const customerEmail = String(body.customerEmail || '').trim();
  const copyEmail = String(
    body.copyEmail || process.env.INVOICE_COPY_EMAIL || process.env.BUSINESS_EMAIL || ''
  ).trim();
  const businessEmail = String(process.env.BUSINESS_EMAIL || copyEmail).trim();
  const invoiceDate = body.invoiceDate || todayInputValue();
  const invoiceNumber = currentInvoiceNumber();
  const rawItems = Array.isArray(body.items) ? body.items : [];

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

  if (!licensePlate) {
    throw new Error('Enter the license plate for this invoice.');
  }

  if (!customerName) {
    throw new Error('Enter the customer name.');
  }

  if (!isEmail(customerEmail)) {
    throw new Error('Enter a valid customer email.');
  }

  if (!isEmail(copyEmail)) {
    throw new Error('Enter a valid copy email for yourself.');
  }

  if (!isEmail(businessEmail)) {
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
    doc.font('Helvetica').fontSize(11).text(invoice.customerName, 50, 168);
    doc.text(invoice.customerEmail, 50, 184);

    doc.font('Helvetica-Bold').text('Job', 300, 150);
    doc.font('Helvetica').text(invoice.folderName, 390, 150, { width: 170 });
    doc.font('Helvetica-Bold').text('Plate', 300, 184);
    doc.font('Helvetica').text(invoice.licensePlate, 390, 184);
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
    `License plate: ${invoice.licensePlate}`,
    `Invoice: ${invoice.invoiceNumber}`,
    `Total: ${formatMoney(invoice.total)}`,
    invoice.dueDate ? `Due: ${formatDate(invoice.dueDate)}` : '',
    '',
    driveLink ? `Drive copy: ${driveLink}` : '',
    '',
    'Thank you.'
  ].filter((line) => line !== '').join('\n');
  const attachment = await fs.promises.readFile(filePath);
  const message = [
    `From: ${formatEmailAddress(invoice.businessEmail, invoice.businessName)}`,
    `To: ${formatEmailAddress(invoice.customerEmail, invoice.customerName)}`,
    `Bcc: ${formatEmailAddress(invoice.copyEmail)}`,
    `Reply-To: ${formatEmailAddress(invoice.businessEmail, invoice.businessName)}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
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

app.get('/api/status', (req, res) => {
  const hasTokens = Boolean(req.session.tokens || getStoredGoogleTokens());

  res.json({
    signedIn: hasTokens,
    parentFolderConfigured: Boolean(process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID?.trim()),
    invoiceDefaults: {
      businessEmail: process.env.BUSINESS_EMAIL || '',
      copyEmail: process.env.INVOICE_COPY_EMAIL || process.env.BUSINESS_EMAIL || '',
      today: todayInputValue(),
      nextInvoiceNumber: currentInvoiceNumber(),
      emailMessage: defaultEmailMessage
    }
  });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/invoice-sequence', (_req, res) => {
  const store = readStore();
  res.json({
    offset: store.invoiceOffset,
    nextInvoiceNumber: currentInvoiceNumber(store)
  });
});

app.post('/api/invoice-sequence', (req, res) => {
  const store = resetInvoiceOffset(req.body.offset);
  res.json({
    offset: store.invoiceOffset,
    nextInvoiceNumber: currentInvoiceNumber(store)
  });
});

app.get('/api/jobs', async (req, res, next) => {
  try {
    const searchTerm = String(req.query.q || '').trim();
    const store = readStore();
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
          job.customerEmail
        ].join(' ').toLowerCase();
        return haystack.includes(searchTerm.toLowerCase());
      })
      .slice(0, 10)
      .map((job) => ({
        ...job,
        source: 'local',
        invoices: jobInvoices(job.key)
      }));

    const drive = getDriveClient(req);
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
    req.session.tokens = saveGoogleTokens(tokens);
    res.redirect('/');
  } catch (error) {
    next(error);
  }
});

app.post('/logout', (req, res) => {
  clearGoogleTokens();
  req.session.destroy(() => {
    res.redirect('/');
  });
});

app.post('/api/upload', upload.array('photos', 100), async (req, res, next) => {
  try {
    const drive = getDriveClient(req);
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

    if (!licensePlate) {
      removeTempFiles(req.files);
      res.status(400).json({ error: 'Enter a license plate for this detail job.' });
      return;
    }

    if (!req.files?.length) {
      res.status(400).json({ error: 'Choose at least one photo.' });
      return;
    }

    const folder = await findOrCreateFolder(drive, folderName);
    upsertJob({
      vehicleName,
      licensePlate,
      folderName,
      folderId: folder.id,
      folderLink: folder.webViewLink
    });

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

app.post('/api/invoice', async (req, res, next) => {
  let tempPdfPath = '';

  try {
    const drive = getDriveClient(req);
    const gmail = getGmailClient(req);

    if (!drive || !gmail) {
      res.status(401).json({ error: 'Please connect Google Drive first.' });
      return;
    }

    const invoice = buildInvoiceData(req.body);
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

    const sentMessage = await sendInvoiceEmail(
      gmail,
      invoice,
      tempPdfPath,
      filename,
      invoiceFile.webViewLink
    );
    const job = upsertJob({
      vehicleName: invoice.vehicleName,
      licensePlate: invoice.licensePlate,
      folderName: invoice.folderName,
      folderId: folder.id,
      folderLink: folder.webViewLink,
      customerName: invoice.customerName,
      customerEmail: invoice.customerEmail,
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
    const invoiceRecord = rememberInvoice(invoice, folder, invoiceFile);
    const nextNumber = advanceInvoiceNumber();

    res.json({
      folder,
      job,
      history: jobInvoices(job.key),
      invoiceRecord,
      invoiceFile,
      email: {
        id: sentMessage.id
      },
      filename,
      invoiceNumber: invoice.invoiceNumber,
      nextInvoiceNumber: nextNumber,
      total: invoice.total
    });
  } catch (error) {
    next(error);
  } finally {
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

app.listen(port, () => {
  console.log(`Drive photo uploader running at http://localhost:${port}`);
});
