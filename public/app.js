const uploadForm = document.querySelector('#uploadForm');
const photos = document.querySelector('#photos');
const folderName = document.querySelector('#folderName');
const photoLicensePlate = document.querySelector('#photoLicensePlate');
const fileSummary = document.querySelector('#fileSummary');
const photoPreviewGrid = document.querySelector('#photoPreviewGrid');
const photoResult = document.querySelector('#photoResult');
const uploadButton = document.querySelector('#uploadButton');
const connectLink = document.querySelector('#connectLink');
const themeToggle = document.querySelector('#themeToggle');

const invoiceForm = document.querySelector('#invoiceForm');
const invoiceItems = document.querySelector('#invoiceItems');
const addItemButton = document.querySelector('#addItemButton');
const invoiceButton = document.querySelector('#invoiceButton');
const invoiceResult = document.querySelector('#invoiceResult');
const invoiceTotal = document.querySelector('#invoiceTotal');
const invoiceFolderName = document.querySelector('#invoiceFolderName');
const licensePlate = document.querySelector('#licensePlate');
const customerName = document.querySelector('#customerName');
const customerEmail = document.querySelector('#customerEmail');
const customerPhone = document.querySelector('#customerPhone');
const invoiceDate = document.querySelector('#invoiceDate');
const invoiceNumber = document.querySelector('#invoiceNumber');
const invoiceOffset = document.querySelector('#invoiceOffset');
const resetInvoiceButton = document.querySelector('#resetInvoiceButton');
const clearInvoiceButton = document.querySelector('#clearInvoiceButton');
const copyEmail = document.querySelector('#copyEmail');
const discountType = document.querySelector('#discountType');
const discount = document.querySelector('#discount');
const taxRate = document.querySelector('#taxRate');
const notes = document.querySelector('#notes');
const emailMessage = document.querySelector('#emailMessage');
const invoicePhotos = document.querySelector('#invoicePhotos');
const invoicePhotoSummary = document.querySelector('#invoicePhotoSummary');
const invoicePhotoPreviewGrid = document.querySelector('#invoicePhotoPreviewGrid');
const jobSuggestions = document.querySelector('#jobSuggestions');
const jobHistory = document.querySelector('#jobHistory');
const jobHistoryList = document.querySelector('#jobHistoryList');

const money = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD'
});
let photoPreviewUrls = [];
let selectedPhotoFiles = [];
let invoicePhotoPreviewUrls = [];
let selectedInvoicePhotoFiles = [];
let knownJobs = [];
let jobSearchTimer;
let activeLoadedJob = null;
let defaultCopyEmail = '';
let defaultInvoiceDate = '';
let defaultEmailMessageText = '';
let pendingSendTimeout;
let pendingSendInterval;

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

function normalizeLicensePlate(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toUpperCase();
}

function defaultEmailMessage() {
  return `Thank you for choosing Jazz's Detailing. Attached is your invoice for today's service.

We appreciate your business and hope you enjoy your cleaner, shinier, protected vehicle.`;
}

function setTheme(theme) {
  const nextTheme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = nextTheme;
  localStorage.setItem('theme', nextTheme);
  themeToggle.textContent = nextTheme === 'dark' ? 'Light' : 'Dark';
}

async function loadStatus() {
  const response = await fetch('/api/status');
  const status = await response.json();
  defaultCopyEmail = status.invoiceDefaults.copyEmail || '';
  defaultInvoiceDate = status.invoiceDefaults.today || '';
  defaultEmailMessageText = status.invoiceDefaults.emailMessage || defaultEmailMessage();
  connectLink.textContent = status.signedIn ? 'Google connected' : 'Connect Google';
  connectLink.classList.toggle('connected', status.signedIn);

  if (!invoiceDate.value) {
    invoiceDate.value = defaultInvoiceDate;
  }

  if (!copyEmail.value && defaultCopyEmail) {
    copyEmail.value = defaultCopyEmail;
  }

  invoiceNumber.value = status.invoiceDefaults.nextInvoiceNumber || 'jd-100';

  if (!emailMessage.value) {
    emailMessage.value = defaultEmailMessageText;
  }
}

