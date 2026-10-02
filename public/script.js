const H2O_CONFIG = {
  currency: '₴',
  waterPricePerLiter: 2.5,
  deliveryPrice18_9L: 120,
  bottlePriceFirstOrder: 400,
  orderEndpoint: '/api/order'
};

const $ = (s, p = document) => p.querySelector(s);
const qtyInput = $('#quantity');
const waterTypeSelect = $('#waterTypeSelect');
const dateInput = $('#dateInput');
const firstOrder = $('#firstOrder');
const form = $('#orderForm');
const toast = $('#toast');

let toastTimer;
const showToast = (message, error = false) => {
  toast.textContent = message;
  toast.classList.toggle('error', error);
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 5000);
};

const formatMoney = (n) => `${new Intl.NumberFormat('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)} ${H2O_CONFIG.currency}`;
const liters = () => 18.9;
const qty = () => Math.max(1, Number(qtyInput.value) || 1);

function updateSummary() {
  const volume = liters();
  const quantity = qty();
  const type = waterTypeSelect.value;
  const waterTotal = volume * H2O_CONFIG.waterPricePerLiter * quantity;
  const delivery = H2O_CONFIG.deliveryPrice18_9L;
  const bottles = firstOrder.checked ? H2O_CONFIG.bottlePriceFirstOrder * quantity : 0;
  const total = waterTotal + delivery + bottles;

  $('#summaryCount').textContent = `${quantity} ${quantity === 1 ? 'позиція' : 'позиції'}`;
  $('#summaryItems').innerHTML = `<div class="summary-item"><span>H2O ${type} · 18,9 л × ${quantity}</span><span>${formatMoney(waterTotal)}</span></div>`;

  const extras = [];
  extras.push(`<div class="summary-extra-row"><span>Доставка</span><span>${formatMoney(delivery)}</span></div>`);
  if (bottles) extras.push(`<div class="summary-extra-row"><span>Бутлі · ${quantity} шт.</span><span>${formatMoney(bottles)}</span></div>`);
  $('#summaryExtra').innerHTML = extras.join('');
  $('#summaryTotal').textContent = formatMoney(total);
}

const today = new Date();
const localToday = new Date(today.getTime() - today.getTimezoneOffset() * 60000).toISOString().split('T')[0];
dateInput.min = localToday;
dateInput.value = localToday;
updateSummary();

document.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-water]');
  if (!btn) return;
  waterTypeSelect.value = btn.dataset.water;
  updateSummary();
  document.querySelector('#order').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

$('#minusBtn').addEventListener('click', () => {
  qtyInput.value = Math.max(1, qty() - 1);
  updateSummary();
});
$('#plusBtn').addEventListener('click', () => {
  qtyInput.value = Math.min(50, qty() + 1);
  updateSummary();
});

[waterTypeSelect, qtyInput, firstOrder].forEach((element) => {
  element.addEventListener('input', updateSummary);
  element.addEventListener('change', updateSummary);
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form).entries());
  data.quantity = qty();
  data.volumeLabel = `${String(liters()).replace('.', ',')} л`;
  data.waterPricePerLiter = H2O_CONFIG.waterPricePerLiter;
  data.waterTotal = liters() * H2O_CONFIG.waterPricePerLiter * qty();
  data.delivery = H2O_CONFIG.deliveryPrice18_9L;
  data.bottles = data.firstOrder === 'on' ? H2O_CONFIG.bottlePriceFirstOrder * qty() : 0;
  data.total = data.waterTotal + data.delivery + data.bottles;

  const submitButton = $('.submit', form);
  submitButton.disabled = true;
  submitButton.classList.add('loading');

  try {
    const response = await fetch(H2O_CONFIG.orderEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.message || 'Order request failed');

    showToast('Замовлення надіслано. H2O cafe зв’яжеться з вами для підтвердження.');
    form.reset();
    dateInput.min = localToday;
    dateInput.value = localToday;
    qtyInput.value = 1;
    updateSummary();
  } catch (error) {
    console.error(error);
    showToast('Не вдалося надіслати замовлення. Спробуйте ще раз або зателефонуйте +380 75 669 54 30.', true);
  } finally {
    submitButton.disabled = false;
    submitButton.classList.remove('loading');
  }
});

$('#year').textContent = new Date().getFullYear();
