# BIOYCLE 技術員考試系統 - 部署指南

## 方法一：GitHub + Render（推薦，免費）

### 步驟 1：創建 GitHub Repository

1. 打開瀏覽器訪問 https://github.com/new
2. 登入您的 GitHub 帳號（如果沒有，先在 https://github.com/signup 註冊）
3. Repository name: `biocycle-exam-system`
4. 選擇 **Private**（私人）
5. 不要勾選 "Add a README file"
6. 點擊 **Create repository**

### 步驟 2：推送代碼到 GitHub

打開命令提示字元（CMD），執行以下命令：

```
cd C:\Users\Sum\Desktop\TEST\exam-system

git remote add origin https://github.com/你的用戶名/biocycle-exam-system.git
git branch -M main
git push -u origin main
```

如果出現登入提示，輸入您的 GitHub 用戶名和密碼（或 Personal Access Token）。

### 步驟 3：在 Render 上部署

1. 打開瀏覽器訪問 https://render.com
2. 點擊 **Get Started** 註冊（可以用 GitHub 帳號直接登入）
3. 登入後，點擊 **New +** → **Web Service**
4. 連接您的 GitHub 帳號
5. 選擇 `biocycle-exam-system` repository
6. 配置：
   - **Name**: biocycle-exam
   - **Region**: Singapore（最接近香港）
   - **Branch**: main
   - **Runtime**: Node
   - **Build Command**: npm install
   - **Start Command**: node server.js
   - **Plan**: Free
7. 點擊 **Create Web Service**
8. 等待 3-5 分鐘部署完成

### 步驟 4：獲取線上 URL

部署完成後，Render 會給您一個 URL，例如：
- 員工考試: https://biocycle-exam.onrender.com
- 管理員面板: https://biocycle-exam.onrender.com/admin

⚠️ 注意：Render 免費版會在15分鐘無活動後休眠，首次訪問需要30-60秒啟動。

---

## 方法二：Railway（更快部署，但有使用限制）

1. 打開 https://railway.app
2. 用 GitHub 帳號登入
3. 點擊 **New Project** → **Deploy from GitHub repo**
4. 選擇 `biocycle-exam-system` repository
5. Railway 會自動偵測 Node.js 並部署
6. 部署完成後會獲得一個 URL

⚠️ 注意：Railway 只有 $5 一次性試用額度，之後需要付費。

---

## 方法三：Bonto（專門為 Node.js 設計）

1. 打開 https://bonto.dev
2. 註冊帳號
3. 創建新應用，上傳代碼或連接 Git
4. 自動部署，獲取 URL（如 app-name.bonto.run）

⚠️ 注意：免費版每月75小時使用時間，30分鐘無活動後休眠。

---

## 重要提醒

### 數據持久化
目前系統使用 JSON 文件存儲數據。在 Render/Railway 的免費版中：
- 伺服器休眠後重啟時，數據文件會保留
- 但如果重新部署（push 新代碼），數據文件可能會被重置

建議：定期在 Admin 面板匯出 CSV 成績備份。

### 更新代碼後重新部署
```
git add -A
git commit -m "更新描述"
git push
```
推送後 Render 會自動重新部署。

### 安全建議
- 修改 Admin 密碼（目前是 ST140 / 61583398）
- 在 Render 環境變數中設定 SECRET_KEY