function renderResult(target, html, isError = false) {
  target.hidden = false;
  target.classList.toggle('error', isError);
  target.innerHTML = html;
}

function activateTab(panelId) {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.tab === panelId);
  });

  document.querySelectorAll('.tool-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.id === panelId);
  });

  window.history.replaceState(null, '', panelId === 'invoicePanel' ? '#invoice' : '#photos');
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => activateTab(tab.dataset.tab));
});

function renderJobSuggestions() {
  jobSuggestions.innerHTML = '';

  knownJobs.forEach((job) => {
    const option = document.createElement('option');
    option.value = job.folderName;
    option.label = [
      job.vehicleName,
      job.licensePlate,
      job.source === 'drive' ? 'Drive folder' : 'Saved job'
    ].filter(Boolean).join(' - ');
    jobSuggestions.append(option);
  });
}

async function searchJobs(query) {
  const trimmed = query.trim();
  if (trimmed.length < 2) {
    knownJobs = [];
    renderJobSuggestions();
    return;
  }

  const response = await fetch(`/api/jobs?q=${encodeURIComponent(trimmed)}`);
  const data = await response.json();
  knownJobs = data.jobs || [];
  renderJobSuggestions();
}

function queueJobSearch(query) {
  window.clearTimeout(jobSearchTimer);
  jobSearchTimer = window.setTimeout(() => {
    searchJobs(query).catch(() => {});
  }, 220);
}

function renderJobHistory(invoices = []) {
  if (!invoices.length) {
    jobHistory.hidden = true;
    jobHistoryList.innerHTML = '';
    return;
  }

  jobHistory.hidden = false;
  jobHistoryList.innerHTML = invoices.map((invoice) => `
    <article class="history-item">
      <div>
        <strong>${escapeHtml(invoice.invoiceNumber)}</strong>
        <span>${escapeHtml(invoice.invoiceDate || '')}</span>
      </div>
      <div>
        <span>${money.format(invoice.total || 0)}</span>
        <a href="${invoice.fileLink}" target="_blank" rel="noreferrer">Open invoice</a>
      </div>
    </article>
  `).join('');
}

function fillInvoiceFromJob(job) {
  if (!job) {
    return;
  }

  activeLoadedJob = job;
  invoiceFolderName.value = job.vehicleName || job.folderName || '';
  licensePlate.value = normalizeLicensePlate(job.licensePlate);
  folderName.value = invoiceFolderName.value;
  photoLicensePlate.value = licensePlate.value;
  customerName.value = job.customerName ? formatPersonName(job.customerName) : '';
  customerEmail.value = job.customerEmail || '';
  customerPhone.value = job.customerPhone || '';
  copyEmail.value = job.copyEmail || defaultCopyEmail || '';
  dueDate.value = '';

  if (job.items?.length) {
    invoiceItems.innerHTML = '';
    job.items.forEach((item) => createItemRow(item));
  } else {
    invoiceItems.innerHTML = '';
    createItemRow();
  }

  discountType.value = job.discountType || 'amount';
  discount.value = job.discount !== undefined ? job.discount : '0';
  taxRate.value = job.taxRate !== undefined ? job.taxRate : '0';
  notes.value = job.notes || '';
  emailMessage.value = job.emailMessage || defaultEmailMessageText || defaultEmailMessage();

  updateInvoiceTotal();
  renderJobHistory(job.invoices || []);
}

function loadedJobMatchesInvoiceInputs() {
  if (!activeLoadedJob) {
    return true;
  }

  const vehicleValue = invoiceFolderName.value.trim().toLowerCase();
  const plateValue = normalizeLicensePlate(licensePlate.value).toLowerCase();
  const possibleVehicleValues = [
    activeLoadedJob.vehicleName,
    activeLoadedJob.folderName
  ].filter(Boolean).map((value) => value.trim().toLowerCase());

  return possibleVehicleValues.includes(vehicleValue)
    && normalizeLicensePlate(activeLoadedJob.licensePlate).toLowerCase() === plateValue;
}

