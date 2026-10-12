import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getFirestore, collection, addDoc, onSnapshot, doc, updateDoc, deleteDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { firebaseConfig } from "./firebase-config.js";
import { initShop, startShop, stopShop } from "./admin-shop.js";
import { money, unitPrice } from "./pricing.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const productsRef = collection(db, "products");

const STATUS_UP = '上架';
const STATUS_DOWN = '下架';
const EMPTY_VALUE = '無'; // 未填寫的欄位存成「無」，前台也依此判斷

// 與前台 index.html「產地篩選」選單相同；產地沒包含其中任何一個時，客人用篩選會找不到該商品
const FILTER_ORIGINS = ['印尼', '哥倫比亞', '巴拿馬', '墨西哥', '瓜地馬拉', '盧安達', '臺灣', '衣索比亞'];

// 與前台 script.js 拆分風味標籤的規則相同
const FLAVOR_SPLIT = /[,，、\s]+/;

const $ = (id) => document.getElementById(id);

const authLoading = $('auth-loading');
const loginSection = $('login-section');
const loginForm = $('login-form');
const loginError = $('login-error');
const btnLogin = $('btn-login');
const adminContent = $('admin-content');
const currentUser = $('current-user');

const formSection = $('form-section');
const productForm = $('product-form');
const formTitle = $('form-title');
const formError = $('form-error');
const btnSubmit = $('btn-submit');
const btnCancelEdit = $('btn-cancel-edit');
const fields = {
    name: $('p-name'),
    price: $('p-price'),
    halfPrice: $('p-half-price'),
    roast: $('p-roast'),
    origin: $('p-origin'),
    process: $('p-process'),
    flavor: $('p-flavor'),
    sort: $('p-sort')
};
const originOptions = $('origin-options');
const originHint = $('origin-hint');
const flavorPreview = $('flavor-preview');

const listContainer = $('admin-product-list');
const listSearch = $('list-search');
const listStatus = $('list-status');
const listCount = $('list-count');
const toastContainer = $('toast-container');

let products = new Map();        // 商品 id → 商品資料
let stopProductsListener = null; // 登出時用來停止即時監聽
let editingId = null;            // 正在編輯的商品 id（null 代表新增模式）
let isSaving = false;

// ========== 共用小工具 ==========

// 商品資料放進 innerHTML 前先跳脫，避免名稱裡的引號、< > 弄壞畫面
function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

function showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    toastContainer.appendChild(toast);
    // 新訂單等提醒（warn）停留久一點，免得管理員沒看到
    setTimeout(() => toast.remove(), { error: 5000, warn: 8000 }[type] ?? 2500);
}

function showError(el, message) {
    el.textContent = message;
    el.hidden = !message;
}

function formatPrice(price) {
    const n = Number(price);
    return Number.isFinite(n) ? n.toLocaleString('zh-TW') : String(price ?? '');
}

function blankIfEmpty(value) {
    return value && value !== EMPTY_VALUE ? value : '';
}

function authErrorMessage(err) {
    switch (err.code) {
        case 'auth/invalid-credential':
        case 'auth/invalid-login-credentials':
        case 'auth/wrong-password':
        case 'auth/user-not-found':
        case 'auth/invalid-email':
            return '帳號或密碼錯誤，請重新輸入';
        case 'auth/too-many-requests':
            return '嘗試次數過多，請稍後再試';
        case 'auth/network-request-failed':
            return '網路連線異常，請檢查網路後再試';
        default:
            return '登入失敗：' + err.message;
    }
}

function dbErrorMessage(err) {
    switch (err.code) {
        case 'permission-denied':
            return '沒有權限，請確認目前登入的是管理員帳號';
        case 'not-found':
            return '找不到這筆資料，可能已被刪除';
        case 'unavailable':
            return '網路連線異常，請稍後再試';
        case 'failed-precondition':
            return '資料庫需要建立索引，請把錯誤畫面截圖給技術人員';
        default:
            return err.message;
    }
}

// 訂單、儲值會員、商店設定（admin-shop.js）共用的工具
initShop({
    db,
    auth,
    showToast,
    escapeHtml,
    dbErrorMessage,
    getProducts: () => products
});

