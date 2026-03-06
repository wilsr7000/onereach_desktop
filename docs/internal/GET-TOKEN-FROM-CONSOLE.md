# Get Token from Console (Easiest Method!)

## 🎯 Simple Console Method - No Network Tab Needed!

Since the Network tab isn't working, use the Console instead - it's actually easier!

---

## 📝 **Step-by-Step Instructions:**

### **Step 1: Log Into GSX**
- Go to: https://studio.edison.onereach.ai
- Make sure you're fully logged in
- Wait for the page to load completely

### **Step 2: Open Console**
- Press **F12** (or `Cmd+Option+I` on Mac)
- Click the **"Console"** tab (not Network)

### **Step 3: Run These Commands**

Copy and paste these commands **one at a time** into the Console and press Enter:

---

#### **Command 1: Check localStorage for tokens**

```javascript
Object.keys(localStorage).filter(key => key.toLowerCase().includes('token')).forEach(key => console.log(key, ':', localStorage.getItem(key)))
```

**What this does:** Shows all items in localStorage with "token" in the name

**Look for:** Any value that's 50+ characters long

---

#### **Command 2: Find ALL long strings**

```javascript
Object.keys(localStorage).forEach(key => {
  const val = localStorage.getItem(key);
  if (val && val.length > 50) {
    console.log('---');
    console.log('Key:', key);
    console.log('Length:', val.length);
    console.log('Value:', val);
  }
});
```

**What this does:** Shows every localStorage value longer than 50 characters

**Look for:** The longest string - that's probably your token!

---

#### **Command 3: Check sessionStorage too**

```javascript
Object.keys(sessionStorage).forEach(key => {
  const val = sessionStorage.getItem(key);
  if (val && val.length > 50) {
    console.log('---');
    console.log('Key:', key);
    console.log('Length:', val.length);
    console.log('Value:', val);
  }
});
```

**What this does:** Checks session storage for long tokens

---

#### **Command 4: Check for common token names**

```javascript
['token', 'authToken', 'accessToken', 'apiToken', 'auth_token', 'access_token', 'bearer_token', 'jwt'].forEach(name => {
  const val = localStorage.getItem(name) || sessionStorage.getItem(name);
  if (val) console.log(name, ':', val);
});
```

**What this does:** Checks common token storage names

---

#### **Command 5: Search window object**

```javascript
Object.keys(window).filter(key => key.toLowerCase().includes('token')).forEach(key => console.log(key, ':', window[key]))
```

**What this does:** Looks for token-related variables in the page's JavaScript

---

## 📋 **What to Look For:**

After running these commands, you should see output like:

```
---
Key: authToken
Length: 187
Value: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIi...
```

**Copy that long Value!**

---

## ✅ **How to Know You Found It:**

The correct token will:
- ✅ Be **50-500+ characters long** (probably 100-300)
- ✅ Start with `eyJ` (JWT format) OR be a long random string
- ✅ NOT be `4szRut.UX3vsaos9DWXzocNER7f7Z_a2` (that's too short)

---

## 🎯 **Quick Copy Method:**

If you find a token in the Console output:

1. **Click on the value** in the Console
2. It should highlight
3. **Right-click** → **Copy**
4. Or just select it and press `Cmd+C` / `Ctrl+C`

---

## 💡 **Alternative: Automatic Token Finder**

Paste this **all-in-one command** that searches everywhere:

```javascript
(function findToken() {
  console.log('🔍 Searching for tokens...\n');
  
  let found = [];
  
  // Check localStorage
  Object.keys(localStorage).forEach(key => {
    const val = localStorage.getItem(key);
    if (val && val.length > 50) {
      found.push({ source: 'localStorage', key, value: val, length: val.length });
    }
  });
  
  // Check sessionStorage
  Object.keys(sessionStorage).forEach(key => {
    const val = sessionStorage.getItem(key);
    if (val && val.length > 50) {
      found.push({ source: 'sessionStorage', key, value: val, length: val.length });
    }
  });
  
  // Sort by length (longest first)
  found.sort((a, b) => b.length - a.length);
  
  console.log(`Found ${found.length} potential tokens:\n`);
  
  found.forEach((item, index) => {
    console.log(`${index + 1}. ${item.source}.${item.key}`);
    console.log(`   Length: ${item.length} characters`);
    console.log(`   Preview: ${item.value.substring(0, 50)}...`);
    console.log(`   Full value: ${item.value}`);
    console.log('');
  });
  
  if (found.length === 0) {
    console.log('❌ No long strings found in storage.');
    console.log('Try navigating to different sections of GSX first.');
  } else {
    console.log('✅ Copy the longest token above!');
  }
})();
```

**This searches everywhere and shows you the most likely tokens!**

---

## 🚀 **After You Find the Token:**

1. **Copy the full token** (should be 50-500 characters)
2. Open **Onereach app** → Settings
3. **Paste** into GSX Token field
4. Environment: **Edison**
5. Account ID: `05bd3c92-5d3c-4dc5-a95d-0c584695cea4`
6. Click **"Test Connection"**
7. Should work now! ✅

---

## 🎬 **Simple Flow:**

```
1. In browser: F12 → Console tab
2. Paste the all-in-one command above
3. Press Enter
4. Look at the results
5. Copy the longest token
6. Paste into Onereach app
7. Done! ✅
```

---

## ⚠️ **If Still No Tokens Found:**

The page might not store tokens in localStorage. Try:

1. **Log out of GSX**
2. **Log back in** (watch the login process)
3. **Immediately after login**, run the Console commands
4. Fresh login often stores the token

**Or contact the OneReach developer who set up the SDK - they can provide a valid token!**

---

**Try the Console method now - it should find your token immediately!** 🔍