function clearInvoiceForm({ keepVehicle = false, keepPlate = false } = {}) {
  const vehicleValue = keepVehicle ? invoiceFolderName.value : '';
  const plateValue = keepPlate ? normalizeLicensePlate(licensePlate.value) : '';

  activeLoadedJob = null;
  invoiceFolderName.value = vehicleValue;
  folderName.value = vehicleValue;
  licensePlate.value = plateValue;
  photoLicensePlate.value = plateValue;
  customerName.value = '';
  customerEmail.value = '';
  customerPhone.value = '';
  dueDate.value = '';
  copyEmail.value = defaultCopyEmail || copyEmail.value;
  invoiceDate.value = defaultInvoiceDate || invoiceDate.value;
  notes.value = '';
  emailMessage.value = defaultEmailMessageText || defaultEmailMessage();
  discountType.value = 'amount';
  discount.value = '0';
  taxRate.value = '0';
  invoiceItems.innerHTML = '';
  createItemRow();
  renderJobHistory([]);
  clearInvoicePhotoSelection();
  invoiceResult.hidden = true;
  invoiceResult.innerHTML = '';
  updateInvoiceTotal();
}

function clearStaleLoadedJobDetails(options = {}) {
  if (activeLoadedJob && !loadedJobMatchesInvoiceInputs()) {
    clearInvoiceForm({ keepVehicle: true, ...options });
  }
}

function maybeFillJobFromInput(value) {
  const match = knownJobs.find((job) => {
    const choices = [job.folderName, job.vehicleName].filter(Boolean).map((item) => item.toLowerCase());
    return choices.includes(value.trim().toLowerCase());
  });

  fillInvoiceFromJob(match);
}

function clearPhotoPreviews() {
  photoPreviewUrls.forEach((url) => URL.revokeObjectURL(url));
  photoPreviewUrls = [];
  photoPreviewGrid.innerHTML = '';
}

function photoFileKey(file) {
  return `${file.name}-${file.size}-${file.lastModified}`;
}

function syncPhotoInput() {
  const transfer = new DataTransfer();
  selectedPhotoFiles.forEach((file) => transfer.items.add(file));
  photos.files = transfer.files;
}

function updateFileSummary() {
  const count = selectedPhotoFiles.length;
  if (count === 0) {
    fileSummary.textContent = 'Select all the images for this detail job.';
    return;
  }

  fileSummary.textContent = count === 1 ? '1 photo selected.' : `${count} photos selected.`;
}

function removeSelectedPhoto(index) {
  selectedPhotoFiles.splice(index, 1);
  syncPhotoInput();
  updateFileSummary();
  renderPhotoPreviews();
}

function renderPhotoPreviews() {
  clearPhotoPreviews();

  selectedPhotoFiles.forEach((file, index) => {
    const url = URL.createObjectURL(file);
    photoPreviewUrls.push(url);

    const item = document.createElement('figure');
    item.className = 'photo-preview';
    item.innerHTML = `
      <button class="photo-remove" type="button" title="Remove photo" aria-label="Remove ${escapeHtml(file.name)}">&times;</button>
      <img src="${url}" alt="${escapeHtml(file.name)}" />
      <figcaption>${escapeHtml(file.name)}</figcaption>
    `;
    item.querySelector('.photo-remove').addEventListener('click', () => removeSelectedPhoto(index));
    photoPreviewGrid.append(item);
  });
}

function clearInvoicePhotoPreviews() {
  invoicePhotoPreviewUrls.forEach((url) => URL.revokeObjectURL(url));
  invoicePhotoPreviewUrls = [];
  invoicePhotoPreviewGrid.innerHTML = '';
}

function syncInvoicePhotoInput() {
  const transfer = new DataTransfer();
  selectedInvoicePhotoFiles.forEach((file) => transfer.items.add(file));
  invoicePhotos.files = transfer.files;
}

function updateInvoicePhotoSummary() {
  const count = selectedInvoicePhotoFiles.length;
  if (count === 0) {
    invoicePhotoSummary.textContent = 'Optional before/after photos for this job.';
    return;
  }

  invoicePhotoSummary.textContent = count === 1
    ? '1 job photo attached.'
    : `${count} job photos attached.`;
}

function removeSelectedInvoicePhoto(index) {
  selectedInvoicePhotoFiles.splice(index, 1);
  syncInvoicePhotoInput();
  updateInvoicePhotoSummary();
  renderInvoicePhotoPreviews();
}

