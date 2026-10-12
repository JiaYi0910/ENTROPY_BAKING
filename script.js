import { initOrder, openProductDialog, syncProducts, setShopSettings, setOrderSubmitter, escapeHtml } from "./order.js";
import { money, unitPrice } from "./pricing.js";

// 全域變數：存放從 Firebase 抓下來的商品
let allProducts = [];
let productsLoaded = false;

// 烘焙度由淺到深；color 用在刻度點與篩選按鈕的小圓點
const ROAST_LEVELS = [
  { value: '淺焙', short: '淺', color: '#d4b48c' },
  { value: '中淺焙', short: '中淺', color: '#b88a5e' },
  { value: '中焙', short: '中', color: '#9a6a42' },
  { value: '中深焙', short: '中深', color: '#74492b' },
  { value: '深焙', short: '深', color: '#4a2f1d' }
];

// 產地篩選的基本選項；商品產地包含這些字就算符合（例如配豆也能篩到）
const BASE_ORIGINS = ['衣索比亞', '哥倫比亞', '瓜地馬拉', '巴拿馬', '墨西哥', '盧安達', '印尼', '臺灣'];

// 「無」、「-」或空白都視為沒填
function hasValue(value) {
  const text = String(value ?? '').trim();
  return text !== '' && text !== '無' && text !== '-';
}

// 1. 開場動畫結束後，才根據驗證狀態決定是否顯示加好友視窗
window.addEventListener('DOMContentLoaded', () => {
  const splash = document.getElementById("splash-screen");
  const friendCheck = document.getElementById('line-friend-check');
  const menuWrapper = document.getElementById('menu-wrapper');

  // 確保一開始加好友視窗跟主選單先隱藏，讓開場動畫獨奏
  if (friendCheck) friendCheck.style.display = 'none';
  if (menuWrapper) menuWrapper.style.display = 'none';

  if (splash) {
    // 停留 1.2 秒讓客人看清楚 Logo
    setTimeout(() => {
      splash.classList.add('fade-out');
    }, 1200);

    // 2 秒後完全移除開場動畫
    setTimeout(() => {
      splash.remove();

      // 檢查是否已經通過 LINE 好友驗證
      if (getCookie('lineVerified') === 'true') {
        if (menuWrapper) menuWrapper.style.display = 'block';
      } else {
        if (friendCheck) friendCheck.style.display = 'flex';
      }
    }, 2000);
  } else {
    if (getCookie('lineVerified') === 'true') {
      if (menuWrapper) menuWrapper.style.display = 'block';
    } else {
      if (friendCheck) friendCheck.style.display = 'flex';
    }
  }

  checkBusinessStatus();
  // 每分鐘更新一次，頁面開著跨過營業時間也會自動切換
  setInterval(checkBusinessStatus, 60 * 1000);
});

// 2. LINE 好友驗證確認按鈕
const confirmBtn = document.getElementById('btn-confirm-friend');
if (confirmBtn) {
  confirmBtn.addEventListener('click', () => {
    setCookie('lineVerified', 'true', 30);
    const friendCheck = document.getElementById('line-friend-check');
    const menuWrapper = document.getElementById('menu-wrapper');

    if (friendCheck) friendCheck.style.display = 'none';
    if (menuWrapper) menuWrapper.style.display = 'block';
  });
}

// 3. 自動檢測營業狀態 (10:00 - 20:00，例假日公休)
// 一律以台灣時間判斷，人在國外的客人看到的狀態也正確
function getTaiwanTime() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei', weekday: 'short', hour: 'numeric', hour12: false
  }).formatToParts(new Date());
  const weekday = parts.find(p => p.type === 'weekday').value;
  const hour = Number(parts.find(p => p.type === 'hour').value) % 24;
  return { isWeekend: weekday === 'Sat' || weekday === 'Sun', hour };
}

function checkBusinessStatus() {
  const badge = document.getElementById('business-status-badge');
  if (!badge) return;

  const { isWeekend, hour } = getTaiwanTime();
  const isOpenTime = hour >= 10 && hour < 20;

  if (!isWeekend && isOpenTime) {
    badge.className = "status-badge-open";
    badge.innerText = "● 營業中 ☕ 歡迎光臨";
  } else {
    badge.className = "status-badge-closed";
    badge.innerText = "● 目前休息中 🌙 營業時間 10:00 - 20:00";
  }
}

