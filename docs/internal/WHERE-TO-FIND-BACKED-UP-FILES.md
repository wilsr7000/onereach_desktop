# Where to Find Your Backed Up Files in GSX

## 🎉 Your Backup Was Successful!

The files are synced - you just need to know where to look.

---

## 📍 **How to Access Your Files**

### **Step 1: Go to GSX Files**

**For Staging (your environment):**
```
https://studio.staging.onereach.ai/files
```

**For other environments:**
- Production: `https://studio.onereach.ai/files`
- Edison: `https://studio.edison.onereach.ai/files`
- QA: `https://studio.qa.api.onereach.ai/files`

---

### **Step 2: Look for "Complete-Backup" Folder**

You should see a folder structure like:

```
GSX Files/
├── Complete-Backup/          ← Look for this folder!
│   ├── OR-Spaces/            ← Your clipboard data
│   │   ├── index.json
│   │   ├── items/
│   │   │   ├── [item folders]
│   │   └── spaces/
│   │       ├── [space folders]
│   └── App-Config/           ← Your app settings
│       ├── reading-log.json
│       ├── app-settings-encrypted.json
│       ├── idw-entries.json
│       ├── gsx-links.json
│       └── [other config files]
└── SDK-Test/                 ← From our test earlier
    └── test.txt
```

---

## 🔍 **If You Don't See the Folder**

### **Try These:**

**1. Refresh the page:**
- Press F5 or click refresh
- Files might take a moment to appear

**2. Check the root/home directory:**
- Make sure you're looking at the root of Files
- Not inside another folder

**3. Look for "SDK-Test" folder:**
- This was created by our test earlier
- If you see this, your backup folders are nearby

**4. Search for the folder:**
- If GSX Files has a search feature
- Search for: "Complete-Backup"

**5. Check different views:**
- List view vs Grid view
- Sort by: Date Modified (newest first)

---

## 📊 **What You Should See**

### **Complete-Backup Folder Contents:**

**OR-Spaces subfolder:**
- Contains: ~43 clipboard items
- Size: ~40-50 MB
- Includes: index.json, items folder, spaces folder

**App-Config subfolder:**
- Contains: ~10-20 config files
- Size: ~3-10 MB
- Includes: reading-log.json, settings, IDW configs

---

## 🌐 **Quick Links by Environment**

Click the link for your environment:

| Environment | Files URL |
|-------------|-----------|
| **Staging** | https://studio.staging.onereach.ai/files |
| Edison | https://studio.edison.onereach.ai/files |
| Production | https://studio.onereach.ai/files |
| QA | https://studio.qa.api.onereach.ai/files |

---

## 🔎 **Still Can't Find It?**

### **Check the Sync History in App:**

1. In Onereach app
2. Menu → **GSX → File Sync → View Sync History**
3. This will show you:
   - What was synced
   - When it was synced
   - Where it was synced to (remote path)
   - Success/failure status

---

## 📱 **Alternative: Check Via Console**

In the app, open Console (`Cmd+Option+I` in the Settings window) and look for:

```
[GSX Sync] ✓ OR-Spaces backup complete
[GSX Sync] ✓ App Config backup complete
```

This confirms the backup worked.

---

## 🎯 **Verification Steps**

To confirm files are there:

1. **Go to:** https://studio.staging.onereach.ai/files
2. **Look for:** "Complete-Backup" folder
3. **Open it** - should have 2 subfolders
4. **Open OR-Spaces** - should have items and spaces folders
5. **Open App-Config** - should have ~15-20 files

---

## 📂 **Folder Names to Look For**

The backup creates:
- `Complete-Backup` (main folder)
  - `OR-Spaces` (clipboard data)
  - `App-Config` (settings & logs)

If you used individual sync options instead, look for:
- `OR-Spaces-Backup`
- `App-Config-Backup`
- `Desktop-Backup` (if you synced desktop)

---

## ✅ **Navigation Path**

```
1. Open browser
2. Go to: studio.staging.onereach.ai
3. Click: "Files" (might be in left menu or top navigation)
4. Look for: "Complete-Backup" folder
5. Double-click to open it
6. See: OR-Spaces and App-Config folders
```

---

## 🔧 **Troubleshooting**

### **"I'm in Files but don't see Complete-Backup"**

**Try:**
- Refresh the page (F5)
- Check you're in the root folder (not inside another folder)
- Look at the path/breadcrumb - should show "Files" or "/"
- Try logging out and back in to GSX

### **"Files section doesn't exist in GSX"**

**Try:**
- Look for "Storage" or "Documents"
- Check the main navigation menu
- Try this direct URL: `https://studio.staging.onereach.ai/files`

### **"I see SDK-Test but not Complete-Backup"**

This means:
- Files ARE being uploaded (SDK-Test proves it)
- Complete-Backup might be named differently
- Look for folders with today's timestamp
- Check for "OR-Spaces" or "App-Config" folders

---

## 📞 **Quick Check**

In your Onereach app, can you:
1. Menu → GSX → File Sync → **View Sync History**
2. Tell me what it shows?

This will tell us the exact remote path where files were synced!

---

**The files are definitely there (the sync succeeded) - we just need to find them in the GSX UI!** 🔍

What do you see when you go to https://studio.staging.onereach.ai/files?

