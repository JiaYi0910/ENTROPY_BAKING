// 咖啡豆購物車：加入購物車 → ① 購物車 → ② 填寫資料 → ③ 訂單完成；另有 VIP 申請儲值
// 訂單一律從網頁送出，存進 Firebase 給後台查看
import {
  PROCESS_OPTIONS, SIZE_OPTIONS, DELIVERY_OPTIONS, TOPUP_PLANS,
  normalizeSettings, money, sizeLabel, unitPrice, processingFee, calcTotals,
  normalizePhone, isValidPhone, paymentLabel
} from './pricing.js';
import { isLineLoginEnabled, getCustomer, requireCustomer, onCustomerChange } from './line-login.js';
import { TW_DISTRICTS } from './tw-address.js';

const LINE_ID = '@245rbror';
const CART_KEY = 'entropy-cart-v1';
const MAX_QTY = 99;
const STEPS = ['cart', 'checkout', 'done'];
const STEP_TITLES = { cart: '購物車', checkout: '填寫訂購資料', done: '訂單完成' };

let settings = normalizeSettings({});
let productsById = new Map();
let productsReady = false;
let cart = loadCart(); // [{ id, name, process, size, qty }]
let removedNotice = '';
let dialogState = null;     // 加入購物車視窗目前的選擇 { product, process, size, qty }
let orderSubmitter = null;  // 由 script.js 提供：把訂單存進 Firebase
let lastOrder = null;       // 購物訂單完成頁顯示用
let lastTopup = null;       // 儲值申請完成頁顯示用
let isSubmitting = false;
let orderHistory = () => []; // 由 script.js 提供：這位客人以前的訂單（新的在前），用來帶入上次的門市、地址

const $ = (id) => document.getElementById(id);

// ========== 共用工具 ==========

// 資料放進 innerHTML 前先跳脫，避免特殊符號弄壞畫面
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

function showToast(message, action) {
  const toast = $('site-toast');
  if (!toast) return;
  // 視窗打開時，提示要放進視窗裡才不會被視窗的灰色背景蓋住
  const host = document.querySelector('dialog[open]') || $('menu-wrapper') || document.body;
  if (toast.parentElement !== host) host.appendChild(toast);
  toast.innerHTML = `<span>${escapeHtml(message)}</span>` +
    (action ? `<button type="button" class="toast-action">${escapeHtml(action.label)}</button>` : '');
  if (action) toast.querySelector('.toast-action').addEventListener('click', action.onClick);
  toast.classList.add('is-visible');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('is-visible'), action ? 4000 : 2400);
}

function lineMessageUrl(text) {
  return `https://line.me/R/oaMessage/${encodeURIComponent(LINE_ID)}/?${encodeURIComponent(text)}`;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 舊瀏覽器或權限不足時的備用做法
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

// 訂單編號：EB + 台灣日期 + 4 碼（去掉容易看錯的 0/O、1/I）
function makeOrderNo() {
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date()).replace(/-/g, '');
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const rand = Array.from(crypto.getRandomValues(new Uint32Array(4)), n => chars[n % chars.length]).join('');
  return `EB${ymd}-${rand}`;
}

// ========== 購物車存取（存在客人自己的瀏覽器，重新整理不會消失） ==========

function isValidItem(item) {
  return item && typeof item.id === 'string'
    && PROCESS_OPTIONS.some(o => o.value === item.process)
    && SIZE_OPTIONS.some(s => s.value === item.size)
    && Number.isInteger(item.qty) && item.qty > 0 && item.qty <= MAX_QTY;
}

function loadCart() {
  try {
    const saved = JSON.parse(localStorage.getItem(CART_KEY) || '[]');
    return Array.isArray(saved) ? saved.filter(isValidItem) : [];
  } catch {
    return [];
  }
}

function saveCart() {
  try {
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
  } catch {
    // 無痕模式等情況存不了也沒關係，只是重新整理後購物車會清空
  }
}

function cartLines() {
  return cart.map(item => {
    const product = productsById.get(item.id);
    const unit = product ? unitPrice(product, item.size) : null;
    const fee = processingFee(item.process, item.size, settings);
    return { ...item, name: product?.name ?? item.name, unit, fee, total: unit == null ? 0 : (unit + fee) * item.qty };
  });
}

// ========== 對外介面（script.js 呼叫） ==========

// 商品更新時同步：已下架或刪除的商品從購物車移除
export function syncProducts(products) {
  productsById = new Map(products.map(p => [p.id, p]));
  productsReady = true;
  const before = cart.length;
  cart = cart.filter(item => unitPrice(productsById.get(item.id), item.size) != null);
  if (cart.length < before) {
    removedNotice = `有 ${before - cart.length} 項商品已下架，已從購物車移除。`;
    saveCart();
  }
  renderCart();
}