function renderInvoicePhotoPreviews() {
  clearInvoicePhotoPreviews();

  selectedInvoicePhotoFiles.forEach((file, index) => {
    const url = URL.createObjectURL(file);
    invoicePhotoPreviewUrls.push(url);

    const item = document.createElement('figure');
    item.className = 'photo-preview';
    item.innerHTML = `
      <button class="photo-remove" type="button" title="Remove photo" aria-label="Remove ${escapeHtml(file.name)}">&times;</button>
      <img src="${url}" alt="${escapeHtml(file.name)}" />
      <figcaption>${escapeHtml(file.name)}</figcaption>
    `;
    item.querySelector('.photo-remove').addEventListener('click', () => removeSelectedInvoicePhoto(index));
    invoicePhotoPreviewGrid.append(item);
  });
}

function clearInvoicePhotoSelection() {
  selectedInvoicePhotoFiles = [];
  syncInvoicePhotoInput();
  updateInvoicePhotoSummary();
  clearInvoicePhotoPreviews();
}

photos.addEventListener('change', () => {
  const knownFiles = new Set(selectedPhotoFiles.map(photoFileKey));
  [...photos.files].forEach((file) => {
    if (!knownFiles.has(photoFileKey(file))) {
      selectedPhotoFiles.push(file);
      knownFiles.add(photoFileKey(file));
    }
  });

  syncPhotoInput();
  updateFileSummary();
  renderPhotoPreviews();
});

invoicePhotos.addEventListener('change', () => {
  const knownFiles = new Set(selectedInvoicePhotoFiles.map(photoFileKey));
  [...invoicePhotos.files].forEach((file) => {
    if (!knownFiles.has(photoFileKey(file))) {
      selectedInvoicePhotoFiles.push(file);
      knownFiles.add(photoFileKey(file));
    }
  });

  syncInvoicePhotoInput();
  updateInvoicePhotoSummary();
  renderInvoicePhotoPreviews();
});

folderName.addEventListener('input', (event) => {
  if (!invoiceFolderName.value) {
    invoiceFolderName.value = event.target.value;
  }

  queueJobSearch(event.target.value);
});

folderName.addEventListener('change', (event) => {
  maybeFillJobFromInput(event.target.value);
});

photoLicensePlate.addEventListener('blur', () => {
  photoLicensePlate.value = normalizeLicensePlate(photoLicensePlate.value);
  if (!licensePlate.value) {
    licensePlate.value = photoLicensePlate.value;
  }
});

invoiceFolderName.addEventListener('input', (event) => {
  clearStaleLoadedJobDetails();
  queueJobSearch(event.target.value);
});

invoiceFolderName.addEventListener('change', (event) => {
  maybeFillJobFromInput(event.target.value);
});

licensePlate.addEventListener('blur', () => {
  licensePlate.value = normalizeLicensePlate(licensePlate.value);
  clearStaleLoadedJobDetails({ keepPlate: true });
  if (!photoLicensePlate.value) {
    photoLicensePlate.value = licensePlate.value;
  }
});

uploadForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  uploadButton.disabled = true;
  uploadButton.textContent = 'Uploading...';
  renderResult(photoResult, 'Creating the Drive folder and sending photos.');

  try {
    const response = await fetch('/api/upload', {
      method: 'POST',
      body: new FormData(uploadForm)
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Upload failed.');
    }

    const plural = data.uploaded.length === 1 ? 'photo' : 'photos';
    renderResult(photoResult, `
      <strong>${data.uploaded.length} ${plural} uploaded.</strong>
      <p>
        Folder:
        <a href="${data.folder.webViewLink}" target="_blank" rel="noreferrer">
          ${escapeHtml(data.folder.name)}
        </a>
      </p>
    `);

    uploadForm.reset();
    selectedPhotoFiles = [];
    syncPhotoInput();
    updateFileSummary();
    clearPhotoPreviews();
  } catch (error) {
    renderResult(photoResult, escapeHtml(error.message), true);
  } finally {
    uploadButton.disabled = false;
    uploadButton.textContent = 'Upload to Drive';
  }
});

