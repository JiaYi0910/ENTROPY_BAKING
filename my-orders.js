// 我的訂單：客人用 LINE 登入後，列出自己的訂單與即時狀態（安全規則確保只看得到自己的）
// 也可以在這裡回報匯款帳號後五碼、查看儲值金餘額
import { escapeHtml, paymentInfoHtml, getShopSettings } from './order.js';
import { money, sizeLabel, paymentLabel, statusHint } from './pricing.js';
import { isLineLoginEnabled, getCustomer, onCustomerChange, requireCustomer, logoutCustomer, canLogout } from './line-login.js';

const LINE_CHAT_URL = 'https://line.me/R/ti/p/%40245rbror';
const $ = (id) => document.getElementById(id);

let firestore = null;   // { db, collection, doc, query, where, onSnapshot, updateDoc, serverTimestamp }
let stopListeners = [];
let listeningUid = null;
let myOrders = [];      // null 代表載入失敗
let myMembers = [];     // 綁定這個 LINE 帳號的儲值會員
let loaded = false;
let logoutAllowed = true;

// 頁面載入時綁定按鈕（不用等 Firebase）
export function setupMyOrdersUi() {
  $('orders-button')?.addEventListener('click', openMyOrders);
  // 頁尾連結、完成頁的「到我的訂單回報匯款」都用 data-open-orders 打開
  document.addEventListener('click', (e) => {
    const link = e.target.closest('[data-open-orders]');
    if (!link) return;
    e.preventDefault();
    const dialog = link.closest('dialog');
    if (dialog && dialog.id !== 'orders-dialog') dialog.close();
    openMyOrders();
  });
  const dialog = $('orders-dialog');
  dialog?.addEventListener('click', async (e) => {
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
  dialog?.addEventListener('submit', onReportPayment);
  // 填後五碼時先不重畫，離開輸入框後再更新
  dialog?.addEventListener('focusout', () => setTimeout(() => {
    if (!isTyping()) render();
  }));
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

// 登入或登出時，重新讀取這位客人的訂單與儲值金（即時更新）
function subscribe(customer) {
  if (!firestore) return;
  const uid = customer?.uid ?? null;
  if (uid !== listeningUid) {
    stopListeners.forEach(stop => stop());
    stopListeners = [];
    myOrders = [];
    myMembers = [];
    loaded = false;
    listeningUid = uid;
    if (uid) {
      const { db, collection, query, where, onSnapshot } = firestore;
      stopListeners.push(onSnapshot(query(collection(db, 'orders'), where('customer_uid', '==', uid)), (snapshot) => {
        // 新的在前；剛送出、時間還沒寫入的訂單排最前面
        const time = (o) => o.created_at?.toMillis?.() ?? Number.MAX_SAFE_INTEGER;
        // 剛送出、伺服器時間還沒回來的欄位先用估計時間，畫面才能馬上顯示「已回報」
        myOrders = snapshot.docs.map(d => ({ id: d.id, ...d.data({ serverTimestamps: 'estimate' }) })).sort((a, b) => time(b) - time(a));
        loaded = true;
        render();
      }, (error) => {
        console.error('我的訂單載入失敗', error);
        myOrders = null;
        loaded = true;
        render();
      }));
      // 儲值金：店家確認這位客人的儲值後才會綁定；讀不到就不顯示
      stopListeners.push(onSnapshot(query(collection(db, 'members'), where('line_uids', 'array-contains', uid)), (snapshot) => {
        myMembers = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        render();
      }, (error) => {
        console.warn('儲值金讀取失敗', error);
        myMembers = [];
        render();
      }));
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

function isTyping() {
  const active = document.activeElement;
  return Boolean(active && $('orders-body')?.contains(active) && active.matches('input'));
}

function render() {
  const body = $('orders-body');
  if (!body || isTyping()) return; // 客人正在填後五碼，等離開輸入框再更新
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
    </div>
    ${myMembers.map(balanceHtml).join('')}`;
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

function shortDate(ms) {
  if (!ms) return '';
  return new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

// 儲值金餘額與最近幾筆加值、扣款（店家內部備註不顯示）
function balanceHtml(m) {
  const recent = Array.isArray(m.recent_tx) ? m.recent_tx.slice(0, 5) : [];
  return `
    <div class="my-balance">
      <div class="my-balance-head">
        <span>💎 儲值金餘額<small>會員電話 ${escapeHtml(m.phone || m.id)}</small></span>
        <strong>${money(m.balance)}</strong>
      </div>
      ${recent.length ? `<ul class="my-balance-tx">${recent.map(t => `
        <li>
          <span>${escapeHtml(shortDate(t.at))}</span>
          <span>${escapeHtml(t.type)}${t.order_no ? `・${escapeHtml(t.order_no)}` : '・門市登記'}</span>
          <span class="${t.amount >= 0 ? 'tx-plus' : 'tx-minus'}">${t.amount >= 0 ? '+' : '−'}${money(Math.abs(t.amount))}</span>
        </li>`).join('')}</ul>` : ''}
    </div>`;
}

function orderCardHtml(o) {
  const isTopup = o.type === 'topup';
  const items = isTopup
    ? `<li>儲值 ${money(o.topup?.plan_amount)}（加贈 ${money(o.topup?.bonus)}，共 ${money(o.topup?.credit)}）</li>`
    : (o.items || []).map(i => `<li>${escapeHtml(i.name)}｜${escapeHtml(i.process)}｜${escapeHtml(sizeLabel(i.size))} ×${escapeHtml(i.qty)}</li>`).join('');
  const meta = [formatDate(o.created_at), isTopup ? '儲值申請' : o.delivery_label, paymentLabel(o.payment_method)]
    .filter(Boolean).map(escapeHtml).join(' · ');
  const needsTransfer = o.status === '待付款' && o.payment_method === 'transfer';

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
        <div class="payment-box">${paymentInfoHtml(o, { inMyOrders: true })}</div>
        ${reportFormHtml(o)}` : ''}
    </li>`;
}

// 回報匯款：填帳號後五碼，店家後台會看到並收到 Email
function reportFormHtml(o) {
  const reported = Boolean(o.payment_reported_at);
  return `
    <form class="report-form" data-order-id="${escapeHtml(o.id)}" novalidate>
      <label>匯款帳號後五碼
        <input type="text" name="last5" inputmode="numeric" maxlength="5" autocomplete="off" placeholder="例如 12345" value="${escapeHtml(o.payment_last5 || '')}">
      </label>
      <button type="submit" class="btn btn-primary">${reported ? '更新回報' : '回報匯款'}</button>
      <p class="report-message" role="status">${reported ? `✓ 已於 ${escapeHtml(formatDate(o.payment_reported_at))} 回報` : ''}</p>
    </form>`;
}

async function onReportPayment(e) {
  const form = e.target.closest('.report-form');
  if (!form) return;
  e.preventDefault();
  const input = form.elements.last5;
  const message = form.querySelector('.report-message');
  const last5 = input.value.replace(/\s/g, '');
  if (!/^\d{5}$/.test(last5)) {
    message.textContent = '請填寫 5 位數字';
    message.classList.add('is-error');
    input.focus();
    return;
  }
  const button = form.querySelector('button');
  button.disabled = true;
  message.classList.remove('is-error');
  message.textContent = '送出中…';
  const orderId = form.dataset.orderId;
  try {
    const { db, doc, updateDoc, serverTimestamp } = firestore;
    await updateDoc(doc(db, 'orders', orderId), { payment_last5: last5, payment_reported_at: serverTimestamp() });
    notifyPaymentReported(orderId);
    input.blur();
    render(); // 換成「已回報」的樣子
  } catch (error) {
    console.error('回報匯款失敗', error);
    message.textContent = `回報失敗，請稍後再試，或用 LINE 告訴我們。（錯誤代碼：${String(error?.code || error?.message || '未知').slice(0, 40)}）`;
    message.classList.add('is-error');
  } finally {
    button.disabled = false;
  }
}

// 請 Google 小幫手寄 Email 通知店家（小幫手會到資料庫確認真的有回報才寄）
function notifyPaymentReported(orderId) {
  const url = getShopSettings().notify_url || '';
  if (!url.startsWith('https://script.google.com/')) return;
  fetch(url, {
    method: 'POST',
    mode: 'no-cors',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: 'payment-reported', orderId })
  }).catch(() => {
    // 通知失敗不影響回報，店家後台一樣看得到
  });
}
