# Network Tab is Empty - How to Fix

## 🎯 The Issue

The Network tab only shows requests made **AFTER** you open it. If you opened DevTools after the page loaded, it will be empty.

---

## ✅ **Solution - 3 Easy Steps**

### **Step 1: Keep Developer Tools Open**
- Press **F12** (or `Cmd+Option+I` on Mac)
- Click the **"Network"** tab
- **Keep it open!**

### **Step 2: Refresh the Page**
- Press **F5** or **Cmd+R**
- OR click the browser refresh button
- **You should immediately see requests appear in the Network tab**

### **Step 3: Filter and Find Token**
- Type `token` in the filter box
- Click on a request
- Look for Authorization header

---

## 🎬 **Animated Flow:**

```
1. Open GSX in browser (studio.edison.onereach.ai)
2. Press F12 → Network tab
3. Press F5 (refresh) ← THIS IS THE KEY!
4. Watch Network tab fill with requests
5. Type "token" in filter
6. Click on a request
7. Headers → Request Headers → authorization
8. Copy the long token after "Bearer "
```

---

## 🔍 **What You Should See After Refreshing:**

The Network tab should fill up with requests like:

```
Name                          Status   Type      Size    Time
────────────────────────────────────────────────────────────
bootstrap                     200      document  15.2KB  145ms
manifest.json                 200      xhr       1.5KB   23ms
api/user/profile             200      xhr       2.3KB   156ms
token                        200      xhr       0.8KB   89ms  ← Look for this!
api/files/list               200      fetch     4.1KB   234ms
chunk-vendor.js              200      script    85.3KB  67ms
app.css                      200      css       12.4KB  45ms
...and many more
```

**If you see this list, you're good! Now filter for "token".**

---

## 🚦 **Still Empty After Refresh?**

Try these:

### **Option 1: Preserve Log**
1. In Network tab, look for a checkbox that says **"Preserve log"**
2. **Check it** - this keeps requests even when navigating
3. Now refresh (F5)

### **Option 2: Disable Cache**
1. In Network tab, look for **"Disable cache"** checkbox
2. **Check it**
3. Refresh (F5)

### **Option 3: Navigate in GSX**
Instead of refreshing, navigate around:
1. Click on **"Files"** section in GSX (if available)
2. Click on **"Bots"** or **"Designer"**
3. Click on your **profile/account**
4. Each click should generate new requests in Network tab

### **Option 4: Clear and Start Fresh**
1. Click the **🚫 Clear** button in Network tab (circle with slash icon)
2. Refresh the page (F5)
3. Requests should appear immediately

---

## 📸 **What the Network Tab Looks Like**

### **Before Refresh (Empty):**
```
┌─────────────────────────────────────────┐
│ 🔍 Filter                              │
├─────────────────────────────────────────┤
│                                         │
│         (No requests captured)          │
│                                         │
│      Refresh the page to see requests  │
│                                         │
└─────────────────────────────────────────┘
```

### **After Refresh (Full):**
```
┌─────────────────────────────────────────┐
│ 🔍 Filter: token                       │
├──────────┬────────┬──────┬──────┬──────┤
│ Name     │ Status │ Type │ Size │ Time │
├──────────┼────────┼──────┼──────┼──────┤
│ token    │ 200    │ xhr  │ 1.2K │ 89ms │ ← Click!
│ api/auth │ 200    │ xhr  │ 2.1K │ 145ms│
└──────────┴────────┴──────┴──────┴──────┘
```

---

## 🎯 **The Magic Sequence:**

```
F12 → Network Tab → F5 (REFRESH!) → See Requests
```

**The refresh is critical! The Network tab is empty until you refresh.**

---

## 🔄 **Alternative: Use Console Method**

If Network tab is still problematic, try this:

1. **Press F12** → **Console** tab (not Network)
2. **Type this command:**
   ```javascript
   localStorage
   ```
3. **Press Enter**
4. Look through the storage items for long tokens
5. Or try:
   ```javascript
   Object.keys(localStorage).forEach(key => {
     const value = localStorage.getItem(key);
     if (value && value.length > 50) {
       console.log(key, ':', value);
     }
   });
   ```
6. This will print all long values in localStorage
7. Look for anything that looks like a long token

---

## 🎬 **Try This Right Now:**

1. ✅ Keep GSX page open in browser
2. ✅ Press **F12**
3. ✅ Click **"Network"** tab
4. ✅ Press **F5** (refresh the page)
5. ✅ Watch the Network tab - it should fill with requests!

**Once you see requests, type "token" in the filter box and you're on your way!**

Let me know if you see requests now! 🚀