export function setShopSettings(data) {
  settings = normalizeSettings(data);
  // 公告裡的運費、耗材費數字跟著後台設定更新
  document.querySelectorAll('[data-setting]').forEach(el => {
    const value = settings[el.dataset.setting];
    if (typeof value === 'number') el.textContent = value.toLocaleString('zh-TW');
  });
  if (dialogState) updateProductDialog();
  renderCart();
}

export function setOrderSubmitter(fn) {
  orderSubmitter = fn;
}

export function setOrderHistoryProvider(fn) {
  orderHistory = fn;
}

export function getShopSettings() {
  return settings;
}

// LINE 登入完成後接著做原本要做的事
export function handleAfterLogin(action) {
  if (action === 'checkout') {
    openCart();
    if (cart.length) goToCheckout();
  } else if (action.startsWith('topup:')) {
    openTopupDialog(Number(action.slice(6)));
  }
}

export function initOrder() {
  const productDialog = $('product-dialog');
  const cartDialog = $('cart-dialog');
  const topupDialog = $('topup-dialog');
  if (!productDialog || !cartDialog || !topupDialog) return;

  [productDialog, cartDialog, topupDialog, $('orders-dialog')].filter(Boolean).forEach(dialog => {
    dialog.addEventListener('click', (e) => {
      // 點視窗外的灰色背景，或有 data-close 的按鈕就關閉
      if (e.target === dialog || e.target.closest('[data-close]')) dialog.close();
      // 複製訂單編號、轉帳帳號
      if (e.target.closest('[data-copy-order-no]')) {
        const order = dialog === topupDialog ? lastTopup : lastOrder;
        copyText(order?.order_no ?? '').then(ok => showToast(ok ? '已複製編號' : '複製失敗，請手動抄寫編號'));
      }
      if (e.target.closest('[data-copy-account]')) {
        copyText(settings.bank_account).then(ok => showToast(ok ? '已複製轉帳帳號' : '複製失敗，請手動抄寫帳號'));
      }
    });
  });
  productDialog.addEventListener('close', () => { dialogState = null; });

  // 加入購物車視窗：切換加工方式、份量、數量
  productDialog.addEventListener('change', (e) => {
    if (!dialogState || e.target.type !== 'radio') return;
    dialogState[e.target.name] = e.target.value;
    updateProductDialog();
  });
  productDialog.addEventListener('click', (e) => {
    const button = e.target.closest('[data-qty]');
    if (!button || !dialogState) return;
    dialogState.qty = Math.min(MAX_QTY, Math.max(1, dialogState.qty + Number(button.dataset.qty)));
    updateProductDialog();
  });
  $('product-dialog-form').addEventListener('submit', (e) => {
    e.preventDefault();
    addToCart();
  });

  // ① 購物車
  $('cart-button').addEventListener('click', openCart);
  $('cart-items').addEventListener('click', onCartItemClick);
  $('btn-go-checkout').addEventListener('click', goToCheckout);
  // 有沒有開啟 LINE 登入、客人登入了沒，會影響結帳按鈕的文字
  onCustomerChange(renderLoginRequirement);

  // ② 填寫資料
  const form = $('checkout-form');
  form.addEventListener('change', (e) => {
    clearCheckoutError();
    if (e.target.name === 'delivery') prefillFromHistory();
    renderCheckoutSummary();
  });
  fillCountyOptions();
  form.elements.home_county.addEventListener('change', () => fillDistrictOptions());
  form.elements.home_district.addEventListener('change', updateZip);
  form.addEventListener('input', clearCheckoutError);
  form.addEventListener('submit', submitOrder);
  $('btn-back-cart').addEventListener('click', () => showStep('cart'));

  // ③ 訂單完成
  $('btn-copy-order').addEventListener('click', async () => {
    const ok = await copyText(lastOrder ? buildOrderMessage(lastOrder) : '');
    showToast(ok ? '已複製訂單內容' : '複製失敗，請手動截圖訂單內容');
  });

  // VIP 申請儲值
  renderTopupPlans();
  $('vip-plans').addEventListener('click', (e) => {
    const button = e.target.closest('[data-plan]');
    if (button) openTopupDialog(Number(button.dataset.plan));
  });
  $('topup-form').addEventListener('submit', submitTopup);
  $('topup-form').addEventListener('input', () => { $('topup-error').hidden = true; });

  renderCart();
}

// ========== 加入購物車視窗 ==========

