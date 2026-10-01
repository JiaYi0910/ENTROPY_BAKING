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

// 💡 媽媽指定的專屬訂購連結
const MOM_ORDER_URL = "http://www.freeshops.co/cs/94gev4b5"; 

// 1. 🌟 升級版開場動畫與滾動偵測動畫初始化
window.addEventListener('DOMContentLoaded', () => {
  const splash = document.getElementById("splash-screen");
  if (splash) {
    // 停留 1.2 秒讓客人看清楚精緻 Logo，然後像布幕一樣優雅往上收起
    setTimeout(() => { 
      splash.classList.add('fade-out'); 
    }, 1200);
    setTimeout(() => { 
      splash.remove(); 
      initScrollAnimations(); // 開場結束後啟動滾動淡入特效
    }, 2000);
  } else {
    initScrollAnimations();
  }
  
  checkBusinessStatus();
});

// 🌟 滾動偵測：當區塊進入畫面時自動柔和浮現
function initScrollAnimations() {
  const observerOptions = {
    root: null,
    rootMargin: '0px',
    threshold: 0.15
  };

  const observer = new IntersectionObserver((entries, observer) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target); // 動畫跑過一次就好
      }
    });
  }, observerOptions);

  document.querySelectorAll('.fade-in-section').forEach(section => {
    observer.observe(section);
  });
}

// 2. LINE 好友驗證確認按鈕
document.getElementById('btn-confirm-friend').addEventListener('click', () => {
  document.getElementById('line-friend-check').style.display = 'none';
  document.getElementById('menu-wrapper').style.display = 'block';
  // 重新觸發一次滾動監聽確保解鎖後內容順利浮現
  initScrollAnimations();
});

// 3. 自動檢測營業狀態 (10:00 - 20:00，例假日公休)
function checkBusinessStatus() {
  const badge = document.getElementById('business-status-badge');
  if (!badge) return;

  const now = new Date();
  const day = now.getDay();
  const hour = now.getHours();

  const isHoliday = (day === 0 || day === 6);
  const isOpenTime = (hour >= 10 && hour < 20);

  if (!isHoliday && isOpenTime) {
    badge.className = "status-badge-open";
    badge.innerText = "● 營業中 ☕ 歡迎光臨";
  } else {
    badge.className = "status-badge-closed";
    badge.innerText = "● 目前休息中 🌙 (營業時間 10:00 - 20:00)";
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

// 6. 渲染商品卡片 (內含風味雷達視覺條與標籤)
function renderProducts(products) {
  coffeeContainer.innerHTML = '';
  if (products.length === 0) {
    coffeeContainer.innerHTML = '<p style="grid-column: 1/-1; text-align:center; color:var(--text-muted); padding: 40px 0;">查無符合條件的咖啡豆</p>';
  } else {
    products.forEach(product => {
      const card = document.createElement('div');
      card.className = 'product-card';

      // 風味標籤處理
      let flavorBadgesHTML = '';
      if (product.flavor_notes && product.flavor_notes !== '無') {
        const notes = product.flavor_notes.split(/[,，、\s]+/);
        notes.forEach(note => {
          if (note.trim()) {
            flavorBadgesHTML += `<span class="flavor-badge"># ${note.trim()}</span>`;
          }
        });
      } else {
        flavorBadgesHTML = `<span class="flavor-badge"># 精選風味</span>`;
      }

      // 動態模擬風味雷達比例
      let acidLevel = 70;
      let sweetLevel = 80;
      let bodyLevel = 75;
      
      const roast = product.roast_level || '';
      if (roast.includes('淺')) { acidLevel = 85; sweetLevel = 75; bodyLevel = 55; }
      else if (roast.includes('深')) { acidLevel = 35; sweetLevel = 85; bodyLevel = 90; }

      card.innerHTML = `
        <div>
          <div class="product-title">${product.name}</div>
          <div class="product-price">NT$${product.price}</div>
          <div class="product-details-wrap">
            <div class="product-info"><b>烘焙度：</b>${roast || '無'}</div>
            <div class="product-info"><b>產地：</b>${product.origin || '無'}</div>
            <div class="product-info"><b>處理方式：</b>${product.process_method || '無'}</div>
            <div class="product-info"><b>風味描述：</b>${product.flavor_notes || '無'}</div>
          </div>

          <!-- ☕ 咖啡風味雷達視覺條 -->
          <div class="flavor-radar-wrap">
            <div class="flavor-radar-title">
              <span>☕ 風味特性指引</span>
            </div>
            <div class="radar-bars">
              <div class="radar-row">
                <span class="radar-label">酸度</span>
                <div class="radar-track"><div class="radar-fill" style="width: ${acidLevel}%;"></div></div>
              </div>
              <div class="radar-row">
                <span class="radar-label">甜感</span>
                <div class="radar-track"><div class="radar-fill" style="width: ${sweetLevel}%;"></div></div>
              </div>
              <div class="radar-row">
                <span class="radar-label">醇厚</span>
                <div class="radar-track"><div class="radar-fill" style="width: ${bodyLevel}%;"></div></div>
              </div>
            </div>
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

// 公告欄與 VIP 儲值方案的收合互動動畫
document.addEventListener('DOMContentLoaded', () => {
  // 1. 公告欄收合控制
  const noticeToggle = document.getElementById('notice-toggle');
  const noticeBody = document.getElementById('notice-body');
  const noticeText = document.getElementById('notice-text');
  const noticeArrow = document.getElementById('notice-arrow');

  if (noticeToggle && noticeBody) {
    noticeToggle.addEventListener('click', () => {
      const isOpen = noticeBody.style.maxHeight && noticeBody.style.maxHeight !== '0px' && noticeBody.style.maxHeight !== '0';
      if (isOpen) {
        noticeBody.style.maxHeight = '0px';
        if (noticeText) noticeText.innerText = '展開';
        if (noticeArrow) noticeArrow.innerText = '▼';
      } else {
        noticeBody.style.maxHeight = noticeBody.scrollHeight + 'px';
        if (noticeText) noticeText.innerText = '收合';
        if (noticeArrow) noticeArrow.innerText = '▲';
      }
    });
  }

  // 2. VIP 儲值方案收合控制
  const vipToggle = document.getElementById('vip-toggle');
  const vipBody = document.getElementById('vip-body');
  const vipText = document.getElementById('vip-text');
  const vipArrow = document.getElementById('vip-arrow');

  if (vipToggle && vipBody) {
    vipToggle.addEventListener('click', () => {
      const isOpen = vipBody.style.maxHeight && vipBody.style.maxHeight !== '0px' && vipBody.style.maxHeight !== '0';
      if (isOpen) {
        vipBody.style.maxHeight = '0px';
        if (vipText) vipText.innerText = '展開';
        if (vipArrow) vipArrow.innerText = '▼';
      } else {
        vipBody.style.maxHeight = vipBody.scrollHeight + 'px';
        if (vipText) vipText.innerText = '收合';
        if (vipArrow) vipArrow.innerText = '▲';
      }
    });
  }
});

// 8. Cookie 同意條款互動邏輯
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