function createItemRow(item = {}) {
  const row = document.createElement('div');
  row.className = 'line-item';
  row.innerHTML = `
    <label class="line-field">
      <span>Service</span>
      <input class="item-description" type="text" placeholder="(enter service offer)" value="${escapeHtml(formatServiceDescription(item.description || ''))}" required />
    </label>
    <label class="line-field">
      <span>Qty</span>
      <input class="item-quantity" type="number" min="0" step="0.01" placeholder="1" value="${escapeHtml(item.quantity || '1')}" required />
    </label>
    <label class="line-field">
      <span>Rate</span>
      <input class="item-rate" type="number" min="0" step="0.01" placeholder="0.00" value="${escapeHtml(item.rate || '')}" required />
    </label>
    <button class="icon-button remove-item" type="button" title="Remove service" aria-label="Remove service">&times;</button>
  `;

  row.querySelectorAll('input').forEach((input) => {
    input.addEventListener('input', updateInvoiceTotal);
  });
  row.querySelector('.item-description').addEventListener('blur', (event) => {
    event.target.value = formatServiceDescription(event.target.value);
  });

  row.querySelector('.remove-item').addEventListener('click', () => {
    if (invoiceItems.children.length === 1) {
      row.querySelectorAll('input').forEach((input) => {
        input.value = input.classList.contains('item-quantity') ? '1' : '';
      });
    } else {
      row.remove();
    }

    updateInvoiceTotal();
  });

  invoiceItems.append(row);
  updateInvoiceTotal();
}

function collectItems() {
  return [...invoiceItems.querySelectorAll('.line-item')].map((row) => ({
    description: formatServiceDescription(row.querySelector('.item-description').value),
    quantity: row.querySelector('.item-quantity').value,
    rate: row.querySelector('.item-rate').value
  }));
}

function calculateTotal() {
  const subtotal = collectItems().reduce((sum, item) => {
    return sum + (Number.parseFloat(item.quantity) || 0) * (Number.parseFloat(item.rate) || 0);
  }, 0);
  const discountValue = Math.max(Number.parseFloat(discount.value) || 0, 0);
  const taxRateValue = Math.max(Number.parseFloat(taxRate.value) || 0, 0);
  const discountAmount = discountType.value === 'percent'
    ? subtotal * (Math.min(discountValue, 100) / 100)
    : Math.min(discountValue, subtotal);
  const taxable = Math.max(subtotal - discountAmount, 0);

  return taxable + taxable * (taxRateValue / 100);
}

function updateInvoiceTotal() {
  invoiceTotal.textContent = money.format(calculateTotal());
}

addItemButton.addEventListener('click', () => createItemRow());
clearInvoiceButton.addEventListener('click', () => {
  cancelPendingSend('Invoice send canceled.');
  clearInvoiceForm();
});
resetInvoiceButton.addEventListener('click', async () => {
  const offset = Number.parseInt(invoiceOffset.value, 10);
  const response = await fetch('/api/invoice-sequence', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      offset: Number.isFinite(offset) ? offset : 0
    })
  });
  const data = await response.json();
  invoiceNumber.value = data.nextInvoiceNumber;
  invoiceOffset.value = data.offset;
});
themeToggle.addEventListener('click', () => {
  setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});
discountType.addEventListener('change', updateInvoiceTotal);
discount.addEventListener('input', updateInvoiceTotal);
taxRate.addEventListener('input', updateInvoiceTotal);
customerName.addEventListener('blur', () => {
  customerName.value = formatPersonName(customerName.value);
});

function setInvoiceFormLocked(locked) {
  invoiceForm.querySelectorAll('input, select, textarea, button').forEach((control) => {
    control.disabled = locked;
  });
}

function updatePendingCountdown(secondsLeft) {
  const countdown = invoiceResult.querySelector('.countdown-ring');
  if (!countdown) {
    return;
  }

  countdown.textContent = secondsLeft;
  countdown.style.setProperty('--progress', `${secondsLeft * 10}%`);
}