export function openProductDialog(product) {
  if (unitPrice(product, '1磅') == null) return;
  dialogState = { product, process: PROCESS_OPTIONS[0].value, size: SIZE_OPTIONS[0].value, qty: 1 };

  $('pd-origin').textContent = [product.origin, product.roast_level]
    .filter(v => v && v !== '無' && v !== '-').join(' · ');
  $('pd-title').textContent = product.name;
  $('pd-process').innerHTML = PROCESS_OPTIONS.map(o => optionChip('process', o.value, o.value, o.value === dialogState.process)).join('');
  $('pd-size').innerHTML = SIZE_OPTIONS.map(s => optionChip('size', s.value, s.label, s.value === dialogState.size)).join('');
  updateProductDialog();
  $('product-dialog').showModal();
  $('pd-title').focus();
}

function optionChip(name, value, label, checked, sub = '') {
  return `<label class="option-chip">
    <input type="radio" name="${name}" value="${escapeHtml(value)}"${checked ? ' checked' : ''}>
    <span class="option-label">${escapeHtml(label)}</span>
    <span class="option-sub" data-sub="${escapeHtml(value)}">${escapeHtml(sub)}</span>
  </label>`;
}

// 依目前選擇更新各選項的價格提示與小計
function updateProductDialog() {
  const { product, process, size, qty } = dialogState;
  PROCESS_OPTIONS.forEach(o => {
    const fee = processingFee(o.value, size, settings);
    $('pd-process').querySelector(`[data-sub="${o.value}"]`).textContent = o.hasFee ? `耗材 +${money(fee)}` : o.note;
  });
  SIZE_OPTIONS.forEach(s => {
    $('pd-size').querySelector(`[data-sub="${s.value}"]`).textContent = money(unitPrice(product, s.value));
  });

  const unit = unitPrice(product, size);
  const fee = processingFee(process, size, settings);
  $('pd-qty').textContent = qty;
  $('pd-total').textContent = money((unit + fee) * qty);
  $('pd-breakdown').textContent = `${process}・${sizeLabel(size)} ${money(unit)}${fee ? ` ＋ 耗材 ${money(fee)}` : ''}${qty > 1 ? ` × ${qty}` : ''}`;
}

function addToCart() {
  const { product, process, size, qty } = dialogState;
  const existing = cart.find(i => i.id === product.id && i.process === process && i.size === size);
  if (existing) {
    existing.qty = Math.min(MAX_QTY, existing.qty + qty);
  } else {
    cart.push({ id: product.id, name: product.name, process, size, qty });
  }
  saveCart();
  $('product-dialog').close();
  renderCart();

  // 購物車圖示跳一下，提醒客人已加入
  const button = $('cart-button');
  button.classList.remove('is-bumped');
  void button.offsetWidth;
  button.classList.add('is-bumped');
  showToast(`已加入購物車：${product.name}（${process}・${sizeLabel(size)} × ${qty}）`, { label: '去結帳', onClick: openCart });
}

// ========== ① 購物車 ==========

function openCart() {
  $('site-toast')?.classList.remove('is-visible');
  // 每次打開都從購物車開始；訂單完成頁只在剛送出訂單時顯示
  lastOrder = null;
  showStep('cart');
  renderCart();
  if (!$('cart-dialog').open) $('cart-dialog').showModal();
  $('cart-title').focus();
}

function showStep(step) {
  document.querySelectorAll('#cart-dialog [data-step]').forEach(el => {
    el.hidden = el.dataset.step !== step;
  });
  document.querySelectorAll('#cart-dialog [data-step-indicator]').forEach(el => {
    const index = STEPS.indexOf(el.dataset.stepIndicator);
    el.classList.toggle('is-active', index === STEPS.indexOf(step));
    el.classList.toggle('is-done', index < STEPS.indexOf(step));
  });
  $('cart-title').textContent = STEP_TITLES[step];
  $('cart-dialog').querySelector('.sheet-inner').scrollTop = 0;
  if (step === 'checkout') renderCheckoutSummary();
}

// 結帳前要先用 LINE 登入（後台有設定 LINE 登入時），訂單才能綁定客人、之後查得到
async function goToCheckout() {
  clearCheckoutError();
  if (isLineLoginEnabled() && !getCustomer()) {
    const button = $('btn-go-checkout');
    button.disabled = true;
    try {
      await requireCustomer('checkout'); // 會跳到 LINE 登入頁，回來後自動繼續
    } catch (error) {
      showToast(error.message);
      return;
    } finally {
      button.disabled = false;
    }
  }
  showStep('checkout');
  const nameField = $('checkout-form').elements.customer_name;
  if (!nameField.value && getCustomer()?.name) nameField.value = getCustomer().name;
  prefillFromHistory();
}

function renderLoginRequirement() {
  const needLogin = isLineLoginEnabled() && !getCustomer();
  $('btn-go-checkout').textContent = needLogin ? '用 LINE 登入並結帳 →' : '前往結帳 →';
  $('checkout-login-note').hidden = !needLogin;
}

