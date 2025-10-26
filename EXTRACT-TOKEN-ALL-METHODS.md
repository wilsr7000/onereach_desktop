# Extract Token - All Methods (When Console Returns Undefined)

## 🔍 Try These Commands in Console One by One

You're in **Staging**: https://studio.staging.onereach.ai

---

## 🎯 **Method 1: Check All Storage (Run Each)**

### **Command 1: Check localStorage (all keys)**
```javascript
console.log('localStorage:', localStorage);
```

### **Command 2: List all localStorage keys**
```javascript
Object.keys(localStorage).forEach(k => console.log(k));
```

### **Command 3: Check sessionStorage**
```javascript
Object.keys(sessionStorage).forEach(k => console.log(k, ':', sessionStorage.getItem(k)));
```

### **Command 4: Check cookies**
```javascript
console.log('Cookies:', document.cookie);
```

### **Command 5: Search for any auth-related items**
```javascript
Object.keys(localStorage).forEach(k => {
  if (k.includes('auth') || k.includes('token') || k.includes('key')) {
    console.log('🔑', k, ':', localStorage.getItem(k));
  }
});
```

---

## 🎯 **Method 2: Inspect Window Variables**

### **Command 6: Check window for tokens**
```javascript
Object.keys(window).filter(k => k.includes('token') || k.includes('auth')).forEach(k => console.log(k, ':', window[k]));
```

### **Command 7: Check for common auth objects**
```javascript
console.log('Auth data:', {
  token: window.token,
  authToken: window.authToken,
  accessToken: window.accessToken,
  apiKey: window.apiKey,
  user: window.user,
  auth: window.auth
});
```

---

## 🎯 **Method 3: Network Tab (Try Again)**

Since Console isn't finding it, the token might only appear in network requests:

### **1. Stay on GSX page (logged in)**

### **2. Open DevTools:**
- Press **F12**

### **3. Go to Network tab**

### **4. Check "Preserve log" checkbox** (important!)
- Look at the top of Network tab
- Find and CHECK the box that says **"Preserve log"**

### **5. Now do something in GSX:**
- Click on **"Bots"** or **"Files"** section
- Click on your **profile/account**  
- Try to **upload a file**
- Basically **click anything** that might trigger an API call

### **6. Watch Network tab fill up**
- You should see requests appear as you click

### **7. Click on requests one by one:**
- Look for requests to `*.onereach.ai` or `api.`
- Click each one
- Check Headers → Request Headers
- Look for `authorization:`

---

## 🎯 **Method 4: Check Application Tab**

### **1. DevTools → Application tab** (or "Storage" tab in Firefox)

### **2. Expand these sections in the left sidebar:**
- **Local Storage** → Click on the domain
- **Session Storage** → Click on the domain  
- **Cookies** → Click on the domain
- **IndexedDB** → Expand and look

### **3. Look at the values:**
- Scroll through the key-value pairs
- Look for anything 50+ characters long

---

## 🎯 **Method 5: Contact Developer**

Since you were told to "copy from network", the OneReach developer who helped you knows there's a token there. 

**Ask them:**
- "I'm in staging (studio.staging.onereach.ai) and can't find the token"
- "Can you provide the exact steps or generate a token for me?"
- "Which specific network request should I look at?"

---

## 🎯 **Method 6: Try Production or QA Instead**

Maybe staging doesn't have your account set up. Try:

**Production:**
```javascript
// Go to: https://studio.onereach.ai
// Run the same console commands
```

**QA:**
```javascript
// Go to: https://studio.qa.api.onereach.ai
// Run the same console commands
```

**Edison:**
```javascript
// Go to: https://studio.edison.onereach.ai
// Run the same console commands
```

---

## 🎯 **Method 7: Make the Network Tab Work**

### **Complete Reset:**

1. **Close all tabs** of GSX
2. **Clear browser cache:**
   - Chrome: `Cmd+Shift+Delete` → Clear browsing data
3. **Restart browser**
4. **Open GSX fresh:** https://studio.staging.onereach.ai
5. **Before logging in:** Press F12 → Network tab
6. **Check "Preserve log"**
7. **Now log in**
8. **Watch Network tab during login** - should see requests!

---

## 📱 **Method 8: Try Different Browser**

Sometimes one browser works better:

1. Try **Chrome** (best DevTools)
2. Try **Firefox** (different tool layout)
3. Try **Safari** (if on Mac)

---

## 🎯 **Method 9: The Nuclear Option**

If nothing works, you can ask the OneReach developer to:

**Generate a token for you via API:**
```bash
# They can run this command (they have access)
curl -X POST https://api.staging.onereach.ai/auth/generate-token \
  -H "Content-Type: application/json" \
  -d '{"accountId": "05bd3c92-5d3c-4dc5-a95d-0c584695cea4", "scope": "files:read,files:write"}'
```

They'll get a token in the response and can send it to you.

---

## ❓ **What Did You See When Running the Console Commands?**

Tell me:
- Did you see "undefined"?
- Did you see any output at all?
- Which command did you run?
- What environment? (staging, production, edison, qa?)

**I can help interpret what you're seeing!**

---

## 🎯 **Quick Recap - Try These NOW:**

```javascript
// 1. Show all localStorage
console.log(localStorage);

// 2. Show all sessionStorage  
console.log(sessionStorage);

// 3. Show cookies
console.log(document.cookie);

// 4. Search everything
Object.keys(localStorage).forEach(k => console.log(k, ':', localStorage.getItem(k)));
```

**Run these and tell me what you see!** Even if it's just a list of keys, that helps! 🔍
