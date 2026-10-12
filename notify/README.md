# Google 小幫手設定：Email 通知、LINE 登入、LINE 訊息

這個資料夾的 [`apps-script.gs`](apps-script.gs) 是放在 Google Apps Script 上的小程式，負責：

| 功能 | 需要的設定 |
|---|---|
| 新訂單、儲值申請寄 Email 到 **shelly45556@gmail.com**，並備份到 Google 試算表 | 第一部分 |
| 客人用 **LINE 登入**，在網站「我的訂單」只看得到自己的訂單 | 第一＋第二部分 |
| 下單後、已付款、已出貨、已取消、儲值完成時，**LINE 機器人自動傳訊息**給客人 | 第一＋第二部分 |

全部免費、不需要信用卡。第二部分還沒設定前，網站維持「不用登入就能下單」，只會寄 Email。

---

## 第一部分：Email 通知（約 10 分鐘）

> 已經設定過 Email 通知的話，可以直接跳到第二部分。

### 1. 建立試算表與程式

1. 用 **shelly45556@gmail.com** 打開 [Google 試算表](https://sheets.google.com)，建立空白試算表，命名為「熵與焙 訂單」。
2. 上方選單：**擴充功能 → Apps Script**。
3. 把編輯器裡原本的程式碼全部刪掉，貼上 [`apps-script.gs`](apps-script.gs) 的**全部內容**，按 💾 儲存。
4. 想多通知一個人時，把最上面這行改成：
   ```
   const ADMIN_EMAILS = ['shelly45556@gmail.com', '另一個信箱'];
   ```

### 2. 授權並寄測試信

1. 上方函式選單選 **`sendTestEmail`**，按 **▶ 執行**。
2. 出現「需要授權」→ 選你的 Google 帳號。
3. 出現「**Google 尚未驗證這個應用程式**」：按「**進階**」→「**前往（不安全）**」→「**允許**」。
   程式是你自己建立的，不是公開 App，這是正常現象。
4. shelly45556@gmail.com 應該會收到「【測試】【熵與焙 ENTROPY & BAKING】新訂單 TEST」。

### 3. 部署成網址

1. 右上角 **部署 → 新增部署作業**。
2. 齒輪「選取類型」→ **網頁應用程式**。
3. 執行身分：**我**；誰可以存取：**所有人**。
4. 按「部署」，複製「**網頁應用程式網址**」（`https://script.google.com/macros/s/……/exec`）。

### 4. 貼到網站後台

1. 網站後台 → 最下方「⚙️ 商店設定」→「📧 Email 與 LINE 通知」。
2. 「Google Apps Script 網址」貼上剛剛的網址 → 💾 儲存商店設定。
3. 按「**寄送測試通知並檢查設定**」，會列出每一項設定的狀態，並寄一封測試信。

---

## 第二部分：LINE 登入與 LINE 訊息（約 30 分鐘）

需要：LINE Developers 的管理權限（你已經有）、Firebase 主控台的權限。
下面的英文按鈕名稱是 LINE Developers 網站上實際看到的文字。

### 1. 關掉過期的 Webhook、確認聊天有開

舊的 Webhook 網址（gengenhao.onrender.com）已經失效，**不影響**機器人主動傳訊息，但建議關掉：

1. [LINE Developers](https://developers.line.biz/console/) → 選機器人所在的 **Provider** → 點機器人的 **Messaging API** channel。
2. **Messaging API** 分頁 → Webhook settings → 把 **Use webhook** 關掉。
3. [LINE 官方帳號管理後台](https://manager.line.biz/) → 設定 → **回應設定** → 確認「**聊天**」是開啟的。
   客人按「用 LINE 回報匯款」傳來的訊息，會出現在官方帳號後台的「聊天」裡。

### 2. 取得機器人的 Channel access token

1. 同一個 Messaging API channel → **Messaging API** 分頁，捲到最下面。
2. **Channel access token (long-lived)** → 按 **Issue**（已經有的話直接複製）。
3. 先把這串文字貼到記事本暫存，等一下要用。

### 3. 建立 LINE Login channel

> ⚠ **一定要建在跟機器人「同一個 Provider」底下。**
> LINE 給每位客人的 ID 是依 Provider 區分的，不同 Provider 的話，機器人會找不到客人、傳不出訊息。

1. 回到機器人所在的 Provider 頁面 → **Create a new channel** → 選 **LINE Login**。
2. 填寫：
   - Region：**Taiwan**
   - Channel name：`熵與焙`（客人登入時會看到）
   - Channel description：`熵與焙 咖啡豆訂購`
   - App types：勾選 **Web app**
   - Email address：shelly45556@gmail.com
3. 同意條款 → **Create**。
4. **Basic settings** 分頁：
   - 複製 **Channel ID**（一串數字），貼到記事本。
   - **Linked LINE Official Account** → Edit → 選你們的官方帳號（機器人）→ Update。
5. **LINE Login** 分頁 → Callback URL 按 Edit，填：
   ```
   https://jiayi0910.github.io/ENTROPY_BAKING/
   ```

### 4. 新增 LIFF（讓網站可以用 LINE 登入）

1. 同一個 LINE Login channel → **LIFF** 分頁 → **Add**。
2. 填寫：
   - LIFF app name：`熵與焙`
   - Size：**Full**
   - Endpoint URL：`https://jiayi0910.github.io/ENTROPY_BAKING/`
   - Scopes：勾 **openid** 和 **profile**（不用勾 chat_message.write）
   - Add friend option：**On (Aggressive)**（登入後會請客人加官方帳號好友，**客人要是好友，機器人才傳得到訊息**）
   - Scan QR、Module mode：維持 Off
3. 按 **Add**，複製 **LIFF ID**（長得像 `1234567890-AbCdEfGh`），貼到記事本。

### 5. 發布 LINE Login channel

LINE Login channel 頁面最上方 channel 名稱旁的狀態是 **Developing** → 點它 → **Publish**。
沒有發布的話，只有你自己能登入，客人會看到錯誤。

### 6. 下載 Firebase 服務帳戶金鑰

小幫手要用這把金鑰，才能讓客人登入網站、讀取訂單內容。

1. [Firebase 主控台](https://console.firebase.google.com/) → 你的專案 → 左上角 ⚙️ → **專案設定** → **服務帳戶** 分頁。
2. 選「Firebase Admin SDK」→ 按「**產生新的私密金鑰**」→「**產生金鑰**」，會下載一個 `.json` 檔。
3. 用「記事本」打開這個檔案 → Ctrl+A 全選 → Ctrl+C 複製（下一步要貼上）。

> ⚠ **這把金鑰等於資料庫的萬能鑰匙，請特別小心：**
> - 只貼到 Apps Script 的「指令碼屬性」，**不要**放進網站資料夾、**不要**上傳 GitHub、**不要**用 LINE 或 Email 傳給任何人。
> - 貼好之後，把下載的 `.json` 檔刪除，並清空資源回收筒。
> - 不要把 Apps Script 專案分享給別人編輯（有編輯權限的人看得到指令碼屬性）。
> - 萬一外流：Firebase 主控台 → 專案設定 → 服務帳戶 → 「管理服務帳戶權限」→ 刪除那把金鑰，再重新產生一把。

### 7. 貼上新版程式、填指令碼屬性

1. 打開第一部分建立的 Apps Script，把程式碼**全部換成**最新的 [`apps-script.gs`](apps-script.gs) → 💾 儲存。
2. 左邊 ⚙️ **專案設定** → 最下面「**指令碼屬性**」→ **編輯指令碼屬性** → 新增三筆：

   | 屬性 | 值 |
   |---|---|
   | `LINE_LOGIN_CHANNEL_ID` | 步驟 3 的 Channel ID |
   | `LINE_CHANNEL_ACCESS_TOKEN` | 步驟 2 的 Channel access token |
   | `FIREBASE_SERVICE_ACCOUNT` | 步驟 6 的 `.json` 檔**整份內容** |

3. 按「**儲存指令碼屬性**」。
4. 回到編輯器，函式選單選 **`sendTestEmail`** → ▶ 執行。這次會要求新的權限（連線到 LINE 和 Firebase）→ 同樣按「進階」→「前往」→「允許」。

### 8. 重新部署（網址不會變）

**部署 → 管理部署作業** → 按 ✏️ 編輯 → 版本選「**新版本**」→ **部署**。

> 不要按「新增部署作業」，那樣會產生新網址，後台就要重新貼網址。

### 9. 發布最新的 Firestore 安全規則

新規則讓 LINE 登入的客人可以讀取自己的訂單。**要先做這一步，再做下一步**，不然客人登入後會無法下單。

1. Firebase 主控台 → Firestore Database → **規則**。
2. 把專案裡 [`firestore.rules`](../firestore.rules) 的整份內容貼上。
3. 把兩個「請換成…管理員信箱」改成兩位管理員登入後台的信箱 → **發布**。
   （真正的信箱只填在主控台，不要改進 GitHub 上的檔案。）

### 10. 在後台開啟 LINE 登入

1. 網站後台 → ⚙️ 商店設定 →「📧 Email 與 LINE 通知」→「**LINE 登入（LIFF ID）**」貼上步驟 4 的 LIFF ID。
2. 💾 儲存商店設定。
3. 按「**寄送測試通知並檢查設定**」，下面五項應該都是 ✓：

   | 項目 | 出現 ✗ 時 |
   |---|---|
   | Email 通知 | 重新執行一次 `sendTestEmail` 並允許權限 |
   | 試算表備份 | 確認程式是從試算表的「擴充功能」開的 |
   | 網站登入憑證（Firebase） | 檢查 `FIREBASE_SERVICE_ACCOUNT` 是否貼上整份 JSON（從 `{` 到 `}`） |
   | LINE 登入 | 檢查 `LINE_LOGIN_CHANNEL_ID` |
   | LINE 機器人傳訊息 | 檢查 `LINE_CHANNEL_ACCESS_TOKEN`，或重新 Issue 一次 |

   改完指令碼屬性不用重新部署，直接再按一次檢查即可。

開啟後，客人在「結帳」、「我的訂單」、「申請儲值」時會先用 LINE 登入；只是瀏覽豆單不需要登入。
**想暫停 LINE 登入**：把 LIFF ID 清空並儲存，網站會回到不用登入的下單方式。

### 11. 用手機實際測試

1. 手機 LINE 打開 `https://liff.line.me/你的LIFF ID`（可以傳給自己再點）→ 會自動登入。
2. 點右上角 👤「我的訂單」，應該顯示「○○，您好」。
3. 下一筆測試訂單（選門市自取）→ LINE 應該收到訂單確認，裡面有轉帳帳號。
4. 到後台把這筆改成「已付款」→ LINE 應該收到付款確認，「我的訂單」也會即時更新。
5. 測完到後台**刪除**這筆測試訂單（改成「已取消」也會傳 LINE 訊息）。

也可以用電腦瀏覽器打開網站，按「我的訂單」→「用 LINE 登入」，會跳到 LINE 登入頁，登入後自動回到網站。

### 12.（建議）在圖文選單加「我的訂單」

LINE 官方帳號管理後台 → **圖文選單** → 選一格，動作選「**連結**」，網址填：

```
https://liff.line.me/你的LIFF ID?view=orders
```

客人點了就會直接打開自己的訂單。

---

## 常見問題

- **LINE 訊息一個月可以傳幾則？**
  官方帳號免費的「輕用量」方案每月 200 則（以官方帳號後台顯示為準）。
  每筆訂單大約 3 則（下單確認、已付款、已出貨），約可支援每月 60～70 筆訂單。「已完成」不傳訊息，以節省則數。
  超過額度時只是訊息傳不出去，訂單照常成立，客人仍可在「我的訂單」看到最新狀態。
  用量可以在官方帳號後台的「設定 → 帳號設定 → 用量」查看。
- **客人沒收到 LINE 訊息？**
  - 客人要是官方帳號的好友，而且沒有封鎖。
  - LINE Login 和機器人要在同一個 Provider 底下（第二部分步驟 3）。
  - 在後台按「寄送測試通知並檢查設定」，確認「LINE 機器人傳訊息」是 ✓。
- **客人登入時看到錯誤？**
  - 確認 LINE Login channel 已經 **Publish**（步驟 5）。
  - 確認 LIFF 的 Endpoint URL 是 `https://jiayi0910.github.io/ENTROPY_BAKING/`，結尾要有 `/`。
- **客人登入後無法下單、改用 LINE 傳訂單？** 通常是 Firestore 規則還是舊的，請做步驟 9。
- **改了程式要重新部署嗎？** 要，照步驟 8。只改指令碼屬性就不用。
- **沒收到 Email？** 先看垃圾郵件匣；再到 Apps Script 左邊「執行項目」看有沒有錯誤。就算 Email 沒寄出，訂單也會出現在後台「訂單管理」。
- **試算表裡有客人的姓名、電話、地址**，請不要分享給管理員以外的人。
- **Google 的使用限制？** 一般 Gmail 帳號每天約可寄 100 封、連線外部服務 2 萬次，小店使用綽綽有餘；程式另外限制每小時最多寄 30 封 Email，防止網址被濫用。
