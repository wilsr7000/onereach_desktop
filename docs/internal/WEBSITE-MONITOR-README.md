# Website Monitoring Feature

This feature allows you to monitor websites for changes and automatically save those changes to your Onereach spaces.

## Features

- **Monitor Any Website**: Track changes on any public website
- **Selective Monitoring**: Monitor specific parts of a page using CSS selectors
- **Visual Comparison**: Automatic screenshots before/after changes
- **Space Integration**: Changes are saved to your selected space
- **Change History**: Full history of all detected changes
- **Automatic Checks**: Websites are checked every 30 minutes

## How to Use

### From the UI

1. **Add a Monitor**:
   ```javascript
   await window.clipboard.addWebsiteMonitor({
     url: "https://example.com",
     name: "Example Site",
     selector: "body", // or specific CSS selector like ".content"
     spaceId: currentSpaceId,
     includeScreenshot: true
   });
   ```

2. **Check Website Manually**:
   ```javascript
   await window.clipboard.checkWebsite(monitorId);
   ```

3. **View All Monitors**:
   ```javascript
   const monitors = await window.clipboard.getWebsiteMonitors();
   ```

4. **View Change History**:
   ```javascript
   const result = await window.clipboard.getMonitorHistory(monitorId);
   ```

5. **Pause/Resume Monitoring**:
   ```javascript
   await window.clipboard.pauseWebsiteMonitor(monitorId);
   await window.clipboard.resumeWebsiteMonitor(monitorId);
   ```

6. **Remove Monitor**:
   ```javascript
   await window.clipboard.removeWebsiteMonitor(monitorId);
   ```

## Use Cases

1. **News Monitoring**: Track news websites for updates
2. **Price Tracking**: Monitor product prices on e-commerce sites
3. **Job Listings**: Watch job boards for new postings
4. **Research**: Track academic papers or research updates
5. **Competitor Analysis**: Monitor competitor websites
6. **Documentation**: Track changes in documentation sites
7. **Social Media**: Monitor public social media pages

## How It Works

1. **Initial Snapshot**: When you add a monitor, it takes an initial snapshot
2. **Periodic Checks**: Every 30 minutes, it checks the website again
3. **Change Detection**: Compares content hash to detect changes
4. **Notification**: If changes detected, adds item to your space
5. **History Storage**: Keeps last 100 changes for each monitor

## Technical Details

- Uses Playwright's Chromium browser for reliable page rendering
- Stores snapshots locally in `~/Library/Application Support/onereach-ai/website-monitors/`
- Content comparison using SHA256 hashing
- Supports monitoring specific CSS selectors
- Respects robots.txt and adds delays between checks

## Example Integration

Here's how you might add a button to monitor websites in your clipboard viewer:

```javascript
// Add to your UI
const monitorButton = document.createElement('button');
monitorButton.textContent = '🌐 Monitor Website';
monitorButton.onclick = async () => {
  // Check if current item is a URL
  const selectedItem = getSelectedItem();
  if (selectedItem && selectedItem.source === 'url') {
    const config = {
      url: selectedItem.content,
      name: new URL(selectedItem.content).hostname,
      spaceId: currentSpace,
      selector: 'body'
    };
    
    const result = await window.clipboard.addWebsiteMonitor(config);
    if (result.success) {
      showNotification({
        title: 'Website Monitor Added',
        body: 'This website will be checked every 30 minutes',
        type: 'success'
      });
    }
  }
};
```

## Limitations

- Only monitors public websites (no authentication support yet)
- 30-minute check interval (can be customized in code)
- Stores up to 100 changes per monitor
- Screenshots may be large, affecting storage

## Future Enhancements

- Authentication support for private pages
- Custom check intervals per monitor
- Email/notification alerts
- Diff visualization
- RSS/API monitoring
- Webhooks for changes
- Export change reports 