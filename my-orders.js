// 我的訂單：客人用 LINE 登入後，列出自己的訂單與即時狀態（安全規則確保只看得到自己的）
import { escapeHtml, paymentInfoHtml, reportPaymentUrl } from './order.js';
import { money, sizeLabel, paymentLabel, statusHint } from './pricing.js';
import { isLineLoginEnabled, getCustomer, onCustomerChange, requireCustomer, logoutCustomer, canLogout } from './line-login.js';

const LINE_CHAT_URL = 'https://line.me/R/ti/p/%40245rbror';
const $ = (id) => document.getElementById(id);

let firestore = null;   // { db, collection, query, where, onSnapshot }
let stopListener = null;
let listeningUid = null;
let myOrders = [];      // null 代表載入失敗
let loaded = false;
let logoutAllowed = true;

// 頁面載入時綁定按鈕（不用等 Firebase）
export function setupMyOrdersUi() {
  $('orders-button')?.addEventListener('click', openMyOrders);
  document.querySelectorAll('[data-open-orders]').forEach(el => el.addEventListener('click', (e) => {
    e.preventDefault();
    openMyOrders();
  }));
  $('orders-dialog')?.addEventListener('click', async (e) => {
    if (e.target.closest('[data-login]')) {
      e.target.closest('[data-login]').disabled = true;
      try {
        await requireCustomer('orders');
      } catch (error) {
        showLoginError(error.message);
      }
    }
    if (e.target.closest('[data-logout]')) await logoutCustomer();
  });
}

// Firebase 載入後呼叫
export function initMyOrders(fs) {
  firestore = fs;
  onCustomerChange(subscribe);
}

export function openMyOrders() {
  render();
  const dialog = $('orders-dialog');
  if (!dialog.open) dialog.showModal();
  $('orders-title').focus();
  canLogout().then((allowed) => {
    logoutAllowed = allowed;
    render();
  });
}

// 登入或登出時，重新讀取這位客人的訂單（即時更新）
function subscribe(customer) {
  if (!firestore) return;
  const uid = customer?.uid ?? null;
  if (uid !== listeningUid) {
    stopListener?.();
    stopListener = null;
    myOrders = [];
    loaded = false;
    listeningUid = uid;
    if (uid) {
      const q = firestore.query(firestore.collection(firestore.db, 'orders'), firestore.where('customer_uid', '==', uid));
      stopListener = firestore.onSnapshot(q, (snapshot) => {
        // 新的在前；剛送出、時間還沒寫入的訂單排最前面
        const time = (o) => o.created_at?.toMillis?.() ?? Number.MAX_SAFE_INTEGER;
        myOrders = snapshot.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => time(b) - time(a));
        loaded = true;
        render();
      }, (error) => {
        console.error('我的訂單載入失敗', error);
        myOrders = null;
        loaded = true;
        render();
      });
    }
  }
  render();
}

function showLoginError(message) {
  const box = $('orders-body').querySelector('.orders-login');
  if (!box) return;
  box.querySelector('[data-login]').disabled = false;
  let error = box.querySelector('.form-error');
  if (!error) {
    error = document.createElement('p');
    error.className = 'form-error';
    box.appendChild(error);
  }
  error.textContent = message;
}

function render() {
  const body = $('orders-body');
  if (!body) return;
  const customer = getCustomer();

  if (!isLineLoginEnabled()) {
    body.innerHTML = `
      <div class="orders-empty">
        <p>線上查詢訂單即將開放，目前請透過 LINE 詢問訂單狀態。</p>
        <a class="btn btn-line" href="${LINE_CHAT_URL}" target="_blank" rel="noopener noreferrer">LINE 詢問</a>
      </div>`;
    return;
  }
  if (!customer) {
    body.innerHTML = `
      <div class="orders-login">
        <div class="orders-login-icon" aria-hidden="true">💬</div>
        <p>用 LINE 登入後，就能查看您的訂單與出貨進度，<br>訂單有更新時也會用 LINE 通知您。</p>
        <button type="button" class="btn btn-line" data-login>用 LINE 登入</button>
      </div>`;
    return;
  }

  const head = `
    <div class="orders-user">
      <span>👋 ${escapeHtml(customer.name || 'LINE 會員')}，您好</span>
      ${logoutAllowed ? '<button type="button" class="link-btn" data-logout>登出</button>' : ''}
    </div>`;
  if (!loaded) {
    body.innerHTML = head + '<p class="orders-empty">訂單載入中…</p>';
  } else if (myOrders === null) {
    body.innerHTML = head + '<p class="orders-empty">訂單暫時無法載入，請稍後再試，或透過 LINE 詢問。</p>';
  } else if (myOrders.length === 0) {
    body.innerHTML = head + `
      <div class="orders-empty">
        <p>還沒有訂單紀錄。</p>
        <a href="#menu" class="btn btn-ghost" data-close>去逛豆單</a>
      </div>`;
  } else {
    body.innerHTML = head + `<ul class="my-orders">${myOrders.map(orderCardHtml).join('')}</ul>`;
  }
}

function formatDate(timestamp) {
  const date = timestamp?.toDate?.();
  if (!date) return '剛剛';
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(date);
}

function orderCardHtml(o) {
  const isTopup = o.type === 'topup';
  const items = isTopup
    ? `<li>儲值 ${money(o.topup?.plan_amount)}（加贈 ${money(o.topup?.bonus)}，共 ${money(o.topup?.credit)}）</li>`
    : (o.items || []).map(i => `<li>${escapeHtml(i.name)}｜${escapeHtml(i.process)}｜${escapeHtml(sizeLabel(i.size))} ×${escapeHtml(i.qty)}</li>`).join('');
  const meta = [formatDate(o.created_at), isTopup ? '儲值申請' : o.delivery_label, paymentLabel(o.payment_method)]
    .filter(Boolean).map(escapeHtml).join(' · ');
  const needsTransfer = o.status === '待付款' && o.payment_method !== 'stored_value';

  return `
    <li class="my-order">
      <div class="my-order-head">
        <strong>${isTopup ? '<span class="type-tag">儲值</span>' : ''}${escapeHtml(o.order_no)}</strong>
        <span class="order-status status-${escapeHtml(o.status)}">${escapeHtml(o.status)}</span>
      </div>
      <div class="my-order-meta">${meta}</div>
      <ul class="my-order-items">${items}</ul>
      <div class="my-order-total">合計 <strong>${money(o.amounts?.total)}</strong></div>
      <p class="my-order-hint">${escapeHtml(statusHint(o))}</p>
      ${needsTransfer ? `
        <div class="payment-box">${paymentInfoHtml(o)}</div>
        <a class="btn btn-line btn-block" href="${reportPaymentUrl(o)}" target="_blank" rel="noopener noreferrer">用 LINE 回報匯款</a>` : ''}
    </li>`;
}
