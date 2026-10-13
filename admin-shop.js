// 後台：訂單管理、儲值會員、商店設定、新訂單通知
import {
  collection, doc, onSnapshot, query, orderBy, limit, updateDoc, deleteDoc, setDoc, getDocs,
  runTransaction, serverTimestamp, arrayUnion
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import {
  ORDER_STATUSES, TOPUP_PLANS, normalizeSettings, money, sizeLabel, unitPrice, processingFee,
  calcTotals, normalizePhone, isValidPhone, paymentLabel
} from "./pricing.js";

const $ = (id) => document.getElementById(id);

let ctx = null;             // admin.js 傳進來的共用工具 { db, auth, showToast, escapeHtml, dbErrorMessage, getProducts }
let orders = new Map();     // 訂單 id → 資料（新到舊）
let members = new Map();    // 電話 → 會員資料
let settings = normalizeSettings({});
let stopListeners = [];
let knownOrderIds = null;   // 第一次載入後才開始判斷「新訂單」
let newOrderIds = new Set();
let openOrderIds = new Set();
let unseenCount = 0;
let settingsDirty = false;  // 設定表單正在修改中，就不要被資料庫的更新蓋掉
const baseTitle = document.title;

// 給管理員看的錯誤訊息（例如餘額不足），會直接顯示
class ShopError extends Error {}

function esc(value) {
  return ctx.escapeHtml(value);
}

function errorText(error) {
  return error instanceof ShopError ? error.message : ctx.dbErrorMessage(error);
}

function formatTime(timestamp) {
  const date = timestamp?.toDate?.();
  if (!date) return '剛剛';
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(date);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// 訂單狀態改變後，請 Google 小幫手用 LINE 通知客人（只有用 LINE 登入下單的客人收得到；同一個狀態只通知一次）
function notifyCustomer(orderId) {
  const url = settings.notify_url;
  if (!url.startsWith('https://script.google.com/')) return;
  fetch(url, {
    method: 'POST',
    mode: 'no-cors',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: 'order-status', orderId })
  }).catch(() => {
    // 通知失敗不影響訂單狀態
  });
}

// ========== 啟動與停止（登入、登出時由 admin.js 呼叫） ==========

export function initShop(context) {
  ctx = context;

  $('order-list').addEventListener('click', onOrderClick);
  $('order-list').addEventListener('submit', onOrderSave);
  $('order-list').addEventListener('toggle', onOrderToggle, true);
  // 正在編輯某筆訂單時先不重畫，離開輸入框後再更新
  $('order-list').addEventListener('focusout', () => setTimeout(() => {
    if (!$('order-list').contains(document.activeElement)) renderOrders();
  }));
  $('order-search').addEventListener('input', renderOrders);
  $('order-status-filter').addEventListener('change', renderOrders);
  document.querySelectorAll('[data-filter-status]').forEach(el => el.addEventListener('click', () => {
    $('order-status-filter').value = el.dataset.filterStatus;
    renderOrders();
  }));

  $('member-search').addEventListener('input', renderMembers);
  $('member-list').addEventListener('toggle', onMemberToggle, true);
  $('member-list').addEventListener('click', onMemberClick);
  $('member-adjust-form').addEventListener('submit', onManualAdjust);
  $('member-adjust-form').addEventListener('input', () => { $('member-adjust-error').hidden = true; });

  $('settings-form').addEventListener('input', () => { settingsDirty = true; });
  $('settings-form').addEventListener('submit', onSaveSettings);
  $('btn-test-notify').addEventListener('click', onTestNotify);

  setupDesktopNotifications();
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      unseenCount = 0;
      document.title = baseTitle;
    }
  });
}

export function startShop() {
  stopShop();
  const db = ctx.db;
  const onError = (label) => (error) => {
    if (!ctx.auth.currentUser) return; // 登出時監聽中斷屬正常
    console.error(label, error);
    ctx.showToast(`${label}：${ctx.dbErrorMessage(error)}`, 'error');
  };

  $('order-list').innerHTML = '<p class="list-empty">訂單載入中…</p>';
  stopListeners.push(onSnapshot(
    query(collection(db, 'orders'), orderBy('created_at', 'desc'), limit(300)),
    (snapshot) => {
      const ids = snapshot.docs.map(d => d.id);
      const previous = orders;
      orders = new Map(snapshot.docs.map(d => [d.id, d.data()]));
      if (knownOrderIds) {
        const fresh = ids.filter(id => !knownOrderIds.has(id));
        if (fresh.length) announceNewOrders(fresh);
        const reportedAt = (o) => o?.payment_reported_at?.toMillis?.() ?? 0;
        const reports = ids.filter(id => !fresh.includes(id) && reportedAt(orders.get(id)) > reportedAt(previous.get(id)));
        if (reports.length) announcePaymentReports(reports);
      }
      knownOrderIds = new Set(ids);
      renderOrders();
      renderStats();
    },
    onError('訂單載入失敗')));

  stopListeners.push(onSnapshot(collection(db, 'members'), (snapshot) => {
    members = new Map(snapshot.docs.map(d => [d.id, d.data()]));
    renderMembers();
    renderOrders(); // 訂單上顯示的會員餘額跟著更新
  }, onError('儲值會員載入失敗')));

  stopListeners.push(onSnapshot(doc(db, 'settings', 'shop'), (snap) => {
    settings = normalizeSettings(snap.exists() ? snap.data() : {});
    if (!settingsDirty) fillSettingsForm();
  }, onError('商店設定載入失敗')));
}