// ========== 1. 登入狀態：登入後才開始讀取商品，登出就停止 ==========
onAuthStateChanged(auth, (user) => {
    authLoading.hidden = true;

    if (user) {
        loginSection.hidden = true;
        adminContent.hidden = false;
        currentUser.textContent = user.email || '';
        loginForm.reset();
        subscribeProducts();
        startShop();
    } else {
        if (stopProductsListener) {
            stopProductsListener();
            stopProductsListener = null;
        }
        stopShop();
        products = new Map();
        resetForm();
        adminContent.hidden = true;
        loginSection.hidden = false;
    }
});

// ========== 2. 登入 / 登出 ==========
loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    showError(loginError, '');
    btnLogin.disabled = true;
    btnLogin.textContent = '登入中…';

    try {
        await signInWithEmailAndPassword(auth, $('login-email').value.trim(), $('login-password').value);
    } catch (err) {
        showError(loginError, authErrorMessage(err));
    } finally {
        btnLogin.disabled = false;
        btnLogin.textContent = '安全登入後台';
    }
});

$('btn-logout').addEventListener('click', () => {
    if (editingId && !confirm('目前正在編輯商品，確定要登出嗎？未儲存的修改會遺失。')) return;
    signOut(auth);
});

// ========== 3. 即時讀取商品 ==========
function subscribeProducts() {
    if (stopProductsListener) return;
    listContainer.innerHTML = '<p class="list-empty">商品載入中…</p>';

    stopProductsListener = onSnapshot(productsRef, (snapshot) => {
        products = new Map(snapshot.docs.map((d) => [d.id, d.data()]));

        // 正在編輯的商品被刪掉了（例如在另一個分頁），就退出編輯模式，避免存檔時失敗
        if (editingId && !products.has(editingId)) {
            resetForm();
            showToast('正在編輯的商品已被刪除，已退出編輯模式', 'warn');
        }

        renderStats();
        renderOriginOptions();
        renderList();
    }, (err) => {
        stopProductsListener = null;
        if (!auth.currentUser) return; // 登出時監聽中斷屬正常，不需提示
        listContainer.innerHTML = `<p class="list-empty error">商品載入失敗：${escapeHtml(dbErrorMessage(err))}</p>`;
    });
}

// ========== 4. 新增 / 編輯商品 ==========
function readForm() {
    const name = fields.name.value.trim();
    const priceText = fields.price.value.trim();
    const price = Number(priceText);
    const halfText = fields.halfPrice.value.trim();
    const halfPrice = halfText === '' ? null : Number(halfText);
    const origin = fields.origin.value.trim();
    const sortText = fields.sort.value.trim();
    const sortOrder = sortText === '' ? 0 : Number(sortText);

    if (!name) return { error: '請填寫商品名稱', field: fields.name };
    if (priceText === '' || !Number.isInteger(price) || price < 0) {
        return { error: '價格請填寫 0 以上的整數', field: fields.price };
    }
    if (halfPrice !== null && (!Number.isInteger(halfPrice) || halfPrice <= 0)) {
        return { error: '半磅價格請填寫 1 以上的整數，或留空自動計算', field: fields.halfPrice };
    }
    if (!origin) return { error: '請填寫產地', field: fields.origin };
    if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 100000) {
        return { error: '排序請填寫 0 ~ 100000 的整數', field: fields.sort };
    }

    return {
        data: {
            name,
            price, // 存成數字，之後才能正確排序與計算
            half_price: halfPrice, // null 代表前台自動用 1 磅價格的一半
            roast_level: fields.roast.value,
            origin,
            process_method: fields.process.value.trim() || EMPTY_VALUE,
            flavor_notes: fields.flavor.value.trim() || EMPTY_VALUE,
            sort_order: sortOrder // 前台依此數字由小到大排列
        }
    };
}

productForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (isSaving) return; // 防止連點造成重複新增

    const { data, error, field } = readForm();
    if (error) {
        showError(formError, error);
        field.focus();
        return;
    }
    showError(formError, '');

    setSaving(true);
    try {
        if (editingId) {
            await updateDoc(doc(db, 'products', editingId), { ...data, updatedAt: serverTimestamp() });
            showToast(`已更新「${data.name}」`);
        } else {
            await addDoc(productsRef, {
                ...data,
                status: STATUS_UP,
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            });
            showToast(`已新增並上架「${data.name}」`);
        }
        resetForm();
    } catch (err) {
        showToast('儲存失敗：' + dbErrorMessage(err), 'error');
    } finally {
        setSaving(false);
    }
});

