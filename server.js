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

fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(invoiceDir, { recursive: true });

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
  if (!req.session.tokens) {
    return null;
  }

  const auth = createOAuthClient();
  auth.setCredentials(req.session.tokens);
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

function sanitizeFileName(name) {
  return normalizeFolderName(name).replace(/[. ]+$/g, '') || 'Detail Job';
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

async function findOrCreateFolder(drive, folderName) {
  const parentFolderId = process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID?.trim();
  const parentQuery = parentFolderId ? ` and '${escapeDriveQuery(parentFolderId)}' in parents` : '';
  const query = [
    `name = '${escapeDriveQuery(folderName)}'`,
    "mimeType = 'application/vnd.google-apps.folder'",
    'trashed = false',
    parentQuery
  ].join(' ');

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
  const folderName = normalizeFolderName(body.folderName || '');
  const customerName = String(body.customerName || '').trim();
  const customerEmail = String(body.customerEmail || '').trim();
  const copyEmail = String(
    body.copyEmail || process.env.INVOICE_COPY_EMAIL || process.env.BUSINESS_EMAIL || ''
  ).trim();
  const businessEmail = String(process.env.BUSINESS_EMAIL || copyEmail).trim();
  const invoiceDate = body.invoiceDate || todayInputValue();
  const invoiceNumber = String(body.invoiceNumber || '').trim()
    || `INV-${invoiceDate.replaceAll('-', '')}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
  const rawItems = Array.isArray(body.items) ? body.items : [];

  const items = rawItems
    .map((item) => {
      const description = String(item.description || '').trim();
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

  if (!folderName) {
    throw new Error('Enter the job/folder name for this invoice.');
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
  const discount = Math.max(parseMoney(body.discount), 0);
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
    invoiceDate,
    dueDate: body.dueDate || '',
    notes: String(body.notes || '').trim(),
    items,
    subtotal,
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
    doc.font('Helvetica-Bold').fontSize(28).text('Invoice', 50, 45);
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
    doc.font('Helvetica-Bold').text('Invoice #', 300, 184);
    doc.font('Helvetica').text(invoice.invoiceNumber, 390, 184);
    doc.font('Helvetica-Bold').text('Date', 300, 202);
    doc.font('Helvetica').text(formatDate(invoice.invoiceDate), 390, 202);

    if (invoice.dueDate) {
      doc.font('Helvetica-Bold').text('Due', 300, 220);
      doc.font('Helvetica').text(formatDate(invoice.dueDate), 390, 220);
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
      doc.text('Discount', totalsX, y, { width: 80 });
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
    `Attached is the invoice for ${invoice.folderName}.`,
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
    `Reply-To: ${formatEmailAddress(invoice.copyEmail)}`,
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
  res.json({
    signedIn: Boolean(req.session.tokens),
    parentFolderConfigured: Boolean(process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID?.trim()),
    invoiceDefaults: {
      businessEmail: process.env.BUSINESS_EMAIL || '',
      copyEmail: process.env.INVOICE_COPY_EMAIL || process.env.BUSINESS_EMAIL || '',
      today: todayInputValue()
    }
  });
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
    req.session.tokens = tokens;
    res.redirect('/');
  } catch (error) {
    next(error);
  }
});

app.post('/logout', (req, res) => {
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

    const folderName = normalizeFolderName(req.body.folderName || '');
    if (!folderName) {
      removeTempFiles(req.files);
      res.status(400).json({ error: 'Enter a folder name for this detail job.' });
      return;
    }

    if (!req.files?.length) {
      res.status(400).json({ error: 'Choose at least one photo.' });
      return;
    }

    const folder = await findOrCreateFolder(drive, folderName);
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

    res.json({
      folder,
      invoiceFile,
      email: {
        id: sentMessage.id
      },
      filename,
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
  res.status(500).json({
    error: error.message || 'Something went wrong.'
  });
});

app.listen(port, () => {
  console.log(`Drive photo uploader running at http://localhost:${port}`);
});