export function stopShop() {
  stopListeners.forEach(stop => stop());
  stopListeners = [];
  orders = new Map();
  members = new Map();
  knownOrderIds = null;
  newOrderIds = new Set();
  openOrderIds = new Set();
  settingsDirty = false;
}

// ========== 統計 ==========

function renderStats() {
  let unpaid = 0;
  let toShip = 0;
  orders.forEach(o => {
    if (o.status === '待付款') unpaid++;
    if (o.status === '已付款' && o.type !== 'topup') toShip++;
  });
  $('stat-unpaid').textContent = unpaid;
  $('stat-to-ship').textContent = toShip;
}

// ========== 新訂單通知 ==========

function announceNewOrders(ids) {
  ids.forEach(id => newOrderIds.add(id));
  const first = orders.get(ids[0]);
  const kind = first?.type === 'topup' ? '儲值申請' : '訂單';
  const text = ids.length === 1
    ? `🔔 新${kind}：${first.order_no}（${first.customer?.name}，${money(first.amounts?.total)}）`
    : `🔔 有 ${ids.length} 筆新訂單`;
  ctx.showToast(text, 'warn');
  playChime();

  if (document.hidden) {
    unseenCount += ids.length;
    document.title = `(${unseenCount}) ${baseTitle}`;
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('熵與焙 有新訂單', { body: text.replace('🔔 ', '') });
    }
  }
}

// 客人在「我的訂單」回報匯款時提示管理員核對入帳
function announcePaymentReports(ids) {
  const first = orders.get(ids[0]);
  const text = ids.length === 1
    ? `💰 客人回報匯款：${first.order_no}（${first.customer?.name}，後五碼 ${first.payment_last5}）`
    : `💰 有 ${ids.length} 筆匯款回報`;
  ctx.showToast(text, 'warn');
  playChime();
  if (document.hidden) {
    unseenCount += ids.length;
    document.title = `(${unseenCount}) ${baseTitle}`;
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('熵與焙 客人回報匯款', { body: text.replace('💰 ', '') });
    }
  }
}

function isPaymentReported(o) {
  return o.status === '待付款' && Boolean(o.payment_reported_at) && o.payment_method === 'transfer';
}

// 提示音：兩聲短音
function playChime() {
  try {
    const audio = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.18].forEach((delay, i) => {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.frequency.value = i === 0 ? 880 : 1175;
      gain.gain.value = 0.08;
      osc.connect(gain).connect(audio.destination);
      osc.start(audio.currentTime + delay);
      osc.stop(audio.currentTime + delay + 0.15);
    });
    setTimeout(() => audio.close(), 800);
  } catch {
    // 瀏覽器不支援就不播放
  }
}

function setupDesktopNotifications() {
  const button = $('btn-enable-notify');
  if (!('Notification' in window)) {
    button.hidden = true;
    return;
  }
  const update = () => {
    const state = Notification.permission;
    button.textContent = state === 'granted' ? '🔔 桌面通知已開啟' : (state === 'denied' ? '🔕 桌面通知被封鎖' : '🔔 開啟桌面通知');
    button.disabled = state !== 'default';
    button.title = state === 'denied' ? '請在瀏覽器網址列左邊的設定裡允許通知' : '後台分頁在背景時，有新訂單會跳出桌面通知';
  };
  update();
  button.addEventListener('click', async () => {
    await Notification.requestPermission();
    update();
  });
}

// ========== 訂單列表 ==========

function filteredOrders() {
  const keyword = $('order-search').value.trim().toLowerCase();
  const filter = $('order-status-filter').value;
  return [...orders.entries()].filter(([, o]) => {
    if (filter === 'topup' && o.type !== 'topup') return false;
    if (filter === 'reported' && !isPaymentReported(o)) return false;
    if (filter && filter !== 'topup' && filter !== 'reported' && o.status !== filter) return false;
    if (!keyword) return true;
    return [o.order_no, o.customer?.name, o.customer?.phone].some(v => String(v ?? '').toLowerCase().includes(keyword));
  });
}