function onCartItemClick(e) {
  const button = e.target.closest('[data-action]');
  if (!button) return;
  const index = Number(button.dataset.index);
  const item = cart[index];
  if (!item) return;

  if (button.dataset.action === 'inc') item.qty = Math.min(MAX_QTY, item.qty + 1);
  if (button.dataset.action === 'dec') item.qty -= 1;
  if (button.dataset.action === 'remove' || item.qty <= 0) cart.splice(index, 1);
  saveCart();
  renderCart();
}

function renderCart() {
  const count = cart.reduce((sum, i) => sum + i.qty, 0);
  const badge = $('cart-count');
  if (badge) {
    badge.hidden = count === 0;
    badge.textContent = count > 99 ? '99+' : count;
    $('cart-button').setAttribute('aria-label', count ? `購物車（${count} 件）` : '購物車');
  }
  if (!$('cart-items')) return;

  const notice = $('cart-notice');
  notice.textContent = removedNotice;
  notice.hidden = !removedNotice;

  const lines = cartLines();
  $('cart-empty').hidden = lines.length > 0;
  $('cart-footer').hidden = lines.length === 0;
  $('cart-items').innerHTML = lines.map((line, index) => `
    <li class="cart-item">
      <div class="cart-item-info">
        <strong>${escapeHtml(line.name)}</strong>
        <span>${escapeHtml(line.process)}・${escapeHtml(sizeLabel(line.size))}・${line.unit == null ? '價格確認中' : money(line.unit)}${line.fee ? `＋耗材 ${money(line.fee)}` : ''}</span>
      </div>
      <div class="qty-stepper small">
        <button type="button" data-action="dec" data-index="${index}" aria-label="減少 ${escapeHtml(line.name)}">−</button>
        <span>${line.qty}</span>
        <button type="button" data-action="inc" data-index="${index}" aria-label="增加 ${escapeHtml(line.name)}">＋</button>
      </div>
      <strong class="cart-item-total">${money(line.total)}</strong>
      <button type="button" class="cart-remove" data-action="remove" data-index="${index}" aria-label="移除 ${escapeHtml(line.name)}">×</button>
    </li>
  `).join('');

  const t = calcTotals(lines, 'pickup', settings);
  $('cart-subtotal').textContent = money(t.subtotal);
  $('cart-free-hint').textContent = settings.free_shipping_threshold > 0
    ? (t.subtotal >= settings.free_shipping_threshold
      ? `🎉 已滿 ${money(settings.free_shipping_threshold)}，寄送免運費！`
      : `運費於下一步計算；再買 ${money(settings.free_shipping_threshold - t.subtotal)} 即可免運`)
    : '運費於下一步計算';

  // 購物車在填寫資料步驟被清空時，回到購物車
  if (lines.length === 0 && !$('checkout-form').hidden) showStep('cart');
  if (!$('checkout-form').hidden) renderCheckoutSummary();
}

// ========== ② 填寫資料 ==========

function checkoutValue(name) {
  return $('checkout-form').elements[name].value;
}

function renderCheckoutSummary() {
  DELIVERY_OPTIONS.forEach(o => {
    const sub = document.querySelector(`[data-delivery-fee="${o.value}"]`);
    if (sub) sub.textContent = o.feeKey ? `運費 ${money(settings[o.feeKey])}` : '免運費';
  });
  $('free-ship-rule').textContent = settings.free_shipping_threshold > 0 ? `滿 ${money(settings.free_shipping_threshold)} 免運` : '';

  const delivery = checkoutValue('delivery') || 'pickup';
  const t = calcTotals(cartLines(), delivery, settings);
  $('field-store').hidden = delivery !== 'cvs';
  $('field-address').hidden = delivery !== 'home';

  $('sum-goods').textContent = money(t.goods);
  $('sum-fees').textContent = money(t.fees);
  $('row-fees').hidden = t.fees === 0;
  $('sum-shipping').textContent = t.baseShipping === 0 ? '免運費' : (t.freeShipping ? `免運（原 ${money(t.baseShipping)}）` : money(t.shipping));
  $('sum-total').textContent = money(t.total);

  const hint = $('free-ship-hint');
  hint.hidden = !(t.baseShipping > 0 && t.threshold > 0);
  hint.textContent = t.freeShipping ? `🎉 已滿 ${money(t.threshold)}，免運費！` : `再買 ${money(t.threshold - t.subtotal)} 即可免運`;

  $('payment-brief').innerHTML = checkoutValue('payment_method') === 'stored_value'
    ? '💎 請在下方填寫<strong>您儲值時登記的電話</strong>，店家確認餘額後從儲值金扣款並安排出貨。還沒儲值？可在「VIP 專屬儲值方案」申請。'
    : '💳 <strong>先付款後出貨</strong>，送出訂單後會顯示轉帳帳號。';
}

