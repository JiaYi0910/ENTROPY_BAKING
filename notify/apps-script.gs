/**
 * 熵與焙｜網站的 Google 小幫手（Google Apps Script）
 * 設定步驟請看同一個資料夾的 README.md
 *
 * 1. LINE 登入：確認客人真的是這個 LINE 使用者，再發給網站登入憑證（客人只看得到自己的訂單）
 * 2. 新訂單：寄 Email 給管理員、備份到試算表、用 LINE 機器人傳訂單確認給客人
 * 3. 訂單狀態更新：已付款／已出貨／已取消（儲值完成）時，用 LINE 通知客人
 * 4. 客人在「我的訂單」回報匯款：寄 Email 請管理員核對入帳
 * 5. 每天早上寄一封待處理訂單提醒（第一次要執行 setupDailyReminder 開啟）
 * 6. 設定檢查：後台「寄送測試通知」會寄測試信，並回報哪些設定已完成
 */

// 收到新訂單要通知的信箱；要通知多人時用逗號隔開，例如 ['a@gmail.com', 'b@gmail.com']
const ADMIN_EMAILS = ['shelly45556@gmail.com'];

const SHOP_NAME = '熵與焙 ENTROPY & BAKING';
const SITE_URL = 'https://jiayi0910.github.io/ENTROPY_BAKING/';
const ADMIN_URL = SITE_URL + 'admin.html';
const STORE_ADDRESS = '新竹縣湖口鄉光復東路73號（10:00-20:00，例假日公休）';

// 每小時最多寄幾封 Email，避免網址被有心人拿來大量寄信
const MAX_EMAILS_PER_HOUR = 30;

// 每日提醒：幾點寄、待付款超過幾天要提醒
const REMIND_HOUR = 9;
const REMIND_UNPAID_DAYS = 2;

// 以下三個設定放在「專案設定 → 指令碼屬性」，不要寫在程式裡（它們是密碼等級的資料）
//   LINE_LOGIN_CHANNEL_ID       LINE Login 的 Channel ID
//   LINE_CHANNEL_ACCESS_TOKEN   LINE 機器人（Messaging API）的 Channel access token
//   FIREBASE_SERVICE_ACCOUNT    Firebase 服務帳戶金鑰（下載的 JSON 檔整份內容）
function prop(name) {
  return PropertiesService.getScriptProperties().getProperty(name) || '';
}

// 網站送資料過來時會執行這裡
function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (error) {
    return json({ ok: false, error: 'bad-request' });
  }
  try {
    switch (body.action) {
      case 'login': return json(handleLogin(body));
      case 'order-created': return json(handleOrderCreated(body));
      case 'order-status': return json(handleOrderStatus(body));
      case 'payment-reported': return json(handlePaymentReported(body));
      case 'test': return json(handleTest());
      default: return json({ ok: false, error: 'unknown-action' });
    }
  } catch (error) {
    console.error(error);
    return json({ ok: false, error: String(error && error.message || error) });
  }
}

function json(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

// ========== 1. LINE 登入 ==========

function handleLogin(body) {
  const channelId = prop('LINE_LOGIN_CHANNEL_ID');
  if (!channelId || !serviceAccount()) return { ok: false, error: 'not-configured' };
  if (typeof body.idToken !== 'string' || body.idToken.length > 4000) return { ok: false, error: 'bad-request' };

  // 請 LINE 確認這張登入憑證是真的，而且是發給我們的 LINE Login
  const res = UrlFetchApp.fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'post',
    payload: { id_token: body.idToken, client_id: channelId },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) return { ok: false, error: 'invalid-token' };
  const profile = JSON.parse(res.getContentText());
  if (!profile.sub) return { ok: false, error: 'invalid-token' };

  const name = String(profile.name || '').slice(0, 30);
  return { ok: true, token: createCustomToken('line:' + profile.sub, { line_name: name }), name: name };
}

// Firebase 自訂登入憑證（用服務帳戶金鑰簽名，網站拿去登入 Firebase）
function createCustomToken(uid, claims) {
  const sa = serviceAccount();
  const now = Math.floor(Date.now() / 1000);
  return signJwt({
    iss: sa.client_email,
    sub: sa.client_email,
    aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
    iat: now,
    exp: now + 3600,
    uid: uid,
    claims: claims
  }, sa.private_key);
}

// ========== 2. 新訂單 ==========