function renderOrders() {
  const list = $('order-list');
  // 正在填寫某筆訂單的欄位時先不重畫，避免打到一半被清掉
  if (list.contains(document.activeElement) && document.activeElement.matches('input, textarea, select')) return;

  const rows = filteredOrders();
  $('order-count').textContent = rows.length === orders.size ? `共 ${orders.size} 筆` : `顯示 ${rows.length} / ${orders.size} 筆`;

  if (orders.size === 0) {
    list.innerHTML = '<p class="list-empty">目前還沒有訂單。客人在前台送出訂單後，會即時出現在這裡。</p>';
  } else if (rows.length === 0) {
    list.innerHTML = '<p class="list-empty">沒有符合條件的訂單</p>';
  } else {
    list.innerHTML = rows.map(([id, o]) => orderHtml(id, o)).join('');
  }
}

function orderHtml(id, o) {
  const isTopup = o.type === 'topup';
  const status = ORDER_STATUSES.includes(o.status) ? o.status : '待付款';
  const meta = [formatTime(o.created_at), o.customer?.name, isTopup ? '儲值申請' : o.delivery_label, paymentLabel(o.payment_method)]
    .filter(Boolean).map(esc).join(' · ');

  return `
    <details class="order-item${newOrderIds.has(id) ? ' is-new' : ''}" data-id="${esc(id)}"${openOrderIds.has(id) ? ' open' : ''}>
      <summary>
        <span class="order-no">${isTopup ? '<span class="type-badge">儲值</span>' : ''}${esc(o.order_no)}</span>
        <span class="order-meta">${meta}</span>
        <strong class="order-total">${money(o.amounts?.total)}</strong>
        ${isPaymentReported(o) ? '<span class="report-badge">💰 已回報</span>' : ''}
        <span class="status-badge status-${esc(status)}">${esc(status)}</span>
      </summary>
      <div class="order-body">
        ${paymentReportHtml(o)}
        ${isTopup ? topupDetailHtml(o) : itemsDetailHtml(o)}
        ${customerHtml(o)}
        ${storedValueHtml(o)}
        ${manageFormHtml(id, o, status)}
      </div>
    </details>`;
}

function paymentReportHtml(o) {
  if (!isPaymentReported(o)) return '';
  const next = o.type === 'topup' ? '核對入帳後，按下方「確認入帳並加值」。' : '核對入帳後，把訂單狀態改成「已付款」並儲存。';
  return `<p class="payment-report-box">💰 客人於 ${formatTime(o.payment_reported_at)} 回報匯款，帳號後五碼 <strong>${esc(o.payment_last5)}</strong>。${next}</p>`;
}

function itemsDetailHtml(o) {
  const items = Array.isArray(o.items) ? o.items : [];
  const a = o.amounts ?? {};
  return `
    <p class="order-section-title">商品</p>
    <table class="order-lines"><tbody>
      ${items.map(i => `
        <tr>
          <td>${esc(i.name)}<small>${esc(i.process)}・${esc(sizeLabel(i.size))} × ${esc(i.qty)}${i.fee ? `（含耗材 ${money(i.fee)}×${esc(i.qty)}）` : ''}</small></td>
          <td>${money(i.total)}</td>
        </tr>`).join('')}
    </tbody></table>
    <dl class="order-amounts">
      <div><dt>咖啡豆</dt><dd>${money(a.goods)}</dd></div>
      ${a.fees ? `<div><dt>加工耗材</dt><dd>${money(a.fees)}</dd></div>` : ''}
      <div><dt>運費</dt><dd>${a.shipping ? money(a.shipping) : '免運費'}</dd></div>
      <div class="amount-total"><dt>合計</dt><dd>${money(a.total)}</dd></div>
    </dl>
    ${amountCheckHtml(o)}`;
}

// 用目前的商品價格與商店設定重新計算，跟客人送出的金額不同就提醒（客人的瀏覽器可能被竄改）
function amountCheckHtml(o) {
  const products = ctx.getProducts();
  const items = Array.isArray(o.items) ? o.items : [];
  const lines = items.map(i => ({
    unit: unitPrice(products.get(i.product_id), i.size),
    fee: processingFee(i.process, i.size, settings),
    qty: Number(i.qty) || 0
  }));
  if (lines.length === 0 || lines.some(l => l.unit == null)) {
    return '<p class="hint">（有商品已刪除，無法自動核對金額）</p>';
  }
  const expected = calcTotals(lines, o.delivery, settings).total;
  if (expected === o.amounts?.total) return '';
  return `<p class="amount-warning">⚠ 依目前價格重新計算應為 ${money(expected)}，與訂單金額 ${money(o.amounts?.total)} 不同。可能是下單後調整過價格或運費，請確認後再收款。</p>`;
}