// 4. Firebase 即時監聽上架商品
// 用動態載入：就算客人的網路連不到 Firebase，只有豆單顯示失敗，按鈕、開場動畫等功能照常運作
async function loadProducts() {
  try {
    const [{ initializeApp }, { getFirestore, collection, doc, query, where, onSnapshot, addDoc, serverTimestamp }, { firebaseConfig }] = await Promise.all([
      import("https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js"),
      import("https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js"),
      import("./firebase-config.js")
    ]);
    const db = getFirestore(initializeApp(firebaseConfig));
    const q = query(collection(db, "products"), where("status", "==", "上架"));

    onSnapshot(q, (querySnapshot) => {
      allProducts = [];
      querySnapshot.forEach((docSnap) => {
        allProducts.push({ id: docSnap.id, ...docSnap.data() });
      });
      // 依後台設定的「前台排序」由小到大排列；沒設定的視為 0，同數字時維持原本順序
      allProducts.sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0));
      productsLoaded = true;
      syncProducts(allProducts);
      renderOriginOptions();
      renderRoastChips();
      filterProducts();
    }, showLoadError);

    // 後台「商店設定」：轉帳帳號、運費、耗材費；讀不到時購物車會用預設值
    onSnapshot(doc(db, "settings", "shop"),
      (snap) => setShopSettings(snap.exists() ? snap.data() : {}),
      (error) => console.warn('商店設定讀取失敗，使用預設值', error));

    // 客人送出的訂單存到 orders，後台「訂單管理」可以看到
    setOrderSubmitter((order) => addDoc(collection(db, "orders"), { ...order, created_at: serverTimestamp() }));
  } catch (error) {
    showLoadError(error);
  }
}

function showLoadError(error) {
  console.error('豆單載入失敗', error);
  if (coffeeContainer) {
    coffeeContainer.innerHTML = '<p class="grid-message">豆單暫時載入失敗，請稍後重新整理，或透過 LINE 詢問我們 🙏</p>';
  }
}

// 5. 搜尋與篩選
const coffeeContainer = document.getElementById('coffee-container');
const searchInput = document.getElementById('searchInput');
const filterOrigin = document.getElementById('filterOrigin');
const roastChips = document.getElementById('roastChips');
const resultCount = document.getElementById('resultCount');
let selectedRoast = '';

if (coffeeContainer) {
  coffeeContainer.innerHTML = '<p class="grid-message">豆單載入中…</p>';
}
if (searchInput) searchInput.addEventListener('input', filterProducts);
if (filterOrigin) filterOrigin.addEventListener('change', filterProducts);

// 商品卡上的「加入購物車」：打開選加工方式、份量的視窗
if (coffeeContainer) {
  coffeeContainer.addEventListener('click', (e) => {
    const button = e.target.closest('.btn-add-cart[data-id]');
    if (!button) return;
    const product = allProducts.find(p => p.id === button.dataset.id);
    if (product) openProductDialog(product);
  });
}

initOrder();
loadProducts();

// 產地選單依目前上架的商品自動產生，新產地不用改程式也篩得到
function renderOriginOptions() {
  if (!filterOrigin) return;
  const current = filterOrigin.value;
  const origins = BASE_ORIGINS.filter(o => allProducts.some(p => (p.origin || '').includes(o)));

  // 不屬於基本選項的產地（例如「韓式配方」）直接用原本的文字當選項
  allProducts.forEach(p => {
    const origin = (p.origin || '').trim();
    if (origin && !BASE_ORIGINS.some(o => origin.includes(o)) && !origins.includes(origin)) {
      origins.push(origin);
    }
  });

  filterOrigin.innerHTML = '<option value="">全部產地</option>' +
    origins.map(o => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('');
  filterOrigin.value = origins.includes(current) ? current : '';
}

// 烘焙度篩選按鈕；目前沒有豆子的烘焙度會變灰無法點選
function renderRoastChips() {
  if (!roastChips) return;
  const available = new Set(allProducts.map(p => p.roast_level));
  if (selectedRoast && !available.has(selectedRoast)) selectedRoast = '';

  const chips = [`<button type="button" class="chip${selectedRoast === '' ? ' is-active' : ''}" data-roast="" aria-pressed="${selectedRoast === ''}">全部烘焙度</button>`]
    .concat(ROAST_LEVELS.map(level => {
      const active = selectedRoast === level.value;
      return `<button type="button" class="chip${active ? ' is-active' : ''}" data-roast="${level.value}" aria-pressed="${active}"${available.has(level.value) ? '' : ' disabled'}>
        <span class="chip-dot" style="background:${level.color}"></span>${level.value}
      </button>`;
    }));
  roastChips.innerHTML = chips.join('');
}

if (roastChips) {
  roastChips.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip || chip.disabled) return;
    selectedRoast = chip.dataset.roast;
    renderRoastChips();
    filterProducts();
  });
}

function filterProducts() {
  if (!coffeeContainer || !productsLoaded) return;
  const keyword = searchInput ? searchInput.value.trim().toLowerCase() : '';
  const origin = filterOrigin ? filterOrigin.value : '';

  const filtered = allProducts.filter(p => {
    const matchKeyword = [p.name, p.origin, p.roast_level, p.process_method, p.flavor_notes]
      .some(v => String(v ?? '').toLowerCase().includes(keyword));
    const matchRoast = selectedRoast === '' || p.roast_level === selectedRoast;
    const matchOrigin = origin === '' || (p.origin || '').includes(origin);
    return matchKeyword && matchRoast && matchOrigin;
  });

  if (resultCount) {
    resultCount.textContent = filtered.length === allProducts.length
      ? `共 ${allProducts.length} 支咖啡豆`
      : `找到 ${filtered.length} 支咖啡豆（共 ${allProducts.length} 支）`;
  }
  renderProducts(filtered);
}