function handleOrderCreated(body) {
  // 還沒設定 Firebase 服務帳戶時，只能用網站送來的文字寄 Email
  if (!serviceAccount()) return legacyEmail(body);

  const orderId = validId(body.orderId);
  if (!orderId) return { ok: false, error: 'bad-request' };
  const order = firestoreGet('orders/' + orderId);
  if (!order) return { ok: false, error: 'not-found' };

  const notified = order.notified || {};
  if (notified.created) return { ok: true, skipped: 'already-notified' };
  // 先標記再通知，同一筆訂單不會重複寄信、重複傳 LINE
  firestorePatch('orders/' + orderId, { notified: Object.assign({}, notified, { created: new Date() }) });

  const settings = firestoreGet('settings/shop') || {};
  if (withinHourlyLimit()) sendAdminEmail(order);
  saveToSheet(order);
  return { ok: true, lineSent: pushToCustomer(order, createdMessage(order, settings)) };
}

// 舊做法：用網站送來的訂單文字寄 Email（還沒設定服務帳戶時使用）
function legacyEmail(body) {
  const valid = body && typeof body.order_no === 'string' && body.order_no.length <= 30
    && body.customer && typeof body.customer.name === 'string' && body.customer.name.length <= 30
    && body.amounts && typeof body.amounts.total === 'number'
    && typeof body.message === 'string' && body.message.length <= 3000;
  if (!valid) return { ok: false, error: 'invalid' };
  if (!withinHourlyLimit()) return { ok: false, error: 'rate-limited' };
  sendEmail(orderKind(body.type), body.order_no, body.customer.name, body.amounts.total, body.message);
  saveToSheet(body);
  return { ok: true, legacy: true };
}

function createdMessage(order, settings) {
  const total = money(order.amounts && order.amounts.total);
  const lines = [];
  if (order.type === 'topup') {
    const t = order.topup || {};
    lines.push('【' + SHOP_NAME + '】已收到您的儲值申請 💎');
    lines.push('申請編號：' + order.order_no);
    lines.push('方案：儲值 ' + money(t.plan_amount) + '（加贈 ' + money(t.bonus) + '，共 ' + money(t.credit) + '）');
    lines.push('');
    lines.push(bankText(settings, total));
    lines.push('轉帳後請點下方連結，在「我的訂單」填寫帳號後五碼，確認入帳後即為您加值。');
  } else {
    lines.push('【' + SHOP_NAME + '】已收到您的訂單 🎉');
    lines.push('訂單編號：' + order.order_no);
    (order.items || []).forEach(function (i) {
      lines.push('・' + i.name + '｜' + i.process + '｜' + sizeLabel(i.size) + ' ×' + i.qty);
    });
    lines.push('合計：' + total + '（' + (order.delivery_label || '') + '）');
    lines.push('');
    if (order.payment_method === 'stored_value') {
      lines.push('付款方式：儲值金扣款');
      lines.push('店家確認後會從您的儲值金扣款並安排出貨。');
    } else {
      lines.push(bankText(settings, total));
      lines.push('轉帳後請點下方連結，在「我的訂單」填寫帳號後五碼，確認入帳後即安排出貨。');
    }
  }
  lines.push('');
  lines.push((order.payment_method === 'stored_value' ? '查看訂單狀態：' : '回報匯款／查看訂單：') + ordersLink(settings));
  return lines.join('\n');
}

// 有設定 LIFF ID 時用 LINE 的連結，在 LINE 裡點開會自動登入
function ordersLink(settings) {
  return settings && settings.liff_id
    ? 'https://liff.line.me/' + settings.liff_id + '?view=orders'
    : SITE_URL + '?view=orders';
}

function bankText(settings, total) {
  if (!settings.bank_account) return '付款方式：銀行轉帳 ' + total + '，轉帳帳號將由店家另外提供。';
  return '請轉帳 ' + total + ' 至：\n'
    + settings.bank_code + (settings.bank_name ? '（' + settings.bank_name + '）' : '') + '\n'
    + '帳號：' + settings.bank_account
    + (settings.bank_holder ? '\n戶名：' + settings.bank_holder : '');
}

// ========== 3. 訂單狀態更新 ==========