function topupDetailHtml(o) {
  const t = o.topup ?? {};
  const plan = TOPUP_PLANS.find(p => p.amount === t.plan_amount);
  const valid = plan && t.bonus === plan.bonus && t.credit === plan.amount + plan.bonus && o.amounts?.total === plan.amount;
  return `
    <p class="order-section-title">儲值方案</p>
    <dl class="order-amounts">
      <div><dt>儲值金額</dt><dd>${money(t.plan_amount)}</dd></div>
      <div><dt>加贈</dt><dd>${money(t.bonus)}</dd></div>
      <div class="amount-total"><dt>加值額度</dt><dd>${money(t.credit)}</dd></div>
    </dl>
    ${valid ? '' : '<p class="amount-warning">⚠ 方案內容與目前的儲值方案不符，請確認後再加值。</p>'}`;
}

function customerHtml(o) {
  const c = o.customer ?? {};
  const phone = normalizePhone(c.phone);
  return `
    <p class="order-section-title">客人資料</p>
    <dl class="order-customer">
      <div><dt>姓名</dt><dd>${esc(c.name)}</dd></div>
      <div><dt>電話</dt><dd><a href="tel:${esc(phone)}">${esc(c.phone)}</a></dd></div>
      ${o.type === 'topup' ? '' : `<div><dt>取貨方式</dt><dd>${esc(o.delivery_label)}</dd></div>`}
      ${c.store ? `<div><dt>全家門市</dt><dd>${esc(c.store)}</dd></div>` : ''}
      ${c.address ? `<div><dt>收件地址</dt><dd>${esc(c.address)}</dd></div>` : ''}
      <div><dt>付款方式</dt><dd>${esc(paymentLabel(o.payment_method))}</dd></div>
      <div><dt>LINE</dt><dd>${o.customer_uid ? '✓ 已用 LINE 登入（付款、出貨時會自動通知客人）' : '未用 LINE 登入（不會自動通知）'}</dd></div>
      ${memberLinkHtml(o, phone)}
      ${o.note ? `<div><dt>客人備註</dt><dd>${esc(o.note)}</dd></div>` : ''}
    </dl>`;
}

// 這支電話是儲值會員時：顯示客人能不能在「我的訂單」看到餘額，還沒綁定就提供綁定按鈕
function memberLinkHtml(o, phone) {
  const member = members.get(phone);
  if (!member || !o.customer_uid) return '';
  const linked = (member.line_uids ?? []).includes(o.customer_uid);
  return `<div><dt>儲值金</dt><dd>餘額 ${money(member.balance)}・${linked
    ? '✓ 客人可在「我的訂單」查看餘額'
    : '<button type="button" class="btn-secondary btn-link-member" data-action="link-member">🔗 讓客人在「我的訂單」看到餘額</button>'}</dd></div>`;
}

// 儲值相關操作：儲值申請 → 確認入帳並加值；儲值金扣款訂單 → 從儲值金扣款
function storedValueHtml(o) {
  const phone = normalizePhone(o.customer?.phone);
  const member = members.get(phone);
  const balanceText = member ? `目前儲值金餘額 <strong>${money(member.balance)}</strong>` : '這支電話還不是儲值會員（加值後會自動建立）';

  if (o.type === 'topup') {
    if (o.stored_value_applied) return `<div class="stored-value-box"><p class="done">✓ 已加值 ${money(o.topup?.credit)}</p><p>${balanceText}</p></div>`;
    return `
      <div class="stored-value-box">
        <p>${balanceText}</p>
        <p>確認收到轉帳 ${money(o.amounts?.total)} 後，按下按鈕會幫 ${esc(o.customer?.name)}（${esc(phone)}）加值 <strong>${money(o.topup?.credit)}</strong>，訂單自動改為「已完成」。</p>
        <button type="button" class="btn-stored-value" data-action="apply-topup">✅ 確認入帳並加值 ${money(o.topup?.credit)}</button>
      </div>`;
  }

  if (o.payment_method !== 'stored_value') return '';
  if (o.stored_value_applied) return `<div class="stored-value-box"><p class="done">✓ 已從儲值金扣款 ${money(o.amounts?.total)}</p><p>${balanceText}</p></div>`;
  const enough = member && Number(member.balance) >= Number(o.amounts?.total);
  return `
    <div class="stored-value-box">
      <p>💎 這筆訂單選擇<strong>儲值金扣款</strong>。${balanceText}</p>
      ${member && !enough ? `<p class="amount-warning">餘額不足，還差 ${money(o.amounts.total - member.balance)}，請先與客人聯繫。</p>` : ''}
      <button type="button" class="btn-stored-value" data-action="charge-stored-value"${enough ? '' : ' disabled'}>💎 從儲值金扣款 ${money(o.amounts?.total)}</button>
    </div>`;
}