function clearCheckoutError() {
  $('checkout-error').hidden = true;
}

function showCheckoutError(message, field) {
  $('checkout-error').textContent = message;
  $('checkout-error').hidden = false;
  field?.focus();
}

function readCheckout() {
  const form = $('checkout-form').elements;
  const storeName = form.cvs_store.value.trim().replace(/^(全家便利商店|全家)\s*/, '');
  const storeId = form.cvs_store_id.value.replace(/\s/g, '');
  const county = form.home_county.value;
  const district = form.home_district.value;
  const detail = addressDetail(county, district, form.home_address.value);
  const data = {
    delivery: checkoutValue('delivery') || 'pickup',
    payment_method: checkoutValue('payment_method') || 'transfer',
    name: form.customer_name.value.trim(),
    phone: normalizePhone(form.customer_phone.value),
    store: composeStore(storeName, storeId),
    address: county && district ? `${zipOf(county, district)} ${county}${district}${detail}` : '',
    note: form.order_note.value.trim()
  };

  if (!productsReady) return showCheckoutError('豆單還在載入中，請稍候再送出'), null;
  if (cart.length === 0) return showCheckoutError('購物車是空的'), null;
  if (!data.name) return showCheckoutError('請填寫訂購人姓名', form.customer_name), null;
  if (!isValidPhone(data.phone)) return showCheckoutError('請填寫正確的聯絡電話（例如 0912345678）', form.customer_phone), null;
  if (data.delivery === 'cvs') {
    if (!storeName) return showCheckoutError('請填寫全家門市名稱（可按「查詢全家門市」查詢）', form.cvs_store), null;
    if (storeId && !/^\d{4,8}$/.test(storeId)) return showCheckoutError('店號請填數字（不知道可以空白）', form.cvs_store_id), null;
  }
  if (data.delivery === 'home') {
    if (!county) return showCheckoutError('請選擇收件地址的縣市', form.home_county), null;
    if (!district) return showCheckoutError('請選擇收件地址的鄉鎮市區', form.home_district), null;
    if (detail.length < 3) return showCheckoutError('請填寫詳細地址（路、巷、弄、號、樓）', form.home_address), null;
  }
  return data;
}

// ========== 全家門市與宅配地址 ==========

function fillCountyOptions() {
  $('checkout-form').elements.home_county.insertAdjacentHTML('beforeend',
    Object.keys(TW_DISTRICTS).map(c => `<option value="${c}">${c}</option>`).join(''));
}

// 換縣市時更新鄉鎮市區選單；keep 是要選回的鄉鎮市區（帶入上次地址時用）
function fillDistrictOptions(keep = '') {
  const form = $('checkout-form').elements;
  const list = TW_DISTRICTS[form.home_county.value] ?? [];
  form.home_district.innerHTML = list.length
    ? '<option value="">請選擇</option>' + list.map(([d, zip]) => `<option value="${d}">${zip} ${d}</option>`).join('')
    : '<option value="">請先選縣市</option>';
  form.home_district.disabled = list.length === 0;
  form.home_district.value = list.some(([d]) => d === keep) ? keep : '';
  updateZip();
}

function zipOf(county, district) {
  return (TW_DISTRICTS[county] ?? []).find(([d]) => d === district)?.[1] ?? '';
}

function updateZip() {
  const form = $('checkout-form').elements;
  const zip = zipOf(form.home_county.value, form.home_district.value);
  $('home-zip').textContent = zip ? `郵遞區號 ${zip}` : '';
}

// 客人在詳細地址又打了一次縣市、鄉鎮時去掉，避免重複
function addressDetail(county, district, text) {
  let detail = text.trim().replace(/^\d{3,6}\s*/, '').replace(/^台/, '臺');
  if (county && detail.startsWith(county)) detail = detail.slice(county.length);
  if (district && detail.startsWith(district)) detail = detail.slice(district.length);
  return detail.trim();
}

// 訂單上存成一段文字，後台、Email、LINE 都直接顯示：「湖口光復店（店號 012345）」、「303 新竹縣湖口鄉光復東路73號」
function composeStore(name, id) {
  return id ? `${name}（店號 ${id}）` : name;
}

function parseStore(text) {
  const m = String(text || '').match(/^(.*?)(?:（店號 (\d+)）)?$/);
  return { name: (m?.[1] ?? '').trim(), id: m?.[2] ?? '' };
}