function handleOrderStatus(body) {
  if (!serviceAccount()) return { ok: false, error: 'not-configured' };
  const orderId = validId(body.orderId);
  if (!orderId) return { ok: false, error: 'bad-request' };
  const order = firestoreGet('orders/' + orderId);
  if (!order) return { ok: false, error: 'not-found' };
  if (!order.customer_uid) return { ok: true, skipped: 'not-line-customer' };

  const text = statusMessage(order);
  if (!text) return { ok: true, skipped: 'status-not-notified' };
  const notified = order.notified || {};
  if (notified[order.status]) return { ok: true, skipped: 'already-notified' };
  const message = text + '\n\n查看訂單：' + ordersLink(firestoreGet('settings/shop'));

  const update = {};
  update[order.status] = new Date();
  firestorePatch('orders/' + orderId, { notified: Object.assign({}, notified, update) });
  return { ok: true, lineSent: pushToCustomer(order, message) };
}

// 只在客人真的需要知道的狀態通知（每筆訂單最多 3 則），節省 LINE 每月免費額度
function statusMessage(order) {
  const no = order.order_no;
  const head = '【' + SHOP_NAME + '】';
  if (order.type === 'topup') {
    if (order.status === '已完成') {
      return head + '儲值完成 💎\n申請編號：' + no + '\n已為您加值 ' + money(order.topup && order.topup.credit) + '，之後購物結帳可選「儲值金扣款」。';
    }
    if (order.status === '已取消') return head + '您的儲值申請已取消\n申請編號：' + no + '\n如有疑問，歡迎直接在這裡留言詢問。';
    return '';
  }
  switch (order.status) {
    case '已付款':
      return head + '已確認您的付款 ✅\n訂單編號：' + no + '\n我們正在為您準備咖啡豆，'
        + (order.delivery === 'pickup' ? '備妥後會再通知您到門市取貨。' : '出貨後會再通知您。');
    case '已出貨':
      return order.delivery === 'pickup'
        ? head + '您的咖啡豆已備妥 ☕\n訂單編號：' + no + '\n歡迎到門市取貨：' + STORE_ADDRESS
        : head + '您的訂單已出貨 🚚\n訂單編號：' + no + '\n寄送方式：' + (order.delivery_label || '') + '，請留意取貨通知。';
    case '已取消':
      return head + '您的訂單已取消\n訂單編號：' + no + '\n如有疑問，歡迎直接在這裡留言詢問。';
    default:
      return '';
  }
}

// ========== 4. 客人回報匯款 ==========

function handlePaymentReported(body) {
  if (!serviceAccount()) return { ok: false, error: 'not-configured' };
  const orderId = validId(body.orderId);
  if (!orderId) return { ok: false, error: 'bad-request' };
  const order = firestoreGet('orders/' + orderId);
  if (!order) return { ok: false, error: 'not-found' };

  // 到資料庫確認客人真的回報了（網站送來的內容不採信）
  const last5 = String(order.payment_last5 || '');
  if (order.status !== '待付款' || !order.payment_reported_at || !/^\d{5}$/.test(last5)) return { ok: true, skipped: 'not-reported' };
  const notified = order.notified || {};
  if (notified.payment_reported === last5) return { ok: true, skipped: 'already-notified' };
  firestorePatch('orders/' + orderId, { notified: Object.assign({}, notified, { payment_reported: last5 }) });

  if (!withinHourlyLimit()) return { ok: true, skipped: 'rate-limited' };
  const c = order.customer || {};
  const isTopup = order.type === 'topup';
  sendEmail('客人回報匯款', order.order_no, c.name, order.amounts && order.amounts.total, [
    (isTopup ? '【儲值申請】' : '【咖啡豆訂單】') + order.order_no,
    '應付金額：' + money(order.amounts && order.amounts.total),
    '帳號後五碼：' + last5,
    '回報時間：' + formatTaipei(order.payment_reported_at),
    '姓名：' + c.name + '　電話：' + c.phone,
    '',
    isTopup ? '請核對入帳後，到後台按「確認入帳並加值」。' : '請核對入帳後，到後台把訂單改成「已付款」。'
  ].join('\n'));
  return { ok: true, emailed: true };
}

// ========== 5. 每日待處理訂單提醒 ==========

// 第一次設定：在上方選「setupDailyReminder」按「執行」，之後每天早上自動檢查
function setupDailyReminder() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'dailyReminder'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('dailyReminder').timeBased().everyDays(1).atHour(REMIND_HOUR).inTimezone('Asia/Taipei').create();
  console.log('已設定：每天 ' + REMIND_HOUR + ' 點檢查待處理訂單，有需要處理的才會寄信');
}

