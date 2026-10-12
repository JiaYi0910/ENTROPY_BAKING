// 客人用 LINE 登入：LIFF 取得 LINE 身分 → Google 小幫手（Apps Script）向 LINE 確認 → 換成 Firebase 登入
// 登入後客人只看得到自己的訂單；訂單狀態更新時，LINE 機器人會通知客人
// 後台「商店設定」還沒填 LIFF ID 時，這裡什麼都不做，網站維持不需登入的下單方式

const LIFF_SDK_URL = 'https://static.line-scdn.net/liff/edge/2/sdk.js';

let liffId = '';
let serverUrl = '';
let fb = null;           // { auth, onAuthStateChanged, signInWithCustomToken, signOut, updateProfile }
let customer = null;     // { uid, name }
let liffReady = null;    // LIFF 初始化的 Promise
let exchanging = null;   // 正在換 Firebase 登入的 Promise（避免重複）
let afterLoginHandler = null;
const listeners = new Set();

export class LoginError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

export function isLineLoginEnabled() {
  return Boolean(liffId && serverUrl.startsWith('https://script.google.com/') && fb);
}

export function getCustomer() {
  return customer;
}

export function onCustomerChange(fn) {
  listeners.add(fn);
  fn(customer);
}

// 登入完成後要接著做的事（例如回到結帳），由 script.js 指定
export function setAfterLoginHandler(fn) {
  afterLoginHandler = fn;
}

function emit() {
  listeners.forEach(fn => fn(customer));
}

// script.js 載入 Firebase 後呼叫
export function initCustomerAuth(firebaseAuth) {
  fb = firebaseAuth;
  fb.onAuthStateChanged(fb.auth, (user) => {
    // 只有 LINE 登入的身分才算客人
    customer = user && user.uid.startsWith('line:') ? { uid: user.uid, name: user.displayName || '' } : null;
    emit();
  });
}

// 商店設定更新時呼叫（LIFF ID、Google Apps Script 網址）
export function configureLineLogin(settings) {
  const wasEnabled = isLineLoginEnabled();
  serverUrl = settings.notify_url || '';
  const nextId = settings.liff_id || '';
  if (nextId !== liffId) {
    liffId = nextId;
    liffReady = null;
    if (isLineLoginEnabled()) startLiff();
  }
  // 開啟或關閉 LINE 登入時，結帳按鈕、我的訂單要跟著更新
  if (wasEnabled !== isLineLoginEnabled()) emit();
}

function loadLiffSdk() {
  if (window.liff) return Promise.resolve(window.liff);
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = LIFF_SDK_URL;
    script.charset = 'utf-8';
    script.onload = () => resolve(window.liff);
    script.onerror = () => reject(new LoginError('LINE 登入元件載入失敗，請稍後再試', 'sdk'));
    document.head.appendChild(script);
  });
}

function ensureLiff() {
  // 還沒設定 LINE 登入時不載入 LINE 元件
  if (!isLineLoginEnabled()) return Promise.reject(new LoginError('LINE 登入尚未設定', 'not-configured'));
  if (!liffReady) {
    liffReady = loadLiffSdk().then(async (liff) => {
      await liff.init({ liffId });
      return liff;
    }).catch((error) => {
      liffReady = null;
      throw error;
    });
  }
  return liffReady;
}

// 網頁打開時：在 LINE 裡開啟、或剛從 LINE 登入頁回來，就自動完成登入
async function startLiff() {
  try {
    const liff = await ensureLiff();
    const params = new URLSearchParams(location.search);
    const nextAction = params.get('after_login') || '';
    if (nextAction) {
      params.delete('after_login');
      const query = params.toString();
      history.replaceState(null, '', location.pathname + (query ? `?${query}` : '') + location.hash);
    }
    if (liff.isLoggedIn() && !customer) {
      await exchange().catch((error) => {
        console.warn('LINE 自動登入失敗', error);
        if (error.code === 'invalid-token') liff.logout(); // LINE 憑證過期，下次需要時再重新登入
      });
    }
    if (nextAction && afterLoginHandler) afterLoginHandler(nextAction);
  } catch (error) {
    console.warn('LINE 登入初始化失敗', error);
  }
}

// 把 LINE 的登入憑證交給 Google 小幫手確認，換成 Firebase 登入
function exchange() {
  if (exchanging) return exchanging;
  exchanging = (async () => {
    const liff = await ensureLiff();
    const idToken = liff.getIDToken();
    if (!idToken) throw new LoginError('無法取得 LINE 身分，請重新登入', 'invalid-token');

    let data;
    try {
      const res = await fetch(serverUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'login', idToken })
      });
      data = await res.json();
    } catch {
      throw new LoginError('LINE 登入暫時無法使用，請稍後再試', 'network');
    }
    if (!data.ok) {
      throw new LoginError(data.error === 'invalid-token' ? 'LINE 登入已過期，請重新登入' : 'LINE 登入暫時無法使用，請稍後再試', data.error);
    }

    const credential = await fb.signInWithCustomToken(fb.auth, data.token);
    if (data.name && credential.user.displayName !== data.name) {
      await fb.updateProfile(credential.user, { displayName: data.name }).catch(() => {});
    }
    customer = { uid: credential.user.uid, name: data.name || credential.user.displayName || '' };
    emit();
    return customer;
  })().finally(() => { exchanging = null; });
  return exchanging;
}

// 需要客人身分時呼叫（結帳、我的訂單、申請儲值）
// 已登入就直接回傳；沒登入會跳到 LINE 登入頁，回來後由 afterLoginHandler 接著做 action
export async function requireCustomer(action) {
  if (customer) return customer;
  if (!isLineLoginEnabled()) return null;
  const liff = await ensureLiff();
  if (liff.isLoggedIn()) {
    try {
      return await exchange();
    } catch (error) {
      if (error.code !== 'invalid-token') throw error;
      liff.logout(); // LINE 憑證過期：登出後重新登入一次
    }
  }
  const url = new URL(location.origin + location.pathname);
  url.searchParams.set('after_login', action);
  liff.login({ redirectUri: url.toString() });
  return new Promise(() => {}); // 頁面會跳到 LINE 登入頁
}

export async function logoutCustomer() {
  try {
    const liff = await ensureLiff();
    if (liff.isLoggedIn() && !liff.isInClient()) liff.logout();
  } catch {
    // LINE 元件載入失敗也照樣登出網站
  }
  await fb?.signOut(fb.auth);
  customer = null;
  emit();
}

// 在 LINE 裡開啟時不顯示登出（LINE 會自動再登入）
export async function canLogout() {
  if (!isLineLoginEnabled()) return true;
  try {
    const liff = await ensureLiff();
    return !liff.isInClient();
  } catch {
    return true;
  }
}
