# BIOYCLE 技術員考試系統 - 部署指南

## 🚀 最簡單的部署方式：GitHub + Render（免費）

整個流程只需要3個步驟，大約10-15分鐘完成。

---

### 📋 前提條件

- 一個 GitHub 帳號（免費註冊：https://github.com/signup）
- 一個 Personal Access Token（下面有詳細步驟）

---

### 步驟 1：創建 GitHub Personal Access Token

1. 打開瀏覽器訪問 https://github.com/settings/tokens/new
2. 登入您的 GitHub 帳號
3. 填寫：
   - **Token name**: `biocycle-deploy`
   - **Expiration**: 90 days
   - **勾選權限**: ✅ repo（完整仓库访问）
4. 點擊 **Generate token**
5. **複製生成的 token**（格式類似 `ghp_xxxxxxxxxxxx`）
6. 把這個 token 告訴 AI，就能自動完成部署

---

### 步驟 2：推送代碼到 GitHub（AI 可以幫你完成）

```
cd C:\Users\Sum\Desktop\TEST\exam-system

gh auth login --with-token
（輸入你的 Personal Access Token）

gh repo create biocycle-exam-system --private --source=. --push
```

---

### 步驟 3：在 Render 上部署

1. 打開瀏覽器訪問 https://render.com
2. 用 GitHub 帳號直接登入（點 **Get Started for Free**）
3. 登入後，點擊 **New +** → **Web Service**
4. 連接您的 GitHub 帳號，選擇 `biocycle-exam-system`
5. 配置：
   - **Name**: `biocycle-exam`
   - **Region**: Singapore（最接近香港）
   - **Branch**: main
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Plan**: Free ✅
6. 點擊 **Create Web Service**
7. 等待 3-5 分鐘部署完成

---

### 🎉 獲取線上 URL

部署完成後，Render 會給您一個 URL，例如：
- 🌳 員工考試: **https://biocycle-exam.onrender.com**
- 🌳 管理員面板: **https://biocycle-exam.onrender.com/admin**

員工可以用手機或任何設備訪問這個 URL 來考試！

⚠️ Render 免費版會在15分鐘無活動後休眠，首次訪問需要30-60秒啟動。

---

## 🔄 更新代碼後重新部署

當你需要更新系統（例如修改題庫、添加員工等）：

```
cd C:\Users\Sum\Desktop\TEST\exam-system
git add -A
git commit -m "更新描述"
git push
```

推送後 Render 會自動重新部署（3-5分鐘）。

---

## 💡 其他部署平台（如果 Render 不適合）

| 平台 | 免費額度 | 特點 | 網址 |
|------|---------|------|------|
| Render | 750小時/月 | 最穩定，自動HTTPS | render.com |
| Railway | $5試用額度 | 最快部署，無冷啟動 | railway.app |
| Bonto | 75小時/月 | 專為Node.js設計 | bonto.dev |
| Fly.io | 3個免費VM | 全球節點，需信用卡 | fly.io |

---

## ⚠️ 重要提醒

### 數據持久化
目前系統使用 JSON 文件存儲數據。在 Render 免費版中：
- 伺服器休眠後重啟時，數據會保留
- 重新部署（push 新代碼）時，數據可能會被重置

**建議**：定期在 Admin 面板匯出 CSV 成績備份。

### 安全建議
- 生產環境建議修改 Admin 密碼
- 可以在 Render 環境變數中設定 SECRET_KEY
