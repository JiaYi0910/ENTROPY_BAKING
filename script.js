import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getFirestore, collection, query, where, onSnapshot } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBJ7FSvcaZjwWmWAjAmt9grWhzPYCwaTNQ",
  authDomain: "gengenhao-coffee.firebaseapp.com",
  projectId: "gengenhao-coffee", 
  storageBucket: "gengenhao-coffee.firebasestorage.app",
  messagingSenderId: "236932259007",
  appId: "1:236932259007:web:3b93dfdfd9d94447e2ba0a"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// 全域變數：存放從 Firebase 抓下來的商品
let allProducts = [];

// 💡 媽媽指定的專屬訂購連結 (請在此處填入實際網址)
const MOM_ORDER_URL = "http://www.freeshops.co/cs/94gev4b5"; 

// 1. 開場動畫計時器
window.addEventListener('DOMContentLoaded', () => {
  const splash = document.getElementById("splash-screen");
  if (splash) {
    setTimeout(() => { splash.style.animation = 'fadeOut 1s ease forwards'; }, 4000);
    setTimeout(() => { splash.remove(); }, 5000);
  }
  
  // 自動偵測營業時間狀態
  checkBusinessStatus();
});

// 2. LINE 好友驗證確認按鈕
document.getElementById('btn-confirm-friend').addEventListener('click', () => {
  document.getElementById('line-friend-check').style.display = 'none';
  document.getElementById('menu-wrapper').style.display = 'block';
});

// 3. 自動檢測營業狀態 (09:00 - 20:00，例假日公休)
function checkBusinessStatus() {
  const badge = document.getElementById('business-status-badge');
  if (!badge) return;

  const now = new Date();
  const day = now.getDay(); // 0 是週日, 6 是週六
  const hour = now.getHours();

  // 假設例假日公休為週六、週日 (可根據實際調整)
  const isHoliday = (day === 0 || day === 6);
  const isOpenTime = (hour >= 9 && hour < 20);

  if (!isHoliday && isOpenTime) {
    badge.className = "status-badge-open";
    badge.innerText = "● 營業中 ☕ 歡迎光臨";
  } else {
    badge.className = "status-badge-closed";
    badge.innerText = "● 目前休息中 🌙 (營業時間 09:00 - 20:00)";
  }
}

// 4. Firebase 即時監聽上架商品
const q = query(collection(db, "products"), where("status", "==", "上架"));

onSnapshot(q, (querySnapshot) => {
  allProducts = [];
  querySnapshot.forEach((doc) => {
    allProducts.push({ id: doc.id, ...doc.data() });
  });
  filterProducts();
});

// 5. 搜尋與篩選事件綁定
const coffeeContainer = document.getElementById('coffee-container');
const searchInput = document.getElementById('searchInput');
const filterRoast = document.getElementById('filterRoast');
const filterOrigin = document.getElementById('filterOrigin');

searchInput.addEventListener('input', filterProducts);
filterRoast.addEventListener('change', filterProducts);
filterOrigin.addEventListener('change', filterProducts);

function filterProducts() {
  const keyword = searchInput.value.trim().toLowerCase();
  const roast = filterRoast.value;
  const origin = filterOrigin.value;

  const filtered = allProducts.filter(p => {
    const name = p.name || '';
    const pOrigin = p.origin || '';
    const roastLevel = p.roast_level || '';
    const processMethod = p.process_method || '';
    const flavorNotes = p.flavor_notes || '';

    const matchKeyword =
      name.toLowerCase().includes(keyword) ||
      pOrigin.toLowerCase().includes(keyword) ||
      roastLevel.toLowerCase().includes(keyword) ||
      processMethod.toLowerCase().includes(keyword) ||
      flavorNotes.toLowerCase().includes(keyword);

    const matchRoast = roast === '' || roastLevel === roast;
    const matchOrigin = origin === '' || pOrigin.includes(origin);

    return matchKeyword && matchRoast && matchOrigin;
  });

  renderProducts(filtered);
}

// 6. 渲染商品卡片 (包含風味標籤與指定訂購連結)
function renderProducts(products) {
  coffeeContainer.innerHTML = '';
  if (products.length === 0) {
    coffeeContainer.innerHTML = '<p style="grid-column: 1/-1; text-align:center; color:var(--text-muted); padding: 40px 0;">查無符合條件的咖啡豆</p>';
  } else {
    products.forEach(product => {
      const card = document.createElement('div');
      card.className = 'product-card';

      // 將風味敘述轉換成精緻的風味標籤
      let flavorBadgesHTML = '';
      if (product.flavor_notes && product.flavor_notes !== '無') {
        const notes = product.flavor_notes.split(/[,，、\s]+/); // 支援逗號或空格分隔
        notes.forEach(note => {
          if (note.trim()) {
            flavorBadgesHTML += `<span class="flavor-badge"># ${note.trim()}</span>`;
          }
        });
      } else {
        flavorBadgesHTML = `<span class="flavor-badge"># 精選風味</span>`;
      }

      card.innerHTML = `
        <div>
          <div class="product-title">${product.name}</div>
          <div class="product-price">NT$${product.price}</div>
          <div class="product-details-wrap">
            <div class="product-info"><b>烘焙度：</b>${product.roast_level || '無'}</div>
            <div class="product-info"><b>產地：</b>${product.origin || '無'}</div>
            <div class="product-info"><b>處理方式：</b>${product.process_method || '無'}</div>
          </div>
          <div class="flavor-tag-container">
            ${flavorBadgesHTML}
          </div>
        </div>
        <a href="${MOM_ORDER_URL}" target="_blank" rel="noopener noreferrer" class="btn-order-link">
          立即前往指定連結下單 ➔
        </a>
      `;
      coffeeContainer.appendChild(card);
    });
  }
}

// 7. 公告欄收合互動動畫
document.addEventListener('DOMContentLoaded', () => {
  const noticeToggle = document.getElementById('notice-toggle');
  const noticeBody = document.getElementById('notice-body');
  const noticeArrow = document.getElementById('notice-arrow');

  if (noticeToggle && noticeBody && noticeArrow) {
    noticeToggle.addEventListener('click', () => {
      if (noticeBody.style.maxHeight === '0px' || noticeBody.style.maxHeight === '' || noticeBody.style.maxHeight === '0') {
        noticeBody.style.maxHeight = noticeBody.scrollHeight + 'px';
        noticeArrow.style.transform = 'rotate(180deg)';
        noticeArrow.innerText = '▲ 收合';
      } else {
        noticeBody.style.maxHeight = '0px';
        noticeArrow.style.transform = 'rotate(0deg)';
        noticeArrow.innerText = '▼ 展開';
      }
    });
  }
});

// 8. Cookie 同意條款邏輯
const consentEl = document.getElementById('cookie-consent');
const acceptBtn = document.getElementById('accept-cookie-btn');
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
if (getCookie('cookieConsent') === 'true') {
  if (consentEl) consentEl.style.display = 'none';
} else {
  if (consentEl) consentEl.style.display = 'flex';
}
if (acceptBtn) {
  acceptBtn.addEventListener('click', () => {
    setCookie('cookieConsent', 'true', 365);
    if (consentEl) consentEl.style.display = 'none';
  });
}