function parseAddress(text) {
  const s = String(text || '').trim().replace(/^\d{3,6}\s*/, '').replace(/^台/, '臺');
  const county = Object.keys(TW_DISTRICTS).find(c => s.startsWith(c));
  if (!county) return null;
  const rest = s.slice(county.length);
  const district = TW_DISTRICTS[county].map(([d]) => d).find(d => rest.startsWith(d));
  if (!district) return null;
  return { county, district, detail: rest.slice(district.length).trim() };
}

// 用 LINE 登入的老客人：帶入上次訂單用過的電話、全家門市、宅配地址（欄位是空的才帶入）
function prefillFromHistory() {
  const history = orderHistory();
  if (!history.length) return;
  const form = $('checkout-form').elements;
  if (!form.customer_phone.value && history[0].customer?.phone) form.customer_phone.value = history[0].customer.phone;

  const delivery = checkoutValue('delivery');
  if (delivery === 'cvs' && !form.cvs_store.value) {
    const last = history.find(o => o.delivery === 'cvs' && o.customer?.store);
    if (last) {
      const store = parseStore(last.customer.store);
      form.cvs_store.value = store.name;
      form.cvs_store_id.value = store.id;
    }
  }
  if (delivery === 'home' && !form.home_county.value && !form.home_address.value) {
    const last = history.find(o => o.delivery === 'home' && o.customer?.address);
    const address = last && parseAddress(last.customer.address);
    if (address) {
      form.home_county.value = address.county;
      fillDistrictOptions(address.district);
      form.home_address.value = address.detail;
    }
  }
}

function buildOrder(data) {
  const lines = cartLines();
  const t = calcTotals(lines, data.delivery, settings);
  const customer = { name: data.name, phone: data.phone };
  if (data.delivery === 'cvs') customer.store = data.store;
  if (data.delivery === 'home') customer.address = data.address;
  return {
    ...ownerField(),
    type: 'order',
    order_no: makeOrderNo(),
    status: '待付款',
    payment_method: data.payment_method,
    delivery: data.delivery,
    delivery_label: t.option.label,
    customer,
    note: data.note,
    items: lines.map(l => ({ product_id: l.id, name: l.name, process: l.process, size: l.size, qty: l.qty, unit: l.unit, fee: l.fee, total: l.total })),
    amounts: { goods: t.goods, fees: t.fees, shipping: t.shipping, total: t.total }
  };
}

// 用 LINE 登入的客人，訂單記下是誰的（安全規則會檢查必須是本人）
function ownerField() {
  const customer = getCustomer();
  return customer ? { customer_uid: customer.uid } : {};
}

// 給 LINE、Email 通知用的文字版訂單
function buildOrderMessage(order) {
  const divider = '――――――――――';
  const contact = [
    `姓名：${order.customer.name}`,
    `電話：${order.customer.phone}`,
    ...(order.customer.store ? [`全家門市：${order.customer.store}`] : []),
    ...(order.customer.address ? [`收件地址：${order.customer.address}`] : []),
    ...(order.note ? [`備註：${order.note}`] : [])
  ];

  if (order.type === 'topup') {
    const t = order.topup;
    return [
      `【熵與焙 儲值申請】${order.order_no}`,
      `方案：儲值 ${money(t.plan_amount)}（加贈 ${money(t.bonus)}，共 ${money(t.credit)} 額度）`,
      divider,
      ...contact,
      divider,
      `付款方式：銀行轉帳 ${money(order.amounts.total)}`
    ].join('\n');
  }

  const a = order.amounts;
  return [
    `【熵與焙 咖啡豆訂單】${order.order_no}`,
    ...order.items.map((l, i) => `${i + 1}. ${l.name}｜${l.process}｜${sizeLabel(l.size)} ×${l.qty}｜${money(l.total)}`),
    divider,
    `咖啡豆：${money(a.goods)}`,
    ...(a.fees ? [`加工耗材：${money(a.fees)}`] : []),
    `運費：${a.shipping ? money(a.shipping) : '免運費'}`,
    `合計：${money(a.total)}`,
    divider,
    `取貨方式：${order.delivery_label}`,
    ...contact,
    divider,
    `付款方式：${paymentLabel(order.payment_method)}${order.payment_method === 'transfer' ? '（先付款後出貨）' : ''}`
  ].join('\n');
}

// 送出失敗時的說明；附上錯誤代碼，客人截圖給店家時方便查原因
function submitErrorText(what, error) {
  const code = String(error?.code || error?.message || '未知').slice(0, 40);
  return `${what}暫時無法送出，請確認網路連線後再按一次。（錯誤代碼：${code}）`;
}

function setSubmitting(button, submitting, idleText) {
  isSubmitting = submitting;
  button.disabled = submitting;
  button.textContent = submitting ? '送出中…' : idleText;
}