function renderPendingSend(secondsLeft) {
  renderResult(invoiceResult, `
    <div class="pending-send">
      <div>
        <strong>Invoice queued.</strong>
        <p>You have 10 seconds to cancel before the invoice is created and saved to Drive.</p>
      </div>
      <div class="countdown-ring" style="--progress: ${secondsLeft * 10}%">${secondsLeft}</div>
      <button class="secondary danger-secondary" id="cancelSendButton" type="button">Cancel send</button>
    </div>
  `);

  invoiceResult.querySelector('#cancelSendButton').addEventListener('click', () => {
    cancelPendingSend('Invoice send canceled.');
  });
}

function cancelPendingSend(message = 'Invoice send canceled.') {
  window.clearTimeout(pendingSendTimeout);
  window.clearInterval(pendingSendInterval);
  pendingSendTimeout = undefined;
  pendingSendInterval = undefined;
  setInvoiceFormLocked(false);
  invoiceButton.disabled = false;
  invoiceButton.textContent = 'Create invoice';

  if (message) {
    renderResult(invoiceResult, escapeHtml(message));
  }
}

async function sendInvoiceNow(body) {
  window.clearInterval(pendingSendInterval);
  pendingSendTimeout = undefined;
  pendingSendInterval = undefined;
  invoiceButton.textContent = 'Creating invoice...';
  renderResult(invoiceResult, 'Creating the invoice PDF and saving everything to Drive.');

  try {
    const response = await fetch('/api/invoice', {
      method: 'POST',
      body
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Invoice failed.');
    }

    const photoCount = data.uploadedPhotos?.length || 0;
    const invoiceDownloadLink = data.invoiceFile.webContentLink || data.invoiceFile.webViewLink;
    renderResult(invoiceResult, `
      <strong>${data.emailed ? 'Invoice created and emailed.' : 'Invoice created. No email was sent.'}</strong>
      <p>Invoice: ${escapeHtml(data.invoiceNumber)}</p>
      <p>Total: ${money.format(data.total)}</p>
      ${photoCount ? `<p>${photoCount} ${photoCount === 1 ? 'photo' : 'photos'} uploaded.</p>` : ''}
      <div class="result-actions">
        <a class="result-button" href="${data.invoiceFile.webViewLink}" target="_blank" rel="noreferrer">Open invoice in Drive</a>
        <a class="result-button" href="${invoiceDownloadLink}" target="_blank" rel="noreferrer">Download invoice</a>
        <a class="result-button" href="${data.folder.webViewLink}" target="_blank" rel="noreferrer">Open job folder</a>
      </div>
    `);
    invoiceNumber.value = data.nextInvoiceNumber;
    renderJobHistory(data.history || []);
    clearInvoicePhotoSelection();
  } catch (error) {
    renderResult(invoiceResult, escapeHtml(error.message), true);
  } finally {
    setInvoiceFormLocked(false);
    invoiceButton.disabled = false;
    invoiceButton.textContent = 'Create invoice';
  }
}

function scheduleInvoiceSend(body) {
  window.clearTimeout(pendingSendTimeout);
  window.clearInterval(pendingSendInterval);
  let secondsLeft = 10;

  setInvoiceFormLocked(true);
  invoiceButton.textContent = 'Queued...';
  renderPendingSend(secondsLeft);

  pendingSendInterval = window.setInterval(() => {
    secondsLeft -= 1;
    updatePendingCountdown(secondsLeft);
  }, 1000);

  pendingSendTimeout = window.setTimeout(() => {
    sendInvoiceNow(body);
  }, 10000);
}

invoiceForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const formData = new FormData(invoiceForm);
  formData.set('folderName', String(formData.get('folderName') || '').trim());
  formData.set('licensePlate', normalizeLicensePlate(formData.get('licensePlate')));
  formData.set('customerName', formatPersonName(formData.get('customerName')));
  formData.set('customerEmail', String(formData.get('customerEmail') || '').trim());
  formData.set('customerPhone', String(formData.get('customerPhone') || '').trim());
  formData.set('copyEmail', String(formData.get('copyEmail') || '').trim());
  formData.set('items', JSON.stringify(collectItems()));

  scheduleInvoiceSend(formData);
});

setTheme(localStorage.getItem('theme') || 'light');
createItemRow();
activateTab(window.location.hash === '#photos' ? 'photosPanel' : 'invoicePanel');
loadStatus();
