# How to Extract Token from Browser Network Tab

## 🎯 Step-by-Step Guide

Follow these exact steps to get your Files API token from the browser.

---

## 📋 **Complete Instructions**

### **Step 1: Log Into GSX**

1. Open your browser (Chrome, Firefox, Safari, etc.)
2. Go to: **https://studio.edison.onereach.ai**
3. **Log in** with your credentials
4. Wait for the dashboard to fully load

---

### **Step 2: Open Developer Tools**

**Mac:**
- Press: `Cmd + Option + I`
- Or: Right-click anywhere → "Inspect"
- Or: View menu → Developer → Developer Tools

**Windows/Linux:**
- Press: `F12`
- Or: `Ctrl + Shift + I`
- Or: Right-click anywhere → "Inspect"

**You should see a panel open at the bottom or side of your browser**

---

### **Step 3: Go to Network Tab**

1. In the Developer Tools panel, click the **"Network"** tab at the top
2. You'll see a list area that's probably empty
3. **Keep this panel open!**

---

### **Step 4: Trigger a Network Request**

You need to make the browser send a request that includes your token. Do ONE of these:

**Option A - Refresh the page:**
- Press `F5` or `Cmd+R` to reload the GSX page
- Watch the Network tab fill with requests

**Option B - Click around in GSX:**
- Click on different sections (Files, Bots, etc.)
- Each click generates new requests

**Option C - Open Files section:**
- Navigate to Files in GSX (if available)
- This will definitely trigger Files API requests

---

### **Step 5: Find Requests with "token"**

1. In the Network tab, look for the **filter/search box** (usually top-left of Network panel)
2. Type: **`token`**
3. This will filter the list to only show requests with "token" in them

**OR**

1. In the Network tab, click on the filter funnel icon
2. Type: **`token`**

**OR**

1. Look through the list manually for requests to:
   - `api.edison.onereach.ai`
   - `files.edison.onereach.ai`
   - Any URL with `/token` in the path

---

### **Step 6: Click on a Request**

1. In the filtered list, **click on any request**
2. A details panel will open (usually on the right or below)
3. You'll see tabs like: Headers, Preview, Response, etc.

---

### **Step 7: Find the Authorization Header**

1. Make sure you're in the **"Headers"** tab
2. Scroll down to the **"Request Headers"** section
3. Look for a line that says: **`authorization:`** or **`Authorization:`**
4. The value will look like:
   ```
   Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIi...
   ```

**IMPORTANT:** You want the part **AFTER "Bearer "** (skip the word "Bearer" and the space)

---

### **Step 8: Copy the Token**

**Method A - Click to Copy:**
- Some browsers let you click the value to copy it
- Look for a copy icon next to the header value

**Method B - Manual Selection:**
1. **Click** on the token value to select it
2. It will highlight (might be on multiple lines)
3. Right-click → Copy
4. Or: `Cmd+C` (Mac) or `Ctrl+C` (Windows)

**Method C - If it's on multiple lines:**
1. Click at the start of the token (after "Bearer ")
2. Hold Shift
3. Click at the very end of the token
4. Copy the selection

---

### **Step 9: Verify You Have the Full Token**

1. Paste it into a text editor temporarily
2. **Check the length:**
   - Should be **50-500+ characters**
   - If it's only ~30-40 characters, you got the wrong token
3. **Check the format:**
   - Should start with `eyJ` (most common)
   - Or be a long random alphanumeric string
4. **Make sure there's no "Bearer " at the start** - remove it if there is

**Example of what you should have:**
```
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c
```

---

### **Step 10: Add to Onereach App**

1. Open Onereach app
2. Settings (`Cmd+,`)
3. GSX File Sync Configuration section
4. **Paste the long token** into the GSX Token field
5. Environment: **Edison**
6. Account ID: `05bd3c92-5d3c-4dc5-a95d-0c584695cea4`
7. Click **"Test Connection"**
8. Should show: ✅ **"Connection successful!"**
9. **Save Settings**
10. Try **"Complete Backup"**

---

## 🖼️ **Visual Guide - What to Look For**

### In Network Tab:
```
Name                    Status  Type    Size
────────────────────────────────────────────
token                   200     xhr     1.2KB  ← Click this!
api/files/list          200     fetch   4.5KB
user/profile            200     xhr     2.1KB
```

### In Headers Tab:
```
Request Headers
────────────────────────────────────────────
authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
                      ↑
                      Copy from here (not "Bearer")
```

---

## 🔍 **Alternative Search Terms**

If searching for "token" doesn't find anything, try:

1. **`authorization`** - Look for Authorization headers
2. **`bearer`** - Find Bearer token headers
3. **`files`** - Find Files API requests
4. **`api`** - Find API requests
5. **`upload`** - Find upload requests

---

## ⚠️ **Common Mistakes**

### ❌ **Don't Copy:**
- The word "Bearer " (remove it)
- Short tokens (< 50 characters)
- Tokens from the wrong environment
- Expired tokens

### ✅ **Do Copy:**
- The long string after "Bearer "
- The entire token (may wrap to multiple lines)
- From a recent/active request
- From the edison environment

---

## 🎬 **Quick Summary**

```
1. Log into GSX (studio.edison.onereach.ai)
2. F12 → Network tab
3. Refresh page (F5)
4. Type "token" in filter box
5. Click on a filtered request
6. Headers tab → Request Headers
7. Find "authorization: Bearer ..."
8. Copy the long string AFTER "Bearer "
9. Paste into Onereach app Settings
10. Test Connection!
```

---

## 📞 **Still Stuck?**

### **Can you see the Network tab?**
- ✅ F12 or Cmd+Option+I should open it
- Look for tabs: Elements, Console, Sources, **Network**

### **Can you see requests when you refresh?**
- ✅ Press F5 - you should see dozens of requests appear
- If not, try clicking around in GSX first

### **Can you find "authorization" header?**
- ✅ Click on ANY request
- Look in Headers tab
- Scroll through Request Headers
- Should be there for authenticated requests

### **Token still short?**
- You might be looking at the wrong request
- Try requests to different endpoints
- Look specifically for Files API requests

---

## 🎯 **What to Look For**

Good requests to check:
- Requests to `*.onereach.ai` domains
- Requests with Status 200
- Requests of type: xhr, fetch, or other
- Requests that load data (not just static files)

**The Authorization header should have a LONG token (100+ characters)!**

Let me know what you see in the Network tab and I'll help you find the right token! 🔍