function resetFilters() {
  if (searchInput) searchInput.value = '';
  if (filterOrigin) filterOrigin.value = '';
  selectedRoast = '';
  renderRoastChips();
  filterProducts();
}

// 6. 渲染商品卡片

// 烘焙度刻度：淺 ─ 中淺 ─ 中 ─ 中深 ─ 深，標出這支豆子的位置
function renderRoastScale(roastLevel) {
  if (!ROAST_LEVELS.some(level => level.value === roastLevel)) return '';
  const steps = ROAST_LEVELS.map(level => `
    <li class="${level.value === roastLevel ? 'is-active' : ''}" style="--roast:${level.color}">${level.short}</li>
  `).join('');
  return `
    <div class="roast-scale" role="img" aria-label="烘焙度：${roastLevel}">
      <div class="roast-scale-head"><span>烘焙度</span><strong>${roastLevel}</strong></div>
      <ol class="roast-steps" aria-hidden="true">${steps}</ol>
    </div>
  `;
}

// 價格區：1 磅價格 + 半磅價格 + 加入購物車；價格不正確的商品改成請客人用 LINE 詢問
function renderPriceFooter(product) {
  const full = unitPrice(product, '1磅');
  if (full == null) {
    return `
      <div class="product-footer">
        <div class="product-price">價格請洽詢</div>
        <a href="https://line.me/R/ti/p/%40245rbror" target="_blank" rel="noopener noreferrer" class="btn-add-cart">LINE 詢問</a>
      </div>`;
  }
  return `
    <div class="product-footer">
      <div class="price-block">
        <div class="product-price">${money(full)}<span>/ 磅</span></div>
        <div class="product-half-price">半磅 ${money(unitPrice(product, '半磅'))}</div>
      </div>
      <button type="button" class="btn-add-cart" data-id="${escapeHtml(product.id)}">加入購物車</button>
    </div>`;
}

function renderProducts(products) {
  if (!coffeeContainer) return;

  if (products.length === 0) {
    coffeeContainer.innerHTML = `
      <div class="grid-message">
        <p>查無符合條件的咖啡豆</p>
        <button type="button" class="btn btn-ghost" id="btn-reset-filters">清除篩選條件</button>
      </div>`;
    document.getElementById('btn-reset-filters').addEventListener('click', resetFilters);
    return;
  }

  coffeeContainer.innerHTML = products.map((product, index) => {
    const originLine = [product.origin, product.process_method].filter(hasValue).map(escapeHtml).join(' · ');
    const tags = hasValue(product.flavor_notes)
      ? String(product.flavor_notes).split(/[,，、\s]+/).filter(Boolean)
        .map(note => `<span class="flavor-badge"># ${escapeHtml(note)}</span>`).join('')
      : '';

    // 卡片依序淡入，最多延遲 0.4 秒
    return `
      <article class="product-card" style="animation-delay:${Math.min(index * 50, 400)}ms">
        ${originLine ? `<div class="product-origin">${originLine}</div>` : ''}
        <h3 class="product-title">${escapeHtml(product.name)}</h3>
        ${renderRoastScale(product.roast_level)}
        ${tags ? `<div class="flavor-tag-container">${tags}</div>` : ''}
        ${renderPriceFooter(product)}
      </article>
    `;
  }).join('');
}

// 7. 公告欄與 VIP 儲值方案的收合互動
function setupCollapsible(toggleId, bodyId) {
  const toggle = document.getElementById(toggleId);
  const body = document.getElementById(bodyId);
  if (!toggle || !body) return;
  const card = toggle.closest('.card-box');
  const text = toggle.querySelector('.toggle-text');

  toggle.addEventListener('click', () => {
    const isOpen = card.classList.contains('is-open');
    body.style.maxHeight = isOpen ? '0px' : body.scrollHeight + 'px';
    card.classList.toggle('is-open', !isOpen);
    toggle.setAttribute('aria-expanded', String(!isOpen));
    if (text) text.textContent = isOpen ? '展開' : '收合';
  });
}

setupCollapsible('notice-toggle', 'notice-body');
setupCollapsible('vip-toggle', 'vip-body');

// 8. Cookie 工具與同意條款互動邏輯
function getCookie(name) {
  const value = `; ${document.cookie}`;
  const parts = value.split(`; ${name}=`);
  if (parts.length === 2) return parts.pop().split(';').shift();
  return null;
}

function setCookie(name, value, days) {
  const d = new Date();
  d.setTime(d.getTime() + days * 24 * 60 * 60 * 1000);
  document.cookie = `${name}=${value};expires=${d.toUTCString()};path=/`;
}

const consentEl = document.getElementById('cookie-consent');
const acceptBtn = document.getElementById('accept-cookie-btn');

if (consentEl) {
  consentEl.style.display = getCookie('cookieConsent') === 'true' ? 'none' : 'flex';
}

if (acceptBtn) {
  acceptBtn.addEventListener('click', () => {
    setCookie('cookieConsent', 'true', 365);
    if (consentEl) consentEl.style.display = 'none';
  });
}
