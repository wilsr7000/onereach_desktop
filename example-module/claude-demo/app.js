// Claude API Demo Module
// This demonstrates how to use the Claude API in a module

// Chat conversation history
let chatHistory = [];

// Check API status on load
window.addEventListener('DOMContentLoaded', async () => {
    await checkAPIStatus();
});

async function checkAPIStatus() {
    const statusEl = document.getElementById('apiStatus');
    
    try {
        // Check if Claude API is available
        const isAvailable = await window.moduleAPI.claude.testConnection();
        
        if (isAvailable) {
            statusEl.textContent = '✓ Claude API is connected and ready';
            statusEl.className = 'api-status connected';
        } else {
            statusEl.textContent = '✗ Claude API key not configured. Please configure it in the main app settings.';
            statusEl.className = 'api-status error';
        }
    } catch (error) {
        statusEl.textContent = '✗ Error checking API status: ' + error.message;
        statusEl.className = 'api-status error';
    }
}

// Tab switching
function switchTab(tabName) {
    // Update tab buttons
    document.querySelectorAll('.tab').forEach(tab => {
        tab.classList.remove('active');
    });
    event.target.classList.add('active');
    
    // Update tab content
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.remove('active');
    });
    document.getElementById(tabName).classList.add('active');
}

// Text Completion Demo
async function runCompletion() {
    const prompt = document.getElementById('completionPrompt').value;
    const resultEl = document.getElementById('completionResult');
    
    if (!prompt.trim()) {
        resultEl.textContent = 'Please enter a prompt.';
        return;
    }
    
    resultEl.innerHTML = '<span class="loading">Generating completion...</span>';
    
    try {
        const completion = await window.moduleAPI.claude.complete(prompt, {
            maxTokens: 500,
            temperature: 0.7
        });
        
        resultEl.textContent = completion;
    } catch (error) {
        resultEl.textContent = 'Error: ' + error.message;
    }
}

// Chat Demo
function addMessage(role, content) {
    const messagesEl = document.getElementById('chatMessages');
    const messageEl = document.createElement('div');
    messageEl.className = `message ${role}`;
    
    messageEl.innerHTML = `
        <div class="message-role">${role}</div>
        <div>${content}</div>
    `;
    
    messagesEl.appendChild(messageEl);
    messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function sendChatMessage() {
    const input = document.getElementById('chatInput');
    const message = input.value.trim();
    
    if (!message) return;
    
    // Add user message to UI and history
    addMessage('user', message);
    chatHistory.push({ role: 'user', content: message });
    
    // Clear input
    input.value = '';
    input.disabled = true;
    
    try {
        // Get Claude's response
        const response = await window.moduleAPI.claude.chat(chatHistory, {
            maxTokens: 1000,
            temperature: 0.7
        });
        
        // Add assistant message to UI and history
        addMessage('assistant', response);
        chatHistory.push({ role: 'assistant', content: response });
        
    } catch (error) {
        addMessage('assistant', 'Error: ' + error.message);
    }
    
    input.disabled = false;
    input.focus();
}

function clearChat() {
    chatHistory = [];
    document.getElementById('chatMessages').innerHTML = '';
}

// Metadata Generation Demo
async function generateMetadata() {
    const content = document.getElementById('metadataContent').value;
    const contentType = document.getElementById('metadataType').value || 'text';
    const resultEl = document.getElementById('metadataResult');
    
    if (!content.trim()) {
        resultEl.textContent = 'Please enter some content to analyze.';
        return;
    }
    
    resultEl.innerHTML = '<span class="loading">Generating metadata...</span>';
    
    try {
        const metadata = await window.moduleAPI.claude.generateMetadata(
            content,
            contentType,
            'Focus on technical details and practical categorization'
        );
        
        resultEl.textContent = JSON.stringify(metadata, null, 2);
    } catch (error) {
        resultEl.textContent = 'Error: ' + error.message;
    }
}

// Analysis Demo
async function runAnalysis() {
    const content = document.getElementById('analysisContent').value;
    const resultEl = document.getElementById('analysisResult');
    
    if (!content.trim()) {
        resultEl.textContent = 'Please enter some content to analyze.';
        return;
    }
    
    resultEl.innerHTML = '<span class="loading">Analyzing content...</span>';
    
    try {
        const analysis = await window.moduleAPI.claude.analyze(
            `Analyze the following logs and identify any issues, patterns, or recommendations:\n\n${content}`,
            {
                maxTokens: 1000,
                temperature: 0.3
            }
        );
        
        // Format the analysis result
        if (typeof analysis === 'object') {
            resultEl.textContent = JSON.stringify(analysis, null, 2);
        } else {
            resultEl.textContent = analysis;
        }
    } catch (error) {
        resultEl.textContent = 'Error: ' + error.message;
    }
}

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
    // Cmd/Ctrl + Enter to submit in textareas
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        const activeElement = document.activeElement;
        
        if (activeElement.id === 'completionPrompt') {
            runCompletion();
        } else if (activeElement.id === 'metadataContent') {
            generateMetadata();
        } else if (activeElement.id === 'analysisContent') {
            runAnalysis();
        }
    }
}); 