function dailyReminder() {
  if (!serviceAccount()) return { sent: false, reason: 'not-configured' };
  const now = Date.now();
  const reported = [];
  const storedValue = [];
  const overdue = [];
  firestoreQuery('orders', 'status', '待付款').forEach(function (o) {
    if (o.payment_method === 'stored_value') storedValue.push(o);
    else if (o.payment_reported_at) reported.push(o);
    else if (o.created_at && now - o.created_at.getTime() >= REMIND_UNPAID_DAYS * 86400000) overdue.push(o);
  });
  const total = reported.length + storedValue.length + overdue.length;
  if (!total) return { sent: false, reason: 'nothing-to-do' };

  const line = function (o) {
    const c = o.customer || {};
    return '・' + o.order_no + (o.type === 'topup' ? '（儲值）' : '') + '｜' + c.name + '｜' + money(o.amounts && o.amounts.total)
      + (o.created_at ? '｜' + formatTaipei(o.created_at) + ' 下單' : '');
  };
  const sections = [];
  if (reported.length) {
    sections.push('💰 客人已回報匯款，請核對入帳（' + reported.length + ' 筆）');
    reported.forEach(function (o) { sections.push(line(o) + '｜後五碼 ' + o.payment_last5); });
    sections.push('');
  }
  if (storedValue.length) {
    sections.push('💎 儲值金扣款待處理（' + storedValue.length + ' 筆）');
    storedValue.forEach(function (o) { sections.push(line(o)); });
    sections.push('');
  }
  if (overdue.length) {
    sections.push('⏰ 超過 ' + REMIND_UNPAID_DAYS + ' 天還沒付款（' + overdue.length + ' 筆），可以聯絡客人或改為「已取消」');
    overdue.forEach(function (o) { sections.push(line(o) + '｜' + (o.customer && o.customer.phone)); });
    sections.push('');
  }
  MailApp.sendEmail({
    to: ADMIN_EMAILS.join(','),
    subject: '【' + SHOP_NAME + '】今日待處理訂單 ' + total + ' 筆',
    body: sections.join('\n') + '\n――――――――――\n請到後台「訂單管理」處理：\n' + ADMIN_URL,
    name: SHOP_NAME + ' 訂單通知'
  });
  return { sent: true, reported: reported.length, storedValue: storedValue.length, overdue: overdue.length };
}

function formatTaipei(date) {
  return date instanceof Date ? Utilities.formatDate(date, 'Asia/Taipei', 'MM/dd HH:mm') : '';
}

// ========== 6. 設定檢查（後台「寄送測試通知」） ==========

function handleTest() {
  const result = { ok: true, email: false, sheet: false, firebase: false, lineLogin: Boolean(prop('LINE_LOGIN_CHANNEL_ID')), linePush: false };
  if (withinHourlyLimit()) {
    sendEmail('新訂單', 'TEST', '測試客人', 0, '這是一封測試信，收到代表新訂單 Email 通知可以正常寄出。');
    result.email = true;
  }
  result.sheet = Boolean(SpreadsheetApp.getActiveSpreadsheet());
  if (serviceAccount()) {
    try {
      firestoreGet('settings/shop');
      result.firebase = true;
    } catch (error) {
      result.firebaseError = String(error.message || error).slice(0, 200);
    }
  }
  try {
    result.reminder = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'dailyReminder'; });
  } catch (error) {
    result.reminder = false; // 還沒授權「管理觸發條件」
  }
  const token = prop('LINE_CHANNEL_ACCESS_TOKEN');
  if (token) {
    // 查詢機器人資料，確認 Channel access token 有效（不會傳訊息給任何人）
    const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/info', { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
    result.linePush = res.getResponseCode() === 200;
  }
  return result;
}

// ========== Email 與試算表 ==========