function setSaving(saving) {
    isSaving = saving;
    btnSubmit.disabled = saving;
    btnCancelEdit.disabled = saving;
    btnSubmit.textContent = saving ? '儲存中…' : (editingId ? '💾 儲存修改' : '確認新增並上架');
}

function startEdit(id) {
    const item = products.get(id);
    if (!item || isSaving) return;

    editingId = id;
    fields.name.value = item.name || '';
    fields.price.value = item.price ?? '';
    fields.halfPrice.value = Number(item.half_price) > 0 ? item.half_price : '';
    setSelectValue(fields.roast, item.roast_level || EMPTY_VALUE);
    fields.origin.value = item.origin || '';
    fields.process.value = blankIfEmpty(item.process_method);
    fields.flavor.value = blankIfEmpty(item.flavor_notes);
    fields.sort.value = item.sort_order ?? '';

    formTitle.textContent = '✏️ 正在修改：' + (item.name || '');
    btnSubmit.textContent = '💾 儲存修改';
    btnCancelEdit.hidden = false;
    showError(formError, '');
    updateOriginHint();
    renderFlavorPreview();
    highlightEditing();

    formSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    fields.name.focus({ preventScroll: true });
}

// 舊資料的烘焙度若不在選單內，補上該選項，避免一編輯就被默默改掉
function setSelectValue(select, value) {
    if (![...select.options].some((o) => o.value === value)) {
        select.add(new Option(value, value));
    }
    select.value = value;
}

function resetForm() {
    productForm.reset();
    editingId = null;
    formTitle.textContent = '✨ 上架新咖啡豆';
    btnSubmit.textContent = '確認新增並上架';
    btnCancelEdit.hidden = true;
    showError(formError, '');
    updateOriginHint();
    renderFlavorPreview();
    highlightEditing();
}

btnCancelEdit.addEventListener('click', resetForm);

// ========== 5. 上下架 / 刪除 ==========
async function toggleStatus(id, button) {
    const item = products.get(id);
    if (!item) return;
    const nextStatus = item.status === STATUS_UP ? STATUS_DOWN : STATUS_UP;

    button.disabled = true;
    try {
        await updateDoc(doc(db, 'products', id), { status: nextStatus, updatedAt: serverTimestamp() });
        showToast(`「${item.name}」已${nextStatus}`);
    } catch (err) {
        button.disabled = false;
        showToast('狀態更新失敗：' + dbErrorMessage(err), 'error');
    }
}

async function deleteProduct(id, button) {
    const item = products.get(id);
    if (!item) return;
    if (!confirm(`確定要永久刪除「${item.name}」嗎？\n刪除後無法復原；若只是暫時不賣，建議改用「下架」。`)) return;

    if (editingId === id) resetForm();
    button.disabled = true;
    try {
        await deleteDoc(doc(db, 'products', id));
        showToast(`已刪除「${item.name}」`);
    } catch (err) {
        button.disabled = false;
        showToast('刪除失敗：' + dbErrorMessage(err), 'error');
    }
}

// 清單按鈕統一由外層處理，不必每次重畫都重新綁定事件
listContainer.addEventListener('click', (e) => {
    const button = e.target.closest('button[data-action]');
    if (!button) return;
    const id = button.closest('.product-item').dataset.id;

    if (button.dataset.action === 'edit') startEdit(id);
    else if (button.dataset.action === 'toggle') toggleStatus(id, button);
    else if (button.dataset.action === 'delete') deleteProduct(id, button);
});

// ========== 6. 畫面渲染 ==========
function renderStats() {
    let up = 0;
    products.forEach((p) => { if (p.status === STATUS_UP) up++; });
    $('stat-up').textContent = up;
    $('stat-down').textContent = products.size - up;
}