function manageFormHtml(id, o, status) {
  return `
    <form class="order-manage" data-id="${esc(id)}">
      <div class="form-grid">
        <div class="form-group">
          <label>訂單狀態
            <select name="status">${ORDER_STATUSES.map(s => `<option value="${s}"${s === status ? ' selected' : ''}>${s}</option>`).join('')}</select>
          </label>
        </div>
        <div class="form-group">
          <label>匯款帳號後五碼
            <input type="text" name="payment_last5" maxlength="5" inputmode="numeric" value="${esc(o.payment_last5)}" placeholder="客人回報後填寫">
          </label>
        </div>
        <div class="form-group full">
          <label>管理備註（客人看不到）
            <textarea name="admin_note" rows="2" maxlength="300">${esc(o.admin_note)}</textarea>
          </label>
        </div>
      </div>
      <div class="order-manage-actions">
        <button type="submit">💾 儲存</button>
        <button type="button" class="btn-secondary" data-action="copy-order">📋 複製訂單資訊</button>
        <button type="button" class="btn-delete" data-action="delete-order">❌ 刪除</button>
      </div>
    </form>`;
}

function onOrderToggle(e) {
  const item = e.target.closest?.('.order-item');
  if (!item || e.target !== item) return;
  const id = item.dataset.id;
  if (item.open) {
    openOrderIds.add(id);
    newOrderIds.delete(id);
    item.classList.remove('is-new');
  } else {
    openOrderIds.delete(id);
  }
}

async function onOrderSave(e) {
  e.preventDefault();
  const form = e.target.closest('.order-manage');
  if (!form) return;
  const id = form.dataset.id;
  const data = {
    status: form.elements.status.value,
    payment_last5: form.elements.payment_last5.value.trim(),
    admin_note: form.elements.admin_note.value.trim(),
    updated_at: serverTimestamp()
  };
  if (data.payment_last5 && !/^\d{5}$/.test(data.payment_last5)) {
    ctx.showToast('匯款帳號後五碼請填 5 個數字', 'error');
    form.elements.payment_last5.focus();
    return;
  }
  const button = form.querySelector('button[type="submit"]');
  const statusChanged = orders.get(id)?.status !== data.status;
  button.disabled = true;
  try {
    await updateDoc(doc(ctx.db, 'orders', id), data);
    if (statusChanged) notifyCustomer(id);
    document.activeElement?.blur();
    ctx.showToast(`已更新訂單 ${orders.get(id)?.order_no ?? ''}`);
  } catch (error) {
    ctx.showToast('訂單更新失敗：' + errorText(error), 'error');
  } finally {
    button.disabled = false;
  }
}

async function onOrderClick(e) {
  const button = e.target.closest('button[data-action]');
  if (!button) return;
  const id = button.closest('.order-item').dataset.id;
  const o = orders.get(id);
  if (!o) return;

  if (button.dataset.action === 'copy-order') {
    const ok = await copyText(orderPlainText(o));
    ctx.showToast(ok ? '已複製訂單資訊' : '複製失敗', ok ? 'success' : 'error');
  }
  if (button.dataset.action === 'delete-order') {
    if (!confirm(`確定要刪除訂單 ${o.order_no}（${o.customer?.name}）嗎？\n刪除後無法復原。只是不成立的訂單，建議改成「已取消」。`)) return;
    try {
      await deleteDoc(doc(ctx.db, 'orders', id));
      ctx.showToast(`已刪除訂單 ${o.order_no}`);
    } catch (error) {
      ctx.showToast('刪除失敗：' + errorText(error), 'error');
    }
  }
  if (button.dataset.action === 'apply-topup') {
    const credit = Number(o.topup?.credit) || 0;
    if (!confirm(`確認已收到 ${o.customer?.name} 的轉帳 ${money(o.amounts?.total)}？\n將為 ${o.customer?.phone} 加值 ${money(credit)}。`)) return;
    await runBalanceChange(button, {
      phone: o.customer?.phone, name: o.customer?.name, amount: credit, type: '儲值', orderId: id, orderNo: o.order_no,
      note: `儲值 ${money(o.topup?.plan_amount)} 加贈 ${money(o.topup?.bonus)}`, orderUpdate: { status: '已完成' },
      linkCustomer: true, // 客人用 LINE 申請儲值並入帳後，就能在「我的訂單」看到餘額
      success: `已為 ${o.customer?.name} 加值 ${money(credit)}`
    });
  }
  if (button.dataset.action === 'link-member') {
    const phone = normalizePhone(o.customer?.phone);
    if (!confirm(`確認 ${phone} 是 ${o.customer?.name} 本人的電話嗎？\n綁定後，這位客人可以在「我的訂單」查看這支電話的儲值金餘額。`)) return;
    button.disabled = true;
    try {
      await updateDoc(doc(ctx.db, 'members', phone), { line_uids: arrayUnion(o.customer_uid) });
      ctx.showToast(`已綁定，${o.customer?.name} 可以在「我的訂單」看到儲值金餘額`);
    } catch (error) {
      ctx.showToast('綁定失敗：' + errorText(error), 'error');
      button.disabled = false;
    }
  }
  if (button.dataset.action === 'charge-stored-value') {
    const total = Number(o.amounts?.total) || 0;
    if (!confirm(`確定從 ${o.customer?.name}（${o.customer?.phone}）的儲值金扣除 ${money(total)}？\n訂單會改為「已付款」。`)) return;
    await runBalanceChange(button, {
      phone: o.customer?.phone, name: o.customer?.name, amount: -total, type: '扣款', orderId: id, orderNo: o.order_no,
      note: '購物訂單', orderUpdate: { status: '已付款' },
      success: `已從儲值金扣款 ${money(total)}`
    });
  }
}

