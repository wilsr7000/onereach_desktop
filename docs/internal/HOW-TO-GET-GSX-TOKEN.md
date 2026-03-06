# How to Get Your GSX Token

This guide shows you how to obtain your OneReach GSX token for the File Sync feature.

---

## 📋 **Quick Steps**

1. Log into your GSX account
2. Go to Account Settings
3. Navigate to API Tokens / Developer Settings
4. Generate a new token with Files API permissions
5. Copy the token and paste it into Onereach app Settings

---

## 🔐 **Detailed Instructions**

### **Step 1: Log Into GSX**

Visit your GSX environment:
- **Production:** https://studio.onereach.ai
- **Staging:** https://studio.staging.onereach.ai
- **QA:** https://studio.qa.onereach.ai

Log in with your credentials.

---

### **Step 2: Navigate to Account Settings**

**Option A - Via Profile Menu:**
1. Click on your **profile icon** (usually top-right corner)
2. Select **"Account Settings"** or **"Profile Settings"**

**Option B - Via URL:**
- Go directly to: `https://studio.onereach.ai/settings/account`
- (Replace domain with your environment)

---

### **Step 3: Find API Tokens Section**

Look for one of these sections:
- **"API Tokens"**
- **"Developer Settings"**
- **"API Keys"**
- **"Access Tokens"**
- **"Integration"**

Common locations:
- Settings → Account → API Tokens
- Settings → Developer → API Keys
- Settings → Integrations → Tokens

---

### **Step 4: Generate New Token**

1. Click **"Generate New Token"** or **"Create Token"** button
2. You may be asked to provide:
   - **Token Name:** e.g., "Desktop App Sync"
   - **Description:** e.g., "For Onereach desktop file sync"
   - **Permissions:** Select **"Files API"** or **"Files Access"**
   - **Expiration:** Choose "Never" or a long duration

3. Click **"Generate"** or **"Create"**

---

### **Step 5: Copy Your Token**

⚠️ **IMPORTANT:** The token is usually shown **only once**!

1. The token will appear on screen (looks like a long string of characters)
2. Click the **"Copy"** button or manually select and copy it
3. Example token format:
   ```
   eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkw...
   ```
   OR
   ```
   4szRut.UX3vsaos9DWXzocNER7f7Z_a2
   ```

4. **Save it somewhere safe** (password manager recommended)

---

### **Step 6: Add Token to Onereach App**

1. Open Onereach app
2. Go to Settings (`Cmd+,` on Mac, `Ctrl+,` on Windows)
3. Scroll to **"GSX File Sync Configuration"**
4. Paste your token in the **"GSX Token"** field
   - You can use the **"📋 Paste Token from Clipboard"** button
5. Select the correct **environment** (Production/Staging/QA)
6. Click **"Test Connection"** to verify it works
7. Click **"Save Settings"**

---

## 🔍 **Can't Find API Tokens Section?**

### **Try These Alternatives:**

#### **Method 1: Use Browser Developer Tools**

Some GSX setups store the token in the browser. You can extract it:

1. Log into GSX in your browser
2. Open Developer Tools:
   - **Mac:** `Cmd + Option + I`
   - **Windows/Linux:** `F12` or `Ctrl + Shift + I`
3. Go to the **"Application"** tab (Chrome) or **"Storage"** tab (Firefox)
4. Look in:
   - **Local Storage** → Look for keys like:
     - `token`
     - `authToken`
     - `accessToken`
     - `onereach_token`
   - **Session Storage** → Same keys
   - **Cookies** → Look for `token` or `auth` cookies

5. Copy the value (the long string)

#### **Method 2: Check Network Requests**

1. Open Developer Tools (F12)
2. Go to **"Network"** tab
3. Reload the GSX page
4. Look for API requests in the list
5. Click on any API request
6. Look in the **"Headers"** section
7. Find the **"Authorization"** header
8. Copy the token (usually after "Bearer ")
   ```
   Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
   ```

#### **Method 3: Contact Support**

If you still can't find it:
1. Contact your OneReach administrator
2. Ask for: "API token with Files API permissions"
3. Or email OneReach support: support@onereach.ai

---

## ✅ **Verify Your Token Works**

After adding the token to Onereach app:

1. In Settings → GSX File Sync Configuration
2. Click **"Test Connection"**
3. Should show: "GSX connection successful!" ✅

If it fails:
- ❌ **"Invalid token"** → Token might be expired or incorrect
- ❌ **"Connection failed"** → Check internet connection
- ❌ **"Insufficient permissions"** → Token needs Files API access

---

## 🔄 **Token Management Tips**

### **Security:**
- ✅ Store token in a password manager
- ✅ Don't share your token
- ✅ Revoke token if compromised
- ✅ Use different tokens for different apps

### **Expiration:**
- Check if your token has an expiration date
- Set calendar reminder to renew before it expires
- Generate new token before old one expires

### **Multiple Environments:**
- Production tokens only work in Production
- Staging tokens only work in Staging
- QA tokens only work in QA
- Generate separate tokens for each environment

---

## 🆘 **Troubleshooting**

### **Problem: "Token field is empty in Settings"**
**Solution:** The token wasn't copied. Go back to GSX and copy it again.

### **Problem: "Test Connection fails"**
**Solutions:**
1. Verify you selected the correct environment
2. Check token was copied completely (no spaces)
3. Try regenerating a new token
4. Ensure token has Files API permissions

### **Problem: "Token expires too soon"**
**Solution:** When generating, select "Never expires" or longest duration available.

### **Problem: "Can't find API Tokens in GSX"**
**Solution:** 
- Your account might not have permission
- Contact your GSX administrator
- Use browser developer tools method (see above)

---

## 📞 **Need Help?**

- **OneReach Support:** support@onereach.ai
- **Documentation:** Check your GSX instance's help section
- **Admins:** Contact your organization's OneReach administrator

---

## 🎉 **Once You Have Your Token:**

1. ✅ Add it to Onereach app Settings
2. ✅ Test the connection
3. ✅ Run a Complete Backup
4. ✅ Verify files appear in GSX Files
5. ✅ You're all set for automatic backups!

---

**Your token is the key to syncing your data. Keep it safe and secure!** 🔐