function renderList() {
    const keyword = listSearch.value.trim().toLowerCase();
    const status = listStatus.value;

    const rows = [...products.entries()]
        .filter(([, p]) => !status || (status === STATUS_UP) === (p.status === STATUS_UP))
        .filter(([, p]) => !keyword || [p.name, p.origin, p.roast_level, p.process_method, p.flavor_notes]
            .some((v) => String(v ?? '').toLowerCase().includes(keyword)))
        // 上架中的排前面，同狀態再照前台排序，最後依名稱
        .sort(([, a], [, b]) =>
            (a.status === STATUS_UP ? 0 : 1) - (b.status === STATUS_UP ? 0 : 1) ||
            (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0) ||
            String(a.name ?? '').localeCompare(String(b.name ?? ''), 'zh-Hant'));

    listCount.textContent = rows.length === products.size
        ? `共 ${products.size} 項`
        : `顯示 ${rows.length} / ${products.size} 項`;

    if (products.size === 0) {
        listContainer.innerHTML = '<p class="list-empty">目前尚無商品資料，從上方表單新增第一支豆子吧！</p>';
    } else if (rows.length === 0) {
        listContainer.innerHTML = '<p class="list-empty">沒有符合條件的商品</p>';
    } else {
        listContainer.innerHTML = rows.map(([id, p]) => renderRow(id, p)).join('');
    }
}

function renderRow(id, p) {
    const isUp = p.status === STATUS_UP;
    const half = unitPrice(p, '半磅');
    const meta = [['產地', p.origin], ['烘焙', p.roast_level], ['處理', p.process_method], ['風味', p.flavor_notes]]
        .map(([label, value]) => `${label}：${escapeHtml(value || EMPTY_VALUE)}`)
        .concat(`半磅：${half == null ? '—' : money(half)}${Number(p.half_price) > 0 ? '' : '（自動）'}`)
        .concat(`排序：${escapeHtml(Number(p.sort_order) || 0)}`)
        .join(' ｜ ');

    return `
        <div class="product-item${isUp ? '' : ' is-down'}${id === editingId ? ' is-editing' : ''}" data-id="${escapeHtml(id)}">
            <div class="product-details">
                <span class="product-name">${escapeHtml(p.name || '（未命名）')}</span>
                <span class="product-price">NT$${escapeHtml(formatPrice(p.price))}</span>
                <span class="status-badge ${isUp ? 'status-up' : 'status-down'}">${isUp ? '上架中' : '已下架'}</span>
                <small class="product-meta">${meta}</small>
            </div>
            <div class="actions">
                <button type="button" class="btn-edit" data-action="edit">✏️ 編輯</button>
                <button type="button" class="btn-toggle" data-action="toggle">${isUp ? '👇 下架' : '☝️ 上架'}</button>
                <button type="button" class="btn-delete" data-action="delete">❌ 刪除</button>
            </div>
        </div>`;
}

function highlightEditing() {
    listContainer.querySelectorAll('.product-item').forEach((row) => {
        row.classList.toggle('is-editing', row.dataset.id === editingId);
    });
}

// 產地建議清單：前台篩選用的標準名稱 + 目前商品用過的產地（「台灣」統一建議成「臺灣」）
function renderOriginOptions() {
    const origins = new Set(FILTER_ORIGINS);
    products.forEach((p) => { if (p.origin) origins.add(p.origin.replace(/台灣/g, '臺灣')); });
    originOptions.innerHTML = [...origins].map((o) => `<option value="${escapeHtml(o)}"></option>`).join('');
}

function updateOriginHint() {
    const origin = fields.origin.value.trim();
    let warning = '';
    if (origin.includes('台灣')) {
        warning = '⚠ 前台篩選使用「臺灣」，寫成「台灣」客人會篩選不到';
    } else if (origin && !FILTER_ORIGINS.some((o) => origin.includes(o))) {
        warning = '⚠ 此產地不在前台「產地篩選」選單中，客人用篩選會找不到（用搜尋仍找得到）';
    }
    originHint.classList.toggle('warn', Boolean(warning));
    originHint.textContent = warning || '可直接從清單選擇，名稱與前台「產地篩選」一致';
}

// 即時預覽前台會顯示的風味標籤
function renderFlavorPreview() {
    const tags = fields.flavor.value.split(FLAVOR_SPLIT).map((t) => t.trim()).filter(Boolean);
    flavorPreview.innerHTML = tags.length
        ? '前台標籤預覽：' + tags.map((t) => `<span class="flavor-badge"># ${escapeHtml(t)}</span>`).join('')
        : '用逗號、頓號或空白分隔，前台會自動轉成風味標籤';
}

fields.origin.addEventListener('input', updateOriginHint);
fields.flavor.addEventListener('input', renderFlavorPreview);
listSearch.addEventListener('input', renderList);
listStatus.addEventListener('change', renderList);

renderOriginOptions();