function orderPlainText(o) {
  const c = o.customer ?? {};
  const lines = [`訂單編號：${o.order_no}`, `姓名：${c.name}`, `電話：${c.phone}`];
  if (o.type === 'topup') {
    lines.push(`儲值申請：儲值 ${money(o.topup?.plan_amount)}，加值 ${money(o.topup?.credit)}`);
  } else {
    lines.push(`取貨方式：${o.delivery_label}`);
    if (c.store) lines.push(`全家門市：${c.store}`);
    if (c.address) lines.push(`收件地址：${c.address}`);
    (o.items ?? []).forEach(i => lines.push(`・${i.name}｜${i.process}｜${sizeLabel(i.size)} ×${i.qty}`));
  }
  lines.push(`金額：${money(o.amounts?.total)}（${paymentLabel(o.payment_method)}）`);
  if (o.note) lines.push(`備註：${o.note}`);
  return lines.join('\n');
}

// ========== 儲值金餘額 ==========

// 加值或扣款：在同一個交易裡更新餘額、寫入紀錄、標記訂單，避免重複加值或扣款
// 會員資料上另存最近 10 筆給客人看（不含經手人與內部備註）；詳細紀錄在 transactions，只有管理員看得到
async function changeBalance({ phone, name, amount, type, orderId, orderNo, note, orderUpdate, linkCustomer }) {
  const memberId = normalizePhone(phone);
  if (!isValidPhone(memberId)) throw new ShopError('電話格式不正確，無法辨識儲值會員');
  if (!Number.isFinite(amount) || amount === 0) throw new ShopError('金額不正確');

  await runTransaction(ctx.db, async (tx) => {
    const memberRef = doc(ctx.db, 'members', memberId);
    const orderRef = orderId ? doc(ctx.db, 'orders', orderId) : null;

    const orderSnap = orderRef ? await tx.get(orderRef) : null;
    if (orderSnap && !orderSnap.exists()) throw new ShopError('找不到這筆訂單，可能已被刪除');
    if (orderSnap?.data().stored_value_applied) throw new ShopError('這筆已經處理過了，不會重複加值或扣款');

    const memberSnap = await tx.get(memberRef);
    const current = memberSnap.exists() ? Number(memberSnap.data().balance) || 0 : 0;
    const next = current + amount;
    if (next < 0) throw new ShopError(`儲值金餘額不足（目前 ${money(current)}，需要 ${money(-amount)}）`);

    const lineUid = linkCustomer ? orderSnap?.data().customer_uid : null;
    const recent = [{ type, amount, balance_after: next, order_no: orderNo || '', at: Date.now() },
      ...(memberSnap.data()?.recent_tx ?? [])].slice(0, 10);
    tx.set(memberRef, {
      phone: memberId,
      name: name || memberSnap.data()?.name || '',
      balance: next,
      recent_tx: recent,
      ...(lineUid ? { line_uids: arrayUnion(lineUid) } : {}),
      updated_at: serverTimestamp()
    }, { merge: true });
    tx.set(doc(collection(ctx.db, 'members', memberId, 'transactions')), {
      type,
      amount,
      balance_after: next,
      order_no: orderNo || '',
      note: note || '',
      by: ctx.auth.currentUser?.email || '',
      created_at: serverTimestamp()
    });
    if (orderRef) tx.update(orderRef, { stored_value_applied: true, ...orderUpdate, updated_at: serverTimestamp() });
  });
}

async function runBalanceChange(button, { success, ...change }) {
  button.disabled = true;
  try {
    await changeBalance(change);
    if (change.orderId) notifyCustomer(change.orderId); // 加值完成、扣款後訂單狀態有變
    ctx.showToast(success);
  } catch (error) {
    console.error('儲值金更新失敗', error);
    ctx.showToast('儲值金更新失敗：' + errorText(error), 'error');
    button.disabled = false;
  }
}