function sendAdminEmail(order) {
  const c = order.customer || {};
  const a = order.amounts || {};
  const lines = [order.type === 'topup' ? '【儲值申請】' + order.order_no : '【咖啡豆訂單】' + order.order_no];
  if (order.type === 'topup') {
    const t = order.topup || {};
    lines.push('方案：儲值 ' + money(t.plan_amount) + '（加贈 ' + money(t.bonus) + '，共 ' + money(t.credit) + '）');
  } else {
    (order.items || []).forEach(function (i, n) {
      lines.push((n + 1) + '. ' + i.name + '｜' + i.process + '｜' + sizeLabel(i.size) + ' ×' + i.qty + '｜' + money(i.total));
    });
    lines.push('咖啡豆：' + money(a.goods) + (a.fees ? '　加工耗材：' + money(a.fees) : '') + '　運費：' + (a.shipping ? money(a.shipping) : '免運費'));
    lines.push('取貨方式：' + (order.delivery_label || ''));
  }
  lines.push('合計：' + money(a.total) + '（' + (order.payment_method === 'stored_value' ? '儲值金扣款' : '銀行轉帳') + '）');
  lines.push('姓名：' + c.name + '　電話：' + c.phone);
  if (c.store) lines.push('全家門市：' + c.store);
  if (c.address) lines.push('收件地址：' + c.address);
  if (order.note) lines.push('備註：' + order.note);
  lines.push(order.customer_uid ? 'LINE：已登入（狀態更新會自動通知客人）' : 'LINE：未登入');
  sendEmail(orderKind(order.type), order.order_no, c.name, a.total, lines.join('\n'));
}

function orderKind(type) {
  return type === 'topup' ? '儲值申請' : '新訂單';
}

function sendEmail(kind, orderNo, name, total, text) {
  const isTest = orderNo === 'TEST';
  const subject = (isTest ? '【測試】' : '') + '【' + SHOP_NAME + '】' + kind + ' ' + orderNo + '｜' + name + '｜' + money(total);
  const body = text + '\n\n――――――――――\n請到後台「訂單管理」查看與處理：\n' + ADMIN_URL;
  MailApp.sendEmail({ to: ADMIN_EMAILS.join(','), subject: subject, body: body, name: SHOP_NAME + ' 訂單通知' });
}

function withinHourlyLimit() {
  const cache = CacheService.getScriptCache();
  const key = 'mail-count-' + Math.floor(Date.now() / 3600000);
  const count = Number(cache.get(key) || 0);
  if (count >= MAX_EMAILS_PER_HOUR) return false;
  cache.put(key, String(count + 1), 3600);
  return true;
}

// 備份到試算表的「訂單」工作表（第一次會自動建立）
function saveToSheet(order) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) return; // 不是從試算表建立的 Apps Script 就略過備份
  const sheet = spreadsheet.getSheetByName('訂單') || spreadsheet.insertSheet('訂單');
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['收到時間', '編號', '類型', '姓名', '電話', '取貨方式', '門市／地址', '內容', '金額', '付款方式', '備註', 'LINE']);
    sheet.setFrozenRows(1);
  }
  const c = order.customer || {};
  const content = order.type === 'topup'
    ? '儲值 ' + (order.topup && order.topup.plan_amount) + '（加值 ' + (order.topup && order.topup.credit) + '）'
    : (order.items || []).map(function (i) { return i.name + '｜' + i.process + '｜' + i.size + '×' + i.qty; }).join('\n');
  sheet.appendRow([
    new Date(),
    safe(order.order_no),
    order.type === 'topup' ? '儲值申請' : '訂單',
    safe(c.name),
    "'" + safe(c.phone), // 前面加 ' 讓試算表保留電話開頭的 0
    safe(order.delivery_label || ''),
    safe(c.store || c.address || ''),
    safe(content),
    order.amounts && order.amounts.total,
    order.payment_method === 'stored_value' ? '儲值金扣款' : '銀行轉帳',
    safe(order.note || ''),
    order.customer_uid ? '已登入' : ''
  ]);
}

// 客人填的文字如果用 = + - @ 開頭，試算表會當成公式，前面加 ' 讓它保持純文字
function safe(value) {
  const text = String(value == null ? '' : value);
  return /^[=+\-@]/.test(text) ? "'" + text : text;
}

// ========== LINE 機器人推播 ==========

function pushToCustomer(order, text) {
  const token = prop('LINE_CHANNEL_ACCESS_TOKEN');
  const uid = String(order.customer_uid || '');
  if (!token || uid.indexOf('line:') !== 0 || !text) return false;
  const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ to: uid.slice(5), messages: [{ type: 'text', text: text.slice(0, 4900) }] }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    // 常見原因：客人沒有加官方帳號好友、封鎖了官方帳號，或本月免費訊息則數用完
    console.error('LINE 推播失敗', res.getResponseCode(), res.getContentText());
    return false;
  }
  return true;
}

