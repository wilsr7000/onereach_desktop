// Bad example - uses localStorage instead of file system
let todos = [];

// Load todos from localStorage (WRONG!)
function loadTodos() {
    const saved = localStorage.getItem('todos');
    if (saved) {
        todos = JSON.parse(saved);
        renderTodos();
    }
}

// Save todos to localStorage (WRONG!)
function saveTodos() {
    localStorage.setItem('todos', JSON.stringify(todos));
}

function addTodo() {
    const input = document.getElementById('todoInput');
    const text = input.value.trim();
    
    if (text) {
        todos.push({
            id: Date.now(),
            text: text,
            completed: false
        });
        
        input.value = '';
        saveTodos();
        renderTodos();
    }
}

function renderTodos() {
    const list = document.getElementById('todoList');
    list.innerHTML = '';
    
    todos.forEach(todo => {
        const li = document.createElement('li');
        li.textContent = todo.text;
        list.appendChild(li);
    });
}

// Uses Claude API without checking if it's available (WRONG!)
async function enhanceTodo(text) {
    const enhanced = await moduleAPI.claude.complete(`Make this todo item clearer: ${text}`);
    return enhanced;
}

// Initialize on load
loadTodos(); 