async function onManualAdjust(e) {
  e.preventDefault();
  const form = $('member-adjust-form').elements;
  const phone = normalizePhone(form.phone.value);
  const amount = Number(form.amount.value);
  const showError = (message, field) => {
    $('member-adjust-error').textContent = message;
    $('member-adjust-error').hidden = false;
    field?.focus();
  };
  if (!isValidPhone(phone)) return showError('請填寫正確的電話', form.phone);
  if (!Number.isInteger(amount) || amount <= 0) return showError('金額請填 1 以上的整數', form.amount);
  if (!members.has(phone) && !form.name.value.trim()) return showError('這是新會員，請填寫姓名', form.name);

  const isCharge = form.type.value === '扣款';
  const label = `${isCharge ? '扣款' : '加值'} ${money(amount)}`;
  if (!confirm(`確定為 ${form.name.value.trim() || members.get(phone)?.name}（${phone}）${label}？`)) return;

  const button = $('btn-member-adjust');
  button.disabled = true;
  try {
    await changeBalance({
      phone, name: form.name.value.trim(), amount: isCharge ? -amount : amount,
      type: isCharge ? '扣款' : '儲值', note: form.note.value.trim() || '手動調整'
    });
    $('member-adjust-form').reset();
    ctx.showToast(`已${label}`);
  } catch (error) {
    showError(errorText(error));
  } finally {
    button.disabled = false;
  }
}

function renderMembers() {
  const keyword = $('member-search').value.trim().toLowerCase();
  const rows = [...members.entries()]
    .filter(([phone, m]) => !keyword || [phone, m.name].some(v => String(v ?? '').toLowerCase().includes(keyword)))
    .sort(([, a], [, b]) => (b.updated_at?.toMillis?.() ?? 0) - (a.updated_at?.toMillis?.() ?? 0));

  let total = 0;
  members.forEach(m => { total += Number(m.balance) || 0; });
  $('member-count').textContent = `共 ${members.size} 位，儲值金總額 ${money(total)}`;

  const list = $('member-list');
  if (members.size === 0) {
    list.innerHTML = '<p class="list-empty">還沒有儲值會員。儲值申請入帳加值，或在上方手動加值後就會出現。</p>';
  } else if (rows.length === 0) {
    list.innerHTML = '<p class="list-empty">沒有符合條件的會員</p>';
  } else {
    list.innerHTML = rows.map(([phone, m]) => `
      <details class="member-item" data-phone="${esc(phone)}">
        <summary>
          <span><strong>${esc(m.name || '（未填姓名）')}</strong> <small class="hint">${esc(phone)}</small>${m.line_uids?.length ? '<span class="line-tag">LINE</span>' : ''}</span>
          <span class="member-balance${Number(m.balance) ? '' : ' zero'}">${money(m.balance)}</span>
        </summary>
        <div class="member-actions">${m.line_uids?.length
          ? `<span>已綁定 ${m.line_uids.length} 個 LINE 帳號，客人可在「我的訂單」查看餘額</span><button type="button" class="btn-secondary" data-unlink-member>解除綁定</button>`
          : '<span>尚未綁定 LINE：客人用 LINE 申請儲值並入帳後會自動綁定，也可以在客人的訂單裡手動綁定</span>'}</div>
        <ul class="tx-list" data-tx-list><li>交易紀錄載入中…</li></ul>
      </details>`).join('');
  }
}

async function onMemberClick(e) {
  const button = e.target.closest('[data-unlink-member]');
  if (!button) return;
  const phone = button.closest('.member-item').dataset.phone;
  const m = members.get(phone);
  if (!confirm(`確定解除 ${m?.name || phone} 的 LINE 綁定？\n解除後客人在「我的訂單」就看不到儲值金餘額（餘額不受影響）。`)) return;
  button.disabled = true;
  try {
    await updateDoc(doc(ctx.db, 'members', phone), { line_uids: [] });
    ctx.showToast('已解除 LINE 綁定');
  } catch (error) {
    ctx.showToast('解除失敗：' + errorText(error), 'error');
    button.disabled = false;
  }
}

// 打開會員時才載入最近 30 筆交易紀錄
async function onMemberToggle(e) {
  const item = e.target;
  if (!item.matches?.('.member-item') || !item.open) return;
  const list = item.querySelector('[data-tx-list]');
  try {
    const snap = await getDocs(query(
      collection(ctx.db, 'members', item.dataset.phone, 'transactions'), orderBy('created_at', 'desc'), limit(30)));
    list.innerHTML = snap.empty ? '<li>沒有交易紀錄</li>' : snap.docs.map(d => {
      const t = d.data();
      return `<li>
        <span>${formatTime(t.created_at)}</span>
        <span>${esc(t.type)}${t.order_no ? `・${esc(t.order_no)}` : ''}${t.note ? `・${esc(t.note)}` : ''}</span>
        <span class="${t.amount >= 0 ? 'tx-plus' : 'tx-minus'}">${t.amount >= 0 ? '+' : '−'}${money(Math.abs(t.amount))}</span>
        <span>餘 ${money(t.balance_after)}</span>
      </li>`;
    }).join('');
  } catch (error) {
    list.innerHTML = `<li>交易紀錄載入失敗：${esc(errorText(error))}</li>`;
  }
}

