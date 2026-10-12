# 熵與焙 ENTROPY & BAKING

精選咖啡豆網站：前台給客人瀏覽豆單，後台管理商品，資料存在 Firebase（免費方案）。

## 檔案說明

| 檔案 | 用途 |
|---|---|
| `index.html`、`script.js`、`style.css` | 前台豆單 |
| `admin.html`、`admin.js` | 後台管理（網址：網站網址後面加 `/admin.html`） |
| `firebase-config.js` | Firebase 專案設定，前台和後台共用 |
| `firestore.rules` | Firestore 安全規則（要貼到 Firebase 主控台才會生效） |
| `privacy.html` | 隱私權政策 |

## 後台使用說明

- **新增商品**：填寫表單後按「確認新增並上架」，會直接出現在前台。
- **前台排序**：數字越小越前面，不填視為 0；數字相同時維持原本順序。
- **產地**：盡量從建議清單選擇，名稱要跟前台「產地篩選」一致（例如「臺灣」不是「台灣」），客人才篩選得到。
- **暫時不賣**：按「下架」就好，不要刪除；之後按「上架」就能恢復。

## 安全規則（重要）

後台登入用的是 Firebase Authentication。要確保**只有你**能修改商品：

1. Firebase 主控台 → Firestore Database → **規則**，把 `firestore.rules` 整份內容貼上。
2. 在主控台裡把兩個「請換成…管理員信箱」改成兩位管理員登入後台的信箱，按「發布」。
   這個 GitHub 專案是公開的，**真正的信箱只填在主控台，不要改進 `firestore.rules` 檔案**。
3. 發布後確認：前台豆單正常顯示、兩位管理員都可以登入後台並修改商品。

## 免費額度

Firebase 免費方案（Spark）不需要綁信用卡、沒有使用期限。Firestore 每天可讀取 5 萬次，
一位客人打開豆單大約用掉 10 次，等於每天約 5,000 位客人都還在免費範圍內。

## 備用：SQL Server 版本

`feature/sql-server` 分支保存了改用 ASP.NET Core + SQL Server 的完整版本（尚未上線），
說明在那個分支的 README。目前正式網站使用 Firebase。
