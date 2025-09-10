const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    getArticleData: () => ipcRenderer.invoke('get-article-data')
}); 