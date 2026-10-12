/**
 * 熵與焙｜新訂單 Email 通知（Google Apps Script）
 * 設定步驟請看同一個資料夾的 README.md
 *
 * 網站有新訂單或儲值申請時會送到這裡 → 寄 Email 給管理員，並備份到這份 Google 試算表
 */

// 收到新訂單要通知的信箱；要通知多人時用逗號隔開，例如 ['a@gmail.com', 'b@gmail.com']
const ADMIN_EMAILS = ['shelly45556@gmail.com'];

const SHOP_NAME = '熵與焙';
const ADMIN_URL = 'https://jiayi0910.github.io/ENTROPY_BAKING/admin.html';

// 每小時最多寄幾封，避免通知網址被有心人拿來大量寄信
const MAX_EMAILS_PER_HOUR = 30;

// 網站送訂單過來時會執行這裡
function doPost(e) {
  try {
    const order = JSON.parse(e.postData.contents);
    if (!isValidOrder(order)) return reply('invalid');
    if (!withinHourlyLimit()) return reply('rate-limited');
    sendOrderEmail(order);
    if (!order.test) saveToSheet(order);
    return reply('ok');
  } catch (error) {
    console.error(error);
    return reply('error');
  }
}

function isValidOrder(order) {
  return Boolean(order)
    && typeof order.order_no === 'string' && order.order_no.length <= 30
    && Boolean(order.customer) && typeof order.customer.name === 'string' && order.customer.name.length <= 30
    && Boolean(order.amounts) && typeof order.amounts.total === 'number'
    && typeof order.message === 'string' && order.message.length <= 3000;
}

function withinHourlyLimit() {
  const cache = CacheService.getScriptCache();
  const key = 'mail-count-' + Math.floor(Date.now() / 3600000);
  const count = Number(cache.get(key) || 0);
  if (count >= MAX_EMAILS_PER_HOUR) return false;
  cache.put(key, String(count + 1), 3600);
  return true;
}

function sendOrderEmail(order) {
  const kind = order.type === 'topup' ? '儲值申請' : '新訂單';
  const total = 'NT$' + Number(order.amounts.total).toLocaleString('en-US');
  const subject = (order.test ? '【測試】' : '') + '【' + SHOP_NAME + '】' + kind + ' ' + order.order_no
    + '｜' + order.customer.name + '｜' + total;
  const body = order.message + '\n\n――――――――――\n請到後台「訂單管理」查看與處理：\n' + ADMIN_URL;
  MailApp.sendEmail({ to: ADMIN_EMAILS.join(','), subject: subject, body: body, name: SHOP_NAME + ' 訂單通知' });
}

// 備份到試算表的「訂單」工作表（第一次會自動建立）
function saveToSheet(order) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) return; // 不是從試算表建立的 Apps Script 就略過備份
  const sheet = spreadsheet.getSheetByName('訂單') || spreadsheet.insertSheet('訂單');
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['收到時間', '編號', '類型', '姓名', '電話', '取貨方式', '門市／地址', '內容', '金額', '付款方式', '備註']);
    sheet.setFrozenRows(1);
  }
  const c = order.customer;
  const content = order.type === 'topup'
    ? '儲值 ' + order.topup.plan_amount + '（加值 ' + order.topup.credit + '）'
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
    order.amounts.total,
    order.payment_method === 'stored_value' ? '儲值金扣款' : '銀行轉帳',
    safe(order.note || '')
  ]);
}

// 客人填的文字如果用 = + - @ 開頭，試算表會當成公式，前面加 ' 讓它保持純文字
function safe(value) {
  const text = String(value == null ? '' : value);
  return /^[=+\-@]/.test(text) ? "'" + text : text;
}

function reply(text) {
  return ContentService.createTextOutput(text);
}

// 第一次設定時：在上方選「sendTestEmail」按「執行」，完成授權並寄一封測試信給管理員
function sendTestEmail() {
  sendOrderEmail({
    test: true,
    type: 'order',
    order_no: 'TEST',
    customer: { name: '測試客人' },
    amounts: { total: 0 },
    message: '這是一封測試信，收到代表 Email 通知可以正常寄出。'
  });
}