// ========== Firebase 資料庫（用服務帳戶讀寫，不受網站安全規則限制） ==========

function serviceAccount() {
  const raw = prop('FIREBASE_SERVICE_ACCOUNT');
  if (!raw) return null;
  try {
    const sa = JSON.parse(raw);
    return sa.client_email && sa.private_key && sa.project_id ? sa : null;
  } catch (error) {
    return null;
  }
}

function googleAccessToken() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('google-access-token');
  if (cached) return cached;

  const sa = serviceAccount();
  const now = Math.floor(Date.now() / 1000);
  const assertion = signJwt({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  }, sa.private_key);
  const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post',
    payload: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: assertion },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) throw new Error('無法取得 Firebase 存取權限，請檢查 FIREBASE_SERVICE_ACCOUNT');
  const token = JSON.parse(res.getContentText()).access_token;
  cache.put('google-access-token', token, 3000); // 存取權限 1 小時有效，快取 50 分鐘
  return token;
}

function firestoreUrl(path) {
  return 'https://firestore.googleapis.com/v1/projects/' + serviceAccount().project_id + '/databases/(default)/documents/' + path;
}

function firestoreGet(path) {
  const res = UrlFetchApp.fetch(firestoreUrl(path), {
    headers: { Authorization: 'Bearer ' + googleAccessToken() },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() === 404) return null;
  if (res.getResponseCode() !== 200) throw new Error('讀取資料庫失敗：' + res.getContentText().slice(0, 200));
  return fromFirestore(JSON.parse(res.getContentText()).fields || {});
}

// 查詢某個欄位等於某個值的資料（單一欄位條件，不需要另外建立索引）
function firestoreQuery(collectionId, field, value) {
  const url = 'https://firestore.googleapis.com/v1/projects/' + serviceAccount().project_id + '/databases/(default)/documents:runQuery';
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + googleAccessToken() },
    payload: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: collectionId }],
      where: { fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value: toValue(value) } },
      limit: 300
    } }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) throw new Error('查詢資料庫失敗：' + res.getContentText().slice(0, 200));
  return JSON.parse(res.getContentText())
    .filter(function (r) { return r.document; })
    .map(function (r) { return fromFirestore(r.document.fields || {}); });
}

// 只更新指定的欄位，其他欄位不動
function firestorePatch(path, data) {
  const mask = Object.keys(data).map(function (k) { return 'updateMask.fieldPaths=' + encodeURIComponent(k); }).join('&');
  const res = UrlFetchApp.fetch(firestoreUrl(path) + '?' + mask + '&currentDocument.exists=true', {
    method: 'patch',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + googleAccessToken() },
    payload: JSON.stringify({ fields: toFirestore(data) }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) throw new Error('寫入資料庫失敗：' + res.getContentText().slice(0, 200));
}

// Firestore 的資料格式 ↔ 一般資料
function fromValue(v) {
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return new Date(v.timestampValue);
  if ('mapValue' in v) return fromFirestore(v.mapValue.fields || {});
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromValue);
  return null;
}

function fromFirestore(fields) {
  const out = {};
  Object.keys(fields).forEach(function (k) { out[k] = fromValue(fields[k]); });
  return out;
}

function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  if (typeof v === 'object') return { mapValue: { fields: toFirestore(v) } };
  return { stringValue: String(v) };
}

function toFirestore(obj) {
  const out = {};
  Object.keys(obj).forEach(function (k) { out[k] = toValue(obj[k]); });
  return out;
}

// ========== 共用小工具 ==========

// JWT 簽名（RS256）：Firebase 登入憑證與 Google 存取權限都用這個
function signJwt(payload, privateKey) {
  const encode = function (obj) { return base64url(Utilities.newBlob(JSON.stringify(obj)).getBytes()); };
  const unsigned = encode({ alg: 'RS256', typ: 'JWT' }) + '.' + encode(payload);
  return unsigned + '.' + base64url(Utilities.computeRsaSha256Signature(unsigned, privateKey));
}

function base64url(bytes) {
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}

function validId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : '';
}

function money(amount) {
  return 'NT$' + Math.round(Number(amount) || 0).toLocaleString('en-US');
}

function sizeLabel(size) {
  return size === '1磅' ? '1 磅' : size;
}

// 第一次設定時：在上方選「sendTestEmail」按「執行」，完成授權並寄一封測試信
function sendTestEmail() {
  console.log(JSON.stringify(handleTest()));
}
