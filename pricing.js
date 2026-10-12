// 價格、耗材、運費的計算規則（前台購物車與後台訂單核對共用，確保兩邊算法一致）

// 加工方式：浸萃包、濾掛包要另收耗材費
export const PROCESS_OPTIONS = [
  { value: '原豆', note: '不研磨', hasFee: false },
  { value: '研磨', note: '代客研磨', hasFee: false },
  { value: '浸萃包', note: '約 40 包／磅', hasFee: true },
  { value: '濾掛包', note: '約 40 包／磅', hasFee: true }
];

export const SIZE_OPTIONS = [
  { value: '1磅', label: '1 磅' },
  { value: '半磅', label: '半磅' }
];

export const DELIVERY_OPTIONS = [
  { value: 'pickup', label: '門市自取', feeKey: null },
  { value: 'cvs', label: '全家店到店', feeKey: 'shipping_cvs' },
  { value: 'home', label: '宅配', feeKey: 'shipping_home' }
];

export const PAYMENT_OPTIONS = [
  { value: 'transfer', label: '銀行轉帳' },
  { value: 'stored_value', label: '儲值金扣款' }
];

// VIP 儲值方案：儲值金額 + 加贈金額（前台方案卡片與後台加值都用這裡）
export const TOPUP_PLANS = [
  { amount: 5000, bonus: 500 },
  { amount: 10000, bonus: 1000, featured: true }
];

export const ORDER_STATUSES = ['待付款', '已付款', '已出貨', '已完成', '已取消'];

// 給客人看的訂單狀態說明（前台「我的訂單」）
export function statusHint(order) {
  const isTopup = order.type === 'topup';
  switch (order.status) {
    case '待付款':
      if (isTopup) return '請轉帳後用 LINE 回報帳號後五碼，確認入帳後即為您加值。';
      return order.payment_method === 'stored_value'
        ? '店家確認後會從您的儲值金扣款並安排出貨。'
        : '請轉帳後用 LINE 回報帳號後五碼，確認入帳後即安排出貨。';
    case '已付款':
      return isTopup ? '已確認入帳，正在為您加值。' : '已確認付款，正在為您準備咖啡豆。';
    case '已出貨':
      return order.delivery === 'pickup' ? '咖啡豆已備妥，歡迎到門市取貨。' : '已出貨，請留意取貨通知。';
    case '已完成':
      return isTopup ? `已加值 ${money(order.topup?.credit)}，結帳時可選「儲值金扣款」。` : '訂單已完成，謝謝您的支持！';
    case '已取消':
      return '這筆訂單已取消，如有疑問歡迎用 LINE 詢問。';
    default:
      return '';
  }
}

// 電話號碼統一格式（去掉空白和 -），儲值會員以電話辨識
export function normalizePhone(phone) {
  return String(phone ?? '').replace(/[\s-]/g, '');
}

export function isValidPhone(phone) {
  return /^0\d{8,9}$/.test(normalizePhone(phone));
}

export function paymentLabel(value) {
  return PAYMENT_OPTIONS.find(p => p.value === value)?.label ?? '銀行轉帳';
}

// 後台「商店設定」沒填或讀不到時使用的預設值
export const DEFAULT_SETTINGS = {
  bank_code: '',
  bank_name: '',
  bank_account: '',
  bank_holder: '',
  shipping_cvs: 60,
  shipping_home: 170,
  free_shipping_threshold: 3000,
  fee_1lb: 200,
  fee_half: 100,
  notify_url: '', // Google Apps Script 網址（Email、LINE 通知與 LINE 登入）
  liff_id: ''     // LINE 登入（LIFF）的 ID；沒填就不需要登入，維持原本的下單方式
};

// 把資料庫裡的設定整理成正確的型別，缺的用預設值補上
export function normalizeSettings(data) {
  const settings = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const value = data?.[key];
    if (value === undefined || value === null || value === '') continue;
    if (typeof DEFAULT_SETTINGS[key] === 'number') {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) settings[key] = n;
    } else {
      settings[key] = String(value).trim();
    }
  }
  return settings;
}

export function money(amount) {
  return 'NT$' + Math.round(Number(amount) || 0).toLocaleString('zh-TW');
}

export function sizeLabel(size) {
  return SIZE_OPTIONS.find(s => s.value === size)?.label ?? size;
}

// 單價：半磅優先用後台填的「半磅價格」，沒填就用 1 磅價格的一半；價格不正確時回傳 null
export function unitPrice(product, size) {
  const price = Number(product?.price);
  if (!Number.isFinite(price) || price <= 0) return null;
  if (size === '半磅') {
    const half = Number(product.half_price);
    return half > 0 ? half : Math.round(price / 2);
  }
  return price;
}

export function processingFee(process, size, settings) {
  const option = PROCESS_OPTIONS.find(o => o.value === process);
  if (!option?.hasFee) return 0;
  return Number(size === '半磅' ? settings.fee_half : settings.fee_1lb) || 0;
}

// lines：[{ unit, fee, qty }]；滿額免運以「咖啡豆＋加工耗材」的金額計算
export function calcTotals(lines, delivery, settings) {
  const goods = lines.reduce((sum, l) => sum + (l.unit ?? 0) * l.qty, 0);
  const fees = lines.reduce((sum, l) => sum + l.fee * l.qty, 0);
  const subtotal = goods + fees;
  const option = DELIVERY_OPTIONS.find(o => o.value === delivery) ?? DELIVERY_OPTIONS[0];
  const baseShipping = option.feeKey ? Number(settings[option.feeKey]) || 0 : 0;
  const threshold = Number(settings.free_shipping_threshold) || 0;
  const freeShipping = baseShipping > 0 && threshold > 0 && subtotal >= threshold;
  const shipping = freeShipping ? 0 : baseShipping;
  return { goods, fees, subtotal, option, baseShipping, shipping, freeShipping, threshold, total: subtotal + shipping };
}
