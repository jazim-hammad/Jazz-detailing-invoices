const uploadForm = document.querySelector('#uploadForm');
const photos = document.querySelector('#photos');
const fileSummary = document.querySelector('#fileSummary');
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
const invoiceDate = document.querySelector('#invoiceDate');
const copyEmail = document.querySelector('#copyEmail');
const discountType = document.querySelector('#discountType');
const discount = document.querySelector('#discount');
const taxRate = document.querySelector('#taxRate');

const money = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD'
});

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
  connectLink.textContent = status.signedIn ? 'Google connected' : 'Connect Google';
  connectLink.classList.toggle('connected', status.signedIn);

  if (!invoiceDate.value) {
    invoiceDate.value = status.invoiceDefaults.today;
  }

  if (!copyEmail.value && status.invoiceDefaults.copyEmail) {
    copyEmail.value = status.invoiceDefaults.copyEmail;
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

photos.addEventListener('change', () => {
  const count = photos.files.length;
  fileSummary.textContent = count === 1 ? '1 photo selected.' : `${count} photos selected.`;
});

document.querySelector('#folderName').addEventListener('input', (event) => {
  if (!invoiceFolderName.value) {
    invoiceFolderName.value = event.target.value;
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
    fileSummary.textContent = 'Select all the images for this detail job.';
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
    <input class="item-description" type="text" placeholder="Complete detail" value="${escapeHtml(item.description || '')}" required />
    <input class="item-quantity" type="number" min="0" step="0.01" value="${escapeHtml(item.quantity || '1')}" required />
    <input class="item-rate" type="number" min="0" step="0.01" value="${escapeHtml(item.rate || '')}" required />
    <button class="icon-button remove-item" type="button" title="Remove service" aria-label="Remove service">&times;</button>
  `;

  row.querySelectorAll('input').forEach((input) => {
    input.addEventListener('input', updateInvoiceTotal);
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
    description: row.querySelector('.item-description').value,
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
themeToggle.addEventListener('click', () => {
  setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});
discountType.addEventListener('change', updateInvoiceTotal);
discount.addEventListener('input', updateInvoiceTotal);
taxRate.addEventListener('input', updateInvoiceTotal);

invoiceForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  invoiceButton.disabled = true;
  invoiceButton.textContent = 'Sending invoice...';
  renderResult(invoiceResult, 'Creating the invoice PDF, saving it to Drive, and emailing the customer.');

  const formData = new FormData(invoiceForm);
  const body = {
    folderName: formData.get('folderName'),
    customerName: formData.get('customerName'),
    customerEmail: formData.get('customerEmail'),
    copyEmail: formData.get('copyEmail'),
    invoiceNumber: formData.get('invoiceNumber'),
    invoiceDate: formData.get('invoiceDate'),
    dueDate: formData.get('dueDate'),
    discountType: formData.get('discountType'),
    discount: formData.get('discount'),
    taxRate: formData.get('taxRate'),
    notes: formData.get('notes'),
    items: collectItems()
  };

  try {
    const response = await fetch('/api/invoice', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Invoice failed.');
    }

    renderResult(invoiceResult, `
      <strong>${escapeHtml(data.filename)} sent.</strong>
      <p>Total: ${money.format(data.total)}</p>
      <p>
        Drive copy:
        <a href="${data.invoiceFile.webViewLink}" target="_blank" rel="noreferrer">
          ${escapeHtml(data.invoiceFile.name)}
        </a>
      </p>
    `);
  } catch (error) {
    renderResult(invoiceResult, escapeHtml(error.message), true);
  } finally {
    invoiceButton.disabled = false;
    invoiceButton.textContent = 'Create and email invoice';
  }
});

setTheme(localStorage.getItem('theme') || 'light');
createItemRow();
activateTab(window.location.hash === '#invoice' ? 'invoicePanel' : 'photosPanel');
loadStatus();