async function submitOrder(e) {
  e.preventDefault();
  if (isSubmitting) return; // 防止連點重複下單
  clearCheckoutError();
  const data = readCheckout();
  if (!data) return;

  const order = buildOrder(data);
  const button = $('btn-submit-order');
  setSubmitting(button, true, '確認送出訂單');
  try {
    if (!orderSubmitter) throw new Error('訂單系統尚未連線');
    const saved = await orderSubmitter(order);
    notifyServer(order, saved?.id);
    finishOrder(order);
  } catch (error) {
    console.error('訂單送出失敗', error);
    showCheckoutError(submitErrorText('訂單', error));
  } finally {
    setSubmitting(button, false, '確認送出訂單');
  }
}

// 通知 Google 小幫手有新訂單：寄 Email 給管理員、用 LINE 傳訂單確認給客人
// 網址在後台「商店設定」填寫；只允許 Google Apps Script，避免訂單資料被送到別處
// 小幫手會用 orderId 到資料庫讀真正的訂單；還沒設定好資料庫權限時，才用這裡附的文字寄 Email
function notifyServer(order, orderId) {
  const url = settings.notify_url;
  if (!url.startsWith('https://script.google.com/')) return;
  fetch(url, {
    method: 'POST',
    mode: 'no-cors',
    keepalive: true,
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ ...order, action: 'order-created', orderId, message: buildOrderMessage(order) })
  }).catch(() => {
    // 通知失敗不影響訂單，訂單已存在後台
  });
}

// 完成頁、我的訂單的付款說明：轉帳顯示帳號；儲值金扣款說明會由店家扣款
// inMyOrders：在「我的訂單」裡，回報表單就在說明下方
export function paymentInfoHtml(order, { inMyOrders = false } = {}) {
  const total = money(order.amounts.total);
  if (order.payment_method === 'stored_value') {
    return `<p class="payment-title">💎 儲值金扣款 <strong>${total}</strong></p>
      <p class="payment-note">店家確認您的儲值金餘額後會扣款並安排出貨；如果餘額不足，我們會在 LINE 與您聯繫。</p>`;
  }
  const bank = settings.bank_account
    ? `<dl class="bank-info">
        <div><dt>銀行代碼</dt><dd>${escapeHtml(settings.bank_code)}${settings.bank_name ? `（${escapeHtml(settings.bank_name)}）` : ''}</dd></div>
        <div><dt>轉帳帳號</dt><dd>${escapeHtml(settings.bank_account)} <button type="button" class="link-btn" data-copy-account>複製</button></dd></div>
        ${settings.bank_holder ? `<div><dt>戶名</dt><dd>${escapeHtml(settings.bank_holder)}</dd></div>` : ''}
      </dl>`
    : '<p class="bank-pending">轉帳帳號將由店家在 LINE 上提供。</p>';
  const after = order.type === 'topup' ? '確認入帳後即為您加值' : '確認入帳後即安排出貨';
  // 在「我的訂單」裡，訂單卡片上方已經說明要在下方填後五碼，這裡就不重複
  const how = inMyOrders ? ''
    : order.customer_uid
      ? `轉帳後請按下方按鈕，到「我的訂單」填寫<strong>帳號後五碼</strong>，${after}。`
      : `轉帳後請按下方按鈕，用 LINE 回覆<strong>帳號後五碼</strong>，${after}。若 LINE 顯示「連線失敗」，回到這頁再按一次即可。`;
  return `<p class="payment-title">💳 請轉帳 <strong>${total}</strong> 至以下帳戶</p>${bank}
    ${how ? `<p class="payment-note">${how}</p>` : ''}`;
}

// 完成頁的回報按鈕：用 LINE 登入的客人到「我的訂單」填後五碼；沒登入的客人用 LINE 回報
function setupReportButton(button, order) {
  const inMyOrders = Boolean(order.customer_uid) && order.payment_method !== 'stored_value';
  if (inMyOrders) {
    button.href = '?view=orders';
    button.removeAttribute('target');
    button.dataset.openOrders = '';
    button.textContent = '到「我的訂單」回報匯款';
  } else {
    button.href = reportPaymentUrl(order);
    button.target = '_blank';
    delete button.dataset.openOrders;
    button.textContent = order.payment_method === 'stored_value' ? '用 LINE 聯絡我們' : '用 LINE 回報匯款';
  }
  button.classList.toggle('btn-line', !inMyOrders);
  button.classList.toggle('btn-primary', inMyOrders);
}

export function reportPaymentUrl(order) {
  if (order.payment_method === 'stored_value') {
    return lineMessageUrl(`您好，我的訂單編號：${order.order_no}（儲值金扣款 ${money(order.amounts.total)}）`);
  }
  return lineMessageUrl(`您好，我已完成轉帳\n${order.type === 'topup' ? '儲值申請' : '訂單'}編號：${order.order_no}\n轉帳金額：${money(order.amounts.total)}\n帳號後五碼：`);
}