// ========== 商店設定 ==========

const SETTING_FIELDS = ['bank_code', 'bank_name', 'bank_account', 'bank_holder', 'shipping_cvs', 'shipping_home',
  'free_shipping_threshold', 'fee_1lb', 'fee_half', 'notify_url', 'liff_id'];

function fillSettingsForm() {
  const form = $('settings-form').elements;
  SETTING_FIELDS.forEach(key => { form[key].value = settings[key]; });
}

function readSettingsForm() {
  const form = $('settings-form').elements;
  const data = {};
  for (const key of SETTING_FIELDS) {
    const raw = form[key].value.trim();
    if (form[key].type === 'number') {
      const n = Number(raw);
      if (raw === '' || !Number.isInteger(n) || n < 0) throw new ShopError(`「${form[key].labels[0].textContent.trim()}」請填 0 以上的整數`);
      data[key] = n;
    } else {
      data[key] = raw;
    }
  }
  if (data.bank_code && !/^\d{3}$/.test(data.bank_code)) throw new ShopError('銀行代碼請填 3 碼數字');
  if (data.bank_account && !/^[\d-]{6,20}$/.test(data.bank_account)) throw new ShopError('轉帳帳號請只填數字');
  if (data.notify_url && !data.notify_url.startsWith('https://script.google.com/')) {
    throw new ShopError('Email 通知網址必須是 https://script.google.com/ 開頭的 Google Apps Script 網址');
  }
  if (data.liff_id && !/^\d+-[A-Za-z0-9]+$/.test(data.liff_id)) {
    throw new ShopError('LIFF ID 格式不正確，應該像「1234567890-AbCdEfGh」');
  }
  if (data.liff_id && !data.notify_url) {
    throw new ShopError('LINE 登入需要先填寫 Google Apps Script 網址');
  }
  return data;
}

async function onSaveSettings(e) {
  e.preventDefault();
  $('settings-error').hidden = true;
  let data;
  try {
    data = readSettingsForm();
  } catch (error) {
    $('settings-error').textContent = errorText(error);
    $('settings-error').hidden = false;
    return;
  }

  const button = $('btn-save-settings');
  button.disabled = true;
  try {
    await setDoc(doc(ctx.db, 'settings', 'shop'), { ...data, updated_at: serverTimestamp() }, { merge: true });
    settingsDirty = false;
    ctx.showToast('商店設定已儲存，前台購物車會立即套用');
  } catch (error) {
    $('settings-error').textContent = '儲存失敗：' + errorText(error);
    $('settings-error').hidden = false;
  } finally {
    button.disabled = false;
  }
}

// 寄測試信，並請 Google 小幫手回報哪些設定已完成
async function onTestNotify() {
  const url = $('settings-form').elements.notify_url.value.trim();
  const box = $('notify-test-result');
  if (!url.startsWith('https://script.google.com/')) {
    ctx.showToast('請先填寫正確的 Google Apps Script 網址', 'error');
    return;
  }
  const button = $('btn-test-notify');
  button.disabled = true;
  box.hidden = false;
  box.textContent = '檢查中，約需 10 秒…';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'test' })
    });
    const r = await res.json();
    const row = (ok, label, fix) => `<li class="${ok ? 'ok' : 'no'}">${ok ? '✓' : '✗'} ${label}${ok ? '' : `：${fix}`}</li>`;
    box.innerHTML = `<strong>設定檢查結果</strong><ul>
      ${row(r.email, 'Email 通知（已寄出測試信，約 1 分鐘內收到）', '這小時寄太多封了，請稍後再試')}
      ${row(r.sheet, '訂單備份到 Google 試算表', 'Apps Script 要從試算表的「擴充功能」建立')}
      ${row(r.firebase, '讀寫訂單資料（Firebase 服務帳戶）', r.firebaseError ? esc(r.firebaseError) : '指令碼屬性 FIREBASE_SERVICE_ACCOUNT 還沒填或格式不對')}
      ${row(r.linePush, 'LINE 機器人傳訊息給客人', '指令碼屬性 LINE_CHANNEL_ACCESS_TOKEN 還沒填或已失效')}
      ${row(r.lineLogin, 'LINE 登入', '指令碼屬性 LINE_LOGIN_CHANNEL_ID 還沒填')}
      ${row(r.reminder, '每天早上 9 點寄送待處理訂單提醒', '在 Apps Script 執行一次 setupDailyReminder')}
    </ul>`;
  } catch {
    box.innerHTML = '<span class="no">✗ 無法取得檢查結果：請確認網址正確、Apps Script 已貼上最新版程式，並重新部署（誰可以存取選「所有人」）。</span>';
  } finally {
    button.disabled = false;
  }
}
