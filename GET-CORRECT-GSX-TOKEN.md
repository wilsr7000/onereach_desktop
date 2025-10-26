# Getting the Correct GSX Token for Files API

## ⚠️ Important: Token Type Matters!

The error **"wrong keyId"** means you're using the wrong type of token. OneReach has different token types for different APIs.

---

## 🔑 **What Token You Need**

You need an **API Access Token** specifically for the **Files API**, not:
- ❌ Session tokens
- ❌ UI tokens  
- ❌ Chat tokens
- ❌ Short authentication tokens

---

## 📝 **How to Get the Correct Token**

### **Method 1: Generate API Token from GSX (Recommended)**

1. **Log into GSX:**
   - For Edison: https://studio.edison.onereach.ai

2. **Navigate to Account Settings:**
   - Click your profile/avatar (top-right)
   - Select "Account Settings" or "Profile"

3. **Find API Tokens Section:**
   - Look for tabs or sections labeled:
     - "API Tokens"
     - "Developer"
     - "API Access"
     - "Integrations"

4. **Generate New Token:**
   - Click "Generate New Token" or "Create Token"
   - **Name:** "Desktop App Files Sync"
   - **Permissions:** Check "Files API" or "Files Access"
   - **Scope:** Full access or Read/Write
   - **Expiration:** Never or Long-term
   - Click "Generate" or "Create"

5. **Copy the Token:**
   - ⚠️ **Shows only once!**
   - Should be a **long string** (50-200+ characters)
   - Example format: `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0...`
   - **NOT** short tokens like: `4szRut.UX3vsaos9DWXzocNER7f7Z_a2`

---

### **Method 2: Extract from Browser Developer Tools**

If you can't find the API Tokens section:

1. **Log into GSX** (Edison environment)

2. **Open Developer Tools** (`F12` or `Cmd+Option+I`)

3. **Go to Network Tab**

4. **Click on any Files API request:**
   - Look for requests to `files.edison.onereach.ai` or similar
   - Or any request that's loading file data

5. **Check Headers:**
   ```
   Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
   ```

6. **Copy everything after "Bearer "**
   - This is your API token
   - Should be a long string

---

### **Method 3: Ask OneReach Support/Admin**

If you still can't find it:

**Contact:**
- Your OneReach account administrator
- OneReach support: support@onereach.ai

**Ask for:**
- "API token with Files API permissions for Edison environment"
- "Long-lived API access token for Files service"

**Provide:**
- Your account ID: `05bd3c92-5d3c-4dc5-a95d-0c584695cea4`
- Environment: Edison
- Purpose: Desktop app file synchronization

---

## ❌ **Wrong Token Types**

These WON'T work:

### **Short Session Token:**
```
4szRut.UX3vsaos9DWXzocNER7f7Z_a2
```
- ❌ Too short (33 characters)
- ❌ Probably a UI session token
- ❌ Not an API access token

### **UI Auth Token:**
Found in Local Storage as `token` or `authToken`
- ❌ These are for UI authentication
- ❌ Don't work with Files API

---

## ✅ **Correct Token Format**

API tokens are typically:

### **JWT Format (Most Common):**
```
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c
```

**Characteristics:**
- ✅ Long (100-500+ characters)
- ✅ Three parts separated by dots
- ✅ Base64 encoded
- ✅ Starts with `eyJ`

### **Or Long API Key Format:**
```
sk_live_abc123def456ghi789jkl012mno345pqr678stu901vwx234yz567
```

**Characteristics:**
- ✅ Long (50-200 characters)
- ✅ May start with `sk_` or similar prefix
- ✅ Contains random alphanumeric characters

---

## 🔍 **How to Verify Your Token**

### **Check Token Length:**
```javascript
// In browser console (F12)
console.log(yourToken.length);
// Should be > 50 characters for API token
```

### **Check Token Format:**
- Does it start with `eyJ`? → JWT token ✅
- Is it 100+ characters? → Probably correct ✅
- Is it < 50 characters? → Wrong token type ❌

---

## 🎯 **What to Do Now**

### **Option A: Get New Token from GSX**
1. Log into https://studio.edison.onereach.ai
2. Go to Account Settings → API Tokens
3. Generate new token with Files API permissions
4. Copy the **entire long token**
5. Paste into Onereach app Settings

### **Option B: Find Existing API Token**
1. Check if you have an existing API token file
2. Look in your password manager
3. Check previous emails from OneReach setup

### **Option C: Use Browser Network Inspector**
1. Log into GSX
2. Open Files section in GSX
3. Open Developer Tools → Network tab
4. Refresh the page
5. Find a Files API request
6. Copy the Authorization header token

---

## 📋 **Testing the New Token**

Once you have the correct token:

1. Open Onereach app Settings
2. Paste the **new long token**
3. Set Environment to: **Edison**
4. Add Account ID: `05bd3c92-5d3c-4dc5-a95d-0c584695cea4`
5. Click **"Test Connection"**
6. Should see: ✅ "Connection successful!"

---

## 🔧 **Expected Log Output with Correct Token**

```
[GSX Sync] Token length: 157 (← Should be 50+)
[GSX Sync] Token prefix: eyJhbGci... (← Should start with eyJ or similar)
[GSX Sync] Creating FilesSyncNode instance...
[GSX Sync] ✓ SDK client object created
[GSX Sync] Starting SDK upload...
[GSX Sync] ✓ SDK upload completed successfully
```

---

## ⚠️ **Current Issue**

Your token `4szRut.UX3vsaos9DWXzocNER7f7Z_a2`:
- ❌ Only 33 characters (too short)
- ❌ Wrong format for Files API
- ❌ Likely a UI session token, not API token
- ❌ Rejected with "wrong keyId" error

**You need a different, longer token specifically for the Files API!**

---

## 📞 **Need Help?**

If you can't find how to generate an API token in GSX:

1. **Contact your OneReach admin**
2. **Email OneReach support:** support@onereach.ai
3. **Provide this info:**
   - Environment: Edison
   - Account ID: 05bd3c92-5d3c-4dc5-a95d-0c584695cea4
   - Need: Files API token for desktop app sync

They can generate it for you or point you to the right place in GSX!

---

**The token type is critical - make sure you get an API token, not a session token!** 🔑