// ========== ③ 訂單完成 ==========

function finishOrder(order) {
  lastOrder = order;
  cart = [];
  removedNotice = '';
  saveCart();
  $('checkout-form').reset();
  fillDistrictOptions(); // 清空後鄉鎮市區選單也要跟著重設
  renderCart();

  $('done-title').textContent = '訂單已送出，謝謝您的訂購！';
  $('done-order-no').textContent = order.order_no;
  $('done-payment').innerHTML = paymentInfoHtml(order);
  setupReportButton($('btn-report-payment'), order);
  showStep('done');
}

// ========== VIP 申請儲值 ==========

function renderTopupPlans() {
  $('vip-plans').innerHTML = TOPUP_PLANS.map(p => `
    <div class="vip-card${p.featured ? ' featured' : ''}">
      ${p.featured ? '<div class="vip-badge-top">最推薦</div>' : ''}
      <div class="vip-amount">儲值 ${money(p.amount)}</div>
      <div class="vip-bonus">加贈 <span>${money(p.bonus)}</span></div>
      <div class="vip-desc">總共獲得 ${money(p.amount + p.bonus)} 額度</div>
      <button type="button" class="btn btn-primary vip-apply" data-plan="${p.amount}">我要儲值</button>
    </div>
  `).join('');
}

async function openTopupDialog(amount) {
  // 申請儲值也要先用 LINE 登入，之後才查得到申請進度
  if (isLineLoginEnabled() && !getCustomer()) {
    try {
      await requireCustomer(`topup:${amount}`);
    } catch (error) {
      showToast(error.message);
      return;
    }
  }
  const plan = TOPUP_PLANS.find(p => p.amount === amount) ?? TOPUP_PLANS[0];
  const nameField = $('topup-form').elements.customer_name;
  if (!nameField.value && getCustomer()?.name) nameField.value = getCustomer().name;
  $('topup-plans').innerHTML = TOPUP_PLANS.map(p =>
    optionChip('plan', String(p.amount), `儲值 ${money(p.amount)}`, p === plan, `加贈 ${money(p.bonus)}・共 ${money(p.amount + p.bonus)}`)
  ).join('');
  document.querySelectorAll('#topup-dialog [data-topup-step]').forEach(el => {
    el.hidden = el.dataset.topupStep !== 'form';
  });
  $('topup-error').hidden = true;
  $('topup-dialog').showModal();
  $('topup-title').focus();
}

async function submitTopup(e) {
  e.preventDefault();
  if (isSubmitting) return;
  const form = $('topup-form').elements;
  const name = form.customer_name.value.trim();
  const phone = normalizePhone(form.customer_phone.value);
  const plan = TOPUP_PLANS.find(p => p.amount === Number(form.plan.value));
  const showError = (message, field) => {
    $('topup-error').textContent = message;
    $('topup-error').hidden = false;
    field?.focus();
  };

  if (!plan) return showError('請選擇儲值方案');
  if (!name) return showError('請填寫姓名', form.customer_name);
  if (!isValidPhone(phone)) return showError('請填寫正確的聯絡電話（例如 0912345678）', form.customer_phone);

  const order = {
    ...ownerField(),
    type: 'topup',
    order_no: makeOrderNo(),
    status: '待付款',
    payment_method: 'transfer',
    customer: { name, phone },
    note: form.order_note.value.trim(),
    topup: { plan_amount: plan.amount, bonus: plan.bonus, credit: plan.amount + plan.bonus },
    amounts: { total: plan.amount }
  };

  const button = $('btn-submit-topup');
  setSubmitting(button, true, '送出儲值申請');
  try {
    if (!orderSubmitter) throw new Error('訂單系統尚未連線');
    const saved = await orderSubmitter(order);
    notifyServer(order, saved?.id);
    finishTopup(order);
  } catch (error) {
    console.error('儲值申請送出失敗', error);
    showError(submitErrorText('儲值申請', error));
  } finally {
    setSubmitting(button, false, '送出儲值申請');
  }
}

function finishTopup(order) {
  lastTopup = order;
  $('topup-form').reset();
  $('topup-order-no').textContent = order.order_no;
  $('topup-payment').innerHTML = paymentInfoHtml(order);
  setupReportButton($('btn-topup-report'), order);
  document.querySelectorAll('#topup-dialog [data-topup-step]').forEach(el => {
    el.hidden = el.dataset.topupStep !== 'done';
  });
  $('topup-dialog').querySelector('.sheet-inner').scrollTop = 0;
}
